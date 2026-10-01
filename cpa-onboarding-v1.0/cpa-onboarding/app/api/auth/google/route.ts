/**
 * GET /api/auth/google — start the Google Workspace SSO flow (302 to Google).
 *
 * Per lib/auth.ts: `buildGoogleAuthUrl({ redirectUri, state })`. A `?hd=`
 * request parameter here is a UX hint only — the real boundary is server-side
 * `hd`-claim enforcement in verifyGoogleIdToken (callback route).
 * CSRF: a random `state` is stored in a short-lived HttpOnly cookie and
 * compared on the way back; the post-login destination (`next`) rides inside
 * the state value.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { buildGoogleAuthUrl, sessionCookieAttributes } from "@/lib/auth";
import { OAUTH_STATE_COOKIE } from "../../_helpers";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/auth/callback`;
  const next = url.searchParams.get("next") || "/";
  const nonce = randomBytes(16).toString("hex");
  const state = `${nonce}.${encodeURIComponent(next)}`;

  let authUrl: string;
  try {
    authUrl = await buildGoogleAuthUrl({ redirectUri, state });
  } catch (e) {
    return NextResponse.json(
      { error: "oauth_unavailable", message: (e as Error).message },
      { status: 500 },
    );
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    ...sessionCookieAttributes(600),
    httpOnly: true,
  });
  return res;
}
