/**
 * Shared helpers for API routes (workstream b).
 *
 * - `getSession()` — verifies the HttpOnly session JWT via lib/auth.ts
 *   (fails closed: null when missing/invalid/expired).
 * - `readBody()` — parses JSON AND application/x-www-form-urlencoded bodies
 *   (the staff UI posts plain HTML forms). Returns a plain object; form values
 *   are strings, so routes coerce numbers/booleans with `num()`/`bool()`.
 * - `getIdempotencyKey()` — header `Idempotency-Key` first, then body
 *   `idempotencyKey`/`idempotency_key`; generates a UUID when absent so every
 *   state-changing write still carries a key.
 * - `transitionErrorStatus()` — maps machine rejections to HTTP status:
 *   role-denied → 403, everything else → 422.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  evaluateSession,
  readSessionToken,
  verifySessionToken,
} from "@/lib/auth";
import { TransitionNotAllowed } from "@/lib/machine";
import type { Role } from "@/lib/machine";

/** Name of the short-lived OAuth state (CSRF) cookie. */
export const OAUTH_STATE_COOKIE = "cpa_oauth_state";

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface Session {
  sub: string;
  role: Role;
  email?: string;
  name?: string;
}

export async function getSession(req: NextRequest): Promise<Session | null> {
  const token = readSessionToken((n) => req.cookies.get(n)?.value);
  if (!token) return null;
  try {
    const claims = await verifySessionToken(token);
    if (evaluateSession(claims) !== "valid") return null;
    return {
      sub: claims.sub,
      role: claims.role as Role,
      email: claims.email,
      name: claims.name,
    };
  } catch {
    return null; // fail closed
  }
}

/** 401 when signed out, 403 when the role is not permitted. Returns session on success. */
export function requireRoles(
  session: Session | null,
  roles: Role[],
): Session | NextResponse {
  if (!session) {
    return err(401, "unauthenticated", "Sign in required.");
  }
  if (!roles.includes(session.role)) {
    return err(
      403,
      "forbidden",
      `Role '${session.role}' is not permitted for this action.`,
    );
  }
  return session;
}

/* ------------------------------------------------------------------ */
/* Body parsing (JSON + HTML forms)                                      */
/* ------------------------------------------------------------------ */

export type Body = Record<string, unknown>;

/** Parse a JSON or x-www-form-urlencoded request body into a plain object. */
export async function readBody(req: NextRequest): Promise<Body> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const obj: Body = {};
    params.forEach((v, k) => {
      const existing = obj[k];
      if (existing === undefined) obj[k] = v;
      else if (Array.isArray(existing)) existing.push(v);
      else obj[k] = [existing, v];
    });
    return obj;
  }
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Body;
    }
    return {};
  } catch {
    return {};
  }
}

/** First defined value among aliases (e.g. client_id / clientId). */
export function pick(body: Body, ...names: string[]): unknown {
  for (const n of names) {
    const v = body[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

export function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Request metadata                                                    */
/* ------------------------------------------------------------------ */

export function getIdempotencyKey(req: NextRequest, body: Body): string {
  const fromHeader = req.headers.get("idempotency-key")?.trim();
  if (fromHeader) return fromHeader;
  const fromBody = str(pick(body, "idempotencyKey", "idempotency_key"));
  if (fromBody) return fromBody;
  // Generated so every state-changing write still carries a unique key.
  return randomUUID();
}

export function getRequestId(req: NextRequest): string {
  return req.headers.get("x-request-id")?.trim() || randomUUID();
}

export function getClientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return null;
}

/** SHA-256 hex of raw webhook bytes — stored for replay defense. */
export function checksumRaw(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/** Constant-time bearer comparison for the stall-check job secret. */
export function bearerMatches(req: NextRequest, secret: string): boolean {  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header.trim());
  if (!m || !secret) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function err(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: code, message, ...extra }, { status });
}

/** Map machine/DB errors from transition attempts to HTTP status codes. */
export function transitionErrorStatus(e: unknown): number {
  if (e instanceof TransitionNotAllowed) {
    return /Role '.*' may not trigger/.test(e.message) ? 403 : 422;
  }
  if (e instanceof Error && e.name === "NotFoundError") return 404;
  return 500;
}

export function transitionErrorBody(e: unknown): { code: string; message: string } {
  if (e instanceof TransitionNotAllowed) {
    const code = /Role '.*' may not trigger/.test(e.message)
      ? "forbidden_for_role"
      : "transition_not_allowed";
    return { code, message: e.message };
  }
  if (e instanceof Error && e.name === "NotFoundError") {
    return { code: "not_found", message: e.message };
  }
  return { code: "internal_error", message: "Unexpected error." };
}
