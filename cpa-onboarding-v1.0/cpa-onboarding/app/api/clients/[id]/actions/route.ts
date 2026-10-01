/**
 * POST /api/clients/[id]/actions — apply a state-machine transition.
 * Auth required; per-event role guards are enforced by the machine itself
 * (role-denied → 403, wrong-state/guard → 422).
 *
 * Accepts JSON or HTML-form bodies. The event comes from the `action` (or
 * `event`) field; remaining fields are per-event (both `snake_case` form
 * names and `camelCase` JSON names are accepted):
 *   INTAKE_MATCHED  submission_id | submissionId
 *   INTAKE_WAIVED    reason (required — also writes the intake_waivers row)
 *   APPLY_DISCOUNT   discount_pct | discountPct (required, 0–100)
 *   SCOPE_CHANGED    services?, fee?, discount_pct? (writes a new scope version row)
 *   DOCUSIGN_SENT    envelope_id | envelopeId (required — records the send;
 *                    the live envelope is created in DocuSign after owner
 *                    approval; Phase 1 does not auto-create envelopes)
 *   DROPBOX_READY    file_request_id?
 *   DOCS_UPDATED     docs_required?, docs_received? (recomputed from the
 *                    checklist when absent)
 *   STALL_DETECTED   reason?
 *   CLIENT_ACTIVITY  activity?
 *   MARK_CANCELED / MARK_LOST  reason?
 *
 * One DB transaction: transition row(s) + side-effect rows + audit row.
 * 200 only after commit. Idempotency via `Idempotency-Key` header or body.
 */
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import {
  type ActorRef,
  type EventType,
  type MachineEvent,
} from "@/lib/machine";
import {
  applyClientTransitionTx,
  userActor,
} from "@/lib/transitions";
import {
  err,
  getClientIp,
  getIdempotencyKey,
  getRequestId,
  getSession,
  num,
  ok,
  pick,
  readBody,
  str,
  transitionErrorBody,
  transitionErrorStatus,
} from "../../../_helpers";

const KNOWN_EVENTS: EventType[] = [
  "BOOKING_CREATED",
  "INTAKE_REQUESTED",
  "INTAKE_MATCHED",
  "INTAKE_WAIVED",
  "BRIEF_APPROVED",
  "MEETING_DONE",
  "APPLY_DISCOUNT",
  "SCOPE_CHANGED",
  "DOCUSIGN_SENT",
  "DOCUSIGN_SIGNED",
  "DROPBOX_READY",
  "ORGANIZER_SENT",
  "DOCS_UPDATED",
  "ONBOARDED",
  "STALL_DETECTED",
  "CLIENT_ACTIVITY",
  "MARK_CANCELED",
  "MARK_NO_SHOW",
  "MARK_LOST",
];

