variable "region" {
  description = "AWS bölgesi"
  type        = string
  default     = "eu-north-1"
}

variable "aws_profile" {
  description = "Kullanılacak AWS CLI profili"
  type        = string
  default     = "watchparty"
}

variable "instance_type" {
  description = "Backend EC2 instance tipi (ARM, linux-arm64 publish ile uyumlu olmalı)"
  type        = string
  default     = "t4g.small"
}

variable "project" {
  description = "Kaynak adlarında kullanılan proje öneki"
  type        = string
  default     = "watchparty"
}

variable "alert_email" {
  description = "Alarm bildirimlerinin gideceği e-posta (infra/terraform.tfvars içinde verilir; repoya girmez)"
  type        = string
}
