/**
 * /api/approvals — owner approval gates.
 *
 * GET: pending gates —
 *   - brief approvals: clients in `intake_received` (03→04 needs a named approver);
 *   - DocuSign-send approvals: clients in 05/06/07 whose recorded owner
 *     approval is missing or stale for the current scope version.
 * POST: { client_id, kind: "brief" | "docusign", decision: "approve" | "reject",
 *   note? } (form fields: client_id, kind, decision, note)
 *   - brief/approve  → BRIEF_APPROVED (machine transition, actor recorded).
 *   - brief/reject   → audit entry only; client stays in 03.
 *   - docusign/approve → records owner approval for the CURRENT scope version
 *     (named owner/CPA gate — owner role only per docs/role-matrix.md); the
 *     DOCUSIGN_SENT machine guard then passes.
 *   - docusign/reject → audit entry only; send stays blocked.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
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
} from "../_helpers";

const GATE_STATES = ["meeting_done", "discount_applied", "scope_changed"];

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const gates = await withTx(async (tx) => {
    const brief = await tx.query(
      `SELECT id, display_name, primary_email, current_state, updated_at
         FROM clients WHERE current_state = 'intake_received'
         ORDER BY updated_at DESC`,
    );
    const docusign = await tx.query(
      `SELECT id, display_name, primary_email, current_state, scope_version,
              owner_approval_scope_version, updated_at
         FROM clients
        WHERE current_state = ANY($1)
          AND (owner_approval_scope_version IS NULL
               OR owner_approval_scope_version <> scope_version)
        ORDER BY updated_at DESC`,
      [GATE_STATES],
    );
    return {
      brief_approvals: brief.rows,
      docusign_approvals: docusign.rows,
    };
  });
  return ok(gates);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const body = await readBody(req);
  const clientId = str(pick(body, "client_id", "clientId"));
  // `kind` may arrive as `action` from plain HTML forms.
  const kind = str(pick(body, "kind", "action"));
  const decision = str(pick(body, "decision"));
  const note = str(pick(body, "note"));

  if (!clientId) return err(400, "missing_field", "client_id is required.");
  if (kind !== "brief" && kind !== "docusign") {
    return err(400, "bad_kind", "kind must be 'brief' or 'docusign'.");
  }
  if (decision !== "approve" && decision !== "reject") {
    return err(400, "bad_decision", "decision must be 'approve' or 'reject'.");
  }
  // Named owner/CPA gate: the DocuSign-send approval cannot be delegated
  // below owner (docs/role-matrix.md recommended default).
  if (kind === "docusign" && session.role !== "owner") {
    return err(403, "forbidden", "Only the owner/CPA can approve a DocuSign send.");
  }

  const actor = userActor(session.sub, session.role);
  const idempotencyKey = getIdempotencyKey(req, body);
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result = await withTx(async (tx) => {
      const c = await tx.query<{
        id: string;
        current_state: string;
        scope_version: number;
        owner_approval_scope_version: number | null;
      }>(
        `SELECT id, current_state, scope_version, owner_approval_scope_version
           FROM clients WHERE id = $1 FOR UPDATE`,
        [clientId],
      );
      const client = c.rows[0];
      if (!client) return err(404, "not_found", `Client not found: ${clientId}`);

      if (kind === "brief") {
        if (decision === "approve") {
          const applied = await applyClientTransitionTx(tx, {
            clientId,
            event: { type: "BRIEF_APPROVED", actor },
            idempotencyKey,
            ip,
            requestId,
            auditAction: "approval:brief_approved",
          });
          return ok({
            client_id: clientId,
            state: applied.state,
            steps: applied.steps,
            deduped: applied.deduped,
          });
        }
        await appendAudit(tx, {
          actor: actor.id,
          actorType: actor.type,
          action: "approval:brief_rejected",
          entity: "client",
          entityId: clientId,
          before: { state: client.current_state },
          after: { state: client.current_state, note },
          ip,
          requestId,
        });
        return ok({ client_id: clientId, state: client.current_state, rejected: true });
      }

      // kind === "docusign"
      if (decision === "approve") {
        await tx.query(
          `UPDATE clients SET owner_approval_scope_version = scope_version,
                              updated_at = now()
            WHERE id = $1`,
          [clientId],
        );
        await appendAudit(tx, {
          actor: actor.id,
          actorType: actor.type,
          action: "approval:docusign_approved",
          entity: "client",
          entityId: clientId,
          before: { owner_approval_scope_version: client.owner_approval_scope_version },
          after: {
            owner_approval_scope_version: client.scope_version,
            scope_version: client.scope_version,
            note,
          },
          ip,
          requestId,
        });
        return ok({
          client_id: clientId,
          approved_scope_version: client.scope_version,
        });
      }
      await appendAudit(tx, {
        actor: actor.id,
        actorType: actor.type,
        action: "approval:docusign_rejected",
        entity: "client",
        entityId: clientId,
        before: { owner_approval_scope_version: client.owner_approval_scope_version },
        after: { owner_approval_scope_version: client.owner_approval_scope_version, note },
        ip,
        requestId,
      });
      return ok({ client_id: clientId, rejected: true });
    });
    return result;
  } catch (e) {
    const { code, message } = transitionErrorBody(e);
    return err(transitionErrorStatus(e), code, message);
  }
}
