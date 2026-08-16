data "archive_file" "bff" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/bff"
  output_path = "${path.module}/.terraform/bff.zip"
  excludes = [
    "index.test.mjs",
    "providers.test.mjs",
    "receptionist.test.mjs",
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
        Sid      = "EnsureWorkspace"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.control_plane["workspaces"].arn
      },
      {
        Sid      = "ManageBusinessProfile"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.control_plane["business_profiles"].arn
      },
      {
        Sid      = "ManageAgents"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.control_plane["agents"].arn
      },
      {
        Sid    = "ManagePhoneNumbers"
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = [
          aws_dynamodb_table.control_plane["phone_numbers"].arn,
          "${aws_dynamodb_table.control_plane["phone_numbers"].arn}/index/*",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "bff_provider_secrets" {
  name = "${local.name_prefix}-bff-provider-secrets"
  role = aws_iam_role.bff_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadTelephonyProviderSecrets"
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.providers["retell"].arn,
        aws_secretsmanager_secret.providers["telnyx"].arn,
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
  memory_size   = 256
  timeout       = 30

  filename         = data.archive_file.bff.output_path
  source_code_hash = data.archive_file.bff.output_base64sha256

  environment {
    variables = {
      WORKSPACES_TABLE        = aws_dynamodb_table.control_plane["workspaces"].name
      BUSINESS_PROFILES_TABLE = aws_dynamodb_table.control_plane["business_profiles"].name
      AGENTS_TABLE            = aws_dynamodb_table.control_plane["agents"].name
      PHONE_NUMBERS_TABLE     = aws_dynamodb_table.control_plane["phone_numbers"].name
      RETELL_SECRET_ARN       = aws_secretsmanager_secret.providers["retell"].arn
      TELNYX_SECRET_ARN       = aws_secretsmanager_secret.providers["telnyx"].arn
      PUBLIC_API_BASE_URL     = aws_apigatewayv2_api.bff.api_endpoint
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.bff_lambda,
    aws_iam_role_policy.bff_dynamodb,
    aws_iam_role_policy.bff_provider_secrets,
    aws_iam_role_policy_attachment.bff_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}
