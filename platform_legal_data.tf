# Terms & Conditions / Privacy Policy - version-controlled documents plus an
# append-only per-user acceptance audit trail (docs/PRODUCT_SPEC.md).

# Version rows are immutable: documentType + version ("v1.0", "v1.1", ...).
# The row with version = "ACTIVE" is an overwritten pointer that also carries a
# denormalized copy of the active document, so the acceptance-status read is a
# single GetItem.
resource "aws_dynamodb_table" "legal_documents" {
  name         = "${local.name_prefix}-legal-documents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "documentType"
  range_key    = "version"

  attribute {
    name = "documentType"
    type = "S"
  }

  attribute {
    name = "version"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-legal-documents"
  }
}

# Per user (Cognito sub). sk is either:
#   LATEST#<documentType>            - overwritten, fast "what did they last accept"
#   HISTORY#<documentType>#<ISO ts>  - immutable audit record, never overwritten
resource "aws_dynamodb_table" "legal_acceptances" {
  name         = "${local.name_prefix}-legal-acceptances"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sk"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name = "${local.name_prefix}-legal-acceptances"
  }
}
