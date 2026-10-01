/**
 * GET /api/clients — list clients. Auth required (any signed-in staff role).
 * Query params: state (filter), q (name/email search), limit (default 50,
 * max 200), offset.
 */
import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { isValidState } from "@/lib/states";
import { err, getSession, num, ok, str } from "../_helpers";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const url = new URL(req.url);
  const state = str(url.searchParams.get("state"));
  const q = str(url.searchParams.get("q"));
  const limit = Math.min(num(url.searchParams.get("limit")) ?? 50, 200);
  const offset = num(url.searchParams.get("offset")) ?? 0;

  if (state && !isValidState(state) && !["stalled", "canceled", "no_show", "lost"].includes(state)) {
    return err(400, "bad_state", `Unknown state filter: ${state}`);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (state) {
    params.push(state);
    where.push(`current_state = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(display_name ILIKE $${params.length} OR primary_email ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM clients ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT id, display_name, primary_email, entity_type, engagement_type,
            current_state, resume_state, scope_version, policy_version,
            docs_required, docs_received, stalled_at, created_at, updated_at
       FROM clients ${whereSql}
      ORDER BY updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return ok({
    clients: rows.rows,
    total: Number(total.rows[0]?.n ?? 0),
    limit,
    offset,
  });
}
