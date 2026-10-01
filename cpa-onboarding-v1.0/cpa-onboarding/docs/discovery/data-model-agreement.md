# Discovery Template — Data Model & State Machine Sign-off

*Paid discovery deliverable. The Firm confirms each item; items marked
**binding** come from the build brief and cannot be changed without a written
change order. Reference: `../architecture.md` §6, `../role-matrix.md`.*

## A. State machine (binding)

- [ ] The 14 states (`01 Booked` … `14 Onboarded`) cover the Firm's real onboarding flow.
      Deviations noted: _[fill]_
- [ ] Overlays confirmed: `Stalled` (resumable, any state; re-entry on client activity),
      terminal dispositions `Canceled` / `No-show` / `Lost`.
- [ ] **Signature-first order confirmed:** 08/09 (DocuSign) come BEFORE 10/11
      (Dropbox/organizer). Engagement order is a versioned policy (`onboarding_policies`).
- [ ] Commercial bypasses confirmed as explicit rules: `05→08`, `06→08`, `06→07`, `07→08`.
- [ ] `02→04` ONLY via `WAIVE_INTAKE` (staff override, audited, reason recorded).
- [ ] `SCOPE_CHANGE` from states 08–13 returns the client to `07`; unsigned envelopes
      voided, signed envelopes superseded by amendment.
- [ ] Webhook-while-`Stalled` resume transitions defined for: intake submission,
      file upload. Other events: _[fill]_

## B. Core tables (binding — schema fixed; firm confirms semantics)

- [ ] `clients`, `client_contacts` — who is a "client" vs. a "contact" at this firm: _[fill]_
- [ ] `engagement_scopes` (versioned) — what constitutes a scope change here: _[fill]_
- [ ] `engagement_envelopes(scope_id, scope_version, policy_version, status, supersedes_envelope_id)`
      — confirmed: scope↔envelope linkage is explicit, never accidental.
- [ ] `intake_submissions` + `intake_waivers(waived_by, waiver_reason)` — waiver policy: _[fill]_
- [ ] `document_requirements` — template per engagement type / entity type (list the firm's types):
      _[fill]_
- [ ] `client_documents` — who may mark a document accepted (manual, Phase 1): _[fill]_
- [ ] `external_actions` + `outbox_steps` (durable, idempotent) — understood.
- [ ] `users` (Google `sub` → role) — initial user list: _[fill]_
- [ ] `stall_rules` (firm-configurable thresholds) — initial thresholds: _[fill]_
- [ ] `audit_events` (append-only, PII-safe) — understood; retention matrix confirmed in WISP §7.

## C. Integrations inventory & auth decisions

| Integration | Decision needed | Firm answer |
|---|---|---|
| Calendly | Which event types subscribed? (`invitee.created/canceled/no_show`) | _[fill]_ |
| Calendly | Who owns the signing key? Rotation contact? | _[fill]_ |
| Typeform | Intake form ID(s); who edits the form? | _[fill]_ |
| DocuSign | Template ID for engagement letter; exact `roleName`(s) | _[fill]_ |
| DocuSign | JWT consent completed in demo? In prod? Impersonated user GUID? | _[fill]_ |
| DocuSign | Go Live + prod re-consent scheduled? | _[fill]_ |
| Gmail | Per-user OAuth confirmed (no domain-wide delegation in Phase 1)? | _[fill]_ |
| Gmail | Refresh-token storage: per-user Secret Manager entry vs. encrypted column + KMS | _[fill]_ |
| Dropbox | WISP decision: possession-based upload acceptable for SSN-bearing documents? | _[fill]_ |
| Organizer | **ONE upload surface chosen** (no second client surface next to Dropbox) | _[fill]_ |
| Organizer | Provider: TaxCaddy is client-facing but NOT settled — final choice | _[fill]_ |

## D. Role matrix (recommended defaults → firm confirms)

- [ ] Final role assignments (Owner/CPA, Staff, Admin): _[fill names]_
- [ ] DocuSign send approver(s) — named: _[fill]_
- [ ] May Staff approve sends under time-boxed delegation? Default NO. Firm decision: _[fill]_
- [ ] Staff audit-log visibility: own-client only (default) vs. full. Firm decision: _[fill]_
- [ ] Discount bands requiring Owner sign-off: _[fill]_

## E. Migration / backfill

- [ ] Excel tracker import — file location, column mapping: _[fill]_
- [ ] Existing Dropbox folders to adopt — naming convention: _[fill]_
- [ ] Mid-onboarding clients — starting state per client: _[fill]_

## Sign-off

_Changing any binding item after sign-off requires a written change order._

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner/CPA | | | |
| Discovery lead | | | |
