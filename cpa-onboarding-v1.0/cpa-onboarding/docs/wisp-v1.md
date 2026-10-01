# Written Information Security Program (WISP) v1

**Scope:** the Firm's client-onboarding automation app (internal web app replacing
Calendly + intake form + Excel tracker + Dropbox folders + manual email with one
pipeline). See also `docs/architecture.md` (system overview) and `docs/threat-model.md`.

**Basis:** IRS Publication 4557 (Safeguarding Taxpayer Data) and the FTC Safeguards Rule.
This document is the Firm's written plan; the Owner/CPA must adopt it and record the
adoption date in §9 before go-live.

> **Verification notice:** statistics, penalty figures, and breach-notification
> timelines quoted on vendor blogs (e.g. "$100k/violation" penalty claims, ransomware
> trend figures, an "IRS 24-hour breach notification" rule, Pub 5708 MFA details) are
> **vendor-reported — verify against the actual IRS/FTC publications before citing**.
> They are not repeated as fact anywhere in this document.

**Firm name / domain:** this document uses "the Firm" and the placeholder
`FIRM_DOMAIN` (e.g. `FIRM_DOMAIN` = `firm.com`). Fill in the real values at adoption.

---

## §1 — Designated security coordinator

The Owner/CPA is the designated security coordinator and the "qualified individual"
under the FTC Safeguards Rule. The coordinator:

- Owns this WISP and its annual review (§9).
- Approves all client-facing template changes (engagement letter template, intake form,
  email drafts, organizer template).
- Is the named approver on every DocuSign engagement-letter send (see `docs/role-matrix.md`).
- Is the escalation point for security incidents (§8) and stall-rule management.

At adoption, record the coordinator's name, role, and effective date here:

| Field | Value |
|---|---|
| Security coordinator | _[name, role — fill at adoption]_ |
| Effective date | _[fill at adoption]_ |

## §2 — Risk assessment

### 2.1 Systems and data inventory

| Asset | Location | Classification |
|---|---|---|
| Client PII (names, emails, SSNs/EINs, account numbers) | Cloud SQL (private IP), intake submissions | Confidential — highest protection |
| Tax documents and organizer answers | Google Cloud Storage (GCS) | Confidential |
| Signed engagement letters (PDF + Certificate of Completion) | GCS | Confidential |
| Credentials and webhook signing secrets | Secret Manager | Confidential — app SA gets `secretAccessor` only |
| Staff OAuth refresh tokens (Gmail) | Secret Manager per-user entry, or encrypted column + KMS | Confidential |
| Append-only audit log (`audit_events`) | Cloud SQL + nightly WORM export to GCS Object Lock | Confidential, tamper-evident |
| Vendor data passing through | Calendly, Typeform, DocuSign, Dropbox, organizer provider | Confidential in transit |

### 2.2 Threats, likelihood, impact

| Threat | Likelihood | Impact | Mitigating controls (this doc) |
|---|---|---|---|
| Webhook forgery (fake Calendly/Typeform/DocuSign event) | Medium | Medium | HMAC signature verification on raw bytes, timestamp freshness, idempotency (§3, `architecture.md`) |
| Stolen staff session | Medium | High | Google Workspace SSO + MFA (§3), server-side `hd` enforcement |
| PII written to logs | Medium | High | Redaction policy — never log secrets/tokens/full PII (§3) |
| Dropbox upload-link leakage | Low–Medium | High | Possession links with expiry + rotation; WISP decision on SSN-bearing documents (§7) |
| Overly-broad service account | Low | High | Split identities: two trust zones, no shared runtime identity (§3) |
| Audit-log tampering | Low | High | Append-only triggers + hash chain + WORM export (§3) |
| Vendor breach or vendor account takeover | Low | High | Vendor oversight (§5), minimal scopes, separate webhook ingress SA |

This assessment is repeated at least annually (§9) and after any material change
(new integration, new data type, incident).

## §3 — Safeguards implementation

### Administrative
- **Access on a need-to-know basis.** Three roles — Owner/CPA, Staff, Admin — with the
  action matrix in `docs/role-matrix.md`. The client confirms the final matrix in discovery.
- **Owner approval gates.** Engagement-letter sends, discount application, scope changes,
  and intake waivers require named approval by role; every approval writes an audit entry.
- **No automatic client communication.** Nothing is ever sent to clients automatically.
  Every client-facing action is a staff-confirmed command or a draft the staff sends
  manually from Gmail. Gmail automation uses `drafts.create` only; `drafts.send` /
  `messages.send` are never called by the app.

### Technical — authentication and access control
- **Google Workspace SSO**, OAuth consent screen set to **Internal** (employees of the
  Firm only).
- **Server-side `hd` claim enforcement:** after ID-token verification, the backend
  requires `hd == FIRM_DOMAIN`. The `hd` request parameter is a UX hint only, never a
  security boundary. Sessions are keyed on the Google `sub` (stable user identifier),
  not on email.
