# Bucket adları global olarak benzersiz olmalı; rastgele sonek eklenir.
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

# Site bucket'ı: frontend dist/ içeriği. Private; yalnızca CloudFront OAC okur.
resource "aws_s3_bucket" "site" {
  bucket        = "${var.project}-site-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "CloudFrontOACOkuma"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Yalnızca bu dağıtım okuyabilir.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# Deploy bucket'ı: backend/<zaman>.zip paketleri. Instance buradan çeker.
resource "aws_s3_bucket" "deploy" {
  bucket        = "${var.project}-deploy-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket = aws_s3_bucket.deploy.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Eski backend paketleri 30 gün sonra silinir.
resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id

  rule {
    id     = "eski-backend-paketlerini-sil"
    status = "Enabled"

    filter {
      prefix = "backend/"
    }

    expiration {
      days = 30
    }
  }
}
