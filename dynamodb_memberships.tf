resource "aws_dynamodb_table" "workspace_memberships" {
  name         = "${local.name_prefix}-workspace-memberships"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "workspaceId"
    type = "S"
  }

  global_secondary_index {
    name            = "workspaceId-index"
    hash_key        = "workspaceId"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-workspace-memberships"
  }
}
