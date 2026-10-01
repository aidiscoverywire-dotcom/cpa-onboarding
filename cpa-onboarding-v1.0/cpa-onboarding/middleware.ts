/**
 * Route protection for the staff service.
 *
 * Public (no session needed): /login, /api/health, /api/auth/*, /api/webhooks/*.
 * Everything else requires a valid session cookie, otherwise:
 *   - page requests  -> 302 to /login?next=<original path> (cookie cleared when
 *                        a token was present but invalid/expired)
 *   - /api/* requests -> 401 JSON (no redirect; API clients don't follow them)
 *
 * On every authenticated request the middleware also refreshes the sliding idle
 * window (fresh `iat`, unchanged absolute `exp`) and stamps the caller's
 * identity into x-user-* headers for downstream API routes.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieAttributes,
  evaluateSession,
  isPublicPath,
  readSessionToken,
  refreshSessionToken,
  sessionCookieAttributes,
  verifySessionToken,
} from "./lib/auth";

function unauthenticated(req: NextRequest, clearCookie: boolean): NextResponse {
  const pathname = req.nextUrl.pathname;

  if (pathname.startsWith("/api/")) {
    const res = NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (clearCookie) {
      res.cookies.set(SESSION_COOKIE_NAME, "", clearSessionCookieAttributes());
    }
    return res;
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = pathname + req.nextUrl.search;
  if (next !== "/login") {
    url.searchParams.set("next", next);
  }
  const res = NextResponse.redirect(url);
  if (clearCookie) {
    res.cookies.set(SESSION_COOKIE_NAME, "", clearSessionCookieAttributes());
  }
  return res;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const token = readSessionToken((n) => req.cookies.get(n)?.value);

  if (isPublicPath(pathname)) {
    // Already signed in and hitting /login? Bounce into the app.
    if (pathname === "/login" && token) {
      try {
        const claims = await verifySessionToken(token);
        if (evaluateSession(claims) === "valid") {
          const next = req.nextUrl.searchParams.get("next");
          const dest =
            next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
          return NextResponse.redirect(new URL(dest, req.url));
        }
      } catch {
        // Invalid/expired token: fall through and show the login page.
      }
    }
    return NextResponse.next();
  }

  if (!token) {
    return unauthenticated(req, false);
  }

  let claims;
  try {
    claims = await verifySessionToken(token);
  } catch {
    return unauthenticated(req, true);
  }

  if (evaluateSession(claims) !== "valid") {
    return unauthenticated(req, true);
  }

  const res = NextResponse.next();
  res.headers.set("x-user-sub", claims.sub);
  res.headers.set("x-user-role", claims.role);
  if (claims.email) {
    res.headers.set("x-user-email", claims.email);
  }
  // Sliding idle window: fresh iat, unchanged absolute exp.
  res.cookies.set(
    SESSION_COOKIE_NAME,
    await refreshSessionToken(claims),
    sessionCookieAttributes(),
  );
  return res;
}

export const config = {
  // NOTE: Next.js requires matcher entries to be inline string literals
  // (imported constants are ignored with a warning). This literal MUST stay
  // identical to MIDDLEWARE_MATCHER in lib/auth.ts — lib/auth.test.ts
  // asserts the two are in sync.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/webhooks|api/auth).*)"],
};
