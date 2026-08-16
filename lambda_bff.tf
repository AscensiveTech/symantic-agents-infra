data "archive_file" "bff" {
  type        = "zip"
  source_file = "${path.module}/lambda/bff/index.mjs"
  output_path = "${path.module}/.terraform/bff.zip"
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
    ]
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
  description   = "Authenticated BFF for Symantic workspace profiles and agents."
  role          = aws_iam_role.bff_lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 10

  filename         = data.archive_file.bff.output_path
  source_code_hash = data.archive_file.bff.output_base64sha256

  environment {
    variables = {
      WORKSPACES_TABLE        = aws_dynamodb_table.control_plane["workspaces"].name
      BUSINESS_PROFILES_TABLE = aws_dynamodb_table.control_plane["business_profiles"].name
      AGENTS_TABLE            = aws_dynamodb_table.control_plane["agents"].name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.bff_lambda,
    aws_iam_role_policy.bff_dynamodb,
    aws_iam_role_policy_attachment.bff_lambda_logs,
  ]

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}
