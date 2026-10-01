/**
 * GET /api/settings — firm-configurable stall rules. Auth required.
 * (Rule management — create/update — is a later admin surface; Phase 1
 * exposes the read side the stall-check job consumes.)
 */
import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { err, getSession, ok } from "../_helpers";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const { rows } = await query(
    `SELECT id, state, threshold_hours, enabled FROM stall_rules ORDER BY state`,
  );
  return ok({ stall_rules: rows });
}
