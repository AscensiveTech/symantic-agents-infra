variable "aws_region" {
  description = "AWS region for the Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile."
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

variable "environment" {
  description = "Environment label for tags."
  type        = string
  default     = "dev"
}
