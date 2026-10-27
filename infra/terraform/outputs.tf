output "api_url" {
  description = "Public ScamShield API."
  value       = "http://${aws_instance.node.public_dns}:8080"
}

output "grafana_tunnel" {
  description = "Forward Grafana to localhost:3000 (password in SSM: /scamshield/grafana-admin-password)."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.node.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=3000,localPortNumber=3000"
}

output "instance_id" {
  description = "Connect with: aws ssm start-session --target <instance_id>"
  value       = aws_instance.node.id
}
