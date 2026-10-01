/**
 * Google Workspace SSO + staff session management for the staff service.
 *
 * Flow (wired by workstream (b) in `app/api/auth/*` — this file is the library
 * those routes call; it creates no routes itself):
 *
 *   GET  /api/auth/google    -> `buildGoogleAuthUrl({ redirectUri, state })`, 302 to Google
 *   GET  /api/auth/callback  -> exchange code for tokens, then:
 *                                `verifyGoogleIdToken(idToken)` (server-side `hd` enforcement),
 *                                upsert user keyed on Google `sub`,
 *                                `createSessionToken({ sub, role, email, name })`,
 *                                set cookie with `sessionCookieAttributes()`, redirect to `next` or `/`
 *   POST /api/auth/signout   -> clear cookie with `clearSessionCookieAttributes()`, redirect `/login`
 *
 * Sessions: JWT (HS256 via `jose`) in an HttpOnly + Secure (prod) + SameSite=Lax
 * cookie. Two expiries: a sliding idle window (middleware re-issues the token with
 * a fresh `iat` on every authenticated request, keeping the absolute `exp`) and a
 * hard absolute cap that activity never extends.
 *
 * MFA is inherited from the Google Workspace Admin console — Google enforces
 * 2-Step Verification at sign-in when the Workspace admin requires it. This app
 * performs no step-up authentication of its own.
 *
 * HONESTY: no real Google Workspace tenant is reachable from this environment,
 * so the OIDC token-verification path (`verifyGoogleIdToken`,
 * `buildGoogleAuthUrl`) has NEVER run against a real Google token. Unit tests
 * cover domain enforcement, session sign/verify, expiry evaluation, cookie
 * attributes, and the middleware public-path rules only. Marked NOT live-verified.
 */

import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { env } from "./env";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Name of the HttpOnly session cookie. */
export const SESSION_COOKIE_NAME = "cpa_session";

/** Sliding idle window, refreshed on every authenticated request by middleware. */
export const IDLE_TIMEOUT_SECONDS = 8 * 60 * 60; // 8 hours
/** Hard cap on session lifetime — activity never extends this. */
export const ABSOLUTE_TIMEOUT_SECONDS = 12 * 60 * 60; // 12 hours

export const SESSION_ISSUER = "cpa-onboarding";
export const SESSION_AUDIENCE = "cpa-onboarding-staff";

/**
 * Paths that never require a session. Mirrored in MIDDLEWARE_MATCHER below —
 * keep the two in sync.
 */
export const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api/health",
  "/api/auth",
  "/api/webhooks",
] as const;

/**
 * Next.js middleware matcher (documented negative-lookahead form). `/login` is
 * intentionally INCLUDED so middleware can bounce already-signed-in staff away
 * from the login page; `isPublicPath()` decides inside middleware.
 */
export const MIDDLEWARE_MATCHER =
  "/((?!_next/static|_next/image|favicon.ico|api/health|api/webhooks|api/auth).*)";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  hd?: string;
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  role: string;
  email?: string;
  name?: string;
}

export interface CreateSessionInput {
  sub: string;
  role: string;
  email?: string;
  name?: string;
}

export type SessionStatus = "valid" | "idle_expired" | "absolute_expired";

