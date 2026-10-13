# GitHub Actions ile deploy: dar yetkili deploy kullanıcısı ve çıktı parametresi.
# Hesap AWS'nin yeni kayıt deneyiminin Free Tier planında; AWS'nin yönettiği SCP iam:*Provider*
# işlemlerini yasakladığı için OIDC kullanılamıyor. Bu yüzden access key'li bir IAM kullanıcısı var;
# anahtar Terraform'da üretilmez (state'e girmesin diye), CLI ile oluşturulup doğrudan GitHub secret'ına
# yazılır (deploy/README.md). Kullanıcının state bucket'ına (watchparty-tfstate-*) hiçbir izni yoktur ve
# S3'ten nesne silemez. SSM parametresi gizli değer içermez. Hesap Paid Plan'a geçince OIDC'ye dönülebilir
# (docs/BACKLOG.md).

data "aws_caller_identity" "current" {}

resource "aws_iam_user" "github_deploy" {
  name = "${var.project}-github-deploy"
}

data "aws_iam_policy_document" "github_deploy" {
  # Frontend: dist/ içeriği site bucket'ına yüklenir; silme yetkisi yok (videolar/ korunur).
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn]
  }
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.site.arn}/*"]
  }

  # Backend: yayın paketi yalnızca backend/ altına yüklenir.
  statement {
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.deploy.arn}/backend/*"]
  }

  statement {
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.main.arn]
  }

  # SSM komutu yalnızca bu instance'a ve AWS-RunShellScript belgesine gönderilebilir.
  statement {
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.api.id}",
      "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }
  # Bu iki eylem kaynak düzeyinde kısıtlanamaz.
  statement {
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }

  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.infra_outputs.arn]
  }
}

resource "aws_iam_user_policy" "github_deploy" {
  name   = "deploy"
  user   = aws_iam_user.github_deploy.name
  policy = data.aws_iam_policy_document.github_deploy.json
}

# İş akışı deploy bilgilerini terraform yerine buradan okur (outputs.tf ile aynı adlar).
resource "aws_ssm_parameter" "infra_outputs" {
  name = "/${var.project}/infra-outputs"
  type = "String"
  value = jsonencode({
    cloudfront_domain = aws_cloudfront_distribution.main.domain_name
    distribution_id   = aws_cloudfront_distribution.main.id
    site_bucket       = aws_s3_bucket.site.bucket
    deploy_bucket     = aws_s3_bucket.deploy.bucket
    instance_id       = aws_instance.api.id
    origin_domain     = aws_eip.api.public_dns
  })
}
