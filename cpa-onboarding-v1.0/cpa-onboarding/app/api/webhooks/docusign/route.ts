/**
 * POST /api/webhooks/docusign — DocuSign Connect completion ingress.
 *
 * DEPLOYMENT NOTE (brief §2): in prod this route runs behind the SEPARATE
 * public webhook-ingress Cloud Run service (Pub/Sub publish only, no SQL).
 * That separation is enforced by infra, not by code here.
 *
 * - Verifies `X-DocuSign-Signature-1` = Base64(HMAC-SHA256(raw body, HMAC key))
 *   via the adapter's pure verifier. 401 on missing/invalid.
 * - Assumes the Connect configuration posts JSON (XML payloads are rejected
 *   with 400 — set "JSON" as the Connect message format). Envelope id and
 *   status are read defensively from several candidate paths.
 * - `completed` → DOCUSIGN_SIGNED (08→09) for the client owning the envelope;
 *   idempotent on `docusign:{envelopeId}:{status}`.
 * - `voided`/`declined` → audit entry only; staff handles the fallout.
 * - Nightly polling reconciliation is a separate job (not this route).
 * - 200 only after the transactional DB write commits.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { adapters } from "@/lib/integrations";
import { env } from "@/lib/env";
import { applyClientTransitionTx, webhookActor } from "@/lib/transitions";
import { TransitionNotAllowed } from "@/lib/machine";
import { err, getClientIp, getRequestId, ok, str } from "../../_helpers";

export const runtime = "nodejs";

/** Defensive extraction: Connect JSON nests the summary under data.envelopeSummary. */
function extractEnvelope(body: unknown): { envelopeId?: string; status?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = (b["data"] ?? {}) as Record<string, unknown>;
  const summary =
    ((data["envelopeSummary"] ?? b["envelopeSummary"] ?? {}) as Record<string, unknown>);
  const envelopeId =
    str(data["envelopeId"]) ?? str(b["envelopeId"]) ?? str(summary["envelopeId"]);
  const status =
    str(summary["status"]) ?? str(data["status"]) ?? str(b["status"]);
  return { envelopeId, status };
}

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("x-docusign-signature-1") ?? "";
  const adapter = adapters().docusign;

  if (!adapter.verifyConnectSignature(rawBody, signature, env.docusign.connectHmacKey)) {
    return err(401, "bad_signature", "Invalid DocuSign Connect signature.");
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return err(400, "bad_payload", "Connect payload must be JSON (set JSON message format).");
  }
  const { envelopeId, status } = extractEnvelope(body);
  if (!envelopeId || !status) {
    return err(400, "bad_payload", "Connect payload has no envelopeId/status.");
  }

  const normalized = status.toLowerCase();
  const deliveryId = `docusign:${envelopeId}:${normalized}`;
  const actor = webhookActor("docusign");
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result = await withTx(async (tx) => {
      const seen = await tx.query(
        `INSERT INTO webhook_deliveries (provider, delivery_id)
         VALUES ('docusign', $1)
         ON CONFLICT (provider, delivery_id) DO NOTHING`,
        [deliveryId],
      );
      if ((seen.rowCount ?? 0) === 0) {
        return { deduped: true as const };
      }

      const envRow = await tx.query<{ client_id: string; id: string }>(
        `SELECT client_id, id FROM engagement_envelopes
          WHERE docusign_envelope_id = $1`,
        [envelopeId],
      );
      const row = envRow.rows[0];
      if (!row) {
        await appendAudit(tx, {
          actor: actor.id,
          actorType: actor.type,
          action: "webhook:unknown_envelope",
          entity: "engagement_envelope",
          entityId: envelopeId,
          before: null,
          after: { status: normalized },
          ip,
          requestId,
        });
        return { deduped: false as const, unknown_envelope: true as const };
      }
      await tx.query(
        `UPDATE webhook_deliveries SET client_id = $1
          WHERE provider = 'docusign' AND delivery_id = $2`,
        [row.client_id, deliveryId],
      );

      if (["completed", "signed"].includes(normalized)) {
        try {
          const applied = await applyClientTransitionTx(tx, {
            clientId: row.client_id,
            event: { type: "DOCUSIGN_SIGNED", actor },
            idempotencyKey: deliveryId,
            ip,
            requestId,
          });
          await tx.query(
            `UPDATE engagement_envelopes SET status = 'signed', updated_at = now()
              WHERE id = $1`,
            [row.id],
          );
          await appendAudit(tx, {
            actor: actor.id,
            actorType: actor.type,
            action: "docusign_combined_download_queued",
            entity: "engagement_envelope",
            entityId: row.id,
            before: null,
            after: {
              note: "documents/combined download to GCS is queued as a follow-up step",
            },
            ip,
            requestId,
          });
          return { deduped: false as const, client_id: row.client_id, state: applied.state };
        } catch (e) {
          if (e instanceof TransitionNotAllowed) {
            return { deduped: false as const, client_id: row.client_id, already_signed: true as const };
          }
          throw e;
        }
      }

      if (["voided", "declined"].includes(normalized)) {
        await tx.query(
          `UPDATE engagement_envelopes SET status = $1, updated_at = now() WHERE id = $2`,
          [normalized === "voided" ? "voided" : "declined", row.id],
        );
        await appendAudit(tx, {
          actor: actor.id,
          actorType: actor.type,
          action: `webhook:envelope_${normalized}`,
          entity: "engagement_envelope",
          entityId: row.id,
          before: null,
          after: { note: "staff follow-up required" },
          ip,
          requestId,
        });
        return { deduped: false as const, client_id: row.client_id, status: normalized };
      }

      // Other statuses (sent, delivered, ...) — acknowledge, no state change.
      return { deduped: false as const, client_id: row.client_id, ignored_status: normalized };
    });

    return ok({ ok: true, ...result });
  } catch (e) {
    return err(500, "internal_error", (e as Error).message);
  }
}
