-- 001_schema.sql — core schema for the CPA onboarding pipeline.
--
-- Covers every core table in BUILD_BRIEF §4: clients, client_contacts,
-- onboarding_transitions (append-only), engagement_scopes (versioned),
-- engagement_envelopes, onboarding_policies, intake_submissions,
-- intake_waivers, document_requirements, client_documents, external_actions,
-- outbox_steps, users (google_sub UNIQUE → role), stall_rules, audit_events
-- (append-only, §7), plus webhook_deliveries (webhook idempotency receiver).
--
-- Discount exists ONLY as state 06 + transition/audit history — there is
-- deliberately NO discount_status column anywhere in this schema.
--
-- SECURITY MODEL (brief §7):
--   * audit_events + onboarding_transitions are append-only: BEFORE
--     UPDATE/DELETE triggers and a statement-level TRUNCATE trigger raise.
--   * audit_events carries a SHA-256 hash chain via a BEFORE INSERT trigger
--     (canonical JSON of the row + prev_hash).
--   * The least-privilege `cpa_app` role gets SELECT/INSERT on the two
--     append-only tables (UPDATE/DELETE/TRUNCATE revoked) and full DML on
--     the operational tables. Connect the app with this role, never as owner.
--
-- NOTE: written, not executed here — no PostgreSQL is available in this
-- environment. Run `npm run db:migrate` (scripts/migrate.ts) against a live
-- database (docker compose up).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Least-privilege application role (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpa_app') THEN
    CREATE ROLE cpa_app NOLOGIN;
  END IF;
END
$$;

/* ------------------------------------------------------------------ */
/* users — Google sub → role (SSO sessions keyed on sub)                */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub           text NOT NULL UNIQUE,
  email                text NOT NULL,
  name                 text,
  role                 text NOT NULL DEFAULT 'staff'
                       CHECK (role IN ('owner', 'admin', 'partner', 'staff', 'viewer')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

/* ------------------------------------------------------------------ */
/* clients — one row per prospect/client; current_state mirrors the      */
/* XState machine position (lib/machine.ts PersistedState).             */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS clients (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name              text NOT NULL,
  primary_email             text,
  entity_type               text,
  engagement_type           text,
  current_state             text NOT NULL DEFAULT 'booked'
                            CHECK (current_state IN (
                              'booked', 'intake_missing', 'intake_received',
                              'brief_ready', 'meeting_done', 'discount_applied',
                              'scope_changed', 'docusign_sent', 'docusign_signed',
                              'dropbox_request_ready', 'organizer_sent',
                              'docs_partial', 'docs_complete', 'onboarded',
                              'stalled', 'canceled', 'no_show', 'lost'
                            )),
  -- Overlay bookkeeping: when current_state = 'stalled', resume_state holds
  -- the machine state to return to on CLIENT_ACTIVITY.
  resume_state              text,
  -- Machine context persisted per client.
  scope_version             integer NOT NULL DEFAULT 1,
  owner_approval_scope_version integer,
  policy_version            text NOT NULL DEFAULT 'v1',
  docs_required             integer NOT NULL DEFAULT 0,
  docs_received             integer NOT NULL DEFAULT 0,
  calendly_invitee_uri      text UNIQUE,
  stalled_at                timestamptz,
  stalled_reason            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_current_state ON clients (current_state);
CREATE INDEX IF NOT EXISTS idx_clients_primary_email ON clients (lower(primary_email));

CREATE TABLE IF NOT EXISTS client_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id),
  name          text NOT NULL,
  email         text,
  phone         text,
  relationship  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_contacts_client ON client_contacts (client_id);

/* ------------------------------------------------------------------ */
/* onboarding_transitions — APPEND-ONLY machine transition log          */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS onboarding_transitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients (id),
  idempotency_key  text UNIQUE,
  from_state       text NOT NULL,
  to_state         text NOT NULL,
  event            text NOT NULL,
  actor_id         text,
  actor_type       text,
  actor_role       text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transitions_client_created
  ON onboarding_transitions (client_id, created_at);

/* ------------------------------------------------------------------ */
/* engagement_scopes — versioned scopes; SCOPE_CHANGED inserts a row     */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS engagement_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients (id),
  version     integer NOT NULL,
  services    jsonb,
  fee         numeric(12, 2),
  discount_pct numeric(5, 2),
  status      text NOT NULL DEFAULT 'draft',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);

/* ------------------------------------------------------------------ */
/* engagement_envelopes — scope→envelope linkage is EXPLICIT:           */
/* (scope_id, scope_version, policy_version, status,                    */
/*  supersedes_envelope_id). Nothing links scope→envelope by accident.   */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS engagement_envelopes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               uuid NOT NULL REFERENCES clients (id),
  scope_id                uuid REFERENCES engagement_scopes (id),
  scope_version           integer NOT NULL,
  policy_version          text NOT NULL,
  docusign_envelope_id    text UNIQUE,
  status                  text NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created', 'sent', 'voided',
                                            'signed', 'superseded', 'declined')),
  supersedes_envelope_id  uuid REFERENCES engagement_envelopes (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_envelopes_client ON engagement_envelopes (client_id);

/* ------------------------------------------------------------------ */
/* onboarding_policies — versioned engagement order + migration rules    */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS onboarding_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version              text NOT NULL UNIQUE,
  engagement_order     jsonb NOT NULL,
  migration_rule       text NOT NULL,
  compensating_controls jsonb,
  is_current           boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- Exactly one current policy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policies_current
  ON onboarding_policies (is_current) WHERE is_current = true;

/* ------------------------------------------------------------------ */
/* intake_submissions — Typeform receiver (idempotent, replay-safe)      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS intake_submissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  typeform_submission_id text NOT NULL UNIQUE,
  raw_body_checksum      text NOT NULL,
  -- Normalized submitter email (lower/trim) for booking matching.
  email_normalized       text,
  matched_client_id      uuid REFERENCES clients (id),
  status                 text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'matched', 'needs_review')),
  answers                jsonb,
  received_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intake_submissions_email
  ON intake_submissions (email_normalized);

CREATE TABLE IF NOT EXISTS intake_waivers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id),
  waived_by     text NOT NULL,
  waiver_reason text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

/* ------------------------------------------------------------------ */
/* document_requirements — expected-document templates per              */
/* engagement type / entity type; client_documents — received files      */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS document_requirements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_type text,
  entity_type     text,
  doc_key         text NOT NULL,
  label           text NOT NULL,
  required        boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients (id),
  requirement_id uuid REFERENCES document_requirements (id),
  file_name      text,
  dropbox_path   text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'received', 'accepted', 'rejected')),
  received_at    timestamptz,
  accepted_at    timestamptz,
  accepted_by    text
);
CREATE INDEX IF NOT EXISTS idx_client_documents_client
  ON client_documents (client_id);

