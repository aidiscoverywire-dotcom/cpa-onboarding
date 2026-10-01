# CPA Onboarding Automation

Internal web app for a CPA firm. Staff log in with Google Workspace SSO. Replaces
Calendly + optional intake form + Excel + Dropbox + manual email with one pipeline.

**Nothing is ever sent to clients automatically.** Every client-facing action is a
staff-confirmed command or a draft the staff sends manually.

## Quick start (dev)

```bash
cp .env.example .env.local   # fill in values; never commit secrets
npm install
npm run db:migrate           # requires PostgreSQL
npm run dev                  # http://localhost:3000
npm test                     # Vitest — must pass
```

With Docker (recommended):

```bash
docker compose up            # app + PostgreSQL
```

## Layout

- `app/` — Next.js App Router pages (staff UI). `app/api/` — API routes (state machine enforced server-side).
- `lib/states.ts` — the 14 pipeline states + overlays (single source of truth).
- `lib/machine.ts` — XState v5 state machine (server-side only).
- `lib/integrations/` — vendor adapters behind interfaces + mock implementations.
- `db/migrations/` — PostgreSQL schema (append-only audit log with hash chain).
- `infra/` — Terraform, Dockerfile, CI.
- `docs/` — WISP v1, architecture write-up, role matrix, threat model, discovery templates.

## Honesty notes

- External vendor APIs (Calendly, DocuSign, Gmail, Typeform, Dropbox, organizer)
  are unreachable in this dev environment: adapters ship with mock implementations
  and contract tests, clearly marked. Nothing here has been live-verified against
  vendor consoles.
- `INTEGRATIONS_LIVE=false` by default — mocks are used unless explicitly enabled.
