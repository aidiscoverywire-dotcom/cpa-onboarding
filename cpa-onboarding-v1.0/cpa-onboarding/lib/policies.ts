/**
 * Engagement-policy version helpers.
 *
 * The engagement order (signature-first: DocuSign 08/09 BEFORE Dropbox 10/11)
 * is a VERSIONED policy (`onboarding_policies`: version, engagement_order,
 * migration_rule, compensating_controls). Clients created under an older
 * policy keep their `policy_version`; these helpers answer "is this client on
 * the current policy, and if not, what migration rule applies".
 *
 * Migration rules are data (rows in `onboarding_policies`), not code branches:
 * changing the engagement order means inserting a new policy row with a
 * `migration_rule` + `compensating_controls`, never editing history.
 */
import type { TxClient } from "./db";

export interface OnboardingPolicy {
  id: string;
  version: string;
  engagement_order: string[];
  migration_rule: string;
  compensating_controls: Record<string, unknown> | null;
  is_current: boolean;
  created_at: string;
}

/** The policy row flagged `is_current` (partial unique index guarantees one). */
export async function getCurrentPolicy(tx: TxClient): Promise<OnboardingPolicy> {
  const { rows } = await tx.query<OnboardingPolicy>(
    `SELECT id, version, engagement_order, migration_rule, compensating_controls, is_current, created_at
       FROM onboarding_policies WHERE is_current = true`,
  );
  const policy = rows[0];
  if (!policy) throw new Error("No current onboarding policy (onboarding_policies.is_current).");
  return policy;
}

/** Fetch a specific policy version (throws when unknown). */
export async function getPolicy(tx: TxClient, version: string): Promise<OnboardingPolicy> {
  const { rows } = await tx.query<OnboardingPolicy>(
    `SELECT id, version, engagement_order, migration_rule, compensating_controls, is_current, created_at
       FROM onboarding_policies WHERE version = $1`,
    [version],
  );
  const policy = rows[0];
  if (!policy) throw new Error(`Unknown onboarding policy version: ${version}`);
  return policy;
}

export interface MigrationAssessment {
  clientPolicyVersion: string;
  currentPolicyVersion: string;
  needsMigration: boolean;
  /** The rule to apply for a mid-flow client, from the CURRENT policy row. */
  migrationRule: string | null;
  compensatingControls: Record<string, unknown> | null;
}

/**
 * For a client on `clientPolicyVersion`, decide whether the current policy's
 * migration rule applies. Pure decision helper — the caller records whatever
 * operational steps it takes as audit entries.
 */
export async function assessPolicyMigration(
  tx: TxClient,
  clientPolicyVersion: string,
): Promise<MigrationAssessment> {
  const current = await getCurrentPolicy(tx);
  const needsMigration = clientPolicyVersion !== current.version;
  return {
    clientPolicyVersion,
    currentPolicyVersion: current.version,
    needsMigration,
    migrationRule: needsMigration ? current.migration_rule : null,
    compensatingControls: needsMigration ? current.compensating_controls : null,
  };
}
