data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "symantic-tfstate-${var.aws_account_id}-${var.aws_region}"
}

resource "aws_s3_bucket" "tfstate" {
  # checkov:skip=CKV_AWS_144: Single-region state; CRR adds cost without benefit for this stack.
  # checkov:skip=CKV_AWS_145: AES256 SSE is sufficient for Terraform state.
  # checkov:skip=CKV2_AWS_62: Event notifications not required for Terraform state.
  bucket = local.state_bucket_name

  tags = {
    Name = local.state_bucket_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Access logging target (separate bucket to avoid self-log loops).
resource "aws_s3_bucket" "tfstate_logs" {
  # checkov:skip=CKV_AWS_144: Single-region logging bucket.
  # checkov:skip=CKV_AWS_145: AES256 SSE is sufficient for access logs.
  # checkov:skip=CKV2_AWS_62: Event notifications not required for access-log bucket.
  # checkov:skip=CKV_AWS_18: This bucket IS the access-log target; do not log to itself.
  # checkov:skip=CKV_AWS_21: Versioning enabled via aws_s3_bucket_versioning.tfstate_logs; Checkov graph often misses it.
  bucket = "${local.state_bucket_name}-logs"

  tags = {
    Name = "${local.state_bucket_name}-logs"
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "tfstate_logs_delivery" {
  statement {
    sid    = "S3ServerAccessLogsPolicy"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.tfstate_logs.arn}/*"]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.tfstate.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "tfstate_logs" {
  bucket = aws_s3_bucket.tfstate_logs.id
  policy = data.aws_iam_policy_document.tfstate_logs_delivery.json
}

resource "aws_s3_bucket_logging" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  target_bucket = aws_s3_bucket.tfstate_logs.id
  target_prefix = "tfstate-access/"
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

output "state_bucket_name" {
  description = "S3 bucket for remote Terraform state. Copy into backend-config/dev.hcl."
  value       = aws_s3_bucket.tfstate.bucket
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state bucket."
  value       = aws_s3_bucket.tfstate.arn
}

output "backend_config_snippet" {
  description = "Paste into backend-config/dev.hcl after bootstrap apply."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.tfstate.bucket}"
    key          = "symantic-agents-infra/${var.environment}/terraform.tfstate"
    region       = "${var.aws_region}"
    encrypt      = true
    use_lockfile = true
    profile      = "${var.aws_profile}"
  EOT
}
