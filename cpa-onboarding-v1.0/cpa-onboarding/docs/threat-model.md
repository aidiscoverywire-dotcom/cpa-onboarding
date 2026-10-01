# Threat Model — CPA Client-Onboarding Automation

## 1. Assets

| Asset | Where it lives | Worst case if compromised |
|---|---|---|
| Client PII (names, emails, SSNs/EINs, account numbers) | Cloud SQL (private IP); intake submissions; organizer answers | Identity theft; regulatory breach (IRS/FTC) |
| Tax documents (W-2s, 1099s, bank statements, returns) | GCS; Dropbox file requests in flight | Client harm; firm liability |
| Credentials (webhook signing keys, DocuSign RSA key, OAuth refresh tokens, DB credentials) | Secret Manager; encrypted storage | Full impersonation of the firm's integrations |
| Signed engagement letters | GCS | Legal exposure |
| Audit log (`audit_events` + WORM export) | Cloud SQL + GCS Object Lock | Loss of tamper evidence |
| Staff sessions / Workspace accounts | Google Workspace | Unauthorized onboarding actions |

## 2. Actors

- **External attacker** — no account; probes public webhook ingress.
- **Malicious/compromised vendor** — abused integration (e.g. forged webhook).
- **Malicious insider / disgruntled staff** — has legitimate access, misuses it.
- **Compromised staff device** — session or token theft.
- **Honest-but-curious staff** — accesses records beyond their clients.
- **Regulator/auditor** — reads the WISP and audit log; non-compliance is itself a risk.

## 3. Threats and mitigations

### T1 — Webhook forgery
*Attacker (or misbehaving vendor) posts a fake Calendly/Typeform/DocuSign event to
move a client through the state machine or exfiltrate via callback behavior.*
- **Mitigations:** HMAC-SHA256 verification on **raw request bytes** before parsing
  (Calendly `t,v1` scheme with ~180s freshness window; Typeform `sha256=` scheme with
  constant-time compare and 401 on failure; DocuSign `X-DocuSign-Signature-1`);
  idempotency keys on every webhook-driven transition (`payload.uri` unique
  constraint for Calendly; submission id for Typeform); replay defense via unique
  submission token + stored raw-body checksum; 200 returned only after a
  transactional DB write.
- **Residual:** a leaked signing key lets an attacker forge events — keys live in
  Secret Manager, rotation is notify-only via Pub/Sub, and repeated verification
  failures alert. Key compromise requires Secret Manager or vendor-console breach.

### T2 — Stolen staff session
*Attacker replays or steals a session cookie / Workspace session.*
- **Mitigations:** Google Workspace SSO (Internal consent screen), server-side
  `hd == FIRM_DOMAIN` enforcement, sessions keyed on Google `sub`, MFA inherited from
  Workspace Admin 2-Step Verification. Staff service sits behind IAP, not on the open
  internet.
- **Residual:** session theft on a compromised device is not stopped by SSO; enforce
  device policy (lock screen, disk encryption) and same-day offboarding per WISP §4.

### T3 — PII in logs
*SSNs, account numbers, or secrets end up in Cloud Logging or the audit trail,
becoming a second, uncontrolled copy of PII.*
- **Mitigations:** redaction policy — never log secrets, token contents, raw request
  bodies, or full PII values; audit log stores identifiers + salted hashes only;
  webhook receivers log verification outcomes, never payloads.
- **Residual:** a developer adding a debug log in a hurry; code review and the
  honesty-rule discipline (no fake tests, real assertions) are the backstop.

### T4 — Dropbox link leakage
*Possession-based file-request links are forwarded, guessed, or indexed, exposing
client tax documents.*
- **Mitigations:** per-client/per-year file requests, link expiry + rotation, no PII
  in URL/title/logs. WISP §7 records the Firm's decision on whether possession-based
  upload is acceptable for SSN-bearing documents (default recommendation: rotated,
  short-expiry links, or the organizer upload surface instead).
