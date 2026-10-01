# Role Matrix — Recommended Defaults

> **The client confirms these in discovery.** The table below is the *recommended
> default*; the Firm signs off the final version during the paid discovery phase
> (see `docs/discovery/data-model-agreement.md`). Roles are stored in `users`
> (Google `sub` → role).

## Roles

| Role | Who | Scope |
|---|---|---|
| **Owner/CPA** | Firm owner / signing CPA | Everything, including all approval gates |
| **Staff** | Preparers, associates, front-office | Day-to-day onboarding operations |
| **Admin** | IT / operations administrator | Technical configuration, no client commercial decisions |

Owner/CPA is the security coordinator under the WISP (`docs/wisp-v1.md` §1).

## Action matrix

✅ = allowed · ❌ = not allowed · 🔒 = allowed with conditions

| Action | Owner/CPA | Staff | Admin | Notes |
|---|---|---|---|---|
| **Waive intake** (`02→04` via `WAIVE_INTAKE`) | ✅ | 🔒 with Owner approval + reason | ❌ | Waiver + reason recorded in `intake_waivers`; audit entry |
| **Apply discount** (state `06`) | ✅ | 🔒 with Owner approval | ❌ | No parallel `discount_status` column — state + history only |
| **Change scope** (→ state `07`) | ✅ | 🔒 with Owner approval | ❌ | From states 08–13 returns client to 07; unsigned envelopes voided, signed superseded by amendment |
| **Approve DocuSign send** | ✅ (named approver) | ❌ | ❌ | Named Owner/CPA approval gate before **every** send; cannot be delegated below Owner/CPA by default |
| **Create engagement-letter draft/envelope payload** | ✅ | ✅ | ❌ | Drafting ≠ approving; send is blocked until Owner approves |
| **Run organizer command** (one staff command → one `external_action` + two outbox steps) | ✅ | ✅ | ❌ | Idempotent; partial failure leaves client at state 10 |
| **Accept documents** (manual acceptance; Phase 1 = manual) | ✅ | ✅ | ❌ | "What's missing" summary is owner-facing; acceptance is a human decision |
| **Manage stall rules** (thresholds in `stall_rules`) | ✅ | ❌ | ✅ | Config change is audited; staff receive digests, don't edit thresholds |
| **View audit log** | ✅ | 🔒 own-client actions only | ✅ | Staff sees events for clients they work on; full log is Owner/Admin |
| **Export audit snapshot** (WORM export verification) | ✅ | ❌ | ✅ | Exports must be PII-safe per WISP §7 |
| **Manage user roles** | ✅ | ❌ | ✅ | Role changes are audit-logged |
| **Approve client-facing template changes** (engagement letter, intake, email, organizer) | ✅ | ❌ | ❌ | Owner-only; feeds the signature-first policy |
| **Send client email / Gmail drafts** | ✅ | ✅ | ❌ | Drafts are create-only; a human sends from Gmail |

## Principles behind the defaults

1. **Commercial risk stays with the Owner/CPA.** Anything that changes what the
   client pays (discount), what the firm owes (scope), or what binds the firm legally
   (engagement letter) requires Owner approval. Staff can prepare, never commit.
2. **Approval gates are blocking, not advisory.** A DocuSign send cannot proceed
   without the named approval; the app enforces this in the state machine, not in
   policy prose.
3. **Auditability over convenience.** Every gated action writes an actor, action,
   timestamp, entity, and before/after snapshot to the append-only audit log.
4. **Admin is technical, not commercial.** Admin can configure thresholds, roles, and
   exports but cannot waive intake, discount, change scope, or approve sends.

## Open for discovery

- Whether Staff may approve DocuSign sends when the Owner is unavailable (e.g.
  time-boxed delegation) — default is NO; the Firm decides.
- Whether any Staff member should see the full audit log (default: own-client only).
- The exact discount bands that always require Owner sign-off vs. pre-authorized
  ranges.
