/**
 * Append-only audit writer.
 *
 * Every state-changing route calls `appendAudit()` inside the SAME database
 * transaction as the state change: one transition row + one audit row, 200
 * only after commit.
 *
 * PII safety (BUILD_BRIEF §7): `before`/`after` snapshots are deep-redacted
 * via `redactPII()` HERE, before the insert — so the WORM-retained
 * `audit_events` rows never conflict with secure disposal. The SHA-256 hash
 * chain and the UPDATE/DELETE/TRUNCATE rejection triggers live in the DB
 * (`db/migrations/001_schema.sql`); this writer only ever INSERTs.
 */
import type { TxClient } from "./db";
import { redactPII } from "./redact";

export interface AuditInput {
  actor: string;
  actorType: "user" | "webhook" | "system";
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  actor: string;
  actor_type: string;
  action: string;
  entity: string;
  entity_id: string;
}

/**
 * Insert one audit row. `prev_hash`/`hash` are computed by the
 * `audit_events_hash_chain` BEFORE INSERT trigger — callers never set them.
 * Must be called inside a transaction (pass the tx client).
 */
export async function appendAudit(
  tx: TxClient,
  input: AuditInput,
): Promise<AuditRow> {
  const { rows } = await tx.query<AuditRow>(
    `INSERT INTO audit_events
       (actor, actor_type, action, entity, entity_id, before, after, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
     RETURNING id, occurred_at, actor, actor_type, action, entity, entity_id`,
    [
      input.actor,
      input.actorType,
      input.action,
      input.entity,
      input.entityId,
      JSON.stringify(redactPII(input.before ?? null)),
      JSON.stringify(redactPII(input.after ?? null)),
      input.ip ?? null,
      input.requestId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("appendAudit: insert returned no row");
  return row;
}
