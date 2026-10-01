/**
 * POST /api/webhooks/typeform — Typeform intake-submission ingress.
 *
 * DEPLOYMENT NOTE (brief §2): in prod this route runs behind the SEPARATE
 * public webhook-ingress Cloud Run service (Pub/Sub publish only, no SQL).
 * That separation is enforced by infra, not by code here.
 *
 * - Verifies `Typeform-Signature` = `sha256=` + Base64(HMAC-SHA256(raw bytes,
 *   secret)) with constant-time compare, via the adapter's pure verifier.
 *   401 on missing/invalid.
 * - Idempotency by submission id (unique constraint); replay defense via the
 *   stored raw-body checksum (same id + different body → 409).
 * - Match by normalized email to a booking in `intake_missing` (or stalled
 *   with resumeState `intake_missing` — the machine auto-resumes, both steps
 *   recorded). No-match/multi-match → staff review queue (`needs_review`).
 * - 200 only after the transactional DB write commits.
 */
import { NextRequest } from "next/server";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { adapters } from "@/lib/integrations";
import { env } from "@/lib/env";
import { applyClientTransitionTx, webhookActor } from "@/lib/transitions";
import { TransitionNotAllowed } from "@/lib/machine";
import { checksumRaw } from "../../_helpers";
import { err, getClientIp, getRequestId, ok } from "../../_helpers";

export const runtime = "nodejs";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type TypeformResult =
  | { deduped: true; conflict: "checksum_mismatch" }
  | { deduped: true; submission_id: string; status: string }
  | {
      deduped: false;
      submission_id: string;
      matched_client: string;
      state: string;
      steps: { from: string; to: string; event: string }[];
    }
  | { deduped: false; submission_id: string; queued: true; candidates?: number };

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("typeform-signature") ?? "";
  const adapter = adapters().typeform;

  if (!adapter.verifySignature(rawBody, signature, env.typeformSecret)) {
    return err(401, "bad_signature", "Invalid Typeform signature.");
  }

  let submission: ReturnType<typeof adapter.parseSubmission>;
  try {
    submission = adapter.parseSubmission(JSON.parse(rawBody.toString("utf8")));
  } catch (e) {
    return err(400, "bad_payload", `Unparseable Typeform payload: ${(e as Error).message}`);
  }

  const checksum = checksumRaw(rawBody);
  const email = normalizeEmail(submission.email);
  const actor = webhookActor("typeform");
  const requestId = getRequestId(req);
  const ip = getClientIp(req);

  try {
    const result: TypeformResult = await withTx(async (tx) => {
      // Idempotent store; replay defense on the raw-body checksum.
      const inserted = await tx.query<{ id: string; raw_body_checksum: string }>(
        `INSERT INTO intake_submissions
           (typeform_submission_id, raw_body_checksum, email_normalized, answers)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (typeform_submission_id) DO NOTHING
         RETURNING id, raw_body_checksum`,
        [
          submission.submissionId,
          checksum,
          email || null,
          JSON.stringify(submission.answers ?? {}),
        ],
      );
      let submissionId = inserted.rows[0]?.id;
      if (!submissionId) {
        const existing = await tx.query<{
          id: string;
          raw_body_checksum: string;
          status: string;
        }>(
          `SELECT id, raw_body_checksum, status FROM intake_submissions
            WHERE typeform_submission_id = $1`,
          [submission.submissionId],
        );
        const row = existing.rows[0];
        if (!row) throw new Error("Submission conflict with no visible row");
        if (row.raw_body_checksum !== checksum) {
          // Same submission id, different body: possible replay attack.
          await appendAudit(tx, {
            actor: actor.id,
            actorType: actor.type,
            action: "webhook:replay_rejected",
            entity: "intake_submission",
            entityId: row.id,
            before: { checksum: row.raw_body_checksum },
            after: { checksum },
            ip,
            requestId,
          });
          return { deduped: true, conflict: "checksum_mismatch" } as TypeformResult;
        }
        return { deduped: true, submission_id: row.id, status: row.status } as TypeformResult;
      }

      // Match by normalized email to a booking awaiting intake.
      const candidates = email
        ? await tx.query<{ id: string; current_state: string; resume_state: string | null }>(
            `SELECT id, current_state, resume_state FROM clients
              WHERE lower(primary_email) = $1
                AND ((current_state = 'intake_missing')
                     OR (current_state = 'stalled' AND resume_state = 'intake_missing'))`,
            [email],
          )
        : { rows: [] as { id: string; current_state: string; resume_state: string | null }[] };

      if (candidates.rows.length === 1) {
        const client = candidates.rows[0];
        try {
          const applied = await applyClientTransitionTx(tx, {
            clientId: client.id,
            event: { type: "INTAKE_MATCHED", actor, submissionId },
            idempotencyKey: `typeform:${submission.submissionId}`,
            ip,
            requestId,
          });
          await tx.query(
            `UPDATE intake_submissions SET matched_client_id = $1, status = 'matched'
              WHERE id = $2`,
            [client.id, submissionId],
          );
          return {
            deduped: false,
            submission_id: submissionId,
            matched_client: client.id,
            state: applied.state,
            steps: applied.steps,
          } as TypeformResult;
        } catch (e) {
          if (e instanceof TransitionNotAllowed) {
            await tx.query(
              `UPDATE intake_submissions SET status = 'needs_review' WHERE id = $1`,
              [submissionId],
            );
            return { deduped: false, submission_id: submissionId, queued: true } as TypeformResult;
          }
          throw e;
        }
      }

      // No match or ambiguous → staff review queue.
      await tx.query(
        `UPDATE intake_submissions SET status = 'needs_review' WHERE id = $1`,
        [submissionId],
      );
      await appendAudit(tx, {
        actor: actor.id,
        actorType: actor.type,
        action: "webhook:intake_needs_review",
        entity: "intake_submission",
        entityId: submissionId,
        before: null,
        after: { candidates: candidates.rows.length },
        ip,
        requestId,
      });
      return {
        deduped: false,
        submission_id: submissionId,
        queued: true,
        candidates: candidates.rows.length,
      } as TypeformResult;
    });

    if ("conflict" in result && result.conflict === "checksum_mismatch") {
      return err(409, "replay_rejected", "Submission id already seen with a different body.");
    }
    return ok({ ok: true, ...result });
  } catch (e) {
    return err(500, "internal_error", (e as Error).message);
  }
}
