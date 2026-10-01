variable "project_id" {
  type        = string
  description = "GCP project ID hosting the CPA onboarding app."
}

variable "region" {
  type        = string
  description = "GCP region for Cloud Run, Cloud SQL and Scheduler."
  default     = "us-central1"
}

variable "firm_domain" {
  type        = string
  description = "Google Workspace domain of the CPA firm (hd claim enforcement, IAP group)."
}

variable "firm_group_email" {
  type        = string
  description = "Google Group whose members may access the staff service via IAP."
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
  default     = "db-custom-2-7680"
}

variable "image" {
  type        = string
  description = "Container image WITH digest, e.g. REGION-docker.pkg.dev/PROJECT/REPO/app@sha256:.... Both Cloud Run services deploy from this same digest."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR for the private services-access range used by Cloud SQL."
  default     = "10.20.0.0/20"
}

variable "connector_cidr" {
  type        = string
  description = "CIDR for the Serverless VPC Access connector."
  default     = "10.21.0.0/28"
}

variable "environment" {
  type        = string
  description = "Label applied to all resources (prod, staging, ...)."
  default     = "prod"
}
