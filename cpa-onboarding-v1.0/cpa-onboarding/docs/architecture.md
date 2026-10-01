# Architecture — CPA Client-Onboarding Automation

*Short write-up suitable for attaching to the Firm's WISP (`docs/wisp-v1.md`).*

## 1. System overview

An internal web app for a CPA firm that replaces Calendly + an optional intake form +
an Excel tracker + Dropbox folders + manual email with one staff-operated pipeline.
**The firm** is referred to throughout as "the Firm"; the domain placeholder is
`FIRM_DOMAIN`.

- **One repo, one Next.js build** (App Router, TypeScript, Tailwind/shadcn). No separate
  API framework — API routes in the same build.
- **State machine: XState v5**, enforced **server-side in API routes**. The frontend
  renders `current_state` + `allowed_actions` from the API and never transitions
  client-side.
- **Database:** PostgreSQL — docker-compose locally; Cloud SQL in prod (private IP,
  IAM database authentication, `requireSsl`, automated backups + point-in-time recovery).
- **Deploy:** two Cloud Run services from the one build (see §2).
- **IaC:** Terraform (Cloud Run x2, Cloud SQL, Secret Manager, GCS, Cloud Scheduler,
  IAP). **CI:** GitHub Actions deploying via Workload Identity Federation (keyless —
  no JSON keys stored anywhere).

## 2. The two trust zones

| | Zone A — staff service | Zone B — public webhook ingress |
|---|---|---|
| Exposure | Behind IAP (Identity-Aware Proxy); staff only | Public HTTPS; receives vendor webhooks |
| Service account | Dedicated SA, **has SQL access** + vendor credentials via Secret Manager | Dedicated SA that **can only publish to a bounded Pub/Sub topic** |
| What it cannot do | — | No SQL, no vendor credentials, no secrets |
| Rule | Never one shared runtime identity | — |

Webhook receivers live in Zone B: they verify HMAC signatures on raw request bytes
*before* parsing, apply idempotency checks, and publish to Pub/Sub; downstream
processing happens under Zone A's identity. This bounds the blast radius of a
compromised public endpoint. The tradeoff and residual risks are documented in
`docs/threat-model.md`.

## 3. Data flows per integration

All six integrations sit behind **adapter interfaces with tests**; adapters have mock
implementations + contract tests for dev (external APIs are unreachable in dev).

- **Calendly (booking capture):** webhook `invitee.created` → client created /
  matched in state `01 Booked`. `invitee.canceled` / `invitee.no_show` → terminal
  dispositions (`Canceled` / `No-show`) — prospects are never left stuck in state 02
  or `Stalled`. Signature: `Calendly-Webhook-Signature: t=<unix>,v1=<hex>` =
  HMAC-SHA256(`{ts}.{raw_body}`) on RAW bytes (`await request.body()` before parsing);
  reject timestamps older than ~180s; idempotency on `payload.uri` (unique constraint);
  reschedule = canceled+created pair linked via `old_invitee`/`new_invitee`; 200 only
  after transactional DB write. Never depend on `no_show` alone (fires only on manual
  host marking).
- **Typeform (intake):** webhook → match by normalized email to a booking →
  `02 Intake missing → 03 Intake received`. `02 → 04 Brief ready` ONLY via
  `WAIVE_INTAKE` (staff override, audited, waiver + reason recorded in
  `intake_waivers`). Signature: `Typeform-Signature` = `sha256=` +
  Base64(HMAC-SHA256(raw bytes, secret)), constant-time compare, 401 on
  missing/invalid; idempotency by submission id; replay defense via unique submission
  token + stored raw-body checksum. Intake submitted **before** booking → staff review
  queue (no client to match); matching re-runs when `invitee.created` arrives plus a
  scheduled reconciliation.
- **DocuSign (engagement letter):** staff-approved send → envelope from template
  (`templateId` + `templateRoles` with EXACT `roleName`; `clientUserId` omitted for
  remote email signing). Auth: JWT Grant (integration key + RSA keypair + impersonated
  user GUID; `aud` = `account-d.docusign.com` demo / `account.docusign.com` prod;
  scope `signature impersonation`; token cached ~55 min). Completion = Connect webhook
  (`X-DocuSign-Signature-1` = Base64(HMAC-SHA256(raw body, HMAC key))) + nightly
  polling reconciliation fallback. Completed documents (`documents/combined`,
  incl. Certificate of Completion) download to GCS. **Named Owner/CPA approval gate
  before every send** (see `docs/role-matrix.md`).