- **MFA inherited from Workspace Admin:** 2-Step Verification is enforced for all Firm
  accounts; the app relies on this rather than a separate factor. Verify Pub 5708's MFA
  requirements against the actual publication before asserting compliance scope.
- **IAM least privilege:** dedicated service account per Cloud Run service; never the
  Compute default SA. Runtime service accounts get `secretAccessor`, never `secretAdmin`.

### Technical — the two trust zones (binding)
- **Zone A — staff service:** Cloud Run behind IAP (Identity-Aware Proxy). This is the
  only service with Cloud SQL access and vendor credentials.
- **Zone B — public webhook ingress:** a second Cloud Run service with a **separate
  service account that can only publish to a bounded Pub/Sub topic**. No SQL, no vendor
  credentials. Webhook receivers validate HMAC signatures on raw bytes and return 200
  only after the transactional DB write.
- Never one shared runtime identity. The full rationale and residual risk are in
  `docs/threat-model.md`.

### Technical — encryption
- **In transit:** TLS everywhere (Cloud Run managed certificates); Cloud SQL
  `requireSsl` enforced.
- **At rest:** GCS and Cloud SQL default encryption (CMEK optional); Secret Manager for
  all credentials and signing keys; Gmail refresh tokens encrypted.

### Technical — webhook verification (exact controls)
- **Calendly:** `Calendly-Webhook-Signature: t=<unix>,v1=<hex>` equals
  HMAC-SHA256(`{ts}.{raw_body}`) against RAW request bytes; reject timestamps older
  than ~180 seconds; idempotency on `payload.uri` (unique constraint).
- **Typeform:** `Typeform-Signature` = `sha256=` + Base64(HMAC-SHA256(raw bytes, secret)),
  constant-time compare; 401 on missing/invalid; idempotency by submission id; replay
  defense via unique submission token + stored raw-body checksum.
- **DocuSign Connect:** verify `X-DocuSign-Signature-1` = Base64(HMAC-SHA256(raw body,
  HMAC key)); nightly polling reconciliation fallback for missed events.

### Technical — audit log
- `audit_events` is append-only: DB triggers reject UPDATE/DELETE/TRUNCATE, app role is
  REVOKEd from those operations, SHA-256 hash chain via BEFORE INSERT trigger, nightly
  chain-verification job, and nightly export to a GCS bucket with Object Lock (WORM).
- **Snapshots must be PII-safe:** redacted/excluded PII so WORM retention does not
  conflict with secure disposal (§7).
- Never log secrets, token contents, raw request bodies, or full PII values (log
  identifiers + salted hashes only).
- Honest boundary: DB triggers stop the app and ordinary DB users; a PostgreSQL
  superuser could bypass triggers — the app is never run as superuser, and the hash
  chain + WORM export are the compensating controls.

### Physical
- Staff devices used for onboarding work are covered by the Firm's device policy
  (lock screen, disk encryption, lost-device remote wipe). Cloud infrastructure has no
  Firm-owned physical footprint (Google Cloud data centers).

## §4 — Employee management & training

- **Onboarding checklist:** every new staff member with app access gets a Workspace
  account in the Firm domain, MFA enrolled before first login, role assigned per the
  role matrix, and a WISP acknowledgment signed and filed.
- **Annual security training** covering: phishing recognition, SSN/EIN handling rules,
  "never send client documents outside the approved upload surfaces", and incident
  reporting (who to call, §8).
- **Phishing exercises** at least annually; results reviewed by the coordinator.
- **Offboarding checklist:** Workspace account suspended on the last day; OAuth grants
  revoked; session keys invalidated; role removed in the app; confirmation logged to
  the audit log.

## §5 — Information systems management

### Asset inventory (firm fills in at adoption)

| Asset | Owner | Patching / review cadence |
|---|---|---|
| Cloud Run services (staff, webhook ingress) | _fill_ | CI/CD via GitHub Actions, keyless deploys (Workload Identity Federation) |
| Cloud SQL instance | _fill_ | Automated backups + point-in-time recovery; restore tests |
| Secret Manager entries | _fill_ | Rotation notify-only (Pub/Sub SECRET_ROTATE); runtime SAs `secretAccessor` only |
| Staff devices | _fill_ | OS/browser auto-update; MDM if used |

### Change management
- All infrastructure and app changes go through GitHub PRs with review; Terraform-managed
  resources only; CI checks must pass before deploy.

### Vendor list (as of v1.0)

| Vendor | Purpose | Auth model | Notes |
|---|---|---|---|
| Calendly | Booking capture (webhooks `invitee.created/canceled/no_show`) | Org-scoped webhook subscription + own signing key in Secret Manager | Never depend on `no_show` alone — it fires only on manual host marking |
| DocuSign | Engagement-letter envelopes (template) + Connect webhook | JWT Grant (integration key + RSA keypair + impersonated user GUID; `account-d.docusign.com` demo / `account.docusign.com` prod; scope `signature impersonation`) | Token cached ~55 min; one-time consent per environment; Go Live + re-consent for prod |
| Google (Workspace, Gmail, GCP) | SSO, Gmail drafts, hosting, storage, DB | Per-user OAuth for Gmail (`gmail.compose` scope only); Workload Identity Federation for CI | Consent screen Production (Testing-mode refresh tokens die in 7 days) |
| Dropbox | Client document upload (file requests) | Per-client/per-year file requests | Possession links with expiry + rotation; WISP decision on SSN-bearing documents recorded in §7 |
| Typeform | Intake submissions (webhook) | HMAC shared secret in Secret Manager | Match by normalized email to booking; review queue on no-match/multi-match |
| Tax organizer | Client tax questionnaire/answers | Adapter interface — **provider not settled** | Discovery must choose ONE upload surface (no second client surface next to Dropbox) |

