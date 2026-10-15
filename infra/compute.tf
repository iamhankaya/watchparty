# CloudFront'un backend'e gönderdiği gizli X-Origin-Verify değeri.
# State'te düz metin durur; state dosyası hassastır ve repoya girmez.
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

data "aws_vpc" "default" {
  default = true
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# Inbound yalnızca CloudFront'tan HTTP:80; SSH yok (erişim SSM ile).
resource "aws_security_group" "api" {
  name        = "${var.project}-api"
  description = "WatchParty backend: yalnizca CloudFront origin-facing HTTP"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "CloudFront origin-facing HTTP"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    description = "Tum cikis"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.project}-api"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Deploy sırasında instance backend paketini deploy bucket'ından indirir.
data "aws_iam_policy_document" "deploy_read" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.deploy.arn}/backend/*"]
  }
}

resource "aws_iam_role_policy" "deploy_read" {
  name   = "deploy-bucket-okuma"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.deploy_read.json
}

# Tarayıcıdan yükleme: backend multipart başlatır/tamamlar/iptal eder ve presigned PUT üretir.
# Yalnızca videolar/ önekine yazabilir; okuma/silme yok.
data "aws_iam_policy_document" "videos_upload" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.videos.arn}/videolar/*"]
  }
}

resource "aws_iam_role_policy" "videos_upload" {
  name   = "video-bucket-yukleme"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.videos_upload.json
}

resource "aws_iam_instance_profile" "api" {
  name = "${var.project}-api"
  role = aws_iam_role.api.name
}

# EIP instance'tan önce oluşur (association ayrı kaynak), böylece user_data ve
# CloudFront origin'i public DNS'i döngüsüz kullanabilir. Durdur/başlat sonrası değişmez.
resource "aws_eip" "api" {
  domain = "vpc"

  tags = {
    Name = "${var.project}-api"
  }
}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.api.name
  vpc_security_group_ids = [aws_security_group.api.id]

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
  }

  # Windows'ta (core.autocrlf) çalışma kopyası CRLF içerebilir; CR sunucuya gitmez.
  user_data = replace(templatefile("${path.module}/user_data.sh.tftpl", {
    origin_secret = random_password.origin_secret.result
    origin_domain = aws_eip.api.public_dns
    service_unit  = file("${path.module}/../deploy/watchparty.service")
  }), "\r", "")

  # user_data yalnızca ilk açılışta çalışır; değişince instance yeniden oluşturulmaz.
  user_data_replace_on_change = false

  tags = {
    Name = "${var.project}-api"
  }

  lifecycle {
    # Yeni AMI yayınlandığında instance'ı yeniden oluşturma.
    # user_data değişiklikleri (unit dosyası, env dosyası, bootstrap) çalışan instance'a
    # uygulanmaz; uygulamak için: terraform -chdir=infra apply -replace=aws_instance.api
    # (EIP ve origin secret aynı kalır; bellekteki lobiler kaybolur).
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip_association" "api" {
  allocation_id = aws_eip.api.id
  instance_id   = aws_instance.api.id
}