/* ------------------------------------------------------------------ */
/* external_actions + outbox_steps — durable, idempotent staff commands  */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS external_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients (id),
  action_type     text NOT NULL,
  idempotency_key text UNIQUE,
  status          text NOT NULL DEFAULT 'pending',
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_action_id uuid NOT NULL REFERENCES external_actions (id),
  step_type          text NOT NULL,
  idempotency_key    text UNIQUE,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'done', 'failed')),
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_steps_action
  ON outbox_steps (external_action_id);

/* ------------------------------------------------------------------ */
/* stall_rules — firm-configurable stall thresholds                     */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS stall_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state           text NOT NULL UNIQUE,
  threshold_hours integer NOT NULL,
  enabled         boolean NOT NULL DEFAULT true
);

/* ------------------------------------------------------------------ */
/* webhook_deliveries — receiver-side idempotency for vendor webhooks    */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  provider     text NOT NULL,
  delivery_id  text NOT NULL,
  client_id    uuid REFERENCES clients (id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, delivery_id)
);

/* ------------------------------------------------------------------ */
/* audit_events — APPEND-ONLY, hash-chained (brief §7)                   */
/* Snapshots are PII-redacted by the writer (lib/audit.ts) BEFORE the    */
/* insert, so WORM retention never conflicts with secure disposal.       */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text,
  actor_type  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  ip          text,
  request_id  text,
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity_time
  ON audit_events (entity, entity_id, occurred_at);

