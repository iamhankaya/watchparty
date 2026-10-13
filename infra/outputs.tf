# Deploy script'leri bu adları `terraform output -json` ile okur; adları değiştirmeyin.

output "cloudfront_domain" {
  description = "Sitenin adresi (ör. d123.cloudfront.net)"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "distribution_id" {
  description = "CloudFront dağıtım kimliği (invalidation için)"
  value       = aws_cloudfront_distribution.main.id
}

output "site_bucket" {
  description = "Frontend dist/ içeriğinin yüklendiği bucket"
  value       = aws_s3_bucket.site.bucket
}

output "deploy_bucket" {
  description = "Backend paketlerinin yüklendiği bucket"
  value       = aws_s3_bucket.deploy.bucket
}

output "instance_id" {
  description = "Backend EC2 instance kimliği (SSM komutları için)"
  value       = aws_instance.api.id
}

output "origin_domain" {
  description = "CloudFront'un API origin'i: Elastic IP'nin public DNS adı"
  value       = aws_eip.api.public_dns
}

output "github_deploy_role_arn" {
  description = "GitHub Actions'ın üstleneceği deploy rolü (repo değişkeni AWS_DEPLOY_ROLE_ARN)"
  value       = aws_iam_role.github_deploy.arn
}
