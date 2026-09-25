# Monday.com CRM integration (lambda/crm).
#
#   Retell inbound webhook -> BFF --invoke--> crm (lookup, 1.5s budget)
#   Retell call_analyzed   -> postcall --SQS--> crm-worker -> Monday API
#   Settings UI            -> API Gateway -> crm (OAuth 2.1, mapping, retry)
#   Monday app lifecycle   -> API Gateway -> crm (JWT-verified uninstall)
#
# Monday tokens are KMS-encrypted with their own key and never leave the
# crm functions. See docs/monday-crm-integration.pdf for the design.

variable "crm_alarm_topic_arn" {
  description = "Optional SNS topic ARN that CRM alarms notify. Empty creates the alarms without actions."
  type        = string
  default     = ""
}

variable "crm_provisioned_concurrency" {
  description = "Always-warm copies of the crm Lambda's call-time lookup alias (no cold start while a caller hears ringing)."
  type        = number
  default     = 1

  validation {
    condition     = var.crm_provisioned_concurrency >= 0 && var.crm_provisioned_concurrency <= 10 && floor(var.crm_provisioned_concurrency) == var.crm_provisioned_concurrency
    error_message = "crm_provisioned_concurrency must be an integer from 0 through 10."
  }
}

variable "monday_api_version" {
  description = "Pinned Monday GraphQL API version (API-Version header)."
  type        = string
  default     = "2026-07"
}

locals {
  crm_alarm_actions = var.crm_alarm_topic_arn == "" ? [] : [var.crm_alarm_topic_arn]
  # Must equal MAX_ATTEMPTS in lambda/crm/worker.mjs.
  crm_sync_max_receive_count = 8
}

# ---------------------------------------------------------------- storage ----

resource "aws_kms_key" "crm_tokens" {
  description             = "Envelope key for CRM OAuth access and refresh tokens (${var.environment})."
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-crm-tokens"
  }
}

resource "aws_kms_alias" "crm_tokens" {
  name          = "alias/${local.name_prefix}-crm-tokens"
  target_key_id = aws_kms_key.crm_tokens.key_id
}

resource "aws_dynamodb_table" "crm_connections" {
  name         = "${local.name_prefix}-crm-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "workspaceId"
  range_key    = "provider"

  attribute {
    name = "workspaceId"
    type = "S"
  }

  attribute {
    name = "provider"
    type = "S"
  }

  attribute {
    name = "accountId"
    type = "S"
  }

  # Monday's uninstall webhook names an account, not a workspace. Keys plus
  # state only - token ciphertext is never projected into the index.
  global_secondary_index {
    name               = "accountId-index"
    hash_key           = "accountId"
    projection_type    = "INCLUDE"
    non_key_attributes = ["connectionState"]
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-crm-connections"
  }
}

# One row per (workspace, provider, caller phone): the CRM record id, the
# per-phone sync lease, and the newest call already applied to it.
resource "aws_dynamodb_table" "crm_links" {
  name         = "${local.name_prefix}-crm-links"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "workspaceId"
  range_key    = "linkKey"

  attribute {
    name = "workspaceId"
    type = "S"
  }

  attribute {
    name = "linkKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-crm-links"
  }
}

# ------------------------------------------------------------------ queue ----

resource "aws_sqs_queue" "crm_sync_dlq" {
  name                      = "${local.name_prefix}-crm-sync-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "${local.name_prefix}-crm-sync-dlq"
  }
}

resource "aws_sqs_queue" "crm_sync" {
  name                      = "${local.name_prefix}-crm-sync"
  message_retention_seconds = 345600
  # 6x the worker timeout, per AWS guidance for Lambda event sources.
  visibility_timeout_seconds = 360
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.crm_sync_dlq.arn
    maxReceiveCount     = local.crm_sync_max_receive_count
  })

  tags = {
    Name = "${local.name_prefix}-crm-sync"
  }
}

resource "aws_sqs_queue_redrive_allow_policy" "crm_sync_dlq" {
  queue_url = aws_sqs_queue.crm_sync_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.crm_sync.arn]
  })
}

