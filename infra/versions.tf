terraform {
  # use_lockfile (S3'te yerleşik kilit) 1.10 ile geldi.
  required_version = ">= 1.10"

  # State S3'te; bucket Terraform dışında bir kez oluşturuldu (deploy/README.md "State bucket'ı").
  # Backend bloğunda değişken kullanılamaz, değerler sabit yazılır.
  backend "s3" {
    bucket       = "watchparty-tfstate-8b2f65c1"
    key          = "watchparty/terraform.tfstate"
    region       = "eu-north-1"
    profile      = "watchparty"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project = "watchparty"
    }
  }
}
