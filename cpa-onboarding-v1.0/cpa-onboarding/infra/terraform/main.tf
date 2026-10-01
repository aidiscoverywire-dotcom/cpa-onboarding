# CPA onboarding automation — GCP infrastructure.
#
# Two trust zones, one image:
#   staff    = UI behind IAP, private ingress, HAS Cloud SQL + Secret Manager access.
#   webhooks = public ingress for Calendly/Typeform/DocuSign, can ONLY publish to
#              a bounded Pub/Sub topic. No SQL, no secrets.
#
# No service account gets roles/secretmanager.admin or other broad roles.

locals {
  labels = {
    app = "cpa-onboarding"
    env = var.environment
  }

  # Secret Manager secret IDs mirror the env var names in lib/env.ts / .env.example.
  # DOCUSIGN_AUTH_HOST is a non-secret config var and is set as plain env instead.
  app_secrets = toset([
    "DATABASE_URL",
    "GOOGLE_CLIENT_ID",
    "SESSION_SECRET",
    "CALENDLY_SIGNING_KEY",
    "TYPEFORM_SECRET",
    "DOCUSIGN_INTEGRATION_KEY",
    "DOCUSIGN_RSA_PRIVATE_KEY",
    "DOCUSIGN_USER_ID",
    "DOCUSIGN_ACCOUNT_ID",
    "DOCUSIGN_TEMPLATE_ID",
    "DOCUSIGN_CONNECT_HMAC_KEY",
    "DROPBOX_APP_KEY",
    "DROPBOX_APP_SECRET",
    "DROPBOX_REFRESH_TOKEN",
  ])

  apis = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iap.googleapis.com",
    "servicenetworking.googleapis.com",
    "vpcaccess.googleapis.com",
    "compute.googleapis.com",
  ])
}

# ---------------------------------------------------------------- APIs ----

resource "google_project_service" "apis" {
  for_each           = local.apis
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- Network ----

resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = "cpa-onboarding-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  project       = var.project_id
  name          = "cpa-onboarding-subnet"
  ip_cidr_range = "10.10.0.0/24"
  region        = var.region
  network       = google_compute_network.main.id
}

# Private services access for Cloud SQL.
resource "google_compute_global_address" "sql_private_range" {
  project       = var.project_id
  name          = "cpa-onboarding-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
  address       = split("/", var.vpc_cidr)[0]
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_private_range.name]
  depends_on              = [google_project_service.apis]
}

# Serverless VPC Access so Cloud Run can reach Cloud SQL's private IP.
resource "google_vpc_access_connector" "connector" {
  project       = var.project_id
  name          = "cpa-onboarding-conn"
  region        = var.region
  network       = google_compute_network.main.name
  ip_cidr_range = var.connector_cidr
  min_instances = 2
  max_instances = 3
}

# ------------------------------------------------- Service accounts ----

resource "google_service_account" "staff_sa" {
  project      = var.project_id
  account_id   = "cpa-onboarding-staff"
  display_name = "cpa-onboarding staff service (IAP zone)"
}

resource "google_service_account" "webhook_sa" {
  project      = var.project_id
  account_id   = "cpa-onboarding-webhooks"
  display_name = "cpa-onboarding webhook ingress (public zone)"
}

resource "google_service_account" "scheduler_sa" {
  project      = var.project_id
  account_id   = "cpa-onboarding-scheduler"
  display_name = "Cloud Scheduler OIDC caller for stall-check"
}

# staff-sa: read the app secrets (per-secret bindings — least privilege),
# plus Cloud SQL client for the private instance. Never secretmanager.admin.
resource "google_secret_manager_secret_iam_member" "staff_secret_access" {
  for_each  = google_secret_manager_secret.app_secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.staff_sa.email}"
}

resource "google_project_iam_member" "staff_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.staff_sa.email}"
}

# webhook-sa: ONLY Pub/Sub publish on the bounded ingress topic.
# No SQL, no Secret Manager, nothing else.
resource "google_pubsub_topic_iam_member" "webhook_sa_publish" {
  project = var.project_id
  topic   = google_pubsub_topic.webhook_ingress.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.webhook_sa.email}"
}

# ------------------------------------------------------- Cloud SQL ----

resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = "cpa-onboarding-db"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = false # flip to true once prod data exists

  settings {
    tier = var.db_tier
    edition = "ENTERPRISE"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      require_ssl     = true
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "app_db" {
  project  = var.project_id
  name     = "cpa_onboarding"
  instance = google_sql_database_instance.main.name
}

# ------------------------------------------------- Secret Manager ----

resource "google_secret_manager_secret" "app_secrets" {
  for_each  = local.app_secrets
  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}

# Secret VALUES are not managed here — populate them out-of-band
# (gcloud secrets versions add ...) or via a separate, access-controlled
# workflow. Terraform only creates the secret containers.

# ------------------------------------------------------------ GCS ----

resource "google_storage_bucket" "app_artifacts" {
  project                     = var.project_id
  name                        = "${var.project_id}-cpa-onboarding-app-artifacts"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  labels = local.labels

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
    condition {
      age = 90
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      num_newer_versions = 3
      with_state         = "ARCHIVED"
    }
  }

  versioning {
    enabled = true
  }
}

