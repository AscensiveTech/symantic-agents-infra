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

output "cognito_user_pool_id" {
  description = "Cognito user pool ID for the Symantic frontend."
  value       = aws_cognito_user_pool.frontend.id
}

output "cognito_client_id" {
  description = "Cognito SPA app client ID."
  value       = aws_cognito_user_pool_client.frontend.id
}

output "cognito_issuer" {
  description = "OIDC issuer URL for the Cognito user pool."
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.frontend.id}"
}

output "bff_api_url" {
  description = "Set NEXT_PUBLIC_API_URL to this authenticated HTTP API base URL."
  value       = aws_apigatewayv2_api.bff.api_endpoint
}

output "signwell_webhook_url" {
  description = "Register this callback with SignWell for document events."
  value       = "${aws_apigatewayv2_api.bff.api_endpoint}/webhooks/signwell"
}

output "signwell_secret_name" {
  description = "Secrets Manager entry populated by scripts/configure-signwell.mjs."
  value       = aws_secretsmanager_secret.providers["signwell"].name
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
