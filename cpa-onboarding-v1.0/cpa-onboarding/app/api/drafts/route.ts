/**
 * POST /api/drafts — create a Gmail DRAFT for staff to send manually.
 * Body: { client_id, kind: "pre_meeting" | "follow_up", idempotency_key? }
 * (form fields: client_id, kind, idempotency_key)
 *
 * CREATE-ONLY by design: the Gmail adapter interface deliberately exposes no
 * send method (`gmail.users.drafts.send` / `messages.send` must NEVER be
 * called from automation — brief §1/§5). Every client-facing email leaves
 * this system as a draft a staff member explicitly sends from Gmail.
 *
 * Durability: one `external_action` + one outbox step (`CREATE_GMAIL_DRAFT`),
 * each with its own idempotency key. The step is marked done/failed after
 * the adapter call; a failed step can be retried by re-POSTing the same
 * idempotency key.
 *
 * HONESTY: per-user Gmail OAuth token storage is not implemented yet, so in
 * live mode (`INTEGRATIONS_LIVE=true`) without a caller-supplied token the
 * draft is QUEUED as pending (202) rather than faked. In dev the mock adapter
 * runs and the recorded draft id is tagged `adapter: "mock"`.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { adapters } from "@/lib/integrations";
import { env } from "@/lib/env";
import { createExternalActionWithSteps } from "@/lib/transitions";
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
} from "../_helpers";

const STAFF_ROLES = ["owner", "admin", "partner", "staff"] as const;

function draftTemplate(
  kind: "pre_meeting" | "follow_up",
  clientName: string,
): { subject: string; html: string } {
  const name = clientName || "there";
  if (kind === "pre_meeting") {
    return {
      subject: "Before our meeting — a quick checklist",
      html: `<p>Hi ${name},</p><p>Looking forward to our meeting. If you have them handy, please bring a photo ID and last year's tax return — anything missing can follow afterwards.</p><p>Best regards</p>`,
    };
  }
  return {
    subject: "Following up on your onboarding",
    html: `<p>Hi ${name},</p><p>Just following up on the documents we discussed. Reply to this email if anything is unclear.</p><p>Best regards</p>`,
  };
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");
  if (!(STAFF_ROLES as readonly string[]).includes(session.role)) {
    return err(403, "forbidden", `Role '${session.role}' cannot create drafts.`);
  }

  const body = await readBody(req);
  const clientId = str(pick(body, "client_id", "clientId"));
  const kind = str(pick(body, "kind"));
  if (!clientId) return err(400, "missing_field", "client_id is required.");
  if (kind !== "pre_meeting" && kind !== "follow_up") {
    return err(400, "bad_kind", "kind must be 'pre_meeting' or 'follow_up'.");
  }

  const idempotencyKey = getIdempotencyKey(req, body);
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  const client = await withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; display_name: string; primary_email: string | null }>(
      `SELECT id, display_name, primary_email FROM clients WHERE id = $1`,
      [clientId],
    );
    return rows[0] ?? null;
  });
  if (!client) return err(404, "not_found", `Client not found: ${clientId}`);
  if (!client.primary_email) {
    return err(400, "no_email", "Client has no primary email address.");
  }

  // 1. Durable action + outbox step.
  const created = await withTx((tx) =>
    createExternalActionWithSteps(tx, {
      clientId,
      actionType: "gmail_draft",
      idempotencyKey,
      payload: { kind, to: client.primary_email, actor: session.sub, ip, requestId },
      steps: [{ stepType: "CREATE_GMAIL_DRAFT", idempotencyKey: `${idempotencyKey}:create` }],
    }),
  );
  if (created.deduped) {
    return ok({ status: "already_exists", action_id: created.actionId });
  }

  // 2. Attempt the adapter. Live mode without a per-user token queues.
  if (env.integrationsLive) {
    // No per-user Gmail OAuth token storage exists yet — never fake a draft.
    await withTx((tx) =>
      tx.query(
        `UPDATE outbox_steps SET status = 'pending', last_error = $1, updated_at = now()
          WHERE id = $2`,
        ["queued: no per-user Gmail OAuth token available", created.stepIds[0]],
      ),
    );
    return ok(
      {
        status: "queued",
        action_id: created.actionId,
        reason: "INTEGRATIONS_LIVE=true but no per-user Gmail OAuth token is stored yet; draft step is pending.",
      },
      202,
    );
  }

  const { subject, html } = draftTemplate(kind, client.display_name);
  try {
    const { draftId } = await adapters().gmail.createDraft({
      to: client.primary_email,
      subject,
      html,
    });
    await withTx((tx) =>
      tx.query(
        `UPDATE outbox_steps SET status = 'done', last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [created.stepIds[0]],
      ),
    );
    await withTx((tx) =>
      tx.query(
        `UPDATE external_actions SET status = 'done', payload = payload || $1::jsonb, updated_at = now()
          WHERE id = $2`,
        [JSON.stringify({ draftId, adapter: "mock" }), created.actionId],
      ),
    );
    return ok({ status: "draft_created", action_id: created.actionId, draft_id: draftId, adapter: "mock" });
  } catch (e) {
    await withTx((tx) =>
      tx.query(
        `UPDATE outbox_steps SET status = 'failed', last_error = $1, updated_at = now()
          WHERE id = $2`,
        [(e as Error).message, created.stepIds[0]],
      ),
    );
    return err(502, "draft_failed", `Gmail draft failed: ${(e as Error).message}`);
  }
}