export interface SessionCookieAttributes {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function sessionKey(): Uint8Array {
  const secret = env.sessionSecret;
  if (secret.length < 32) {
    throw new AuthError(
      "weak_secret",
      "SESSION_SECRET must be at least 32 characters.",
    );
  }
  return new TextEncoder().encode(secret);
}

/* ------------------------------------------------------------------ */
/* Google OIDC (NOT live-verified — no real Workspace tenant here)     */
/* ------------------------------------------------------------------ */

/**
 * Server-side hosted-domain enforcement. Pure and unit-tested.
 *
 * A `?hd=` request parameter is a UX hint only and is NEVER consulted here —
 * only the `hd` claim inside the verified ID token is trusted.
 */
export function assertWorkspaceDomain(
  hd: string | null | undefined,
): string {
  const firm = env.firmDomain; // throws when unset — fail closed
  if (!hd) {
    throw new AuthError(
      "missing_hd",
      "This Google account is not a Workspace account (no hosted-domain claim).",
    );
  }
  if (hd.toLowerCase() !== firm.toLowerCase()) {
    throw new AuthError(
      "wrong_domain",
      `Account domain '${hd}' is not the firm domain.`,
    );
  }
  return firm;
}

/**
 * Verify a Google ID token and enforce the firm Workspace domain.
 * Maps Google `sub` -> staff identity; sessions are keyed on `sub`.
 */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdentity> {
  // Lazy + webpackIgnore: google-auth-library is a Node-only dependency and
  // must never be pulled into the edge-runtime middleware bundle. The OIDC
  // callback route runs on the Node runtime, where this resolves normally.
  const { OAuth2Client } = await import(
    /* webpackIgnore: true */ "google-auth-library"
  );
  const client = new OAuth2Client(env.googleClientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.googleClientId,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new AuthError(
      "invalid_token",
      `Google ID token verification failed: ${(err as Error).message}`,
    );
  }
  if (!payload?.sub) {
    throw new AuthError("invalid_token", "Google ID token has no subject.");
  }
  // SERVER-SIDE hd enforcement (see assertWorkspaceDomain).
  assertWorkspaceDomain(payload.hd);
  if (payload.email_verified !== true) {
    throw new AuthError(
      "unverified_email",
      "Google account email is not verified.",
    );
  }
  return {
    sub: payload.sub,
    email: payload.email ?? "",
    emailVerified: true,
    name: payload.name,
    hd: payload.hd,
  };
}

/**
 * Build the Google authorization URL that starts the OIDC flow.
 * `hd` here is a UX hint (pre-selects the Workspace domain), NOT a boundary —
 * enforcement happens in `verifyGoogleIdToken` on the way back.
 */
export async function buildGoogleAuthUrl(opts: {
  redirectUri: string;
  state: string;
}): Promise<string> {
  const { OAuth2Client } = await import(
    /* webpackIgnore: true */ "google-auth-library"
  );
  const client = new OAuth2Client(env.googleClientId, undefined, opts.redirectUri);
  return client.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    hd: env.firmDomain,
    state: opts.state,
    prompt: "select_account",
  });
}

/* ------------------------------------------------------------------ */
/* Session tokens (jose HS256)                                         */
/* ------------------------------------------------------------------ */

export async function createSessionToken(
  input: CreateSessionInput,
  opts: { expiresInSeconds?: number } = {},
): Promise<string> {
  if (!input.sub) throw new AuthError("invalid_input", "Session requires sub.");
  if (!input.role) throw new AuthError("invalid_input", "Session requires role.");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: input.sub,
    role: input.role,
    email: input.email,
    name: input.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime(now + (opts.expiresInSeconds ?? ABSOLUTE_TIMEOUT_SECONDS))
    .sign(sessionKey());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  let verified;
  try {
    verified = await jwtVerify(token, sessionKey(), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ["HS256"],
    });
  } catch (err) {
    const code =
      err instanceof Error && err.name === "JWTExpired"
        ? "session_expired"
        : "invalid_session";
    throw new AuthError(
      code,
      `Session verification failed: ${(err as Error).message}`,
    );
  }
  const claims = verified.payload as SessionClaims;
  if (!claims.sub || !claims.role) {
    throw new AuthError("invalid_session", "Session token is missing sub/role.");
  }
  return claims;
}

/**
 * Pure session-status evaluation (unit-tested). Idle expiry uses `iat` as the
 * last-activity marker: middleware re-issues the token (fresh `iat`, unchanged
 * `exp`) on every authenticated request, so a stale `iat` means an idle user.
 */
export function evaluateSession(
  claims: SessionClaims,
  nowMs: number = Date.now(),
): SessionStatus {
  const nowS = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || nowS >= claims.exp) {
    return "absolute_expired";
  }
  const iat = typeof claims.iat === "number" ? claims.iat : 0;
  if (nowS - iat >= IDLE_TIMEOUT_SECONDS) {
    return "idle_expired";
  }
  return "valid";
}

/**
 * Re-issue a session token for the sliding idle window: fresh `iat`,
 * UNCHANGED absolute `exp`. Call only after `evaluateSession` returned "valid".
 */
export async function refreshSessionToken(
  claims: SessionClaims,
): Promise<string> {
  if (typeof claims.exp !== "number") {
    throw new AuthError(
      "invalid_session",
      "Cannot refresh a session without exp.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: claims.sub,
    role: claims.role,
    email: claims.email,
    name: claims.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime(claims.exp)
    .sign(sessionKey());
}

/* ------------------------------------------------------------------ */
/* Cookie helpers                                                      */
/* ------------------------------------------------------------------ */

/** Attributes for the session cookie: HttpOnly + Secure (prod) + SameSite=Lax. */
export function sessionCookieAttributes(
  maxAge: number = IDLE_TIMEOUT_SECONDS,
): SessionCookieAttributes {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

export function clearSessionCookieAttributes(): SessionCookieAttributes {
  return { ...sessionCookieAttributes(0), maxAge: 0 };
}

/** Framework-agnostic cookie read: pass `(n) => req.cookies.get(n)?.value`. */
export function readSessionToken(
  get: (name: string) => string | undefined,
): string | null {
  return get(SESSION_COOKIE_NAME) ?? null;
}
