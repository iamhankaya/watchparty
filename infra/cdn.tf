locals {
  s3_origin_id     = "s3"
  api_origin_id    = "api"
  videos_origin_id = "videos"

  # connect-src: tarayıcıdan yüklemede presigned PUT video bucket'ının bölgesel adresine gider.
  # Spec ile birebir; değiştirirken frontend'in yüklediği kaynakları (YouTube, Google Fonts) kontrol edin.
  content_security_policy = "default-src 'self'; script-src 'self' https://www.youtube.com; frame-src https://www.youtube.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src https:; connect-src 'self' https://${aws_s3_bucket.videos.bucket}.s3.${var.region}.amazonaws.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.project}-site"
  description                       = "WatchParty site bucket OAC"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# SPA yönlendirmesi; yalnızca varsayılan (S3) behavior'a bağlanır.
# Custom error response kullanılmaz: API'nin 404'ünü 200 HTML'e çevirirdi.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "SPA: uzantisiz yollar -> /index.html"
  code    = file("${path.module}/spa-rewrite.js")
  publish = true
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.project}-security-headers"
  comment = "CSP, HSTS, nosniff, Referrer-Policy"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "WatchParty"
  default_root_object = "index.html"
  price_class         = "PriceClass_All"

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # Videolar: private video bucket'ı, aynı OAC ile.
  origin {
    origin_id                = local.videos_origin_id
    domain_name              = aws_s3_bucket.videos.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # Backend: EIP'nin public DNS'i, HTTP:80. Gizli header'ı taşımayan istekleri backend 403 ile reddeder.
  origin {
    origin_id   = local.api_origin_id
    domain_name = aws_eip.api.public_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.api_origin_id
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # SignalR: negotiate (POST) ve WebSocket upgrade; ?id= ve Sec-WebSocket-* başlıkları origin'e gider.
  ordered_cache_behavior {
    path_pattern               = "/hubs/*"
    target_origin_id           = local.api_origin_id
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Videolar: SPA yönlendirmesi uygulanmaz; MP4 sıkıştırılmaz, edge önbelleği en fazla 1 gün.
  ordered_cache_behavior {
    path_pattern               = "/videolar/*"
    target_origin_id           = local.videos_origin_id
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = false
    cache_policy_id            = aws_cloudfront_cache_policy.videos.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