- **Gmail (staff email):** `drafts.create` **ONLY**, scope `gmail.compose`, per-user
  OAuth. Refresh tokens stored encrypted (per-user Secret Manager entry or encrypted
  column + KMS — one chosen and documented at build). The app **never** calls
  `drafts.send`/`messages.send`. Covers follow-up drafts and the pre-meeting email
  draft; staff sends from Gmail.
- **Dropbox (document upload):** per-client/per-year file requests; possession-based
  links with expiry + rotation; no PII in URL/title/logs. WISP decision recorded on
  whether possession-based upload is acceptable for SSN-bearing documents
  (`docs/wisp-v1.md` §7).
- **Tax organizer (adapter):** provider **not settled** — TaxCaddy is verified
  client-facing but is NOT the settled provider; discovery must choose ONE upload
  surface (no second client surface next to Dropbox). One staff command writes ONE
  `external_action` + TWO durable outbox steps (`CREATE_DROPBOX_REQUEST` then
  `SEND_ORGANIZER`), each with its own idempotency key; partial failure leaves the
  client at state 10 with only the organizer step retried. `outbox_steps` is durable
  and idempotent.

## 4. Signature-first engagement order (binding)

The engagement order is a **versioned policy** (`onboarding_policies`: version,
engagement_order, migration_rule, compensating_controls), and it is
**signature-first**:

> **DocuSign send (08) → DocuSign signed (09) → Dropbox request ready (10) →
> Organizer sent (11).**

Documents are collected only after the engagement letter is signed. Migration rules
cover clients already mid-flow if the order ever changes. Scope changes
(`SCOPE_CHANGE` from states 08–13) return the client to state 07; unsigned envelopes
are voided, signed envelopes are superseded by amendment. Scope and envelope are
linked explicitly — `engagement_envelopes(scope_id, scope_version, policy_version,
status, supersedes_envelope_id)` — never by accident.

## 5. Nothing sent to clients automatically

This is a deliberate product rule, not a missing feature:

- Every client-facing action is a **staff-confirmed command** or a **draft the staff
  sends manually** (Gmail drafts are create-only).
- Phase 1 stall detection sends a **minimal digest/alert to staff only** — internal
  only, never any client-facing message.
- The pre-meeting email is a Gmail draft from a template; the staff member sends it
  from Gmail.

## 6. State machine summary (14 states + overlays)

```
01 Booked → 02 Intake missing → 03 Intake received → 04 Brief ready →
05 Meeting done → 06 Discount applied → 07 Scope changed → 08 DocuSign sent →
09 DocuSign signed → 10 Dropbox request ready → 11 Organizer sent →
12 Docs partial → 13 Docs complete → 14 Onboarded
```

- **Overlays:** `Stalled` (resumable, any state; re-entry on client activity) and
  terminal dispositions `Canceled` / `No-show` / `Lost`.
- **Commercial bypasses** are explicit transition rules, not prose:
  `05→08`, `06→08`, `06→07`, `07→08`.
- Discount is state `06` + transition/audit history only — no parallel
  `discount_status` column anywhere.
- Every transition: one DB transaction, one append-only `onboarding_transitions` row,
  one audit entry, idempotency keys on webhook-driven events.

Core tables: `clients`, `client_contacts`, `onboarding_transitions` (append-only),
`engagement_scopes` (versioned), `engagement_envelopes`, `onboarding_policies`,
`intake_submissions`, `intake_waivers(waived_by, waiver_reason)`,
`document_requirements` (template per engagement/entity type), `client_documents`,
`external_actions`, `outbox_steps` (durable, idempotent), `users` (Google sub → role),
`stall_rules` (firm-configurable thresholds), `audit_events` (append-only, PII-safe).

## 7. What was live-verified vs. not

Per build honesty rules: external APIs are unreachable in the build environment, so
adapters ship with mock implementations + contract tests. **Live verification status
(no vendor consoles available at build time):** none of the six integrations has been
live-verified end-to-end; Calendly/DocuSign/Gmail API details come from index-level
research (docs read 2026-09-30), not from console testing. Items explicitly not
verified include: Claude/document-AI model IDs and pricing (sources conflict), Calendly
webhook retry schedule and plan gating, IRS breach-notification timelines and penalty
figures from vendor blogs. The build report (`~/workspace/cpa-onboarding-build/BUILD_REPORT.md`)
tracks what needs real credentials before go-live.
