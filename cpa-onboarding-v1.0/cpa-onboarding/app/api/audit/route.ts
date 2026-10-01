/**
 * GET /api/audit — read the append-only audit log. Role-gated:
 *   - owner / admin: full log;
 *   - partner: full log (read-only);
 *   - staff: only rows for actions they performed (own-client scope per
 *     docs/role-matrix.md recommended default);
 *   - viewer / webhook / system: denied.
 *
 * Query params: entity, entity_id, action, limit (default 50, max 200).
 * Snapshots are already PII-redacted at write time (lib/audit.ts), so reads
 * are safe to return as stored.
 */
import { NextRequest } from "next/server";
import { query } from "@/lib/db";
import { err, getSession, num, ok, str } from "../_helpers";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");
  if (!["owner", "admin", "partner", "staff"].includes(session.role)) {
    return err(403, "forbidden", `Role '${session.role}' cannot read the audit log.`);
  }

  const url = new URL(req.url);
  const entity = str(url.searchParams.get("entity"));
  const entityId = str(url.searchParams.get("entity_id"));
  const action = str(url.searchParams.get("action"));
  const limit = Math.min(num(url.searchParams.get("limit")) ?? 50, 200);

  const where: string[] = [];
  const params: unknown[] = [];
  if (entity) {
    params.push(entity);
    where.push(`entity = $${params.length}`);
  }
  if (entityId) {
    params.push(entityId);
    where.push(`entity_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    where.push(`action = $${params.length}`);
  }
  if (session.role === "staff") {
    // Recommended default: staff see only their own actions.
    params.push(session.sub);
    where.push(`actor = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await query(
    `SELECT id, occurred_at, actor, actor_type, action, entity, entity_id,
            before, after, ip, request_id, prev_hash, hash
       FROM audit_events ${whereSql}
      ORDER BY occurred_at DESC
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return ok({ events: rows, limit });
}
