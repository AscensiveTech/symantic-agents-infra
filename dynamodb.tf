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
      // Was workspaceId-only (one calendar per account); now workspaceId +
      // agentId so each agent can have its own calendar connection. This is
      // a breaking key-schema change for any already-deployed table - it
      // requires a real migration (new table + backfill, or accept
      // reconnects) before this is ever applied to the live stack.
      name_suffix = "calendar-connections"
      range_key   = "agentId"
    }
    appointments = {
      name_suffix = "appointments"
      range_key   = "appointmentId"
    }
    calls = {
      name_suffix = "calls"
      range_key   = "callId"
    }
    workspace_usage = {
      name_suffix = "workspace-usage"
      range_key   = "period"
    }
    blocked_numbers = {
      name_suffix = "blocked-numbers"
      range_key   = "phoneNumber"
    }
    contacts = {
      // A manual name override (and/or a "hidden" tombstone for delete) per
      // phone number - the Contacts page itself is still primarily a
      // client-side aggregation over call history, this table only holds
      // what a customer explicitly set: a rename, a manually-added contact
      // with no calls yet (via the Excel import), or a delete.
      name_suffix = "contacts"
      range_key   = "phoneNumber"
    }
    leads = {
      name_suffix = "leads"
      range_key   = "leadId"
    }
    messages = {
      name_suffix = "messages"
      range_key   = "messageId"
    }
    proposals = {
      name_suffix = "proposals"
      range_key   = "proposalId"
    }
    proposal_parts = {
      name_suffix = "proposal-parts"
      range_key   = "partId"
    }
    proposal_templates = {
      name_suffix = "proposal-templates"
      range_key   = "templateId"
    }
    knowledge_bases = {
      name_suffix = "knowledge-bases"
      range_key   = "knowledgeBaseId"
    }
    most_asked_digests = {
      // One row per generated digest run - doubles as the LLM cost ledger
      // (each row carries costCents + agentId), summed on read rather than
      // maintained as a separate running counter.
      name_suffix = "most-asked-digests"
      range_key   = "digestId"
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
      each.key == "agents" ? "retellAgentId" : null,
      each.key == "calls" ? "startedAt" : null,
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

  dynamic "global_secondary_index" {
    for_each = each.key == "agents" ? [1] : []

    content {
      name            = "retellAgentId-index"
      hash_key        = "retellAgentId"
      projection_type = "ALL"
    }
  }

  // Lets Contacts (and any other "just the recent calls" view) Query the
  // most recent calls directly, ScanIndexForward: false + Limit, instead of
  // pulling the entire call history into the Lambda and sorting in memory -
  // the calls table's own key (workspaceId + a random callId) has no way to
  // ask for "recent" cheaply otherwise.
  dynamic "global_secondary_index" {
    for_each = each.key == "calls" ? [1] : []

    content {
      name            = "startedAt-index"
      hash_key        = "workspaceId"
      range_key       = "startedAt"
      projection_type = "ALL"
    }
  }

  dynamic "ttl" {
    for_each = contains(["workspace_usage", "blocked_numbers"], each.key) ? [1] : []

    content {
      attribute_name = "expiresAt"
      enabled        = true
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
