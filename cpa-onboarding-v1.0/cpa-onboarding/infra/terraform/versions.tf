terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Remote state. Create the bucket once (outside this config), then uncomment:
  # backend "gcs" {
  #   bucket = "cpa-onboarding-tfstate"
  #   prefix = "terraform/state"
  # }
}
