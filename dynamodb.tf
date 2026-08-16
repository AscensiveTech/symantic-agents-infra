locals {
  control_plane_tables = {
    workspaces = {
      name_suffix = "workspaces"
      range_key   = null
    }
    business_profiles = {
      name_suffix = "business-profiles"
      range_key   = null
    }
    agents = {
      name_suffix = "agents"
      range_key   = "agentId"
    }
    phone_numbers = {
      name_suffix = "phone-numbers"
      range_key   = "phoneNumberId"
    }
    calendar_connections = {
      name_suffix = "calendar-connections"
      range_key   = null
    }
    appointments = {
      name_suffix = "appointments"
      range_key   = "appointmentId"
    }
    calls = {
      name_suffix = "calls"
      range_key   = "callId"
    }
    leads = {
      name_suffix = "leads"
      range_key   = "leadId"
    }
    messages = {
      name_suffix = "messages"
      range_key   = "messageId"
    }
  }
}

resource "aws_dynamodb_table" "control_plane" {
  for_each = local.control_plane_tables

  name         = "${local.name_prefix}-${each.value.name_suffix}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "workspaceId"
  range_key    = each.value.range_key

  dynamic "attribute" {
    for_each = toset(compact([
      "workspaceId",
      each.value.range_key,
      each.key == "phone_numbers" ? "telnyxPhoneNumber" : null,
    ]))

    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.key == "phone_numbers" ? [1] : []

    content {
      name            = "telnyxPhoneNumber-index"
      hash_key        = "telnyxPhoneNumber"
      projection_type = "ALL"
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-${each.value.name_suffix}"
  }
}
