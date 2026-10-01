import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntakeSubmission, TypeformAdapter } from "./types";
import { env } from "../env";

/**
 * Verify a Typeform webhook signature against raw request bytes.
 *
 * Header format: `sha256=` + Base64(HMAC-SHA256(rawBody, secret)).
 * Constant-time compare; returns false (never throws) on missing/invalid header.
 */
export function verifyTypeformSignature(
  rawBody: Buffer,
  header: string,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length).trim(), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(rawBody).digest("base64"),
    "utf8",
  );
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

type RawAnswer = {
  field?: { id?: unknown; title?: unknown; ref?: unknown };
  type?: unknown;
  text?: unknown;
  email?: unknown;
  url?: unknown;
  number?: unknown;
  boolean?: unknown;
  date?: unknown;
  choice?: { label?: unknown };
  choices?: { labels?: unknown };
};

type RawFormResponse = {
  form_response?: {
    token?: unknown;
    submitted_at?: unknown;
    definition?: { fields?: Array<{ id?: unknown; title?: unknown }> };
    answers?: RawAnswer[];
  };
};

function answerToString(a: RawAnswer): string {
  if (typeof a.text === "string") return a.text;
  if (typeof a.email === "string") return a.email;
  if (typeof a.url === "string") return a.url;
  if (typeof a.date === "string") return a.date;
  if (typeof a.number === "number") return String(a.number);
  if (typeof a.boolean === "boolean") return String(a.boolean);
  if (typeof a.choice?.label === "string") return a.choice.label;
  if (Array.isArray(a.choices?.labels)) return a.choices.labels.map(String).join(", ");
  return "";
}

/**
 * Parse a verified Typeform webhook envelope into an IntakeSubmission.
 * Answers are keyed by question title; the email answer is picked from the
 * first `email`-type answer (falling back to any question titled like email).
 */
export function parseTypeformSubmission(body: unknown): IntakeSubmission {
  const env2 = (body ?? {}) as RawFormResponse;
  const fr = env2.form_response ?? {};
  const submissionId = typeof fr.token === "string" && fr.token ? fr.token : "";
  if (!submissionId) throw new Error("TypeformAdapter: missing form_response.token");
  const submittedAt = typeof fr.submitted_at === "string" && fr.submitted_at ? fr.submitted_at : "";
  if (!submittedAt) throw new Error("TypeformAdapter: missing form_response.submitted_at");

  const titleById = new Map<string, string>();
  for (const f of fr.definition?.fields ?? []) {
    if (typeof f.id === "string" && typeof f.title === "string") titleById.set(f.id, f.title);
  }

  const answers: Record<string, string> = {};
  let email = "";
  for (const a of fr.answers ?? []) {
    const fieldId = typeof a.field?.id === "string" ? a.field.id : "";
    const title =
      (typeof a.field?.title === "string" && a.field.title) ||
      titleById.get(fieldId) ||
      fieldId ||
      "answer";
    const value = answerToString(a);
    answers[title] = value;
    if (a.type === "email" && typeof a.email === "string" && !email) email = a.email;
    if (!email && /e-?mail/i.test(title) && value.includes("@")) email = value;
  }
  if (!email) throw new Error("TypeformAdapter: no email answer found in submission");
  return { submissionId, email, answers, submittedAt };
}

/**
 * Idempotency helper for Typeform intake: rejects duplicate (replayed)
 * submission ids within the process. Persistent enforcement belongs in the
 * receiver (unique constraint on submission id + stored raw-body checksum);
 * this helper is the in-memory second line for the single-process path and is
 * what unit tests exercise.
 */
export function createSubmissionDedupe(): { alreadySeen(submissionId: string): boolean } {
  const seen = new Set<string>();
  return {
    alreadySeen(submissionId: string): boolean {
      if (seen.has(submissionId)) return true;
      seen.add(submissionId);
      return false;
    },
  };
}

/**
 * Real Typeform adapter. Verification and parsing are pure (safe in tests and
 * the public webhook ingress); Typeform pushes submissions to us — no
 * outbound API calls are needed for intake.
 */
export class RealTypeformAdapter implements TypeformAdapter {
  constructor(private readonly secret: string = env.typeformSecret) {}

  verifySignature(rawBody: Buffer, header: string, secret: string): boolean {
    return verifyTypeformSignature(rawBody, header, secret || this.secret);
  }

  parseSubmission(body: unknown): IntakeSubmission {
    return parseTypeformSubmission(body);
  }
}
