resource "aws_cognito_user_pool" "frontend" {
  name = "${local.name_prefix}-users"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  tags = {
    Name = "${local.name_prefix}-users"
  }
}

locals {
  frontend_role_groups = {
    super-admin = {
      description = "Symantic.ai platform operators"
      precedence  = 0
    }
    company-admin = {
      description = "Customer company administrators"
      precedence  = 10
    }
    quotation-builder = {
      description = "Company users permitted to build quotations"
      precedence  = 20
    }
  }
}

resource "aws_cognito_user_group" "frontend_roles" {
  for_each = local.frontend_role_groups

  user_pool_id = aws_cognito_user_pool.frontend.id
  name         = each.key
  description  = each.value.description
  precedence   = each.value.precedence
}

resource "aws_cognito_user_pool_client" "frontend" {
  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.frontend.id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["email", "openid", "profile"]
  callback_urls                        = local.cognito_callback_urls
  logout_urls                          = local.cognito_logout_urls
  supported_identity_providers         = ["COGNITO"]

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "frontend" {
  domain       = "${local.name_prefix}-${var.aws_account_id}"
  user_pool_id = aws_cognito_user_pool.frontend.id
}
