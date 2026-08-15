# Partial S3 backend. Real values come from:
#   terraform init -backend-config=backend-config/dev.hcl
# Requires Terraform >= 1.10 for native S3 lockfiles (use_lockfile = true).
terraform {
  backend "s3" {}
}
