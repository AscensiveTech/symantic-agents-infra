# Call-summary emails. An hourly EventBridge schedule runs the digest Lambda,
# which evaluates each workspace's own frequency (hourly / every 6 hours /
# daily / weekly, in the workspace's timezone) and sends to its admins plus any
# extra addresses. The BFF also invokes it directly for "send me a test".

data "archive_file" "digest" {
  type        = "zip"
  output_path = "${path.module}/.terraform/digest.zip"

  # digest's own files now live under digest/ in the zip (not the zip root)
  # so its "../bff/..." import resolves the same way it does on disk in this
  # repo - identical relative layout to lambda_kb_refresh.tf's own
  # kb-refresh/ + bff/ sibling-folder packaging.
  dynamic "source" {
    for_each = toset([
      for f in fileset("${path.module}/lambda/digest", "**") : f
      if !can(regex("\\.test\\.mjs$", f))
    ])
    content {
      content  = file("${path.module}/lambda/digest/${source.value}")
      filename = "digest/${source.value}"
    }
  }

  # digest imports lambda/bff/receptionist-billing.mjs directly (to reuse
  # buildUsage/resolveAccountPlan for the usage-threshold alert rather than
  # duplicating the billing/plan math), so the whole bff module set rides
  # along in the same zip - identical pattern to lambda_kb_refresh.tf.
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

resource "aws_iam_role" "digest_lambda" {
  name = "${local.name_prefix}-call-digest-lambda"

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
    Name = "${local.name_prefix}-call-digest-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "digest_lambda_logs" {
  role       = aws_iam_role.digest_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "digest_runtime" {
  name = "${local.name_prefix}-call-digest-runtime"
  role = aws_iam_role.digest_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Scan finds workspaces with summaries on; UpdateItem moves the
        # window cursor and records the last run.
        Sid      = "TrackDigestSchedule"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["workspaces"].arn
      },
      {
        Sid    = "ReadCallsAndAgents"
        Effect = "Allow"
        Action = ["dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.control_plane["calls"].arn,
          aws_dynamodb_table.control_plane["agents"].arn,
        ]
      },
      {
        Sid      = "ReadAdminRecipients"
        Effect   = "Allow"
        Action   = ["dynamodb:Query"]
        Resource = "${aws_dynamodb_table.workspace_memberships.arn}/index/workspaceId-index"
      },
      local.ses_send_statement,
    ]
  })
}

resource "aws_cloudwatch_log_group" "digest_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-call-digest"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-call-digest"
  }
}

resource "aws_lambda_function" "digest" {
  function_name = "${local.name_prefix}-call-digest"
  description   = "Scheduled call-summary emails, plus on-demand test sends from the BFF."
  role          = aws_iam_role.digest_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "digest/index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  # SES in the sandbox allows one message a second, and every recipient gets
  # their own copy - leave room for a run across many workspaces.
  timeout = 300

  filename         = data.archive_file.digest.output_path
  source_code_hash = data.archive_file.digest.output_base64sha256

  environment {
    variables = {
      APP_URL                     = local.app_url
      WORKSPACES_TABLE            = aws_dynamodb_table.control_plane["workspaces"].name
      CALLS_TABLE                 = aws_dynamodb_table.control_plane["calls"].name
      AGENTS_TABLE                = aws_dynamodb_table.control_plane["agents"].name
      WORKSPACE_MEMBERSHIPS_TABLE = aws_dynamodb_table.workspace_memberships.name
      EMAIL_FROM                  = local.email_from
      EMAIL_CONFIGURATION_SET     = aws_sesv2_configuration_set.notifications.configuration_set_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.digest_lambda,
    aws_iam_role_policy.digest_runtime,
    aws_iam_role_policy_attachment.digest_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-call-digest"
  }
}

resource "aws_cloudwatch_event_rule" "call_digest" {
  name        = "${local.name_prefix}-call-digest-5min"
  description = "Evaluates every workspace's notification schedule every 5 minutes - isDigestDue() in schedule.mjs decides whether a given workspace is actually due on any given tick, so this just needs to be at least as frequent as the shortest selectable interval."
  schedule_expression = "rate(5 minutes)"

  tags = {
    Name = "${local.name_prefix}-call-digest-5min"
  }
}

resource "aws_cloudwatch_event_target" "call_digest" {
  rule      = aws_cloudwatch_event_rule.call_digest.name
  target_id = "call-digest"
  arn       = aws_lambda_function.digest.arn
}

resource "aws_lambda_permission" "call_digest_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.digest.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.call_digest.arn
}

# Lets the BFF run "send me a test summary" through the real digest code.
resource "aws_iam_role_policy" "bff_call_digest" {
  name = "${local.name_prefix}-bff-call-digest"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SendTestCallSummary"
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.digest.arn
    }]
  })
}