# ---------------------------------------------------------------- package ----

data "archive_file" "crm" {
  type        = "zip"
  output_path = "${path.module}/.terraform/crm.zip"

  dynamic "source" {
    for_each = toset([
      for f in fileset("${path.module}/lambda/crm", "**/*.mjs") : f
      if !can(regex("(\\.test\\.mjs$|^test-support/|^integration/)", f))
    ])
    content {
      content  = file("${path.module}/lambda/crm/${source.value}")
      filename = "crm/${source.value}"
    }
  }
}

locals {
  crm_environment = {
    APP_URL                     = local.app_url
    PUBLIC_API_BASE_URL         = aws_apigatewayv2_api.bff.api_endpoint
    CRM_CONNECTIONS_TABLE       = aws_dynamodb_table.crm_connections.name
    CRM_LINKS_TABLE             = aws_dynamodb_table.crm_links.name
    CALLS_TABLE                 = aws_dynamodb_table.control_plane["calls"].name
    BUSINESS_PROFILES_TABLE     = aws_dynamodb_table.control_plane["business_profiles"].name
    WORKSPACE_MEMBERSHIPS_TABLE = aws_dynamodb_table.workspace_memberships.name
    OAUTH_STATES_TABLE          = aws_dynamodb_table.oauth_states.name
    CRM_TOKENS_KMS_KEY_ID       = aws_kms_key.crm_tokens.arn
    MONDAY_OAUTH_SECRET_ARN     = aws_secretsmanager_secret.providers["monday-oauth"].arn
    MONDAY_API_VERSION          = var.monday_api_version
    CRM_SYNC_QUEUE_URL          = aws_sqs_queue.crm_sync.url
  }
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --------------------------------------------------- crm (API + lookup) ----

resource "aws_iam_role" "crm_lambda" {
  name               = "${local.name_prefix}-crm-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json

  tags = {
    Name = "${local.name_prefix}-crm-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "crm_lambda_logs" {
  role       = aws_iam_role.crm_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "crm_runtime" {
  name = "${local.name_prefix}-crm-runtime"
  role = aws_iam_role.crm_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Scan: the token keeper walks the (one-row-per-workspace) table.
        Sid      = "ManageCrmConnections"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = [aws_dynamodb_table.crm_connections.arn, "${aws_dynamodb_table.crm_connections.arn}/index/accountId-index"]
      },
      {
        Sid      = "ManageCrmLinks"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.crm_links.arn
      },
      {
        # Retry-failed lists this workspace's failed calls and re-arms them.
        Sid      = "RequeueFailedCalls"
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["calls"].arn
      },
      {
        Sid      = "ConsumeOAuthState"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.oauth_states.arn
      },
      {
        Sid      = "ReadWorkspaceMemberships"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.workspace_memberships.arn
      },
      {
        Sid      = "EncryptCrmTokens"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt"]
        Resource = aws_kms_key.crm_tokens.arn
      },
      {
        Sid      = "ReadMondayAppSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.providers["monday-oauth"].arn
      },
      {
        Sid      = "RequeueSync"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.crm_sync.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "crm_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-crm"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-crm"
  }
}

resource "aws_lambda_function" "crm" {
  function_name = "${local.name_prefix}-crm"
  description   = "CRM (Monday.com) connection settings, OAuth 2.1, lifecycle webhook, and call-time caller lookup."
  role          = aws_iam_role.crm_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "crm/index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 15
  publish       = true

  filename         = data.archive_file.crm.output_path
  source_code_hash = data.archive_file.crm.output_base64sha256

  environment {
    variables = local.crm_environment
  }

  depends_on = [
    aws_cloudwatch_log_group.crm_lambda,
    aws_iam_role_policy.crm_runtime,
    aws_iam_role_policy_attachment.crm_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-crm"
  }
}

# The BFF invokes the lookup through this alias, which keeps provisioned
# (pre-initialized) instances; the settings API and the token keeper use the
# unqualified function so they never take that capacity from a live call.
resource "aws_lambda_alias" "crm_live" {
  name             = "live"
  description      = "Published crm Lambda version for call-time lookups."
  function_name    = aws_lambda_function.crm.function_name
  function_version = aws_lambda_function.crm.version
}

resource "aws_lambda_provisioned_concurrency_config" "crm" {
  count                             = var.crm_provisioned_concurrency > 0 ? 1 : 0
  function_name                     = aws_lambda_function.crm.function_name
  qualifier                         = aws_lambda_alias.crm_live.name
  provisioned_concurrent_executions = var.crm_provisioned_concurrency
}

# Token keeper: refreshes Monday access tokens before they expire so the
# call-time lookup never has to (see lambda/crm/keeper.mjs).
resource "aws_cloudwatch_event_rule" "crm_token_keeper" {
  name                = "${local.name_prefix}-crm-token-keeper"
  description         = "Refresh CRM access tokens ahead of expiry."
  schedule_expression = "rate(10 minutes)"
}

resource "aws_cloudwatch_event_target" "crm_token_keeper" {
  rule  = aws_cloudwatch_event_rule.crm_token_keeper.name
  arn   = aws_lambda_function.crm.arn
  input = jsonencode({ action = "refresh-tokens" })
}

resource "aws_lambda_permission" "crm_token_keeper" {
  statement_id  = "AllowEventBridgeTokenKeeper"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.crm.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.crm_token_keeper.arn
}

resource "aws_apigatewayv2_integration" "crm" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.crm.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000
}

locals {
  crm_authorized_routes = toset([
    "GET /crm/connection",
    "DELETE /crm/connection",
    "POST /crm/monday/start",
    "GET /crm/monday/boards",
    "PUT /crm/mapping",
    "POST /crm/sync/retry",
  ])

  # Both verify themselves: the callback by its one-time OAuth state, the
  # lifecycle webhook by Monday's HS256 JWT.
  crm_public_routes = toset([
    "GET /crm/oauth/monday/callback",
    "POST /crm/monday/lifecycle",
  ])
}

resource "aws_apigatewayv2_route" "crm_authorized" {
  for_each = local.crm_authorized_routes

  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = each.value
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.bff_jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.crm.id}"
}

