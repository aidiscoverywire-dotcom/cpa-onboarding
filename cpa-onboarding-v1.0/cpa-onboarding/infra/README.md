# Infrastructure — CPA onboarding automation

Everything under `infra/` plus the repo-root Docker assets. **Not validated in
this environment**: there are no `terraform` or `docker` binaries here, so
nothing was planned, applied, built, or run. Treat all of this as
hand-checked, unexecuted IaC.

## Files

| File | What it does |
|---|---|
| `Dockerfile` (repo root) | Multi-stage build: `node:20-alpine` deps → builder (`npm ci`, `npm run build`) → runner. Runner uses the Next.js `output: "standalone"` server (`node server.js`), runs as non-root user `nextjs`, respects `PORT`, binds `0.0.0.0`. |
| `.dockerignore` (repo root) | Keeps `node_modules`, `.next`, `.env*` (except `.env.example`), `.git`, tests, docs, and `infra/` out of the image. Secrets can never be baked in. |
| `docker-compose.yml` (repo root) | Local dev: `db` (postgres:16-alpine, `pg_isready` healthcheck, named volume `pgdata`, `POSTGRES_USER/PASSWORD/DB` from env with `cpa`/`cpa`/`cpa_onboarding` defaults) + `app` (built from the Dockerfile, `env_file: .env.local`, `SERVICE_ROLE=staff`, waits for db `service_healthy`, `3000:3000`). |
| `infra/terraform/versions.tf` | `required_version >= 1.6.0`, `hashicorp/google ~> 6.0`. GCS backend block is commented — create the state bucket once, then uncomment. |
| `infra/terraform/variables.tf` | `project_id`, `region`, `firm_domain`, `firm_group_email` (IAP accessor group), `db_tier`, `image` (image **digest** — both services deploy from the same one), VPC CIDRs, `environment`. |
| `infra/terraform/main.tf` | All GCP resources (below). |
| `infra/terraform/outputs.tf` | Service names/URLs, DB connection name, topic, bucket names. |
| `.github/workflows/ci.yml` | CI/CD (below). |

## What main.tf builds

- **Two Cloud Run services from one image digest** — `cpa-onboarding-staff`
  (ingress `INGRESS_TRAFFIC_INTERNAL_ONLY`, env `SERVICE_ROLE=staff`) and
  `cpa-onboarding-webhooks` (ingress `INGRESS_TRAFFIC_ALL`, env
  `SERVICE_ROLE=webhooks`).
- **Two service accounts** — `staff-sa` and `webhook-sa`.
  - `staff-sa` gets `roles/secretmanager.secretAccessor` **per secret**
    (no project-wide grant, never `secretmanager.admin`) and
    `roles/cloudsql.client`.
  - `webhook-sa` gets **only** `roles/pubsub.publisher` on the single bounded
    topic `cpa-onboarding-webhook-ingress`. No SQL, no secrets, nothing else.
- **Cloud SQL** — Postgres 16, private IP via private services access
  (no public IPv4), `require_ssl = true`, automated backups + PITR, IAM DB
  authentication flag on. Deletion protection is `false` in the config — flip
  to `true` once prod data exists.
- **Secret Manager** — one secret per app secret (see list below). Terraform
  creates the secret *containers only*; values are added out-of-band
  (`gcloud secrets versions add ...`) or by a separate access-controlled flow.
  The staff service injects every secret at runtime via `secret_key_ref`.
- **GCS** — `app-artifacts` (Nearline after 90d, versioned) and
  `audit-exports` with a 7-year retention policy (WORM). `is_locked` is
  deliberately `false` — locking is irreversible, so lock it only after the
  firm signs off on the retention period. Nightly audit exports written here
  must be PII-safe (see §7 of the build brief) so WORM does not conflict with
  secure disposal.
- **Pub/Sub** — `cpa-onboarding-webhook-ingress` topic + staff subscription.
  Webhook ingress publishes raw vendor events; the staff service subscribes
  and verifies signatures server-side. 24h message retention covers staff
  downtime.
