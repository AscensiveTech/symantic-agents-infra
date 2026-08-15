output "amplify_app_id" {
  description = "Amplify app ID. Set GitHub Actions repository variable AMPLIFY_APP_ID to this value."
  value       = aws_amplify_app.frontend.id
}

output "amplify_default_domain" {
  description = "Amplify default domain (branch.amplifyapp.com style default_domain)."
  value       = aws_amplify_app.frontend.default_domain
}

output "amplify_branch_name" {
  description = "Production Amplify branch name."
  value       = aws_amplify_branch.main.branch_name
}

output "app_url" {
  description = "Public application URL (custom domain or Amplify default)."
  value       = local.app_url
}

output "ci_deploy_role_arn" {
  description = "Set this as the symantic-agents-frontend GitHub repository secret AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.ci_deploy.arn
}

output "github_setup" {
  description = "Exact GitHub repository secret/variable wiring after apply."
  value       = <<-EOT
    In ${var.github_owner_repo}:
      Repository secret:
        AWS_DEPLOY_ROLE_ARN = ${aws_iam_role.ci_deploy.arn}
      Repository variable:
        AMPLIFY_APP_ID = ${aws_amplify_app.frontend.id}
      Optional variable (defaults to main / us-east-1 in the workflow):
        AMPLIFY_BRANCH = ${var.amplify_branch}
        AWS_REGION = ${var.aws_region}
  EOT
}

output "state_bucket_hint" {
  description = "Expected remote-state bucket name (created by bootstrap/)."
  value       = "symantic-tfstate-${var.aws_account_id}-${var.aws_region}"
}