- **Residual:** possession links are bearer tokens by design — anyone with the link
  can upload (not download, for file requests). Expiry/rotation bound the window;
  they do not authenticate the uploader.

### T5 — Overly-broad service account
*A single runtime identity with SQL + secrets + Pub/Sub + vendor credentials means one
compromise is total.*
- **Mitigations:** split identities — two Cloud Run services, two trust zones. The
  public webhook ingress SA can **only publish to a bounded Pub/Sub topic** (no SQL,
  no vendor credentials, no secrets). Dedicated SAs per service; never the Compute
  default SA; runtime SAs get `secretAccessor`, never `secretAdmin`; CI deploys via
  Workload Identity Federation (no long-lived JSON keys).

### T6 — Audit-log tampering
*Attacker or insider deletes or rewrites history to hide an action.*
- **Mitigations:** append-only `audit_events` — DB triggers reject
  UPDATE/DELETE/TRUNCATE, REVOKE from app role, SHA-256 hash chain via BEFORE INSERT
  trigger, nightly chain-verification job, nightly export to GCS Object Lock (WORM).
- **Residual (honest boundary):** a PostgreSQL superuser can bypass triggers — the
  app is never run as superuser; the hash chain + WORM export are the compensating
  controls. Snapshots are PII-safe so WORM retention doesn't conflict with disposal.

### T7 — Organizer / second upload surface confusion
*Two client upload surfaces (Dropbox + organizer) split the audit trail and confuse
clients into uploading sensitive documents to the weaker surface.*
- **Mitigations:** discovery must choose ONE upload surface; the organizer is an
  adapter interface until then. One staff command writes ONE `external_action` + TWO
  durable outbox steps, each with its own idempotency key.
- **Residual:** until discovery settles the provider, the adapter boundary is the
  control — the unsettled choice is tracked, not silently defaulted.

## 4. The two-trust-zone tradeoff (explicit)

**Why two zones instead of one service:** the webhook ingress must be public (vendors
call it), and a public endpoint is the most exposed part of the system. Giving that
endpoint SQL access and vendor credentials would make a single RCE or SSRF a total
compromise. Splitting identities means the exposed surface holds nothing worth
stealing — only the ability to publish to a bounded Pub/Sub topic.

**What the split costs:**
- More moving parts (two services, Pub/Sub plumbing, two service accounts to manage).
- Webhook processing is asynchronous — a forged-but-valid event is still processed;
  verification (T1 controls) is the real gate, the zone split is blast-radius control.
- Debugging spans two services; request-id propagation is required to keep the audit
  trail coherent.

**What the split does NOT do:** it does not verify webhook authenticity (HMAC does
that), it does not stop a legitimate-but-malicious staff member (role matrix does
that), and it does not protect PII at rest (encryption + access control do that).

## 5. Residual risks accepted at v1.0

1. **No live verification yet.** Adapters ship with mocks + contract tests; none of
   the six integrations is live-verified end-to-end (no vendor consoles in the build
   environment). Go-live requires credentialed verification per
   `~/workspace/cpa-onboarding-build/BUILD_REPORT.md`.
2. **Organizer provider unsettled.** TaxCaddy is verified client-facing but is not
   the settled provider; the second-surface risk (T7) persists until discovery
   chooses one.
3. **Superuser bypass of audit triggers** (T6) — accepted with hash-chain + WORM
   compensating controls.
4. **Possession-link bearer risk** (T4) — accepted with expiry/rotation; final call
   recorded in WISP §7 at adoption.
5. **Vendor-reported figures** (penalties, breach timelines, ransomware stats) are
   unverified against IRS/FTC publications and are not relied upon anywhere in this
   model.

## 6. Out of scope for v1.0

AI drafting (approval-gated, later phases), Document AI classification/extraction,
fee/discount engine beyond state 06, analytics. Each later phase re-opens this threat
model for the new data flows it introduces.
