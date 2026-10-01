/**
 * Server-side API client for pages + shared API response types.
 *
 * All data and all mutations go through the workstream-(b) API routes over
 * HTTP (same origin). The UI NEVER transitions state client-side: pages render
 * `current_state` + `allowed_actions` returned by the API, and action buttons
 * are plain HTML forms that POST to `/api/**`.
 *
 * Assumed API contract (workstream (b) builds these; shapes below are the
 * working assumption — fields are optional/loose so minor shape differences
 * degrade to empty states instead of crashes):
 *
 *   GET  /api/clients
 *   GET  /api/clients/[id]
 *   POST /api/clients/[id]/actions        (form-encoded or JSON: { action })
 *   GET  /api/intake/review
 *   POST /api/intake/review/[id]          (form-encoded or JSON: { action, ... })
 *   GET  /api/approvals
 *   POST /api/approvals/[id]              (form-encoded or JSON: { decision, note? })
 *   GET  /api/audit
 *   GET  /api/settings
 *   GET  /api/auth/google                 (OIDC flow start; ?next=)
 *   GET  /api/auth/callback               (OIDC callback; sets session cookie)
 *   POST /api/auth/signout                (clears session cookie)
 *
 * Auth endpoints are assumed, not contracted — flagged in the build report.
 */

import { cookies, headers } from "next/headers";
import {
  SESSION_COOKIE_NAME,
  evaluateSession,
  verifySessionToken,
} from "../lib/auth";

/* ----------------------------- types ------------------------------ */

export interface ClientSummary {
  id: string;
  name: string;
  email?: string;
  current_state: string;
  stalled?: boolean;
  stalled_since?: string | null;
  updated_at?: string;
}

export interface AllowedAction {
  id: string;
  label: string;
}

export interface StateTransition {
  id?: string | number;
  from_state?: string | null;
  to_state: string;
  at: string;
  actor?: string;
  note?: string;
}

export interface DocRequirement {
  name: string;
  required?: boolean;
  received?: boolean;
}

export interface IntakeWaiver {
  waived_by?: string;
  waiver_reason?: string;
  at?: string;
}

export interface ClientDetail {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  current_state: string;
  stalled?: boolean;
  stalled_since?: string | null;
  allowed_actions?: AllowedAction[];
  transitions?: StateTransition[];
  documents?: {
    required?: DocRequirement[];
    missing?: string[];
  };
  intake_answers?: Record<string, string> | null;
  intake_waiver?: IntakeWaiver | null;
  approval?: {
    status?: string;
    type?: string;
    requested_by?: string;
    requested_at?: string;
    decided_by?: string;
    decided_at?: string;
    note?: string;
  } | null;
}

export interface IntakeSubmission {
  id: string | number;
  received_at?: string;
  email?: string;
  match_status?: "no_match" | "multi_match" | "pre_booking" | string;
  answers?: Record<string, string>;
  candidates?: Array<{ client_id: string; name: string; email?: string }>;
}

export interface Approval {
  id: string | number;
  type?: string;
  client_id?: string;
  client_name?: string;
  status?: string;
  requested_by?: string;
  requested_at?: string;
  detail?: string;
}

export interface AuditEvent {
  id?: string | number;
  at?: string;
  actor?: string;
  action?: string;
  client_id?: string;
  detail?: string;
}

export interface Settings {
  stall_thresholds?: Record<string, string | number>;
  [key: string]: unknown;
}

export interface CurrentUser {
  sub: string;
  role: string;
  email?: string;
  name?: string;
}

/* --------------------------- fetching ----------------------------- */

/** Absolute base URL for same-origin API calls from server components. */
export function apiBaseUrl(): string {
  const h = headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

/** GET an API route, forwarding the request's cookies (session included). */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: { cookie: cookies().toString() },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Current signed-in staff member, decoded from the session cookie. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const claims = await verifySessionToken(token);
    if (evaluateSession(claims) !== "valid") return null;
    return {
      sub: claims.sub,
      role: claims.role,
      email: claims.email,
      name: claims.name,
    };
  } catch {
    return null;
  }
}
