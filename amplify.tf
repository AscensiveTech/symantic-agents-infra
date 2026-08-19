# Amplify Hosting for symantic-agents-frontend (Next.js 15 SSR / WEB_COMPUTE).
# GitHub Actions starts RELEASE jobs via OIDC; auto-build is disabled.

data "aws_iam_policy_document" "amplify_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["amplify.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "amplify_ssr" {
  name               = "${local.name_prefix}-amplify-ssr"
  assume_role_policy = data.aws_iam_policy_document.amplify_assume.json

  tags = {
    Name = "${local.name_prefix}-amplify-ssr"
  }
}

resource "aws_iam_role_policy" "amplify_ssr_logs" {
  name = "ssr-cloudwatch-logs"
  role = aws_iam_role.amplify_ssr.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/amplify/*"
    }]
  })
}

# Server-only cookie/signing secret for /api/agent-registry (>= 32 chars).
resource "random_password" "agent_registry_secret" {
  length  = 48
  special = false
}

resource "aws_amplify_app" "frontend" {
  name                 = "${local.name_prefix}-agents"
  repository           = var.amplify_repository_url
  access_token         = var.amplify_github_access_token != "" ? var.amplify_github_access_token : null
  platform             = "WEB_COMPUTE"
  iam_service_role_arn = aws_iam_role.amplify_ssr.arn

  # Fallback build_spec; repo amplify.yml overrides once Amplify clones the branch.
  build_spec = <<-EOT
    version: 1
    frontend:
      phases:
        preBuild:
          commands:
            - nvm use 20 || nvm install 20
            - node -v
            - npm ci
            - echo "AGENT_REGISTRY_SECRET=$AGENT_REGISTRY_SECRET" >> .env.production
            - env | grep -e NEXT_PUBLIC_ >> .env.production
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: .next
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
          - .next/cache/**/*
  EOT

  environment_variables = {
    _LIVE_UPDATES = jsonencode([{
      name    = "Node.js version"
      pkg     = "node"
      type    = "nvm"
      version = "20.19.0"
    }])
  }

  # The GitHub connection token and console-normalized build-spec line endings are
  # write-only/provider-managed after app creation. The repository's amplify.yml
  # remains the production build source of truth.
  lifecycle {
    ignore_changes = [access_token, build_spec]
  }

  tags = {
    Name = "${local.name_prefix}-agents"
  }
}

resource "aws_amplify_branch" "main" {
  app_id            = aws_amplify_app.frontend.id
  branch_name       = var.amplify_branch
  framework         = "Next.js - SSR"
  stage             = "PRODUCTION"
  enable_auto_build = false

  environment_variables = {
    AGENT_REGISTRY_SECRET            = random_password.agent_registry_secret.result
    NEXT_PUBLIC_API_URL              = aws_apigatewayv2_api.bff.api_endpoint
    NEXT_PUBLIC_COGNITO_DOMAIN       = "https://${aws_cognito_user_pool_domain.frontend.domain}.auth.${var.aws_region}.amazoncognito.com"
    NEXT_PUBLIC_COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.frontend.id
    NEXT_PUBLIC_COGNITO_REDIRECT_URI = "${trimsuffix(local.app_url, "/")}/auth/callback"
    NEXT_PUBLIC_COGNITO_LOGOUT_URI   = trimsuffix(local.app_url, "/")
  }
}
