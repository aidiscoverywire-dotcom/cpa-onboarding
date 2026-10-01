/**
 * POST /api/webhooks/calendly — Calendly webhook ingress.
 *
 * DEPLOYMENT NOTE (brief §2): in prod this route runs behind the SEPARATE
 * public webhook-ingress Cloud Run service, whose service account can only
 * publish to a bounded Pub/Sub topic — it NEVER gets SQL or vendor
 * credentials. That separation is enforced by infra (Terraform), not by code
 * here; the staff service (behind IAP) is the only runtime with SQL access.
 *
 * - Verifies `Calendly-Webhook-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256
 *   (`{ts}.{raw_body}`) against the RAW bytes, via the adapter's pure
 *   verifier (real logic in both mock and live modes). Rejects timestamps
 *   older than ~180s. 401 on missing/invalid.
 * - Idempotency on the invitee URI (+ event kind): `webhook_deliveries`.
 * - `invitee.created` → create client (or re-book a terminal one; reschedule
 *   pairs link via old_invitee/new_invitee) and re-run intake matching.
 * - `invitee.canceled` / `no_show` → MARK_CANCELED / MARK_NO_SHOW, so
 *   prospects never get stuck in 02 or Stalled.
 * - 200 only after the transactional DB write commits.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { adapters } from "@/lib/integrations";
import { env } from "@/lib/env";
import {
  applyClientTransitionTx,
  webhookActor,
  type ApplyTransitionResult,
} from "@/lib/transitions";
import { TransitionNotAllowed } from "@/lib/machine";
import {
  err,
  getClientIp,
  getRequestId,
  ok,
} from "../../_helpers";

export const runtime = "nodejs";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("calendly-webhook-signature") ?? "";
  const adapter = adapters().calendly;

  if (!adapter.verifySignature(rawBody, signature, env.calendlySigningKey)) {
    return err(401, "bad_signature", "Invalid Calendly webhook signature.");
  }

  let parsed: ReturnType<typeof adapter.parseEvent>;
  try {
    parsed = adapter.parseEvent(JSON.parse(rawBody.toString("utf8")));
  } catch (e) {
    return err(400, "bad_payload", `Unparseable Calendly event: ${(e as Error).message}`);
  }

  const deliveryId = `${parsed.kind}:${parsed.inviteeUri}`;
  const actor = webhookActor("calendly");
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result = await withTx(async (tx) => {
      // Idempotent ingress: duplicate deliveries are acknowledged, not reprocessed.
      const seen = await tx.query(
        `INSERT INTO webhook_deliveries (provider, delivery_id)
         VALUES ('calendly', $1)
         ON CONFLICT (provider, delivery_id) DO NOTHING`,
        [deliveryId],
      );
      if ((seen.rowCount ?? 0) === 0) {
        return { deduped: true as const };
      }

      const email = normalizeEmail(parsed.email);

      if (parsed.kind === "created") {
        // Reschedule pair? The created half carries the old invitee URI.
        const lookupUri = parsed.newInviteeUri ? parsed.oldInviteeUri! : parsed.inviteeUri;
        const existing = await tx.query<{ id: string; current_state: string }>(
          `SELECT id, current_state FROM clients WHERE calendly_invitee_uri = $1`,
          [lookupUri],
        );
        if (existing.rows[0]) {
          const client = existing.rows[0];
          await tx.query(
            `UPDATE clients SET calendly_invitee_uri = $1, updated_at = now() WHERE id = $2`,
            [parsed.inviteeUri, client.id],
          );
          // Re-booking after a terminal disposition re-enters the pipeline.
          if (["canceled", "no_show", "lost"].includes(client.current_state)) {
            const applied: ApplyTransitionResult = await applyClientTransitionTx(tx, {
              clientId: client.id,
              event: { type: "BOOKING_CREATED", actor },
              idempotencyKey: `calendly:${deliveryId}`,
              ip,
              requestId,
            });
            await tx.query(
              `UPDATE webhook_deliveries SET client_id = $1 WHERE provider = 'calendly' AND delivery_id = $2`,
              [client.id, deliveryId],
            );
            return { deduped: false as const, clientId: client.id, rebooked: true, state: applied.state };
          }
          return { deduped: false as const, clientId: client.id, rebooked: false };
        }

        // New prospect.
        const created = await tx.query<{ id: string }>(
          `INSERT INTO clients (display_name, primary_email, calendly_invitee_uri, current_state)
           VALUES ($1, $2, $3, 'booked') RETURNING id`,
          [parsed.name || parsed.email, email || null, parsed.inviteeUri],
        );
        const clientId = created.rows[0].id as string;

        // Intake submitted BEFORE booking? Re-run matching on invitee.created.
        const pending = email
          ? await tx.query<{ id: string }>(
              `SELECT id FROM intake_submissions
                WHERE status = 'pending' AND email_normalized = $1
               ORDER BY received_at DESC LIMIT 2`,
              [email],
            )
          : { rows: [] as { id: string }[] };

        if (pending.rows.length === 1) {
          const submissionId = pending.rows[0].id;
          await tx.query(
            `UPDATE intake_submissions SET matched_client_id = $1, status = 'matched'
              WHERE id = $2`,
            [clientId, submissionId],
          );
          // booked → intake_missing → intake_received in one transaction.
          await applyClientTransitionTx(tx, {
            clientId,
            event: { type: "INTAKE_REQUESTED", actor },
            idempotencyKey: `calendly:${deliveryId}:await`,
            ip,
            requestId,
          });
          const applied = await applyClientTransitionTx(tx, {
            clientId,
            event: { type: "INTAKE_MATCHED", actor, submissionId },
            idempotencyKey: `calendly:${deliveryId}:match`,
            ip,
            requestId,
          });
          await appendAudit(tx, {
            actor: actor.id,
            actorType: actor.type,
            action: "webhook:intake_prematch",
            entity: "client",
            entityId: clientId,
            before: null,
            after: { submissionId },
            ip,
            requestId,
          });
          await tx.query(
            `UPDATE webhook_deliveries SET client_id = $1 WHERE provider = 'calendly' AND delivery_id = $2`,
            [clientId, deliveryId],
          );
          return { deduped: false as const, clientId, state: applied.state, prematched: true };
        }

        await applyClientTransitionTx(tx, {
          clientId,
          event: { type: "INTAKE_REQUESTED", actor },
          idempotencyKey: `calendly:${deliveryId}:await`,
          ip,
          requestId,
        });
        await tx.query(
          `UPDATE webhook_deliveries SET client_id = $1 WHERE provider = 'calendly' AND delivery_id = $2`,
          [clientId, deliveryId],
        );
        return { deduped: false as const, clientId, state: "intake_missing" as const };
      }

      // canceled / no_show → terminal dispositions (never stuck in 02/Stalled).
      const target = await tx.query<{ id: string; current_state: string }>(
        `SELECT id, current_state FROM clients WHERE calendly_invitee_uri = $1`,
        [parsed.kind === "canceled" && parsed.oldInviteeUri ? parsed.oldInviteeUri : parsed.inviteeUri],
      );
      const client = target.rows[0];
      if (!client) {
        return { deduped: false as const, unknown_invitee: true as const };
      }
      // Reschedule pair: the canceled half only retires the old booking; the
      // created half (with new_invitee) arrives separately and re-books.
      const event =
        parsed.kind === "canceled"
          ? ({ type: "MARK_CANCELED", actor, reason: "Calendly invitee.canceled" } as const)
          : ({ type: "MARK_NO_SHOW", actor } as const);
      try {
        const applied = await applyClientTransitionTx(tx, {
          clientId: client.id,
          event,
          idempotencyKey: `calendly:${deliveryId}`,
          ip,
          requestId,
        });
        await tx.query(
          `UPDATE webhook_deliveries SET client_id = $1 WHERE provider = 'calendly' AND delivery_id = $2`,
          [client.id, deliveryId],
        );
        return { deduped: false as const, clientId: client.id, state: applied.state };
      } catch (e) {
        if (e instanceof TransitionNotAllowed) {
          // Already terminal (e.g. canceled twice) — acknowledge idempotently.
          return { deduped: false as const, clientId: client.id, already_terminal: true as const };
        }
        throw e;
      }
    });

    return ok({ ok: true, ...result });
  } catch (e) {
    return err(500, "internal_error", (e as Error).message);
  }
}
