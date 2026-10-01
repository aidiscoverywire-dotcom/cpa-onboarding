/**
 * Real behavior tests for lib/auth.ts.
 *
 * Covered: Workspace domain enforcement (pure), session sign/verify round-trip
 * with jose (real HS256 tokens, real tampering/expiry/secret checks), idle vs
 * absolute expiry evaluation, token refresh preserving the absolute cap,
 * session cookie attributes, cookie read helper, and the middleware
 * public-path rules + matcher.
 *
 * NOT covered here (and NOT live-verified): verifyGoogleIdToken /
 * buildGoogleAuthUrl — no real Google Workspace tenant is reachable from this
 * environment, so the OIDC path is never exercised against real tokens.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

// env.ts reads process.env lazily, so setting these before the tests run is
// sufficient even though imports are hoisted.
process.env.FIRM_DOMAIN = "firm.example.com";
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.SESSION_SECRET = "x".repeat(40);

import {
  ABSOLUTE_TIMEOUT_SECONDS,
  AuthError,
  IDLE_TIMEOUT_SECONDS,
  MIDDLEWARE_MATCHER,
  SESSION_COOKIE_NAME,
  assertWorkspaceDomain,
  clearSessionCookieAttributes,
  createSessionToken,
  evaluateSession,
  isPublicPath,
  readSessionToken,
  refreshSessionToken,
  sessionCookieAttributes,
  verifySessionToken,
  type SessionClaims,
} from "./auth";

const SECRET = "x".repeat(40);

beforeEach(() => {
  process.env.FIRM_DOMAIN = "firm.example.com";
  process.env.SESSION_SECRET = SECRET;
  vi.stubEnv("NODE_ENV", "test");
});

/* --------------------- domain enforcement --------------------- */

describe("assertWorkspaceDomain", () => {
  it("accepts the firm's hosted domain", () => {
    expect(assertWorkspaceDomain("firm.example.com")).toBe("firm.example.com");
  });

  it("compares case-insensitively (domains are case-insensitive)", () => {
    expect(assertWorkspaceDomain("Firm.Example.COM")).toBe("firm.example.com");
  });

  it("rejects a missing hd claim (consumer Gmail, not Workspace)", () => {
    expect(() => assertWorkspaceDomain(undefined)).toThrowError(AuthError);
    expect(() => assertWorkspaceDomain(null)).toThrowError(AuthError);
    expect(() => assertWorkspaceDomain("")).toThrowError(AuthError);
    try {
      assertWorkspaceDomain(undefined);
    } catch (e) {
      expect((e as AuthError).code).toBe("missing_hd");
    }
  });

  it("rejects the wrong domain", () => {
    try {
      assertWorkspaceDomain("attacker.example");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).code).toBe("wrong_domain");
    }
  });

  it("fails closed when FIRM_DOMAIN is unset", () => {
    delete process.env.FIRM_DOMAIN;
    expect(() => assertWorkspaceDomain("firm.example.com")).toThrowError(
      /FIRM_DOMAIN/,
    );
  });
});

/* ------------------- session sign/verify ------------------- */

describe("session tokens", () => {
  it("round-trips sub, role, email and name through jose HS256", async () => {
    const token = await createSessionToken({
      sub: "google-sub-123",
      role: "owner",
      email: "nelson@example.com",
      name: "Nelson",
    });
    const claims = await verifySessionToken(token);
    expect(claims.sub).toBe("google-sub-123");
    expect(claims.role).toBe("owner");
    expect(claims.email).toBe("nelson@example.com");
    expect(claims.name).toBe("Nelson");
    expect(claims.iss).toBe("cpa-onboarding");
    expect(claims.aud).toBe("cpa-onboarding-staff");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    // Absolute cap is baked into exp at issuance.
    expect(claims.exp! - claims.iat!).toBe(ABSOLUTE_TIMEOUT_SECONDS);
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({ sub: "u1", role: "staff" });
    const tampered =
      token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    await expect(verifySessionToken(tampered)).rejects.toThrowError(AuthError);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken({ sub: "u1", role: "staff" });
    process.env.SESSION_SECRET = "y".repeat(40);
    await expect(verifySessionToken(token)).rejects.toThrowError(AuthError);
  });

  it("rejects an expired token with the session_expired code", async () => {
    const token = await createSessionToken(
      { sub: "u1", role: "staff" },
      { expiresInSeconds: -60 },
    );
    try {
      await verifySessionToken(token);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).code).toBe("session_expired");
    }
  });

  it("rejects garbage input", async () => {
    await expect(verifySessionToken("not-a-token")).rejects.toThrowError(
      AuthError,
    );
    await expect(verifySessionToken("")).rejects.toThrowError(AuthError);
  });

  it("requires sub and role at creation", async () => {
    await expect(
      createSessionToken({ sub: "", role: "staff" }),
    ).rejects.toThrowError(AuthError);
    await expect(
      createSessionToken({ sub: "u1", role: "" }),
    ).rejects.toThrowError(AuthError);
  });

  it("refuses a weak SESSION_SECRET", async () => {
    process.env.SESSION_SECRET = "short";
    await expect(
      createSessionToken({ sub: "u1", role: "staff" }),
    ).rejects.toThrowError(/at least 32/);
  });
});

