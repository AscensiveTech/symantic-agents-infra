locals {
  bff_routes = toset([
    "GET /platform/companies",
    "POST /platform/companies",
    "GET /workspaces/me/proposal-settings",
    "GET /workspaces/me/profile",
    "PUT /workspaces/me/profile",
    "GET /workspaces/me/agents",
    "POST /workspaces/me/agents",
    "GET /workspaces/me/agents/{agentId}",
    "PUT /workspaces/me/agents/{agentId}",
    "POST /workspaces/me/agents/{agentId}/activate",
    "POST /workspaces/me/agents/{agentId}/start-test-call",
    "GET /workspaces/me/calls",
    "GET /workspaces/me/calls/{callId}",
    "GET /workspaces/me/proposals",
    "POST /workspaces/me/proposals",
    "GET /workspaces/me/proposals/{proposalId}",
    "PATCH /workspaces/me/proposals/{proposalId}",
    "DELETE /workspaces/me/proposals/{proposalId}",
    "POST /workspaces/me/proposals/{proposalId}/duplicate",
    "GET /workspaces/me/proposal-templates",
    "POST /workspaces/me/proposal-templates",
    "GET /workspaces/me/proposal-templates/{templateId}",
    "PATCH /workspaces/me/proposal-templates/{templateId}",
    "DELETE /workspaces/me/proposal-templates/{templateId}",
    "GET /workspaces/me/parts",
    "POST /workspaces/me/parts",
    "PATCH /workspaces/me/parts/{partId}",
    "DELETE /workspaces/me/parts/{partId}",
    "POST /workspaces/me/parts/bulk",
    "POST /workspaces/me/proposal-assets/upload-url",
    "POST /workspaces/me/proposal-assets/download-url",
    "GET /workspaces/me/users",
    "POST /workspaces/me/users",
    "PATCH /workspaces/me/users/{userId}",
    "DELETE /workspaces/me/users/{userId}",
  ])
}

resource "aws_apigatewayv2_api" "bff" {
  name          = "${local.name_prefix}-bff"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = false
    allow_headers     = ["authorization", "content-type", "x-retell-signature"]
    allow_methods     = ["DELETE", "GET", "PATCH", "POST", "PUT", "OPTIONS"]
    allow_origins     = distinct(compact(["http://localhost:3000", var.app_url]))
    max_age           = 300
  }

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}

resource "aws_apigatewayv2_authorizer" "bff_jwt" {
  api_id           = aws_apigatewayv2_api.bff.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-cognito"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.frontend.id]
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.frontend.id}"
  }
}

resource "aws_apigatewayv2_integration" "bff" {
  api_id                 = aws_apigatewayv2_api.bff.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.bff.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "bff" {
  for_each = local.bff_routes

  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = each.value
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.bff_jwt.id
  target             = "integrations/${aws_apigatewayv2_integration.bff.id}"
}

resource "aws_apigatewayv2_route" "retell_inbound_lookup" {
  api_id             = aws_apigatewayv2_api.bff.id
  route_key          = "POST /retell/inbound-lookup"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.bff.id}"
}

resource "aws_apigatewayv2_stage" "bff" {
  api_id      = aws_apigatewayv2_api.bff.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    detailed_metrics_enabled = true
    throttling_burst_limit   = 100
    throttling_rate_limit    = 50
  }

  tags = {
    Name = "${local.name_prefix}-bff"
  }
}

resource "aws_lambda_permission" "bff_api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.bff.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bff.execution_arn}/*/*"
}
