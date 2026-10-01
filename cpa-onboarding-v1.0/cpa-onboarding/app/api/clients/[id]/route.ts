/**
 * GET /api/clients/[id] — client detail. Auth required.
 *
 * Returns the client row plus `current_state`, `allowed_actions` (from the
 * XState machine for the caller's role), contacts, latest scope, envelopes,
 * document summary, and the policy-migration assessment.
 * The UI renders state + allowed actions from here and never transitions
 * client-side.
 */
import { NextRequest } from "next/server";
import { query, withTx } from "@/lib/db";
import {
  allowedActions,
  baseContext,
  type PersistedState,
} from "@/lib/machine";
import { assessPolicyMigration } from "@/lib/policies";
import { stateLabel, stateNum } from "@/lib/states";
import { err, getSession, ok } from "../../_helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = await getSession(req);
  if (!session) return err(401, "unauthenticated", "Sign in required.");

  const detail = await withTx(async (tx) => {
    const c = await tx.query(
      `SELECT id, display_name, primary_email, entity_type, engagement_type,
              current_state, resume_state, scope_version,
              owner_approval_scope_version, policy_version,
              docs_required, docs_received, calendly_invitee_uri,
              stalled_at, stalled_reason, created_at, updated_at
         FROM clients WHERE id = $1`,
      [params.id],
    );
    const client = c.rows[0];
    if (!client) return null;

    const contacts = await tx.query(
      `SELECT id, name, email, phone, relationship FROM client_contacts
        WHERE client_id = $1 ORDER BY created_at`,
      [params.id],
    );
    const scopes = await tx.query(
      `SELECT id, version, services, fee, discount_pct, status, created_by, created_at
         FROM engagement_scopes WHERE client_id = $1 ORDER BY version DESC`,
      [params.id],
    );
    const envelopes = await tx.query(
      `SELECT id, scope_id, scope_version, policy_version, docusign_envelope_id,
              status, supersedes_envelope_id, created_at, updated_at
         FROM engagement_envelopes WHERE client_id = $1 ORDER BY created_at DESC`,
      [params.id],
    );
    const docs = await tx.query(
      `SELECT status, count(*)::int AS n FROM client_documents
        WHERE client_id = $1 GROUP BY status`,
      [params.id],
    );
    const transitions = await tx.query(
      `SELECT id, from_state, to_state, event, actor_id, actor_type, actor_role,
              created_at FROM onboarding_transitions
        WHERE client_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [params.id],
    );
    const migration = await assessPolicyMigration(tx, client.policy_version);
    return { client, contacts: contacts.rows, scopes: scopes.rows, envelopes: envelopes.rows, docs: docs.rows, transitions: transitions.rows, migration };
  });

  if (!detail) return err(404, "not_found", `Client not found: ${params.id}`);
  const { client } = detail;

  const ctx = {
    ...baseContext(client.id),
    scopeVersion: client.scope_version,
    policyVersion: client.policy_version,
    ownerApprovalForScopeVersion: client.owner_approval_scope_version,
    resumeState: client.resume_state,
    docsRequired: client.docs_required,
    docsReceived: client.docs_received,
    stalledAt: client.stalled_at,
    stalledReason: client.stalled_reason,
  };

  return ok({
    client,
    state: {
      id: client.current_state,
      num: stateNum(client.current_state),
      label: stateLabel(client.current_state),
      resume_state: client.resume_state,
    },
    allowed_actions: allowedActions(
      client.current_state as PersistedState,
      ctx,
      session.role,
    ),
    contacts: detail.contacts,
    scopes: detail.scopes,
    envelopes: detail.envelopes,
    documents_summary: detail.docs,
    recent_transitions: detail.transitions,
    policy_migration: detail.migration,
  });
}
