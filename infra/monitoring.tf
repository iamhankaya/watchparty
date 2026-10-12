# İzleme: uçtan uca sağlık kontrolü, EC2 durum kontrolü ve yüksek CPU alarmları, e-posta bildirimi.
# Organizasyon SCP'si yalnızca eu-north-1'e izin verdiği için Route 53 health check ve CloudFront
# metrikleri (us-east-1'de durur) kullanılamaz; sağlık kontrolü bu bölgedeki bir Lambda ile yapılır.

resource "aws_sns_topic" "alarms" {
  name = "${var.project}-alarms"
}

# AWS bir onay e-postası gönderir; linke tıklanana kadar bildirim gelmez.
resource "aws_sns_topic_subscription" "alarm_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- Uçtan uca sağlık kontrolü (5 dakikada bir) ---

data "archive_file" "health_check" {
  type        = "zip"
  source_file = "${path.module}/health_check.py"
  output_path = "${path.module}/.terraform/health_check.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "health_check" {
  name               = "${var.project}-health-check"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "health_check_logs" {
  role       = aws_iam_role.health_check.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "health_check" {
  name              = "/aws/lambda/${var.project}-health-check"
  retention_in_days = 14
}

resource "aws_lambda_function" "health_check" {
  function_name    = "${var.project}-health-check"
  role             = aws_iam_role.health_check.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "health_check.handler"
  filename         = data.archive_file.health_check.output_path
  source_code_hash = data.archive_file.health_check.output_base64sha256
  timeout          = 15
  memory_size      = 128

  environment {
    variables = {
      HEALTH_URL = "https://${aws_cloudfront_distribution.main.domain_name}/api/health"
    }
  }

  depends_on = [aws_cloudwatch_log_group.health_check, aws_iam_role_policy_attachment.health_check_logs]
}

resource "aws_cloudwatch_event_rule" "health_check" {
  name                = "${var.project}-health-check"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "health_check" {
  rule = aws_cloudwatch_event_rule.health_check.name
  arn  = aws_lambda_function.health_check.arn
}

resource "aws_lambda_permission" "health_check_events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.health_check.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.health_check.arn
}

# Art arda 2 başarısız kontrol (10 dk) ya da hiç veri gelmemesi (fonksiyon çalışmıyor) alarm sayılır.
resource "aws_cloudwatch_metric_alarm" "site_down" {
  alarm_name          = "${var.project}-site-down"
  alarm_description   = "CloudFront uzerinden /api/health 10 dakikadir basarisiz"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.health_check.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# --- EC2 ---

# Donanım/AWS tarafı sorunu: instance sağlam bir makineye taşınır (EIP ve disk aynı kalır).
resource "aws_cloudwatch_metric_alarm" "ec2_system_check" {
  alarm_name          = "${var.project}-ec2-system-check"
  alarm_description   = "EC2 sistem durum kontrolu basarisiz; otomatik recover tetiklendi"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = { InstanceId = aws_instance.api.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  alarm_actions       = ["arn:aws:automate:${var.region}:ec2:recover", aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# İşletim sistemi tarafı sorun (çökme, bellek tükenmesi): yalnızca bildirim.
resource "aws_cloudwatch_metric_alarm" "ec2_instance_check" {
  alarm_name          = "${var.project}-ec2-instance-check"
  alarm_description   = "EC2 instance durum kontrolu basarisiz"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.api.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "ec2_cpu_high" {
  alarm_name          = "${var.project}-ec2-cpu-high"
  alarm_description   = "EC2 CPU 15 dakikadir %80 uzerinde (t4g burst: yavaslama ve ek ucret riski)"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.api.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
