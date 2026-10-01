# Discovery Template — Phased Plan with Acceptance Criteria

*Paid discovery deliverable. Phase 1 scope is binding (from the build brief); later
phases are planning only. Every phase ends with explicit acceptance criteria the
Firm signs.*

## Phase 1 — MVP (binding scope)

| # | Feature | Acceptance criteria |
|---|---|---|
| 1 | Calendly capture + state machine | `invitee.created` creates/matches client at `01 Booked`; canceled/no-show land in terminal dispositions; reschedule links old/new invitee; all webhook-driven transitions idempotent |
| 2 | Intake form + templated brief (staff-reviewed) | Typeform webhook → `03 Intake received` on email match; no-match/multi-match → review queue; brief template renders from booking + intake; `04 Brief ready` only after named approval |
| 3 | Document checklist + GCS uploads | `document_requirements` generated per entity type/scope; "what's missing" summary visible to owner; **Phase 1 = manual acceptance, stated explicitly** |
| 4 | DocuSign engagement letter (template + Connect) | Envelope created from template with exact `roleName`; named Owner/CPA approval before every send; Connect webhook drives `09 DocuSign signed`; nightly poll reconciles; completed PDF (+ Certificate of Completion) in GCS |
| 5 | Gmail drafts (create-only) | `drafts.create` only; staff sends from Gmail; covers follow-ups and pre-meeting email draft; `gmail.compose` scope; no `drafts.send`/`messages.send` calls exist in code |
| 6 | Workspace SSO | Internal consent screen; server-side `hd == FIRM_DOMAIN`; sessions keyed on Google `sub`; MFA via Workspace Admin |
| 7 | Append-only audit log | Triggers reject UPDATE/DELETE/TRUNCATE; REVOKE from app role; hash chain verified nightly; nightly PII-safe export to WORM bucket |
| 8 | WISP v1 | This doc set adopted: `wisp-v1.md` signed, coordinator named, retention matrix filled |
| 9 | Stall detection (Phase 1) | Cloud Scheduler → stall-check job; firm-configurable thresholds in `stall_rules`; **minimal digest/alert to staff only — internal, never client-facing** |
| 10 | Migration/backfill | Excel tracker imported; existing Dropbox folders adopted; mid-onboarding clients assigned starting states |

**Explicitly NOT in Phase 1:** AI drafting (stays approval-gated for later phases —
do NOT pull forward), Document AI classification/extraction, fee/discount engine
beyond state 06, analytics, automatic client emails of any kind.

## Phase 2 — (planning; scope confirmed after Phase 1 acceptance)

| Candidate | Acceptance criteria (draft) |
|---|---|
| Document AI classification/extraction | Processor versions pinned; confidence < threshold → staff review queue; never auto-accept low-confidence SSN/amount fields |
| Claude drafting with approval gates | Model output → DB draft (`pending_review`) → staff approves in UI (diff view) → Gmail draft → human sends; model has no send tools; model id + token usage logged per draft |
| Stall detection v2 | _[define in Phase 2 planning]_ |
| Fee/discount engine + scope-version billing | Fee + signed letter always reference scope version |

## Phase 3 — (planning)

| Candidate | Notes |
|---|---|
| Analytics | _[define later]_ |
| _[fill]_ | |

## Fixed-fee boundaries

_What is included in the fixed fee vs. billed as change orders. Binding items from
the build brief cannot be descoped without a change order._

| Included | Change order |
|---|---|
| _[fill — Phase 1 items above]_ | Binding scope changes (state machine, signature-first order, trust zones) |
| | New integrations beyond the six |
| | AI drafting pulled into Phase 1 (explicitly excluded) |

## Go-live checklist (before production cutover)

- [ ] All six integrations live-verified with real credentials (none were verifiable
      in the build environment — see `../architecture.md` §7)
- [ ] DocuSign Go Live completed; prod consent + impersonated user GUID recorded
- [ ] Webhook signing keys in Secret Manager; verification tested per vendor
- [ ] Cloud SQL backups + PITR restore test passed
- [ ] Audit hash-chain verification job green; WORM export confirmed PII-safe
- [ ] WISP v1 adopted and signed; coordinator named
- [ ] Role matrix confirmed; initial users provisioned with MFA
- [ ] Staff training completed; acknowledgments filed
- [ ] Migration/backfill completed and spot-checked

## Sign-off

| Phase | Accepted by (Owner/CPA) | Date | Signature |
|---|---|---|---|
| Phase 1 | | | |
| Phase 2 (when planned) | | | |
