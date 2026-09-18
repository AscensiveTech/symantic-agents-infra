data "archive_file" "bff" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/bff"
  output_path = "${path.module}/.terraform/bff.zip"
  excludes = [
    "index.test.mjs",
    "providers.test.mjs",
    "receptionist.test.mjs",
    "receptionist-billing.test.mjs",
    "proposals.test.mjs",
  ]
}

resource "aws_iam_role" "bff_lambda" {
  name = "${local.name_prefix}-bff-lambda"

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
    Name = "${local.name_prefix}-bff-lambda"
  }
}

resource "aws_iam_role_policy_attachment" "bff_lambda_logs" {
  role       = aws_iam_role.bff_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "bff_dynamodb" {
  name = "${local.name_prefix}-bff-dynamodb"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ManageWorkspaces"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.control_plane["workspaces"].arn
      },
      {
        Sid      = "ManageBusinessProfile"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.control_plane["business_profiles"].arn
      },
      {
        Sid      = "ReadCalendarConnection"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.control_plane["calendar_connections"].arn
      },
      {
        Sid      = "ManageAgents"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["agents"].arn
      },
      {
        Sid    = "ManageCalls"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = [
          aws_dynamodb_table.control_plane["calls"].arn,
          "${aws_dynamodb_table.control_plane["calls"].arn}/index/*",
        ]
      },
      {
        Sid      = "ManageKnowledgeBases"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["knowledge_bases"].arn
      },
      {
        Sid      = "ManageMostAskedDigests"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["most_asked_digests"].arn
      },
      {
        Sid      = "ManageWorkspaceUsage"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.control_plane["workspace_usage"].arn
      },
      {
        Sid      = "ManageBlockedNumbers"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["blocked_numbers"].arn
      },
      {
        Sid      = "ManageContacts"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["contacts"].arn
      },
      {
        Sid    = "ManageActivityLog"
        Effect = "Allow"
        # PutItem only - every login/page-view write; Query (+ its
        # occurredAt-index) for the super-admin "Uses" panel to read it back
        # paginated. No UpdateItem/DeleteItem - rows are write-once and
        # self-expire via the table's own TTL, nothing here ever edits or
        # manually deletes one.
        Action = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.control_plane["activity_log"].arn,
          "${aws_dynamodb_table.control_plane["activity_log"].arn}/index/*",
        ]
      },
      {
        Sid    = "ManagePhoneNumbers"
        Effect = "Allow"
        # DeleteItem is needed to release a number when its agent is deleted -
        # missing until now, which surfaced as a prod "Internal server error"
        # on delete-agent for any agent that actually had a number attached.
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.control_plane["phone_numbers"].arn,
          "${aws_dynamodb_table.control_plane["phone_numbers"].arn}/index/*",
        ]
      },
      {
        Sid      = "ManageProposals"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["proposals"].arn
      },
      {
        Sid      = "ManageProposalParts"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["proposal_parts"].arn
      },
      {
        Sid      = "ManageProposalTemplates"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["proposal_templates"].arn
      },
      {
        Sid    = "ManageWorkspaceMemberships"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.workspace_memberships.arn,
          "${aws_dynamodb_table.workspace_memberships.arn}/index/*",
        ]
      },
      {
        Sid    = "ManageLegalDocuments"
        Effect = "Allow"
        # UpdateItem stamps replacedAt on the outgoing version when a new one is published.
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:TransactWriteItems"]
        Resource = aws_dynamodb_table.legal_documents.arn
      },
      {
        Sid    = "ManageLegalAcceptances"
        Effect = "Allow"
        # TransactWriteItems, not BatchWriteItem: the HISTORY audit row and the
        # LATEST pointer are written together or not at all (see
        # recordLegalAcceptance). Mirrors ManageLegalDocuments above. Scan is
        # for the per-company acceptance-evidence table (listWorkspaceLegalAcceptances).
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems", "dynamodb:Query", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.legal_acceptances.arn
      },
      {
        Sid    = "OnboardCompanyAtomically"
        Effect = "Allow"
        Action = ["dynamodb:TransactWriteItems"]
        Resource = [
          aws_dynamodb_table.control_plane["workspaces"].arn,
          aws_dynamodb_table.control_plane["proposal_templates"].arn,
          aws_dynamodb_table.workspace_memberships.arn,
        ]
      },
      {
        Sid      = "ManageProposalAssets"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.proposal_assets.arn}/*"
      },
      {
        Sid      = "ListProposalAssets"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.proposal_assets.arn
      },
      {
        Sid      = "ReadCallRecordings"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.call_artifacts.arn}/*"
      },
      {
        Sid      = "ManageKnowledgeAssets"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.knowledge_assets.arn}/*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "bff_cognito_admin" {
  name = "${local.name_prefix}-bff-cognito-admin"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ManageWorkspaceUsers"
      Effect = "Allow"
      Action = [
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:ListUsers",
      ]
      Resource = aws_cognito_user_pool.frontend.arn
    }]
  })
}

resource "aws_iam_role_policy" "bff_provider_secrets" {
  name = "${local.name_prefix}-bff-provider-secrets"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadProviderSecrets"
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.providers["retell"].arn,
        aws_secretsmanager_secret.providers["telnyx"].arn,
        aws_secretsmanager_secret.providers["signwell"].arn,
        aws_secretsmanager_secret.providers["anthropic"].arn,
      ]
    }]
  })
}

resource "aws_cloudwatch_log_group" "bff_lambda" {
  name              = "/aws/lambda/${local.name_prefix}-bff"
  retention_in_days = 14

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}

resource "aws_lambda_function" "bff" {
  function_name = "${local.name_prefix}-bff"
  description   = "Workspace BFF for profiles, agents, telephony activation, and signed inbound lookup."
  role          = aws_iam_role.bff_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  # Memory = CPU on Lambda. Knowledge-base sync can temporarily hold up to the
  # product's 100 MB upload allowance while constructing Retell multipart data,
  # so keep enough heap and network CPU headroom for that path.
  memory_size = 1024
  timeout     = 29

  filename         = data.archive_file.bff.output_path
  source_code_hash = data.archive_file.bff.output_base64sha256

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
      CONTACTS_TABLE              = aws_dynamodb_table.control_plane["contacts"].name
      ACTIVITY_LOG_TABLE          = aws_dynamodb_table.control_plane["activity_log"].name
      COGNITO_USER_POOL_ID        = aws_cognito_user_pool.frontend.id
      PROPOSAL_ASSETS_BUCKET      = aws_s3_bucket.proposal_assets.bucket
      CALL_ARTIFACTS_BUCKET       = aws_s3_bucket.call_artifacts.bucket
      KNOWLEDGE_ASSETS_BUCKET     = aws_s3_bucket.knowledge_assets.bucket
      RETELL_SECRET_ARN           = aws_secretsmanager_secret.providers["retell"].arn
      TELNYX_SECRET_ARN           = aws_secretsmanager_secret.providers["telnyx"].arn
      SIGNWELL_SECRET_ARN         = aws_secretsmanager_secret.providers["signwell"].arn
      ANTHROPIC_SECRET_ARN        = aws_secretsmanager_secret.providers["anthropic"].arn
      PUBLIC_API_BASE_URL         = aws_apigatewayv2_api.bff.api_endpoint
      CALL_DIGEST_FUNCTION_NAME   = aws_lambda_function.digest.function_name
      EMAIL_SENDER_ADDRESS        = var.email_sender_address
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.bff_lambda,
    aws_iam_role_policy.bff_dynamodb,
    aws_iam_role_policy.bff_provider_secrets,
    aws_iam_role_policy.bff_cognito_admin,
    aws_iam_role_policy_attachment.bff_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}
