resource "aws_s3_bucket" "proposal_assets" {
  bucket = "${local.name_prefix}-proposal-assets"

  tags = {
    Name = "${local.name_prefix}-proposal-assets"
  }
}

resource "aws_s3_bucket_public_access_block" "proposal_assets" {
  bucket                  = aws_s3_bucket.proposal_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "proposal_assets" {
  bucket = aws_s3_bucket.proposal_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "proposal_assets" {
  bucket = aws_s3_bucket.proposal_assets.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_origins = distinct(compact(["http://localhost:3000", var.app_url]))
    expose_headers  = ["ETag"]
    max_age_seconds = 300
  }
}
