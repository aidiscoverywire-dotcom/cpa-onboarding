output "staff_service_name" {
  description = "Cloud Run staff service (IAP-gated, internal ingress)."
  value       = google_cloud_run_v2_service.staff.name
}

output "webhooks_service_url" {
  description = "Public URL of the webhook ingress service."
  value       = google_cloud_run_v2_service.webhooks.uri
}

output "db_instance_connection_name" {
  description = "Cloud SQL instance connection name."
  value       = google_sql_database_instance.main.connection_name
}

output "db_private_ip" {
  description = "Cloud SQL private IP."
  value       = google_sql_database_instance.main.private_ip_address
  sensitive   = true
}

output "webhook_topic" {
  description = "Bounded Pub/Sub topic for raw webhook events."
  value       = google_pubsub_topic.webhook_ingress.name
}

output "audit_exports_bucket" {
  description = "WORM bucket for nightly audit exports."
  value       = google_storage_bucket.audit_exports.name
}

output "app_artifacts_bucket" {
  description = "Bucket for app artifacts (DocuSign combined docs, etc.)."
  value       = google_storage_bucket.app_artifacts.name
}
