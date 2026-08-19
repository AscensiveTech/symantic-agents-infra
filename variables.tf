# ---------------------------------------------------------------------------
# Account / region / tagging
# ---------------------------------------------------------------------------
variable "aws_region" {
  description = "AWS region for Amplify Hosting and related resources."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Named AWS CLI/SDK profile. Empty = default credential chain (CI)."
  type        = string
  default     = "ascensiveAdmin"
}

variable "aws_account_id" {
  description = "Expected AWS account ID guardrail."
  type        = string
  default     = "883155611064"

  validation {
    condition     = can(regex("^\\d{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "project" {
  description = "Project tag."
  type        = string
  default     = "Symantic"
}

variable "environment" {
  description = "Environment (dev/stage/prod). Drives resource naming."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "environment must be one of: dev, stage, prod."
  }
}

variable "company" {
  description = "Owning entity tag."
  type        = string
  default     = "AscensiveTech"
}

# ---------------------------------------------------------------------------
# Amplify (Next.js SSR)
# ---------------------------------------------------------------------------
variable "amplify_repository_url" {
  description = "HTTPS Git URL of symantic-agents-frontend."
  type        = string
  default     = "https://github.com/AscensiveTech/symantic-agents-frontend"
}

variable "amplify_github_access_token" {
  description = "GitHub PAT for Amplify to connect the repo (GitHub App access). Pass via TF_VAR_, never commit."
  type        = string
  default     = ""
  sensitive   = true

}

variable "amplify_branch" {
  description = "Git branch Amplify builds (production)."
  type        = string
  default     = "main"
}

variable "app_url" {
  description = "Public custom-domain URL. Empty = Amplify default *.amplifyapp.com."
  type        = string
  default     = "https://agents.symantic.ai"
}

variable "domain_root_zone" {
  description = "Route53 hosted zone (root domain) for the custom domain."
  type        = string
  default     = "symantic.ai"
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC deploy role
# ---------------------------------------------------------------------------
variable "github_owner_repo" {
  description = "owner/repo (human-readable). Not used as the OIDC sub — AscensiveTech mints unique IDs."
  type        = string
  default     = "AscensiveTech/symantic-agents-frontend"
}

variable "github_org_id" {
  description = "GitHub org numeric id (Settings → General, or CloudTrail userName). Required because the org enables unique-ID OIDC subjects."
  type        = string
  default     = "212477424"
}

variable "github_repo_id" {
  description = "GitHub repo numeric id for symantic-agents-frontend (API node_id / CloudTrail userName)."
  type        = string
  default     = "1315122090"
}

variable "create_github_oidc_provider" {
  description = "true to create the GitHub Actions OIDC provider; false to reuse one already in the account."
  type        = bool
  default     = false
}
