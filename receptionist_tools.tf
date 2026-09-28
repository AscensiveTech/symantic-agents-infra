variable "tools_provisioned_concurrency" {
  description = "Always-warm copies of the Retell tools Lambda (zero cold start on live calls). Right-sized to real concurrency: at current volume 1-2 covers ~100% of calls; 5+ is headroom that never gets used."
  type        = number
  default     = 2

  validation {
    condition = (
      var.tools_provisioned_concurrency >= 1 &&
      var.tools_provisioned_concurrency <= 20 &&
      floor(var.tools_provisioned_concurrency) == var.tools_provisioned_concurrency
    )
    error_message = "tools_provisioned_concurrency must be an integer from 1 through 20."
  }
}

data "archive_file" "tools" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/tools"
  output_path = "${path.module}/.terraform/tools.zip"
  excludes    = ["index.test.mjs"]
}

resource "aws_iam_role" "tools_lambda" {
  name = "${local.name_prefix}-tools-lambda"

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
    Name = "${local.name_prefix}-tools-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "tools_lambda_logs" {
  role       = aws_iam_role.tools_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "tools_runtime" {
  name = "${local.name_prefix}-tools-runtime"
  role = aws_iam_role.tools_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadWriteToolRecords"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.control_plane["appointments"].arn,
          aws_dynamodb_table.control_plane["leads"].arn,
          aws_dynamodb_table.control_plane["messages"].arn,
          aws_dynamodb_table.control_plane["calls"].arn,
          aws_dynamodb_table.control_plane["calendar_connections"].arn,
          aws_dynamodb_table.control_plane["agents"].arn,
          aws_dynamodb_table.control_plane["business_profiles"].arn,
        ]
      },
      {
        Sid    = "UseCalendarTokenKey"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Encrypt",
        ]
        Resource = aws_kms_key.calendar_tokens.arn
      },
      {
        Sid    = "ReadProviderSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.providers["retell"].arn,
          aws_secretsmanager_secret.providers["google-oauth"].arn,
          aws_secretsmanager_secret.providers["microsoft-oauth"].arn,
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "tools_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-tools"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-tools"
  }
}

resource "aws_lambda_function" "tools" {
  function_name = "${local.name_prefix}-tools"
  description   = "Signature-verified Retell calendar, lead, message, and transfer tools."
  role          = aws_iam_role.tools_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 10
  publish       = true

  filename         = data.archive_file.tools.output_path
  source_code_hash = data.archive_file.tools.output_base64sha256

  environment {
    variables = {
      APPOINTMENTS_TABLE         = aws_dynamodb_table.control_plane["appointments"].name
      LEADS_TABLE                = aws_dynamodb_table.control_plane["leads"].name
      MESSAGES_TABLE             = aws_dynamodb_table.control_plane["messages"].name
      CALLS_TABLE                = aws_dynamodb_table.control_plane["calls"].name
      CALENDAR_CONNECTIONS_TABLE = aws_dynamodb_table.control_plane["calendar_connections"].name
      AGENTS_TABLE               = aws_dynamodb_table.control_plane["agents"].name
      BUSINESS_PROFILES_TABLE    = aws_dynamodb_table.control_plane["business_profiles"].name
      CALENDAR_TOKENS_KMS_KEY_ID = aws_kms_key.calendar_tokens.arn
      RETELL_SECRET_ARN          = aws_secretsmanager_secret.providers["retell"].arn
      GOOGLE_OAUTH_SECRET_ARN    = aws_secretsmanager_secret.providers["google-oauth"].arn
      MICROSOFT_OAUTH_SECRET_ARN = aws_secretsmanager_secret.providers["microsoft-oauth"].arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.tools_lambda,
    aws_iam_role_policy.tools_runtime,
    aws_iam_role_policy_attachment.tools_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-tools"
  }
}

resource "aws_lambda_alias" "tools_live" {
  name             = "live"
  description      = "Published Retell tools Lambda version."
  function_name    = aws_lambda_function.tools.function_name
  function_version = aws_lambda_function.tools.version
}

resource "aws_lambda_provisioned_concurrency_config" "tools" {
  function_name                     = aws_lambda_function.tools.function_name
  qualifier                         = aws_lambda_alias.tools_live.name
  provisioned_concurrent_executions = var.tools_provisioned_concurrency
}

resource "aws_apigatewayv2_integration" "tools" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_alias.tools_live.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

locals {
  retell_tool_routes = toset([
    "POST /retell/tools/calendar.findAppointment",
    "POST /retell/tools/calendar.getAvailability",
    "POST /retell/tools/calendar.createBooking",
    "POST /retell/tools/calendar.rescheduleBooking",
    "POST /retell/tools/calendar.cancelBooking",
    "POST /retell/tools/lead.capture",
    "POST /retell/tools/message.take",
    "POST /retell/tools/call.transfer",
  ])
}

resource "aws_apigatewayv2_route" "tools" {
  for_each = local.retell_tool_routes

  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = each.value
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.tools.id}"
}

resource "aws_lambda_permission" "tools_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tools.function_name
  qualifier     = aws_lambda_alias.tools_live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}
