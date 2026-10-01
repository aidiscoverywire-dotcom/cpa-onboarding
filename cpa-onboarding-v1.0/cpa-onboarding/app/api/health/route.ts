/**
 * GET /api/health — liveness probe. No auth (listed in PUBLIC_PATH_PREFIXES).
 * Deliberately does NOT touch the database: health must stay green while
 * Postgres is still booting (see lib/db.ts retry-on-boot).
 */
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    service: "cpa-onboarding",
    serviceRole: env.serviceRole,
    time: new Date().toISOString(),
  });
}
