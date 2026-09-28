data "archive_file" "most_asked_refresh" {
  type        = "zip"
  output_path = "${path.module}/.terraform/most-asked-refresh.zip"

  source {
    content  = file("${path.module}/lambda/most-asked-refresh/index.mjs")
    filename = "most-asked-refresh/index.mjs"
  }
  # most-asked-refresh/index.test.mjs is intentionally excluded (no source entry).

  # most-asked-refresh imports lambda/bff/index.mjs directly (to reuse
  # generateMostAskedQuestionsDigest + the store/provider factories rather
  # than duplicating them), so the whole bff module set rides along in the
  # same zip, one level up from most-asked-refresh/ - identical relative
  # layout to the repo. Same pattern as lambda_kb_refresh.tf.
  dynamic "source" {
    for_each = toset([
      for f in fileset("${path.module}/lambda/bff", "*.mjs") : f
      if !can(regex("\\.test\\.mjs$", f))
    ])
    content {
      content  = file("${path.module}/lambda/bff/${source.value}")
      filename = "bff/${source.value}"
    }
  }
}

resource "aws_iam_role" "most_asked_refresh_lambda" {
  name = "${local.name_prefix}-most-asked-refresh-lambda"

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
    Name = "${local.name_prefix}-most-asked-refresh-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "most_asked_refresh_lambda_logs" {
  role       = aws_iam_role.most_asked_refresh_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "most_asked_refresh_runtime" {
  name = "${local.name_prefix}-most-asked-refresh-runtime"
  role = aws_iam_role.most_asked_refresh_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ScanAndReadWorkspaces"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:GetItem"]
        Resource = aws_dynamodb_table.control_plane["workspaces"].arn
      },
      {
        Sid      = "ReadBusinessProfile"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.control_plane["business_profiles"].arn
      },
      {
        Sid      = "ReadCalls"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["calls"].arn
      },
      {
        Sid      = "ManageMostAskedDigests"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.control_plane["most_asked_digests"].arn
      },
      {
        Sid    = "ReadProviderSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.providers["retell"].arn,
          aws_secretsmanager_secret.providers["telnyx"].arn,
          aws_secretsmanager_secret.providers["anthropic"].arn,
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "most_asked_refresh_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-most-asked-refresh"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-most-asked-refresh"
  }
}

resource "aws_lambda_function" "most_asked_refresh" {
  function_name = "${local.name_prefix}-most-asked-refresh"
  description   = "Daily check that auto-generates one Most Asked Questions digest per billing cycle, 15 days after each workspace's account-creation day, for any entitled workspace that hasn't already refreshed this cycle."
  role          = aws_iam_role.most_asked_refresh_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "most-asked-refresh/index.handler"
  architectures = ["arm64"]
  memory_size   = 512
  timeout       = 120

  filename         = data.archive_file.most_asked_refresh.output_path
  source_code_hash = data.archive_file.most_asked_refresh.output_base64sha256

  # getDefaultStore()/getDefaultProviders() (imported from bff/index.mjs)
  # require every one of these env vars to be set, even though this
  # function only reads a handful of them - keep this block a superset
  # matching lambda_bff.tf's rather than a partial list that throws at
  # cold start. Same approach as lambda_kb_refresh.tf.
  environment {
    variables = {
      WORKSPACES_TABLE            = aws_dynamodb_table.control_plane["workspaces"].name
      BUSINESS_PROFILES_TABLE     = aws_dynamodb_table.control_plane["business_profiles"].name
      AGENTS_TABLE                = aws_dynamodb_table.control_plane["agents"].name
      PHONE_NUMBERS_TABLE         = aws_dynamodb_table.control_plane["phone_numbers"].name
      CALENDAR_CONNECTIONS_TABLE  = aws_dynamodb_table.control_plane["calendar_connections"].name
      CALLS_TABLE                 = aws_dynamodb_table.control_plane["calls"].name
      WORKSPACE_USAGE_TABLE       = aws_dynamodb_table.control_plane["workspace_usage"].name
      BLOCKED_NUMBERS_TABLE       = aws_dynamodb_table.control_plane["blocked_numbers"].name
      PROPOSALS_TABLE             = aws_dynamodb_table.control_plane["proposals"].name
      PROPOSAL_PARTS_TABLE        = aws_dynamodb_table.control_plane["proposal_parts"].name
      PROPOSAL_TEMPLATES_TABLE    = aws_dynamodb_table.control_plane["proposal_templates"].name
      WORKSPACE_MEMBERSHIPS_TABLE = aws_dynamodb_table.workspace_memberships.name
      LEGAL_DOCUMENTS_TABLE       = aws_dynamodb_table.legal_documents.name
      LEGAL_ACCEPTANCES_TABLE     = aws_dynamodb_table.legal_acceptances.name
      KNOWLEDGE_BASES_TABLE       = aws_dynamodb_table.control_plane["knowledge_bases"].name
      MOST_ASKED_DIGESTS_TABLE    = aws_dynamodb_table.control_plane["most_asked_digests"].name
      RETELL_SECRET_ARN           = aws_secretsmanager_secret.providers["retell"].arn
      TELNYX_SECRET_ARN           = aws_secretsmanager_secret.providers["telnyx"].arn
      ANTHROPIC_SECRET_ARN        = aws_secretsmanager_secret.providers["anthropic"].arn
      PUBLIC_API_BASE_URL         = aws_apigatewayv2_api.bff.api_endpoint
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.most_asked_refresh_lambda,
    aws_iam_role_policy.most_asked_refresh_runtime,
    aws_iam_role_policy_attachment.most_asked_refresh_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-most-asked-refresh"
  }
}

resource "aws_cloudwatch_event_rule" "most_asked_refresh_daily" {
  name                = "${local.name_prefix}-most-asked-refresh-daily"
  description         = "Runs the Most Asked Questions auto-refresh trigger-day check once a day at 09:00 UTC (late night across every continental US timezone)."
  schedule_expression = "cron(0 9 * * ? *)"
}

resource "aws_cloudwatch_event_target" "most_asked_refresh_daily" {
  rule = aws_cloudwatch_event_rule.most_asked_refresh_daily.name
  arn  = aws_lambda_function.most_asked_refresh.arn
}

resource "aws_lambda_permission" "most_asked_refresh_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.most_asked_refresh.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.most_asked_refresh_daily.arn
}
