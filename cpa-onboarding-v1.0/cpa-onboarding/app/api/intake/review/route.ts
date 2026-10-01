/**
 * /api/intake/review — staff review queue for unmatched intake submissions.
 *
 * GET: pending/ambiguous submissions (status needs_review), newest first.
 * POST: { action: "match" | "waive", submission_id?, client_id, reason? }
 *   (form fields: action, submission_id, client_id, reason)
 *   - match: INTAKE_MATCHED for the client (machine guards apply).
 *   - waive: INTAKE_WAIVED — owner/admin only per the machine guard (403
 *     otherwise); writes the intake_waivers row with the reason, audited.
 * One transaction: submission update + transition row + audit row.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { applyClientTransitionTx, userActor } from "@/lib/transitions";
import {
  err,
  getClientIp,
  getIdempotencyKey,
  getRequestId,
  getSession,
  ok,
  pick,
  readBody,
  str,
  transitionErrorBody,
  transitionErrorStatus,
} from "../../_helpers";

const STAFF_ROLES = ["owner", "admin", "partner", "staff"] as const;

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const { rows } = await withTx((tx) =>
    tx.query(
      `SELECT id, typeform_submission_id, email_normalized, matched_client_id,
              status, answers, received_at
         FROM intake_submissions
        WHERE status = 'needs_review'
        ORDER BY received_at DESC
        LIMIT 100`,
    ),
  );
  return ok({ queue: rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");
  if (!(STAFF_ROLES as readonly string[]).includes(session.role)) {
    return err(403, "forbidden", `Role '${session.role}' cannot review intake.`);
  }

  const body = await readBody(req);
  const action = str(pick(body, "action"));
  const clientId = str(pick(body, "client_id", "clientId"));
  const submissionId = str(pick(body, "submission_id", "submissionId"));
  const reason = str(pick(body, "reason"));

  if (!clientId) return err(400, "missing_field", "client_id is required.");
  if (action !== "match" && action !== "waive") {
    return err(400, "bad_action", "action must be 'match' or 'waive'.");
  }
  if (action === "waive" && !reason) {
    return err(400, "missing_field", "A waiver reason is required (audited).");
  }
  if (action === "match" && !submissionId) {
    return err(400, "missing_field", "submission_id is required to match.");
  }

  const actor = userActor(session.sub, session.role);
  const idempotencyKey = getIdempotencyKey(req, body);
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result = await withTx(async (tx) => {
      if (action === "match") {
        const sub = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM intake_submissions WHERE id = $1 FOR UPDATE`,
          [submissionId],
        );
        if (!sub.rows[0]) return err(404, "not_found", "Submission not found.");
        const applied = await applyClientTransitionTx(tx, {
          clientId,
          event: { type: "INTAKE_MATCHED", actor, submissionId: sub.rows[0].id },
          idempotencyKey,
          ip,
          requestId,
        });
        if (!applied.deduped) {
          await tx.query(
            `UPDATE intake_submissions SET matched_client_id = $1, status = 'matched'
              WHERE id = $2`,
            [clientId, sub.rows[0].id],
          );
        }
        return ok({
          client_id: clientId,
          state: applied.state,
          steps: applied.steps,
          deduped: applied.deduped,
        });
      }

      // waive — the machine's role guard (owner/admin) is the enforcer.
      const applied = await applyClientTransitionTx(tx, {
        clientId,
        event: { type: "INTAKE_WAIVED", actor, waiverId: idempotencyKey, reason: reason! },
        idempotencyKey,
        ip,
        requestId,
      });
      if (!applied.deduped) {
        await tx.query(
          `INSERT INTO intake_waivers (client_id, waived_by, waiver_reason)
           VALUES ($1, $2, $3)`,
          [clientId, session.sub, reason],
        );
      }
      return ok({
        client_id: clientId,
        state: applied.state,
        steps: applied.steps,
        deduped: applied.deduped,
      });
    });
    return result;
  } catch (e) {
    const { code, message } = transitionErrorBody(e);
    return err(transitionErrorStatus(e), code, message);
  }
}