# Audit exports: WORM via Object Retention. Snapshots written here must be
# PII-safe (see §7) so retention does not conflict with secure disposal.
resource "google_storage_bucket" "audit_exports" {
  project                     = var.project_id
  name                        = "${var.project_id}-cpa-onboarding-audit-exports"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  labels = local.labels

  # 7-year retention. is_locked = true is IRREVERSIBLE — lock it only after
  # the firm signs off on the retention period.
  retention_policy {
    is_locked        = false
    retention_period = 220752000 # 7 * 365 * 24 * 3600
  }

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
    condition {
      age = 365
    }
  }
}

# ---------------------------------------------------------- Pub/Sub ----

# Bounded topic: the public webhook service publishes raw vendor events here;
# the staff service subscribes and verifies signatures server-side.
resource "google_pubsub_topic" "webhook_ingress" {
  project = var.project_id
  name    = "cpa-onboarding-webhook-ingress"

  labels = local.labels

  message_retention_duration = "86400s" # 24h, in case staff is down
}

resource "google_pubsub_subscription" "webhook_ingress_staff" {
  project = var.project_id
  name    = "cpa-onboarding-webhook-ingress-staff"
  topic   = google_pubsub_topic.webhook_ingress.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"
  retain_acked_messages      = false
}

# -------------------------------------------------------- Cloud Run ----

# staff: internal-only ingress (fronted by IAP), SQL + secrets access.
resource "google_cloud_run_v2_service" "staff" {
  project  = var.project_id
  name     = "cpa-onboarding-staff"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels = local.labels

  template {
    service_account = google_service_account.staff_sa.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.image

      ports {
        container_port = 3000
      }

      env {
        name  = "SERVICE_ROLE"
        value = "staff"
      }

      env {
        name  = "FIRM_DOMAIN"
        value = var.firm_domain
      }

      env {
        name  = "INTEGRATIONS_LIVE"
        value = "false" # flip per-environment only via explicit var change
      }

      env {
        name  = "DOCUSIGN_AUTH_HOST"
        value = "account.docusign.com" # demo override goes in Secret Manager-backed env if needed
      }

      # Every app secret is injected from Secret Manager at runtime.
      dynamic "env" {
        for_each = google_secret_manager_secret.app_secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
      }
    }

    scaling {
      min_instance_count = 1
      max_instance_count = 4
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.apis]
}

# IAP gate on the staff service: only the firm group gets through.
# Note: the IAP OAuth brand/consent screen is a one-time console setup and is
# not managed here.
resource "google_iap_web_cloud_run_service_iam_binding" "staff_iap" {
  project  = var.project_id
  location = var.region
  service  = google_cloud_run_v2_service.staff.name
  role     = "roles/iap.httpsResourceAccessor"
  members  = ["group:${var.firm_group_email}"]
}

# webhooks: public ingress, publish-only identity. No SQL, no secrets.
resource "google_cloud_run_v2_service" "webhooks" {
  project  = var.project_id
  name     = "cpa-onboarding-webhooks"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  labels = local.labels

  template {
    service_account = google_service_account.webhook_sa.email

    containers {
      image = var.image

      ports {
        container_port = 3000
      }

      env {
        name  = "SERVICE_ROLE"
        value = "webhooks"
      }

      env {
        name  = "WEBHOOK_INGRESS_TOPIC"
        value = google_pubsub_topic.webhook_ingress.name
      }

      env {
        name  = "INTEGRATIONS_LIVE"
        value = "false"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.apis]
}

# Cloud Scheduler needs run.invoker on the webhooks service for OIDC calls.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.webhooks.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_sa.email}"
}

# -------------------------------------------------- Cloud Scheduler ----

resource "google_cloud_scheduler_job" "stall_check" {
  project   = var.project_id
  region    = var.region
  name      = "cpa-onboarding-stall-check"
  schedule  = "*/15 * * * *"
  time_zone = "America/New_York"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.webhooks.uri}/api/jobs/stall-check"

    oidc_token {
      service_account_email = google_service_account.scheduler_sa.email
      audience              = google_cloud_run_v2_service.webhooks.uri
    }
  }

  attempt_deadline = "180s"

  retry_config {
    retry_count = 2
  }

  depends_on = [google_cloud_run_v2_service_iam_member.scheduler_invoker]
}
