data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name_prefix = "symantic-${var.environment}"

  # Public app URL: custom domain if provided, else Amplify default.
  app_url = var.app_url != "" ? var.app_url : "https://${var.amplify_branch}.${aws_amplify_app.frontend.default_domain}"
}