resource "aws_apigatewayv2_route" "crm_public" {
  for_each = local.crm_public_routes

  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = each.value
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.crm.id}"
}

resource "aws_lambda_permission" "crm_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.crm.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}

# ------------------------------------------------------------- crm-worker ----

resource "aws_iam_role" "crm_worker_lambda" {
  name               = "${local.name_prefix}-crm-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json

  tags = {
    Name = "${local.name_prefix}-crm-worker-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "crm_worker_lambda_logs" {
  role       = aws_iam_role.crm_worker_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "crm_worker_runtime" {
  name = "${local.name_prefix}-crm-worker-runtime"
  role = aws_iam_role.crm_worker_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadAndRefreshConnections"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.crm_connections.arn
      },
      {
        Sid      = "ManageCrmLinks"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.crm_links.arn
      },
      {
        Sid      = "ReadCallRecordSyncState"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["calls"].arn
      },
      {
        Sid      = "ReadWorkspaceTimezone"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.control_plane["business_profiles"].arn
      },
      {
        Sid      = "EncryptCrmTokens"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt"]
        Resource = aws_kms_key.crm_tokens.arn
      },
      {
        Sid      = "ReadMondayAppSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.providers["monday-oauth"].arn
      },
      {
        Sid    = "ConsumeSyncQueue"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.crm_sync.arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "crm_worker_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-crm-worker"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-crm-worker"
  }
}

resource "aws_lambda_function" "crm_worker" {
  function_name = "${local.name_prefix}-crm-worker"
  description   = "Post-call CRM sync: SQS consumer that writes leads, call notes and fields to Monday.com."
  role          = aws_iam_role.crm_worker_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "crm/worker.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 60

  filename         = data.archive_file.crm.output_path
  source_code_hash = data.archive_file.crm.output_base64sha256

  environment {
    variables = local.crm_environment
  }

  depends_on = [
    aws_cloudwatch_log_group.crm_worker_lambda,
    aws_iam_role_policy.crm_worker_runtime,
    aws_iam_role_policy_attachment.crm_worker_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-crm-worker"
  }
}

resource "aws_lambda_event_source_mapping" "crm_sync" {
  event_source_arn        = aws_sqs_queue.crm_sync.arn
  function_name           = aws_lambda_function.crm_worker.arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  # Caps parallel Monday writes well under the lowest plan's concurrency
  # limit (40), whatever the queue depth.
  scaling_config {
    maximum_concurrency = 5
  }
}

# ------------------------------------------ callers: BFF and post-call ----

resource "aws_iam_role_policy" "bff_crm_lookup" {
  name = "${local.name_prefix}-bff-crm-lookup"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeCrmLookup"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_alias.crm_live.arn
      },
      {
        # Status only (the BFF can't decrypt tokens - no KMS grant).
        Sid      = "ReadCrmConnectionStatus"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.crm_connections.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "postcall_crm_enqueue" {
  name = "${local.name_prefix}-postcall-crm-enqueue"
  role = aws_iam_role.postcall_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCrmConnectionStatus"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.crm_connections.arn
      },
      {
        Sid      = "EnqueueCrmSync"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.crm_sync.arn
      },
    ]
  })
}

