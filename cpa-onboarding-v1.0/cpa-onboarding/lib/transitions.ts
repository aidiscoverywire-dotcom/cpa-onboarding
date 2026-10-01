/**
 * DB-side transition helpers used by the API routes.
 *
 * `applyClientTransition()` is the single funnel for every state change:
 *   1. one transaction,
 *   2. idempotency-key check (unique constraint on `onboarding_transitions`),
 *   3. SELECT ... FOR UPDATE on the client row,
 *   4. pure machine `transition()` (throws TransitionNotAllowed),
 *   5. append-only `onboarding_transitions` row per machine step,
 *   6. `clients` row update,
 *   7. one PII-redacted audit row,
 *   8. COMMIT — the route answers 200 only after this resolves.
 *
 * Also hosts small DB helpers routes need: user upsert (SSO callback),
 * external-action + outbox-step creation (durable, idempotent).
 */
import { withTx, type TxClient } from "./db";
import {
  baseContext,
  transition,
  TransitionNotAllowed,
  type ActorRef,
  type CpaContext,
  type MachineEvent,
  type PersistedState,
  type TransitionStep,
} from "./machine";
import { appendAudit } from "./audit";

export { TransitionNotAllowed };

/* ------------------------------------------------------------------ */
/* Client state load                                                   */
/* ------------------------------------------------------------------ */

