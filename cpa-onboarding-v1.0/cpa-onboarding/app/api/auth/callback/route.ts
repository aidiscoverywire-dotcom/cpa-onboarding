/**
 * GET /api/auth/callback — finish the Google Workspace SSO flow.
 *
 * Per lib/auth.ts: exchange code for tokens → verifyGoogleIdToken (server-side
 * `hd` enforcement) → upsert user keyed on Google `sub` (role is never
 * overwritten on re-login; the first-ever user bootstraps as `owner`) →
 * createSessionToken → set the session cookie → redirect to `next` or `/`.
 *
 * Requires GOOGLE_CLIENT_SECRET (read here via process.env — env.ts is owned
 * by the coordinator; see the report for the new variable).
 * NOT live-verified: no real Google Workspace tenant is reachable here.
 */
import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import {
  AuthError,
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieAttributes,
  verifyGoogleIdToken,
} from "@/lib/auth";
import { withTx } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { upsertUserByGoogleSub } from "@/lib/transitions";
import { OAUTH_STATE_COOKIE } from "../../_helpers";

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const errParam = url.searchParams.get("error");

  if (errParam) {
    return fail(401, "oauth_denied", `Google sign-in was not completed (${errParam}).`);
  }
  if (!code) return fail(400, "missing_code", "Missing OAuth authorization code.");

  // CSRF check: state nonce must match the cookie set at /api/auth/google.
  const [nonce, nextEncoded] = state.split(".");
  const expected = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!nonce || !expected || nonce !== expected) {
    return fail(403, "bad_state", "OAuth state mismatch — please sign in again.");
  }
  const next = nextEncoded ? decodeURIComponent(nextEncoded) : "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"];
  if (!clientSecret) {
    return fail(
      500,
      "oauth_unconfigured",
      "GOOGLE_CLIENT_SECRET is not set; Google sign-in is unavailable.",
    );
  }

  try {
    const redirectUri = `${url.origin}/api/auth/callback`;
    const oauth = new OAuth2Client(
      process.env["GOOGLE_CLIENT_ID"],
      clientSecret,
      redirectUri,
    );
    const { tokens } = await oauth.getToken(code);
    if (!tokens.id_token) {
      return fail(401, "oauth_failed", "Google did not return an ID token.");
    }
    // Server-side hd-claim enforcement happens inside.
    const identity = await verifyGoogleIdToken(tokens.id_token);

    const { user, created } = await withTx(async (tx) => {
      const upserted = await upsertUserByGoogleSub(tx, {
        sub: identity.sub,
        email: identity.email,
        name: identity.name,
      });
      await appendAudit(tx, {
        actor: identity.sub,
        actorType: "user",
        action: created ? "user_created" : "user_signin",
        entity: "user",
        entityId: upserted.user.id,
        before: null,
        after: { email: identity.email, role: upserted.user.role },
        requestId: null,
      });
      return upserted;
    });

    const session = await createSessionToken({
      sub: user.google_sub,
      role: user.role,
      email: user.email,
      name: user.name ?? undefined,
    });

    const res = NextResponse.redirect(new URL(safeNext, url.origin));
    res.cookies.set(SESSION_COOKIE_NAME, session, sessionCookieAttributes());
    res.cookies.set(OAUTH_STATE_COOKIE, "", { ...sessionCookieAttributes(0), maxAge: 0 });
    return res;
  } catch (e) {
    if (e instanceof AuthError) {
      return fail(401, e.code, e.message);
    }
    return fail(500, "oauth_failed", (e as Error).message);
  }
}
