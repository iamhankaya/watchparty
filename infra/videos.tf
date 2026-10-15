# Video bucket'ı: tools/downloader'ın yüklediği MP4'ler (videolar/ önekiyle). Private; yalnızca CloudFront OAC okur.
resource "aws_s3_bucket" "videos" {
  bucket        = "${var.project}-videos-${random_id.bucket_suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "videos" {
  bucket = aws_s3_bucket.videos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "videos" {
  statement {
    sid       = "CloudFrontOACOkuma"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.videos.arn}/*"]

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

resource "aws_s3_bucket_policy" "videos" {
  bucket = aws_s3_bucket.videos.id
  policy = data.aws_iam_policy_document.videos.json

  depends_on = [aws_s3_bucket_public_access_block.videos]
}

# Videolar 30 gün sonra silinir; yarım kalan çok parçalı yüklemeler 2 gün sonra iptal edilir.
resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    id     = "eski-videolari-sil"
    status = "Enabled"

    # Boş filtre: tüm bucket.
    filter {}

    expiration {
      days = 30
    }
  }

  rule {
    id     = "yarim-yuklemeleri-iptal-et"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

# Edge önbelleği en fazla 1 gün: S3'te silinen video CloudFront'ta en geç 1 gün sonra erişilemez olur.
# Bu 1 günlük üst sınır yalnızca CloudFront edge'i için geçerlidir; tarayıcılar nesnenin
# max-age=31536000, immutable başlığını olduğu gibi korur.
resource "aws_cloudfront_cache_policy" "videos" {
  name        = "${var.project}-videos"
  comment     = "Videolar: en fazla 1 gun onbellek, cache key'de cerez/baslik/query yok"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 86400

  parameters_in_cache_key_and_forwarded_to_origin {
    # MP4 zaten sıkıştırılmış; gzip/brotli kapalı.
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# Tarayıcıdan doğrudan yükleme: presigned PUT (multipart parçaları ve altyazı) yalnızca sitenin
# origin'inden (ve isteğe bağlı geliştirme origin'inden) gelir. ETag, multipart tamamlama için okunur.
resource "aws_s3_bucket_cors_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  cors_rule {
    allowed_origins = concat(
      ["https://${aws_cloudfront_distribution.main.domain_name}"],
      var.upload_dev_origin != "" ? [var.upload_dev_origin] : []
    )
    allowed_methods = ["PUT"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
