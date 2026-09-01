data "archive_file" "oauth" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/oauth"
  output_path = "${path.module}/.terraform/oauth.zip"
  excludes    = ["index.test.mjs"]
}

resource "aws_dynamodb_table" "oauth_states" {
  name         = "${local.name_prefix}-oauth-states"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "state"

  attribute {
    name = "state"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-oauth-states"
  }
}

resource "aws_iam_role" "oauth_lambda" {
  name = "${local.name_prefix}-oauth-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "${local.name_prefix}-oauth-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "oauth_lambda_logs" {
  role       = aws_iam_role.oauth_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "oauth_runtime" {
  name = "${local.name_prefix}-oauth-runtime"
  role = aws_iam_role.oauth_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConsumeOAuthState"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.oauth_states.arn
      },
      {
        Sid      = "ManageCalendarConnection"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["calendar_connections"].arn
      },
      {
        Sid      = "ReadWorkspaceMemberships"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.workspace_memberships.arn
      },
      {
        Sid    = "ReadOAuthSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.providers["google-oauth"].arn,
          aws_secretsmanager_secret.providers["microsoft-oauth"].arn,
        ]
      },
      {
        Sid      = "EncryptCalendarTokens"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt"]
        Resource = aws_kms_key.calendar_tokens.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "oauth_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-oauth"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-oauth"
  }
}

resource "aws_lambda_function" "oauth" {
  function_name = "${local.name_prefix}-oauth"
  description   = "Google and Microsoft calendar OAuth connection service."
  role          = aws_iam_role.oauth_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 20

  filename         = data.archive_file.oauth.output_path
  source_code_hash = data.archive_file.oauth.output_base64sha256

  environment {
    variables = {
      APP_URL                     = local.app_url
      OAUTH_REDIRECT_BASE_URL     = aws_apigatewayv2_api.bff.api_endpoint
      OAUTH_STATE_TTL_SECONDS     = "600"
      OAUTH_STATES_TABLE          = aws_dynamodb_table.oauth_states.name
      CALENDAR_CONNECTIONS_TABLE  = aws_dynamodb_table.control_plane["calendar_connections"].name
      WORKSPACE_MEMBERSHIPS_TABLE = aws_dynamodb_table.workspace_memberships.name
      CALENDAR_TOKENS_KMS_KEY_ID  = aws_kms_key.calendar_tokens.arn
      GOOGLE_OAUTH_SECRET_ARN     = aws_secretsmanager_secret.providers["google-oauth"].arn
      MICROSOFT_OAUTH_SECRET_ARN  = aws_secretsmanager_secret.providers["microsoft-oauth"].arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.oauth_lambda,
    aws_iam_role_policy.oauth_runtime,
    aws_iam_role_policy_attachment.oauth_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-oauth"
  }
}

resource "aws_apigatewayv2_integration" "oauth" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.oauth.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 20000
}

locals {
  oauth_authorized_routes = toset([
    "GET /oauth/{provider}/start",
    "POST /calendars/select",
    "GET /calendars/connection",
    "DELETE /calendars/connection",
  ])
}

resource "aws_apigatewayv2_route" "oauth_authorized" {
  for_each = local.oauth_authorized_routes

  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = each.value
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.bff_jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.oauth.id}"
}

resource "aws_apigatewayv2_route" "oauth_callback" {
  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = "GET /oauth/{provider}/callback"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.oauth.id}"
}

resource "aws_lambda_permission" "oauth_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.oauth.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}
