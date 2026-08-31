locals {
  provider_secrets = {
    retell = {
      description = "Placeholder for Retell provider credentials"
    }
    telnyx = {
      description = "Placeholder for Telnyx provider credentials"
    }
    google-oauth = {
      description = "Placeholder for Google OAuth provider credentials"
    }
    microsoft-oauth = {
      description = "Placeholder for Microsoft OAuth provider credentials"
    }
    signwell = {
      description = "SignWell API key, webhook ID, and test-mode configuration"
    }
  }
}

resource "aws_secretsmanager_secret" "providers" {
  for_each = local.provider_secrets

  name                    = "symantic/${var.environment}/${each.key}"
  description             = each.value.description
  recovery_window_in_days = 7

  tags = {
    Name = "symantic/${var.environment}/${each.key}"
  }
}
