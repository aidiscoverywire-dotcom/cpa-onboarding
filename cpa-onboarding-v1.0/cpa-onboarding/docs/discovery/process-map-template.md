# Discovery Template — Current vs. Future Process Map

*Paid discovery deliverable. Fill in with the Firm during discovery workshops.
"Current" = how onboarding works today; "Future" = how it works with the app.
Reference: the 14-state machine and signature-first order in `../architecture.md`.*

## Instructions

1. Walk each stage with the person who actually does the work today (not just the owner).
2. For every handoff, note the tool used, the trigger, and what breaks when someone is out.
3. Mark every client-facing message with **[C]** — the app will never send these automatically.

## Firm context

| Field | Value |
|---|---|
| Firm name | _[fill]_ |
| Domain (`FIRM_DOMAIN`) | _[fill]_ |
| Participants & roles | _[fill]_ |
| Discovery dates | _[fill]_ |

## Stage-by-stage map

| # | Stage (app state) | Current: tool + owner + trigger | Current pain / failure mode | Future: app behavior | Staff action required |
|---|---|---|---|---|---|
| 1 | `01 Booked` | _e.g. Calendly email → Excel row by [name]_ | _[fill]_ | Calendly webhook creates/matches client | None (automatic capture) |
| 2 | `02 Intake missing` | _[fill]_ | _[fill]_ | Typeform link sent (staff-confirmed) | Confirm send |
| 3 | `03 Intake received` | _[fill]_ | _[fill]_ | Webhook matches by normalized email | Review no-match/multi-match queue |
| 4 | `04 Brief ready` | _[fill]_ | _[fill]_ | Templated brief, named approver | Approve brief; or `WAIVE_INTAKE` (audited) |
| 5 | `05 Meeting done` | _[fill]_ | _[fill]_ | Pre-meeting email as Gmail draft | Send from Gmail |
| 6 | `06 Discount applied` | _[fill]_ | _[fill]_ | State + audit history | Owner approval per role matrix |
| 7 | `07 Scope changed` | _[fill]_ | _[fill]_ | Versioned scope; envelopes voided/superseded | Owner approval |
| 8 | `08 DocuSign sent` | _[fill]_ | _[fill]_ | Envelope from template | **Named Owner/CPA approval before every send** |
| 9 | `09 DocuSign signed` | _[fill]_ | _[fill]_ | Connect webhook + nightly poll; PDF to GCS | None (verify completion) |
| 10 | `10 Dropbox request ready` | _[fill]_ | _[fill]_ | Per-client/per-year file request | Confirm request creation |
| 11 | `11 Organizer sent` | _[fill]_ | _[fill]_ | One staff command → two outbox steps | Confirm command |
| 12–13 | `12 Docs partial` → `13 Docs complete` | _[fill]_ | _[fill]_ | "What's missing" summary; manual acceptance | Accept documents (human decision) |
| 14 | `14 Onboarded` | _[fill]_ | _[fill]_ | Terminal state | None |

## Overlays & exceptions

| Situation | Current handling | Future handling |
|---|---|---|
| Client goes quiet (`Stalled`) | _[fill]_ | Firm-configurable thresholds; **internal staff digest only** |
| Reschedule (Calendly canceled+created) | _[fill]_ | Linked via `old_invitee`/`new_invitee` |
| Cancel / no-show | _[fill]_ | Terminal dispositions; never stuck in 02/`Stalled` |
| Intake before booking | _[fill]_ | Review queue; re-run matching on `invitee.created` |
| Scope change mid-flow (states 08–13) | _[fill]_ | Return to 07; void/supersede envelopes |

## Client-facing touchpoints inventory **[C]**

List every message the client receives today, who sends it, and from which tool.
The app replaces **none** of these with automatic sends — each becomes a
staff-confirmed command or a Gmail draft.

| # | Message | Sent today by / from | Future: command or draft? |
|---|---|---|---|
| 1 | _[fill]_ | _[fill]_ | _[fill]_ |
| 2 | _[fill]_ | _[fill]_ | _[fill]_ |

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner/CPA | | | |
| Discovery lead | | | |
