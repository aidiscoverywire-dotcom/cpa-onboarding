/**
 * POST /api/jobs/stall-check — stall detection job (Cloud Scheduler target).
 *
 * Auth: `Authorization: Bearer <STALL_JOB_SECRET>` compared in constant time.
 * Missing/mismatched secret → 401; unset STALL_JOB_SECRET → 500 (misconfigured).
 *
 * PROD OIDC NOTE: the Phase-1 mechanism is a shared Bearer secret. In prod
 * this job should be invoked by Cloud Scheduler with an OIDC token minted for
 * the scheduler's service account (audience = this service's URL), validated
 * here via Google's certs — or, equivalently, placed behind IAP with the
 * scheduler SA in the IAP-secured-web-app-user role. The Bearer-secret check
 * below must then be replaced by that OIDC/IAP verification; do not run both.
 *
 * Logic: for each client in a non-terminal, non-stalled state, compare the
 * last activity (latest of clients.updated_at and the newest transition row)
 * against stall_rules for the state (falling back to the 'default' rule).
 * Past-threshold clients get STALL_DETECTED (actor job:stall-check), one
 * transaction per client; already-stalled/terminal clients are skipped.
 * Phase 1 sends no client-facing messages — the digest is the returned JSON
 * (a staff-visible minimal alert; wiring it to email/Slack is later work).
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { applyClientTransitionTx, systemActor } from "@/lib/transitions";
import { TransitionNotAllowed } from "@/lib/machine";
import {
  bearerMatches,
  err,
  getRequestId,
  ok,
} from "../../_helpers";

export const runtime = "nodejs";

interface StallCandidate {
  id: string;
  display_name: string;
  current_state: string;
  last_activity: string;
  threshold_hours: number;
}

export async function POST(req: NextRequest) {
  const secret = process.env["STALL_JOB_SECRET"] ?? "";
  if (!secret) {
    return err(500, "misconfigured", "STALL_JOB_SECRET is not set.");
  }
  if (!bearerMatches(req, secret)) {
    return err(401, "unauthorized", "Invalid job credentials.");
  }

  const requestId = getRequestId(req);
  const actor = systemActor("stall-check");

  const candidates = await withTx((tx) =>
    tx.query<StallCandidate>(
      `WITH rules AS (
         SELECT state, threshold_hours FROM stall_rules WHERE enabled = true
       ),
       last_tx AS (
         SELECT client_id, max(created_at) AS at
           FROM onboarding_transitions GROUP BY client_id
       )
       SELECT c.id, c.display_name, c.current_state,
              GREATEST(c.updated_at, COALESCE(lt.at, c.updated_at)) AS last_activity,
              COALESCE(r.threshold_hours,
                       (SELECT threshold_hours FROM rules WHERE state = 'default')) AS threshold_hours
         FROM clients c
         LEFT JOIN last_tx lt ON lt.client_id = c.id
         LEFT JOIN rules r ON r.state = c.current_state
        WHERE c.current_state NOT IN
              ('onboarded', 'stalled', 'canceled', 'no_show', 'lost')
          AND GREATEST(c.updated_at, COALESCE(lt.at, c.updated_at))
              < now() - make_interval(
                    hours => COALESCE(r.threshold_hours,
                       (SELECT threshold_hours FROM rules WHERE state = 'default'), 72))`,
    ),
  );

  const stalled: { client_id: string; state: string }[] = [];
  const skipped: { client_id: string; reason: string }[] = [];

  for (const cand of candidates.rows) {
    try {
      const applied = await withTx(async (tx) => {
        const result = await applyClientTransitionTx(tx, {
          clientId: cand.id,
          event: {
            type: "STALL_DETECTED",
            actor,
            reason: `no activity for ${cand.threshold_hours}h (rule: ${cand.current_state})`,
          },
          idempotencyKey: `stall-check:${cand.id}:${requestId}`,
          requestId,
        });
        if (!result.deduped) {
          await appendAudit(tx, {
            actor: actor.id,
            actorType: actor.type,
            action: "job:stall_detected",
            entity: "client",
            entityId: cand.id,
            before: { state: cand.current_state },
            after: { state: result.state, resume_state: result.context.resumeState },
            requestId,
          });
        }
        return result;
      });
      if (!applied.deduped) {
        stalled.push({ client_id: cand.id, state: applied.state });
      }
    } catch (e) {
      // A client that changed state between scan and write (e.g. already
      // stalled) is skipped, not failed.
      if (e instanceof TransitionNotAllowed || (e as Error).name === "NotFoundError") {
        skipped.push({ client_id: cand.id, reason: (e as Error).message });
        continue;
      }
      throw e;
    }
  }

  return ok({
    ok: true,
    scanned: candidates.rows.length,
    stalled,
    skipped,
    note: "Phase 1: staff-visible digest only; no client-facing messages are sent.",
  });
}