function bad(code: string, message: string) {
  return err(400, code, message);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const body = await readBody(req);
  const eventType = str(pick(body, "action", "event")) as EventType | undefined;
  if (!eventType || !KNOWN_EVENTS.includes(eventType)) {
    return bad("unknown_event", `Unknown or missing action: ${eventType ?? "(none)"}.`);
  }

  const actor: ActorRef = userActor(session.sub, session.role);
  const idempotencyKey = getIdempotencyKey(req, body);
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  // Build the machine event; validate required fields up front.
  let event: MachineEvent;
  switch (eventType) {
    case "INTAKE_MATCHED": {
      const submissionId = str(pick(body, "submission_id", "submissionId"));
      if (!submissionId) return bad("missing_field", "submission_id is required.");
      event = { type: eventType, actor, submissionId };
      break;
    }
    case "INTAKE_WAIVED": {
      const reason = str(pick(body, "reason"));
      if (!reason) return bad("missing_field", "A waiver reason is required (audited).");
      event = { type: eventType, actor, waiverId: randomUUID(), reason };
      break;
    }
    case "APPLY_DISCOUNT": {
      const discountPct = num(pick(body, "discount_pct", "discountPct"));
      if (discountPct === undefined || discountPct < 0 || discountPct > 100) {
        return bad("missing_field", "discount_pct (0–100) is required.");
      }
      event = { type: eventType, actor, discountPct };
      break;
    }
    case "DOCUSIGN_SENT": {
      const envelopeId = str(pick(body, "envelope_id", "envelopeId"));
      if (!envelopeId) return bad("missing_field", "envelope_id is required.");
      event = { type: eventType, actor, envelopeId };
      break;
    }
    case "DROPBOX_READY":
      event = {
        type: eventType,
        actor,
        fileRequestId: str(pick(body, "file_request_id", "fileRequestId")),
      };
      break;
    case "DOCS_UPDATED":
      event = {
        type: eventType,
        actor,
        docsRequired: num(pick(body, "docs_required", "docsRequired")) ?? -1,
        docsReceived: num(pick(body, "docs_received", "docsReceived")) ?? -1,
      };
      break;
    case "STALL_DETECTED":
      event = {
        type: eventType,
        actor,
        reason: str(pick(body, "reason")) ?? "manual",
      };
      break;
    case "CLIENT_ACTIVITY":
      event = {
        type: eventType,
        actor,
        activity: str(pick(body, "activity")) ?? "staff note",
      };
      break;
    case "MARK_CANCELED":
    case "MARK_LOST":
      event = { type: eventType, actor, reason: str(pick(body, "reason")) };
      break;
    default:
      event = { type: eventType, actor } as MachineEvent;
  }

  try {
    const result = await withTx(async (tx) => {
      // Recompute checklist counts when the caller didn't supply them.
      if (event.type === "DOCS_UPDATED" && (event.docsRequired < 0 || event.docsReceived < 0)) {
        const counts = await tx.query<{ required: number; received: number }>(
          `SELECT
             (SELECT count(*)::int FROM document_requirements r
               JOIN clients c ON c.id = $1
              WHERE r.required AND (r.engagement_type IS NULL OR r.engagement_type = c.engagement_type)
                AND (r.entity_type IS NULL OR r.entity_type = c.entity_type)) AS required,
             (SELECT count(*)::int FROM client_documents d
               WHERE d.client_id = $1 AND d.status = 'accepted') AS received`,
          [params.id],
        );
        event.docsRequired = counts.rows[0]?.required ?? 0;
        event.docsReceived = counts.rows[0]?.received ?? 0;
      }

      const applied = await applyClientTransitionTx(tx, {
        clientId: params.id,
        event,
        idempotencyKey,
        ip,
        requestId,
      });
      if (applied.deduped) return applied;

      // Event-specific side effects, same transaction.
      if (event.type === "INTAKE_WAIVED") {
        await tx.query(
          `INSERT INTO intake_waivers (client_id, waived_by, waiver_reason)
           VALUES ($1, $2, $3)`,
          [params.id, session.sub, event.reason],
        );
      }
      if (event.type === "SCOPE_CHANGED") {
        const version = applied.context.scopeVersion;
        const services = pick(body, "services");
        await tx.query(
          `INSERT INTO engagement_scopes
             (client_id, version, services, fee, discount_pct, status, created_by)
           VALUES ($1, $2, $3::jsonb, $4, $5, 'draft', $6)
           ON CONFLICT (client_id, version) DO NOTHING`,
          [
            params.id,
            version,
            JSON.stringify(
              typeof services === "string" ? { note: services } : (services ?? {}),
            ),
            num(pick(body, "fee")) ?? null,
            num(pick(body, "discount_pct", "discountPct")) ?? null,
            session.sub,
          ],
        );
        // Unsigned envelopes are voided; signed ones are superseded by amendment.
        if (applied.context.voidUnsignedEnvelope) {
          await tx.query(
            `UPDATE engagement_envelopes SET status = 'voided', updated_at = now()
              WHERE client_id = $1 AND status = 'sent' AND scope_version < $2`,
            [params.id, version],
          );
        }
        if (applied.context.supersedeSignedEnvelope) {
          await tx.query(
            `UPDATE engagement_envelopes SET status = 'superseded', updated_at = now()
              WHERE client_id = $1 AND status = 'signed' AND scope_version < $2`,
            [params.id, version],
          );
        }
      }
      if (event.type === "DOCUSIGN_SENT") {
        const scopeRow = await tx.query<{ id: string }>(
          `SELECT id FROM engagement_scopes
            WHERE client_id = $1 AND version = $2`,
          [params.id, applied.context.scopeVersion],
        );
        const superseded = await tx.query<{ id: string }>(
          `SELECT id FROM engagement_envelopes
            WHERE client_id = $1 AND status = 'superseded'
            ORDER BY created_at DESC LIMIT 1`,
          [params.id],
        );
        const policy = await tx.query<{ version: string }>(
          `SELECT version FROM onboarding_policies WHERE is_current = true`,
        );
        await tx.query(
          `INSERT INTO engagement_envelopes
             (client_id, scope_id, scope_version, policy_version,
              docusign_envelope_id, status, supersedes_envelope_id)
           VALUES ($1, $2, $3, $4, $5, 'sent', $6)
           ON CONFLICT (docusign_envelope_id) DO NOTHING`,
          [
            params.id,
            scopeRow.rows[0]?.id ?? null,
            applied.context.scopeVersion,
            policy.rows[0]?.version ?? applied.context.policyVersion,
            event.envelopeId,
            superseded.rows[0]?.id ?? null,
          ],
        );
      }
      if (event.type === "DOCUSIGN_SIGNED") {
        await appendAudit(tx, {
          actor: actor.id,
          actorType: actor.type,
          action: "docusign_combined_download_queued",
          entity: "client",
          entityId: params.id,
          before: null,
          after: {
            note: "documents/combined download to GCS is queued as a follow-up step",
          },
          ip,
          requestId,
        });
      }
      return applied;
    });

    return ok({
      client_id: result.clientId,
      from: result.from,
      state: result.state,
      steps: result.steps,
      deduped: result.deduped,
    });
  } catch (e) {
    const { code, message } = transitionErrorBody(e);
    return err(transitionErrorStatus(e), code, message);
  }
}
