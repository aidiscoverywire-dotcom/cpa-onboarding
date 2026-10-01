/**
 * /api/documents — expected-document checklist + manual acceptance.
 *
 * GET ?client_id= — checklist: document_requirements for the client's
 * engagement/entity type (plus global rows) LEFT JOINed with the client's
 * documents, and an owner-facing "what's missing" summary.
 * POST — accept a document (Phase 1 = MANUAL acceptance, stated explicitly;
 * acceptance is a human decision): upserts the client_documents row as
 * `accepted`, recomputes checklist counts, and fires DOCS_UPDATED so the
 * machine auto-derives docs_partial / docs_complete. One transaction.
 *
 * Body: { client_id, requirement_id?, file_name, dropbox_path?,
 *   idempotency_key? } (form fields: client_id, requirement_id, file_name,
 *   dropbox_path, idempotency_key)
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
} from "../_helpers";

const STAFF_ROLES = ["owner", "admin", "partner", "staff"] as const;

function guard(session: { role: string } | null) {
  if (!session) return err(401, "unauthenticated", "Sign in required.");
  if (!(STAFF_ROLES as readonly string[]).includes(session.role)) {
    return err(403, "forbidden", `Role '${session.role}' cannot manage documents.`);
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  const denied = guard(session);
  if (denied) return denied;

  const clientId = new URL(req.url).searchParams.get("client_id");
  if (!clientId) return err(400, "missing_field", "client_id query param is required.");

  const checklist = await withTx(async (tx) => {
    const c = await tx.query(
      `SELECT id, display_name, engagement_type, entity_type, docs_required, docs_received
         FROM clients WHERE id = $1`,
      [clientId],
    );
    const client = c.rows[0];
    if (!client) return null;
    const { rows } = await tx.query(
      `SELECT r.id AS requirement_id, r.doc_key, r.label, r.required,
              d.id AS document_id, d.file_name, d.status, d.received_at,
              d.accepted_at, d.accepted_by
         FROM document_requirements r
         LEFT JOIN client_documents d
           ON d.requirement_id = r.id AND d.client_id = $1
        WHERE (r.engagement_type IS NULL OR r.engagement_type = $2)
          AND (r.entity_type IS NULL OR r.entity_type = $3)
        ORDER BY r.required DESC, r.label`,
      [clientId, client.engagement_type, client.entity_type],
    );
    const missing = rows.filter(
      (r) => r.required && r.status !== "accepted",
    );
    return { client, checklist: rows, missing };
  });
  if (!checklist) return err(404, "not_found", `Client not found: ${clientId}`);
  return ok(checklist);
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  const denied = guard(session);
  if (denied) return denied;

  const body = await readBody(req);
  const clientId = str(pick(body, "client_id", "clientId"));
  const requirementId = str(pick(body, "requirement_id", "requirementId"));
  const fileName = str(pick(body, "file_name", "fileName"));
  const dropboxPath = str(pick(body, "dropbox_path", "dropboxPath"));
  if (!clientId) return err(400, "missing_field", "client_id is required.");
  if (!fileName) return err(400, "missing_field", "file_name is required.");

  const actor = userActor(session!.sub, session!.role);
  const idempotencyKey = getIdempotencyKey(req, body);
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result = await withTx(async (tx) => {
      const c = await tx.query<{ id: string }>(
        `SELECT id FROM clients WHERE id = $1 FOR UPDATE`,
        [clientId],
      );
      if (!c.rows[0]) return err(404, "not_found", `Client not found: ${clientId}`);

      // Manual acceptance: upsert the document as accepted by this staff user.
      await tx.query(
        `INSERT INTO client_documents
           (client_id, requirement_id, file_name, dropbox_path, status,
            received_at, accepted_at, accepted_by)
         VALUES ($1, $2, $3, $4, 'accepted', now(), now(), $5)
         ON CONFLICT (id) DO NOTHING`,
        [clientId, requirementId ?? null, fileName, dropboxPath ?? null, session!.sub],
      );
      // If a row for this requirement already exists, mark it accepted.
      if (requirementId) {
        await tx.query(
          `UPDATE client_documents
              SET status = 'accepted', file_name = COALESCE($3, file_name),
                  dropbox_path = COALESCE($4, dropbox_path),
                  accepted_at = now(), accepted_by = $5
            WHERE client_id = $1 AND requirement_id = $2`,
          [clientId, requirementId, fileName, dropboxPath ?? null, session!.sub],
        );
      }

      const counts = await tx.query<{ required: number; received: number }>(
        `SELECT
           (SELECT count(*)::int FROM document_requirements r
             JOIN clients c ON c.id = $1
            WHERE r.required AND (r.engagement_type IS NULL OR r.engagement_type = c.engagement_type)
              AND (r.entity_type IS NULL OR r.entity_type = c.entity_type)) AS required,
           (SELECT count(*)::int FROM client_documents d
             WHERE d.client_id = $1 AND d.status = 'accepted') AS received`,
        [clientId],
      );
      const docsRequired = counts.rows[0]?.required ?? 0;
      const docsReceived = counts.rows[0]?.received ?? 0;

      const applied = await applyClientTransitionTx(tx, {
        clientId,
        event: { type: "DOCS_UPDATED", actor, docsRequired, docsReceived },
        idempotencyKey,
        ip,
        requestId,
        auditAction: "document_accepted",
      });
      return ok({
        client_id: clientId,
        state: applied.state,
        steps: applied.steps,
        deduped: applied.deduped,
        docs_required: docsRequired,
        docs_received: docsReceived,
      });
    });
    return result;
  } catch (e) {
    const { code, message } = transitionErrorBody(e);
    return err(transitionErrorStatus(e), code, message);
  }
}