- **Cloud Scheduler** — `cpa-onboarding-stall-check`, every 15 min, POST to
  `https://<webhooks-url>/api/jobs/stall-check` with an OIDC token from a
  dedicated scheduler SA (granted `roles/run.invoker` on the webhooks service
  only).
- Supporting: VPC + private services access + Serverless VPC Access connector
  (Cloud Run → Cloud SQL private IP), required API enablements.
- **Not managed here**: the IAP OAuth brand/consent screen (one-time console
  setup). The IAP IAM binding on the staff service *is* managed here.

## Two-trust-zone rationale

One runtime identity would let a signature-verification bug in the public
webhook path reach the database and vendor credentials. Splitting into two
services with two identities contains that blast radius:

- **Public zone (webhooks)** can be hit by anyone on the internet, so it holds
  nothing worth stealing: no DB access, no secrets. Its only power is
  appending raw events to one Pub/Sub topic.
- **Private zone (staff)** is unreachable from the internet (internal ingress
  + IAP group check), holds SQL and all integration secrets, and does the
  actual signature verification and state transitions.

Compromise of the public zone yields an attacker… the ability to publish
unverifiable events that the staff service rejects.

## Secret Manager secret names

Exactly the env var names from `lib/env.ts` / `.env.example`:

```
DATABASE_URL, GOOGLE_CLIENT_ID, SESSION_SECRET,
CALENDLY_SIGNING_KEY, TYPEFORM_SECRET,
DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_RSA_PRIVATE_KEY, DOCUSIGN_USER_ID,
DOCUSIGN_ACCOUNT_ID, DOCUSIGN_TEMPLATE_ID, DOCUSIGN_CONNECT_HMAC_KEY,
DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
```

(`DOCUSIGN_AUTH_HOST` is non-secret config and is set as a plain env var.)

## GitHub secrets / variables required by CI

| Name | Type | Purpose |
|---|---|---|
| `WIF_PROVIDER` | secret | Workload Identity Federation provider resource name |
| `DEPLOY_SA` | secret | Deploy service account email (Artifact Registry writer, Cloud Run admin, Secret Manager accessor for `DATABASE_URL`) |
| `TERRAFORM_PLAN_SA` | secret | Read-only SA used by the PR `terraform plan` step |
| `PROJECT_ID` | variable | GCP project |
| `REGION` | variable | Deploy region |
| `FIRM_DOMAIN` | variable | Firm Workspace domain |
| `FIRM_GROUP_EMAIL` | variable | IAP accessor group |
| `IMAGE_REPO` | variable | Artifact Registry repo, e.g. `us-central1-docker.pkg.dev/PROJECT/cpa-onboarding/app` |

Auth is keyless OIDC federation — **no JSON service-account keys anywhere**.

## CI pipeline (`.github/workflows/ci.yml`)

1. **`build-test`** (every push/PR): checkout → Node 20 → `npm ci` →
   `npx tsc --noEmit` → `npm test` → `npm run build`.
2. **`terraform-plan`** (PRs touching `infra/` only): fmt check, init,
   validate, then `terraform plan` with read-only WIF creds. **CI never
   applies** — applies are manual (`terraform apply`) by a human with the
   deploy identity.
3. **`deploy`** (pushes to `main` only, needs `build-test`): WIF auth →
   build the image **once**, push by git SHA → deploy the **same digest** to
   both Cloud Run services with different `SERVICE_ROLE` env → fetch
   `DATABASE_URL` from Secret Manager → `npx tsx scripts/migrate.ts`.

Known gap (honest): Cloud SQL has no public IP, so GitHub-hosted runners
cannot reach it for the migrate step. Either run migrations from a
self-hosted runner with a Cloud SQL Auth Proxy sidecar, or replace the step
with a Cloud Run job inside the VPC. The workflow documents this inline.

## Local dev ordering note

`docker compose up --build` brings up `db` then `app`, and `depends_on:
service_healthy` ensures Postgres accepts connections before the app
container starts — but Postgres may still be replaying WAL / initializing
when the app boots. **`lib/db.ts` must retry the initial connection with
backoff** rather than failing fast on the first refused connection, or the
app will crash-loop on cold starts.
