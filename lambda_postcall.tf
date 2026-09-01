data "archive_file" "postcall" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/postcall"
  output_path = "${path.module}/.terraform/postcall.zip"
  excludes    = ["index.test.mjs"]
}

resource "aws_iam_role" "postcall_lambda" {
  name = "${local.name_prefix}-postcall-lambda"

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
    Name = "${local.name_prefix}-postcall-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "postcall_lambda_logs" {
  role       = aws_iam_role.postcall_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "postcall_runtime" {
  name = "${local.name_prefix}-postcall-runtime"
  role = aws_iam_role.postcall_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WritePostCallRecords"
        Effect = "Allow"
        Action = ["dynamodb:PutItem"]
        Resource = [
          aws_dynamodb_table.control_plane["appointments"].arn,
          aws_dynamodb_table.control_plane["leads"].arn,
          aws_dynamodb_table.control_plane["messages"].arn,
        ]
      },
      {
        Sid      = "UpsertCallRecord"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["calls"].arn
      },
      {
        Sid      = "ReadWorkspaceTimezone"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.control_plane["business_profiles"].arn
      },
      {
        Sid      = "IncrementWorkspaceUsage"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["workspace_usage"].arn
      },
      {
        Sid      = "StoreCallRecording"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.call_artifacts.arn}/*"
      },
      {
        Sid      = "MarkTestAgentComplete"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["agents"].arn
      },
      {
        Sid      = "ResolveRetellAgent"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${aws_dynamodb_table.control_plane["agents"].arn}/index/retellAgentId-index"
      },
      {
        Sid      = "ReadRetellSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.providers["retell"].arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "postcall_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-postcall"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-postcall"
  }
}

resource "aws_lambda_function" "postcall" {
  function_name = "${local.name_prefix}-postcall"
  description   = "Signature-verified Retell call-ended transcript and outcome ingest."
  role          = aws_iam_role.postcall_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 29

  filename         = data.archive_file.postcall.output_path
  source_code_hash = data.archive_file.postcall.output_base64sha256

  environment {
    variables = {
      CALLS_TABLE             = aws_dynamodb_table.control_plane["calls"].name
      APPOINTMENTS_TABLE      = aws_dynamodb_table.control_plane["appointments"].name
      LEADS_TABLE             = aws_dynamodb_table.control_plane["leads"].name
      MESSAGES_TABLE          = aws_dynamodb_table.control_plane["messages"].name
      AGENTS_TABLE            = aws_dynamodb_table.control_plane["agents"].name
      BUSINESS_PROFILES_TABLE = aws_dynamodb_table.control_plane["business_profiles"].name
      WORKSPACE_USAGE_TABLE   = aws_dynamodb_table.control_plane["workspace_usage"].name
      RETELL_SECRET_ARN       = aws_secretsmanager_secret.providers["retell"].arn
      CALL_ARTIFACTS_BUCKET   = aws_s3_bucket.call_artifacts.bucket
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.postcall_lambda,
    aws_iam_role_policy.postcall_runtime,
    aws_iam_role_policy_attachment.postcall_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-postcall"
  }
}

resource "aws_apigatewayv2_integration" "postcall" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.postcall.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "postcall" {
  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = "POST /retell/webhooks/call-ended"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.postcall.id}"
}

resource "aws_lambda_permission" "postcall_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.postcall.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}