export interface ClientStateRow {
  id: string;
  current_state: string;
  resume_state: string | null;
  scope_version: number;
  owner_approval_scope_version: number | null;
  policy_version: string;
  docs_required: number;
  docs_received: number;
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** Load + lock the client's state row. Throws NotFoundError. */
export async function getClientForUpdate(
  tx: TxClient,
  clientId: string,
): Promise<ClientStateRow> {
  const { rows } = await tx.query<ClientStateRow>(
    `SELECT id, current_state, resume_state, scope_version,
            owner_approval_scope_version, policy_version,
            docs_required, docs_received
       FROM clients WHERE id = $1 FOR UPDATE`,
    [clientId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("client", clientId);
  return row;
}

export function contextFromRow(clientId: string, row: ClientStateRow): CpaContext {
  return {
    ...baseContext(clientId),
    scopeVersion: row.scope_version,
    policyVersion: row.policy_version,
    ownerApprovalForScopeVersion: row.owner_approval_scope_version,
    resumeState: row.resume_state as CpaContext["resumeState"],
    docsRequired: row.docs_required,
    docsReceived: row.docs_received,
  };
}

/* ------------------------------------------------------------------ */
/* applyClientTransition                                               */
/* ------------------------------------------------------------------ */

export interface ApplyTransitionInput {
  clientId: string;
  event: MachineEvent;
  /** Idempotency key (header `Idempotency-Key` or body). Generated when absent. */
  idempotencyKey?: string | null;
  ip?: string | null;
  requestId?: string | null;
  /** Override the audit action name (default: `transition:<EVENT>`). */
  auditAction?: string;
}

export interface ApplyTransitionResult {
  clientId: string;
  from: PersistedState;
  state: PersistedState;
  /** Machine context after the transition (scope version, envelope flags…). */
  context: CpaContext;
  steps: TransitionStep[];
  /** True when the idempotency key was already seen — no new rows written. */
  deduped: boolean;
}

interface StoredTransition {
  from_state: string;
  to_state: string;
  event: string;
}

export async function applyClientTransition(
  input: ApplyTransitionInput,
): Promise<ApplyTransitionResult> {
  return withTx((tx) => applyClientTransitionTx(tx, input));
}

/**
 * Tx-scoped variant: runs inside the caller's transaction so routes can add
 * side-effect writes (waiver rows, scope rows, envelope rows) atomically with
 * the transition. The caller commits.
 */
export async function applyClientTransitionTx(
  tx: TxClient,
  input: ApplyTransitionInput,
): Promise<ApplyTransitionResult> {
  const key = input.idempotencyKey ?? null;
  {
    // 1. Idempotency: a seen key returns the previously recorded outcome.
    if (key) {
      const seen = await tx.query<StoredTransition>(
        `SELECT from_state, to_state, event FROM onboarding_transitions
          WHERE idempotency_key = $1`,
        [key],
      );
      const prior = seen.rows[0];
      if (prior) {
        const row = await getClientForUpdate(tx, input.clientId);
        return {
          clientId: input.clientId,
          from: prior.from_state as PersistedState,
          state: prior.to_state as PersistedState,
          context: contextFromRow(input.clientId, row),
          steps: [
            {
              from: prior.from_state as PersistedState,
              to: prior.to_state as PersistedState,
              event: prior.event as TransitionStep["event"],
            },
          ],
          deduped: true,
        };
      }
    }

    // 2-3. Lock + pure machine transition.
    const row = await getClientForUpdate(tx, input.clientId);
    const from = row.current_state as PersistedState;
    const ctx = contextFromRow(input.clientId, row);
    const { state, context, steps } = transition(from, input.event, ctx);

    // 4. Append-only transition rows (one per machine step).
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepKey =
        key === null ? null : i === 0 ? key : `${key}:step${i + 1}`;
      const inserted = await tx.query(
        `INSERT INTO onboarding_transitions
           (client_id, idempotency_key, from_state, to_state, event,
            actor_id, actor_type, actor_role, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.clientId,
          stepKey,
          step.from,
          step.to,
          step.event,
          input.event.actor.id,
          input.event.actor.type,
          input.event.actor.role,
          JSON.stringify({ event: input.event }),
        ],
      );
      if (inserted.rowCount === 0 && stepKey !== null) {
        // Lost a race with a concurrent identical request: return its outcome.
        const winner = await tx.query<StoredTransition>(
          `SELECT from_state, to_state, event FROM onboarding_transitions
            WHERE idempotency_key = $1`,
          [stepKey],
        );
        const w = winner.rows[0];
        if (!w) throw new Error("Idempotency conflict with no visible winner");
        const raceRow = await getClientForUpdate(tx, input.clientId);
        return {
          clientId: input.clientId,
          from: w.from_state as PersistedState,
          state: w.to_state as PersistedState,
          context: contextFromRow(input.clientId, raceRow),
          steps: [
            {
              from: w.from_state as PersistedState,
              to: w.to_state as PersistedState,
              event: w.event as TransitionStep["event"],
            },
          ],
          deduped: true,
        };
      }
    }

    // 5. Persist the new machine position + context.
    await tx.query(
      `UPDATE clients SET
         current_state = $1,
         resume_state = $2,
         scope_version = $3,
         owner_approval_scope_version = $4,
         docs_required = $5,
         docs_received = $6,
         stalled_at = $7::timestamptz,
         stalled_reason = $8,
         updated_at = now()
       WHERE id = $9`,
      [
        state,
        context.resumeState,
        context.scopeVersion,
        context.ownerApprovalForScopeVersion,
        context.docsRequired,
        context.docsReceived,
        context.stalledAt,
        context.stalledReason,
        input.clientId,
      ],
    );

    // 6. One audit row for the whole transition (PII-redacted by appendAudit).
    await appendAudit(tx, {
      actor: input.event.actor.id,
      actorType: input.event.actor.type,
      action: input.auditAction ?? `transition:${input.event.type}`,
      entity: "client",
      entityId: input.clientId,
      before: { state: from, scopeVersion: ctx.scopeVersion },
      after: {
        state,
        steps,
        scopeVersion: context.scopeVersion,
        voidUnsignedEnvelope: context.voidUnsignedEnvelope,
        supersedeSignedEnvelope: context.supersedeSignedEnvelope,
      },
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
    });

    return { clientId: input.clientId, from, state, context, steps, deduped: false };
  }
}

/* ------------------------------------------------------------------ */
/* Users (SSO callback)                                                */
/* ------------------------------------------------------------------ */

export interface UpsertUserInput {
  sub: string;
  email: string;
  name?: string;
}

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * Upsert a user keyed on Google `sub`. The role is NEVER overwritten on
 * re-login — role changes go through user management (audited).
 * Bootstrap: the very first user becomes `owner`; everyone else `viewer`
 * (least privilege — the owner upgrades roles).
 */
export async function upsertUserByGoogleSub(
  tx: TxClient,
  input: UpsertUserInput,
): Promise<{ user: UserRow; created: boolean }> {
  const count = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users`,
  );
  const isFirst = count.rows[0]?.n === "0";
  const { rows } = await tx.query<UserRow>(
    `INSERT INTO users (google_sub, email, name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       updated_at = now()
     RETURNING id, google_sub, email, name, role`,
    [input.sub, input.email, input.name ?? null, isFirst ? "owner" : "viewer"],
  );
  const user = rows[0];
  if (!user) throw new Error("upsertUserByGoogleSub: no row returned");
  return { user, created: isFirst };
}

/* ------------------------------------------------------------------ */
/* External actions + outbox steps (durable, idempotent)               */
/* ------------------------------------------------------------------ */

export interface OutboxStepSpec {
  stepType: string;
  idempotencyKey?: string | null;
}

/**
 * One staff command → ONE external_action + N outbox steps, each with its own
 * idempotency key (brief §5: CREATE_DROPBOX_REQUEST then SEND_ORGANIZER).
 * Idempotent: an existing action idempotency key returns the existing rows.
 */
export async function createExternalActionWithSteps(
  tx: TxClient,
  input: {
    clientId: string;
    actionType: string;
    idempotencyKey?: string | null;
    payload?: unknown;
    steps: OutboxStepSpec[];
  },
): Promise<{ actionId: string; stepIds: string[]; deduped: boolean }> {
  const key = input.idempotencyKey ?? null;
  if (key) {
    const seen = await tx.query<{ id: string }>(
      `SELECT id FROM external_actions WHERE idempotency_key = $1`,
      [key],
    );
    if (seen.rows[0]) {
      const steps = await tx.query<{ id: string }>(
        `SELECT id FROM outbox_steps WHERE external_action_id = $1 ORDER BY created_at`,
        [seen.rows[0].id],
      );
      return {
        actionId: seen.rows[0].id,
        stepIds: steps.rows.map((r) => r.id),
        deduped: true,
      };
    }
  }

  const action = await tx.query<{ id: string }>(
    `INSERT INTO external_actions (client_id, action_type, idempotency_key, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.clientId,
      input.actionType,
      key,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  let actionId = action.rows[0]?.id;
  if (!actionId) {
    // Lost the race — fetch the winner.
    const winner = await tx.query<{ id: string }>(
      `SELECT id FROM external_actions WHERE idempotency_key = $1`,
      [key],
    );
    const w = winner.rows[0];
    if (!w) throw new Error("External-action idempotency conflict with no winner");
    const steps = await tx.query<{ id: string }>(
      `SELECT id FROM outbox_steps WHERE external_action_id = $1 ORDER BY created_at`,
      [w.id],
    );
    return { actionId: w.id, stepIds: steps.rows.map((r) => r.id), deduped: true };
  }

  const stepIds: string[] = [];
  for (const step of input.steps) {
    const s = await tx.query<{ id: string }>(
      `INSERT INTO outbox_steps (external_action_id, step_type, idempotency_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [actionId, step.stepType, step.idempotencyKey ?? null],
    );
    if (s.rows[0]) {
      stepIds.push(s.rows[0].id);
    } else {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM outbox_steps
          WHERE external_action_id = $1 AND step_type = $2`,
        [actionId, step.stepType],
      );
      if (existing.rows[0]) stepIds.push(existing.rows[0].id);
    }
  }
  return { actionId, stepIds, deduped: false };
}

/** Build an ActorRef for a signed-in staff user. */
export function userActor(
  sub: string,
  role: string,
): ActorRef {
  return { id: sub, type: "user", role: role as ActorRef["role"] };
}

/** ActorRef for verified vendor webhooks. */
export function webhookActor(provider: "calendly" | "docusign" | "typeform"): ActorRef {
  return { id: `webhook:${provider}`, type: "webhook", role: "webhook" };
}

/** ActorRef for scheduled jobs. */
export function systemActor(job: string): ActorRef {
  return { id: `job:${job}`, type: "system", role: "system" };
}
