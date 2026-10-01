/**
 * POST /api/auth/signout — clear the session cookie.
 *
 * Per lib/auth.ts: `clearSessionCookieAttributes()`. Redirects to /login so
 * plain HTML form posts land somewhere sensible.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCookieAttributes,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const res = NextResponse.redirect(new URL("/login", url.origin));
  res.cookies.set(SESSION_COOKIE_NAME, "", clearSessionCookieAttributes());
  return res;
}
