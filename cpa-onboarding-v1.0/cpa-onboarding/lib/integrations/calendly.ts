import { createHmac, timingSafeEqual } from "node:crypto";
import type { CalendlyAdapter, CalendlyEvent } from "./types";
import { env } from "../env";

/** Timestamp tolerance in seconds for Calendly webhook signatures. */
export const CALENDLY_SIGNATURE_TOLERANCE_S = 180;

/**
 * Verify a Calendly webhook signature against raw request bytes.
 *
 * Header format: `t=<unix_timestamp>,v1=<hex_hmac>`.
 * Expected signature: hex(HMAC-SHA256(`${ts}.${rawBody}`, signingKey)).
 * Timestamps older than 180s are rejected (replay defense).
 */
export function verifyCalendlySignature(
  rawBody: Buffer,
  header: string,
  key: string,
): boolean {
  if (!header || !key) return false;
  const parts: Record<string, string> = {};
  for (const pair of header.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const ts = parts["t"];
  const sig = parts["v1"];
  if (!ts || !sig) return false;
  if (!/^\d+$/.test(ts)) return false;
  const ageS = Math.abs(Date.now() / 1000 - Number(ts));
  if (ageS > CALENDLY_SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", key)
    .update(`${ts}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type RawCalendlyEnvelope = {
  event?: unknown;
  payload?: {
    uri?: unknown;
    email?: unknown;
    name?: unknown;
    rescheduled?: unknown;
    old_invitee?: unknown;
    new_invitee?: unknown;
    event?: { uri?: unknown; start_time?: unknown; end_time?: unknown };
    event_type?: { uri?: unknown };
  };
};

const KIND_BY_EVENT: Record<string, CalendlyEvent["kind"]> = {
  "invitee.created": "created",
  "invitee.canceled": "canceled",
  "invitee.no_show": "no_show",
};

/** Parse a verified Calendly webhook envelope. Throws on unknown event types (receiver answers 200 + logs). */
export function parseCalendlyEvent(body: unknown): CalendlyEvent {
  const env2 = (body ?? {}) as RawCalendlyEnvelope;
  const kind = KIND_BY_EVENT[String(env2.event ?? "")];
  if (!kind) throw new Error(`CalendlyAdapter: unknown event type "${String(env2.event ?? "")}"`);
  const p = env2.payload ?? {};
  const str = (v: unknown, field: string): string => {
    if (typeof v !== "string" || v.length === 0)
      throw new Error(`CalendlyAdapter: missing/invalid payload field "${field}"`);
    return v;
  };
  const inviteeUri = str(p.uri, "payload.uri");
  const email = str(p.email, "payload.email");
  const name = str(p.name, "payload.name");
  const eventStart = str(p.event?.start_time, "payload.event.start_time");
  const eventEnd = str(p.event?.end_time, "payload.event.end_time");
  const eventTypeUri = str(p.event_type?.uri, "payload.event_type.uri");
  const out: CalendlyEvent = {
    inviteeUri,
    email,
    name,
    eventStart,
    eventEnd,
    eventTypeUri,
    kind,
    rescheduled: p.rescheduled === true,
  };
  if (typeof p.old_invitee === "string" && p.old_invitee) out.oldInviteeUri = p.old_invitee;
  if (typeof p.new_invitee === "string" && p.new_invitee) out.newInviteeUri = p.new_invitee;
  return out;
}

/**
 * Real Calendly adapter. Signature verification and event parsing are pure
 * (safe in tests and in the public webhook ingress); there are no other
 * Calendly API calls needed — booking data arrives via webhooks only.
 */
export class RealCalendlyAdapter implements CalendlyAdapter {
  constructor(private readonly signingKey: string = env.calendlySigningKey) {}

  verifySignature(rawBody: Buffer, header: string, key: string): boolean {
    // Allow the caller to pass an explicit key (routes do); default to env.
    return verifyCalendlySignature(rawBody, header, key || this.signingKey);
  }

  parseEvent(body: unknown): CalendlyEvent {
    return parseCalendlyEvent(body);
  }
}