/* ------------------- expiry evaluation ------------------- */

function claimsAt(iatS: number, expS: number): SessionClaims {
  return { sub: "u1", role: "staff", iat: iatS, exp: expS };
}

describe("evaluateSession", () => {
  it("is valid for a fresh session", () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(evaluateSession(claimsAt(nowS, nowS + 3600))).toBe("valid");
  });

  it("flags idle expiry when iat is older than the idle window", () => {
    const nowS = Math.floor(Date.now() / 1000);
    const status = evaluateSession(
      claimsAt(nowS - IDLE_TIMEOUT_SECONDS - 1, nowS + 3600),
    );
    expect(status).toBe("idle_expired");
  });

  it("stays valid just inside the idle window", () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(
      evaluateSession(claimsAt(nowS - IDLE_TIMEOUT_SECONDS + 60, nowS + 3600)),
    ).toBe("valid");
  });

  it("flags absolute expiry even with recent activity", () => {
    const nowS = Math.floor(Date.now() / 1000);
    expect(evaluateSession(claimsAt(nowS - 10, nowS - 1))).toBe(
      "absolute_expired",
    );
  });
});

describe("refreshSessionToken", () => {
  it("bumps iat but preserves the absolute exp cap", async () => {
    const original = await createSessionToken({ sub: "u1", role: "owner" });
    const claims = await verifySessionToken(original);
    // Simulate later activity.
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await refreshSessionToken(claims);
    const fresh = await verifySessionToken(refreshed);
    expect(fresh.sub).toBe("u1");
    expect(fresh.role).toBe("owner");
    expect(fresh.exp).toBe(claims.exp); // absolute cap unchanged
    expect(fresh.iat).toBeGreaterThanOrEqual(claims.iat!);
  });

  it("refuses to refresh a token without exp", async () => {
    await expect(
      refreshSessionToken({ sub: "u1", role: "staff" }),
    ).rejects.toThrowError(AuthError);
  });
});

/* ------------------- cookie helpers ------------------- */

describe("session cookies", () => {
  it("sets HttpOnly + SameSite=Lax + path, non-secure outside prod", () => {
    const attrs = sessionCookieAttributes();
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("lax");
    expect(attrs.path).toBe("/");
    expect(attrs.maxAge).toBe(IDLE_TIMEOUT_SECONDS);
    expect(attrs.secure).toBe(false); // NODE_ENV=test
  });

  it("sets Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieAttributes().secure).toBe(true);
  });

  it("clear helper zeroes the max age", () => {
    const attrs = clearSessionCookieAttributes();
    expect(attrs.maxAge).toBe(0);
    expect(attrs.httpOnly).toBe(true);
  });

  it("readSessionToken reads the right cookie name", () => {
    const token = "tok123";
    expect(
      readSessionToken((n) => (n === SESSION_COOKIE_NAME ? token : undefined)),
    ).toBe(token);
    expect(readSessionToken(() => undefined)).toBeNull();
  });
});

/* ------------------- middleware routing rules ------------------- */

describe("isPublicPath", () => {
  it("treats login, health, auth and webhook paths as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/auth/google")).toBe(true);
    expect(isPublicPath("/api/auth/callback")).toBe(true);
    expect(isPublicPath("/api/webhooks/calendly")).toBe(true);
    expect(isPublicPath("/api/webhooks/typeform")).toBe(true);
  });

  it("protects app pages and the client/intake/approval APIs", () => {
    for (const p of [
      "/",
      "/clients/abc",
      "/intake-review",
      "/approvals",
      "/audit",
      "/settings",
      "/api/clients",
      "/api/clients/abc/actions",
      "/api/intake/review",
      "/api/approvals",
      "/api/audit",
      "/api/settings",
    ]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("does not confuse similarly-prefixed paths", () => {
    expect(isPublicPath("/api/healthcheck")).toBe(false);
    expect(isPublicPath("/logins")).toBe(false);
    expect(isPublicPath("/api/webhooks-evil")).toBe(false);
  });
});

describe("MIDDLEWARE_MATCHER", () => {
  // The documented Next.js negative-lookahead form compiles to an equivalent
  // regex; assert the shipped string behaves as intended.
  const re = new RegExp(`^${MIDDLEWARE_MATCHER}$`);

  it("runs middleware for protected paths", () => {
    for (const p of ["/", "/login", "/clients/1", "/api/clients", "/audit"]) {
      expect(re.test(p)).toBe(true);
    }
  });

  it("skips middleware for static assets and public API prefixes", () => {
    for (const p of [
      "/_next/static/chunk.js",
      "/_next/image?url=x",
      "/favicon.ico",
      "/api/health",
      "/api/webhooks/calendly",
      "/api/auth/callback",
    ]) {
      expect(re.test(p)).toBe(false);
    }
  });

  it("stays in sync with the inline literal in middleware.ts config", async () => {
    // Next.js only accepts inline string literals in config.matcher, so
    // middleware.ts carries a copy of MIDDLEWARE_MATCHER. Fail loudly if
    // they drift apart.
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../middleware.ts"), "utf8");
    expect(source).toContain(`matcher: ["${MIDDLEWARE_MATCHER}"]`);
  });
});