# ----------------------------------------------------------------- alarms ----

resource "aws_cloudwatch_metric_alarm" "crm_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-crm-sync-dlq-not-empty"
  alarm_description   = "A call failed to sync to the CRM after every retry. Fix the cause, then redrive the DLQ (sync is idempotent)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.crm_sync_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.crm_alarm_actions
  ok_actions          = local.crm_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "crm_queue_age" {
  alarm_name          = "${local.name_prefix}-crm-sync-queue-age"
  alarm_description   = "CRM sync is running more than an hour behind (Monday down, throttled, or a daily API cap)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.crm_sync.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.crm_alarm_actions
  ok_actions          = local.crm_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "crm_worker_errors" {
  alarm_name          = "${local.name_prefix}-crm-worker-errors"
  alarm_description   = "The CRM sync worker is crashing (not a Monday error - those are handled)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.crm_worker.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.crm_alarm_actions
  ok_actions          = local.crm_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "crm_lookup_degraded" {
  alarm_name          = "${local.name_prefix}-crm-lookup-degraded"
  alarm_description   = "Call-time CRM lookups are timing out or failing; calls continue without caller context."
  namespace           = "Symantic/CRM"
  metric_name         = "InboundLookupLatency"
  dimensions          = { Outcome = "timeout" }
  statistic           = "SampleCount"
  period              = 900
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.crm_alarm_actions
  ok_actions          = local.crm_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "crm_sync_failures" {
  alarm_name          = "${local.name_prefix}-crm-sync-failures"
  alarm_description   = "Calls are failing to sync permanently (reconnect needed, or the field mapping broke)."
  namespace           = "Symantic/CRM"
  metric_name         = "SyncFailed"
  dimensions          = { Provider = "monday", Outcome = "mapping_invalid" }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.crm_alarm_actions
  ok_actions          = local.crm_alarm_actions
}

# --------------------------------------------------------------- outputs ----

output "monday_oauth_redirect_uri" {
  description = "Redirect URI to register in the Monday Developer Center (OAuth & Permissions)."
  value       = "${aws_apigatewayv2_api.bff.api_endpoint}/crm/oauth/monday/callback"
}

output "monday_lifecycle_webhook_url" {
  description = "App lifecycle webhook URL to register in the Monday Developer Center (Webhooks)."
  value       = "${aws_apigatewayv2_api.bff.api_endpoint}/crm/monday/lifecycle"
}

output "crm_sync_queue_url" {
  description = "Post-call CRM sync queue."
  value       = aws_sqs_queue.crm_sync.url
}

output "crm_sync_dlq_url" {
  description = "Dead-letter queue for CRM sync; redrive after fixing the cause."
  value       = aws_sqs_queue.crm_sync_dlq.url
}
