# GitHub Actions ile deploy: OIDC sağlayıcısı, dar yetkili deploy rolü ve çıktı parametresi.
# Rol yalnızca master dalındaki iş akışlarından üstlenilebilir. State bucket'ına (watchparty-tfstate-*)
# hiçbir izni yoktur ve S3'ten nesne silemez. SSM parametresi gizli değer içermez.

data "aws_caller_identity" "current" {}

# Thumbprint verilmez; AWS GitHub'ın sertifikasını kendisi doğrular.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/master"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.project}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  # Frontend: dist/ içeriği site bucket'ına yüklenir; silme yetkisi yok; videolar ayrı bir bucket'ta durur ve bu rol ona erişemez.
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

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
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
