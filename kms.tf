resource "aws_kms_key" "calendar_tokens" {
  description             = "Envelope encryption key for Symantic calendar connection tokens"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = {
    Name = "${local.name_prefix}-calendar-tokens"
  }
}

resource "aws_kms_alias" "calendar_tokens" {
  name          = "alias/${local.name_prefix}-calendar-tokens"
  target_key_id = aws_kms_key.calendar_tokens.key_id
}