Vendor oversight: confirm each vendor's data-processing/security terms before go-live;
prefer vendors with published security documentation; re-review on contract renewal.
(TaxCaddy is verified to be client-facing — it is NOT the settled provider; the
decision is recorded here so the Firm does not treat a demo as a commitment.)

## §6 — Detecting & managing system failures

- **Monitoring:** Cloud Logging for both Cloud Run services; log-router sink to GCS for
  retention; alerts on 5xx spikes, failed webhook verifications, and audit-chain
  verification failures.
- **Webhook health:** failed HMAC verifications, timestamp rejections, and idempotency
  conflicts are logged (without payloads) and alerted; repeated failures indicate
  key rotation needs or an attack.
- **Log review cadence:** staff access logs reviewed monthly by the coordinator;
  audit-chain verification runs nightly with automatic alert on mismatch/gap.
- **Maintenance windows:** scheduled changes are applied via CI/CD; emergency security
  patches are applied same-day and recorded in §9's review log.

## §7 — Data disposal & retention

### Retention schedule (firm confirms at adoption)

| Record type | Retention | Notes |
|---|---|---|
| Tax returns and supporting documents | 7 years (verify against the actual IRS/state requirement before finalizing) | _Firm confirms_ |
| Signed engagement letters | Life of engagement + 7 years | _Firm confirms_ |
| PII access logs | 6 years | Per compliance research recommendation |
| Authorization/permission changes | 2 years | _Firm confirms_ |
| Operational onboarding events (state transitions) | 90 days hot / 1 year cold | _Firm confirms_ |
| Sensitive actions (refunds, deletions) | 7 years | _Firm confirms_ |

### Secure disposal
- Electronic records: crypto-shredding via key destruction (CMEK) where used; otherwise
  secure delete followed by audit-log entry. Paper records: cross-cut shredding.
- Offboarded-staff data handled per §4.

### Audit snapshots and the WORM conflict (binding rule)
- Nightly audit exports to the Object Lock (WORM) bucket **must be PII-safe** —
  redacted/excluded PII — so that immutable retention does not conflict with secure
  disposal when a record's retention expires. If PII-safe snapshots cannot be
  guaranteed, the coordinator must approve a compensating control in writing before
  go-live.

### Dropbox upload links
- File-request links are possession-based with expiry and rotation. **WISP decision
  (recorded here at adoption):** whether possession-based upload is acceptable for
  SSN-bearing documents. Default recommendation: SSN-bearing documents use the organizer
  upload surface or a rotated, short-expiry link — the Firm records its final decision
  and the compensating control in this section.

## §8 — Incident response plan

### Roles
| Role | Responsibility |
|---|---|
| Owner/CPA (coordinator) | Declares incidents, approves notifications, client communication |
| Admin | Technical containment (key rotation, access revocation, service isolation) |
| Staff | Report suspected incidents immediately; preserve evidence |

### Steps
1. **Detect & report** — any staff member who suspects an incident (phishing success,
   suspicious webhook traffic, unexpected document access) reports to the coordinator
   the same day.
2. **Contain** — revoke/rotate the affected credentials (Workspace session, webhook
   signing key, DocuSign keys, OAuth grants); isolate the affected service if needed.
3. **Eradicate & recover** — remove the cause, restore from verified backups, verify
   the audit hash chain, and re-verify webhook signing secrets.
4. **Notify** — client, IRS, and state notifications follow the timelines in the
   applicable publications. **Vendor-reported timelines (e.g. an "IRS 24-hour rule")
   are not relied upon until confirmed against the actual IRS/FTC publications.**
5. **Learn** — post-incident review within 14 days; findings recorded in §9's log;
   WISP updated if a control gap caused the incident.

An annual tabletop exercise (walk through a simulated incident) is recommended.

## §9 — Annual review & update

The coordinator reviews this WISP at least annually and records each review below.
Update triggers (review immediately, don't wait for the annual date): new software or
integration, staff changes in security roles, any security incident, or a change to
the engagement order policy (`onboarding_policies` version bump).

| Date | Reviewer | Changes | Signature |
|---|---|---|---|
| _[adoption date]_ | _[coordinator]_ | v1.0 adopted | |
| | | | |

---

*Document control: WISP v1.0 — created 2026-09-30. Adoption date and firm details to
be filled at adoption. Attachments: `docs/architecture.md`, `docs/threat-model.md`,
`docs/role-matrix.md`.*