/* ------------------------------------------------------------------ */
/* Append-only enforcement: UPDATE/DELETE/TRUNCATE all raise            */
/* ------------------------------------------------------------------ */
CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_no_mutation ON audit_events;
CREATE TRIGGER trg_audit_events_no_mutation
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS trg_transitions_no_mutation ON onboarding_transitions;
CREATE TRIGGER trg_transitions_no_mutation
  BEFORE UPDATE OR DELETE ON onboarding_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS trg_transitions_no_truncate ON onboarding_transitions;
CREATE TRIGGER trg_transitions_no_truncate
  BEFORE TRUNCATE ON onboarding_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

/* ------------------------------------------------------------------ */
/* SHA-256 hash chain on audit_events (BEFORE INSERT)                    */
/* canonical JSON of the row's content + prev_hash. Genesis prev_hash   */
/* is the literal 'GENESIS'.                                            */
/* ------------------------------------------------------------------ */
CREATE OR REPLACE FUNCTION audit_events_hash_chain()
RETURNS trigger AS $$
DECLARE
  prev      text;
  canonical text;
BEGIN
  SELECT a.hash INTO prev
    FROM audit_events AS a
   ORDER BY a.occurred_at DESC, a.id DESC
   LIMIT 1;
  IF prev IS NULL THEN
    prev := 'GENESIS';
  END IF;
  NEW.prev_hash := prev;
  canonical := jsonb_build_object(
    'action',      NEW.action,
    'actor',       NEW.actor,
    'actor_type',  NEW.actor_type,
    'after',       NEW.after,
    'before',      NEW.before,
    'entity',      NEW.entity,
    'entity_id',   NEW.entity_id,
    'ip',          NEW.ip,
    'occurred_at', NEW.occurred_at,
    'prev_hash',   prev,
    'request_id',  NEW.request_id
  )::text;
  NEW.hash := encode(digest(canonical, 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_hash_chain ON audit_events;
CREATE TRIGGER trg_audit_events_hash_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_hash_chain();

/* ------------------------------------------------------------------ */
/* Least-privilege grants for cpa_app                                    */
/* ------------------------------------------------------------------ */
GRANT USAGE ON SCHEMA public TO cpa_app;

-- Operational tables: full DML for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, clients, client_contacts,
  engagement_scopes, engagement_envelopes, onboarding_policies,
  intake_submissions, intake_waivers,
  document_requirements, client_documents,
  external_actions, outbox_steps,
  stall_rules, webhook_deliveries
  TO cpa_app;

-- Append-only tables: SELECT + INSERT only; mutation explicitly revoked.
GRANT SELECT, INSERT ON audit_events, onboarding_transitions TO cpa_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, onboarding_transitions FROM cpa_app;
REVOKE ALL ON audit_events, onboarding_transitions FROM PUBLIC;

-- gen_random_uuid() defaults need no sequence grants (no serial columns),
-- but keep future sequences usable:
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cpa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cpa_app;

/* ------------------------------------------------------------------ */
/* Seed: v1 engagement policy (signature-first) + default stall rules   */
/* ------------------------------------------------------------------ */
INSERT INTO onboarding_policies
  (version, engagement_order, migration_rule, compensating_controls, is_current)
VALUES (
  'v1',
  '["08 DocuSign sent", "09 DocuSign signed", "10 Dropbox request ready", "11 Organizer sent"]'::jsonb,
  'Clients already past 08 under an older order keep their order for the current engagement; any SCOPE_CHANGED re-baselines them onto the current policy version. New scopes are always created under the current policy.',
  '{"requires_owner_reapproval_on_scope_change": true, "void_unsigned_envelopes_on_scope_change": true}'::jsonb,
  true
)
ON CONFLICT (version) DO NOTHING;

INSERT INTO stall_rules (state, threshold_hours, enabled) VALUES
  ('default', 72, true),
  ('booked', 48, true),
  ('intake_missing', 72, true),
  ('brief_ready', 96, true),
  ('docusign_sent', 120, true),
  ('docs_partial', 168, true)
ON CONFLICT (state) DO NOTHING;
