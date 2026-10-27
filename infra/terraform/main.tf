data "aws_vpc" "default" {
  default = true
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# --- Secrets -----------------------------------------------------------------
# Generated once and stored encrypted in SSM; the instance reads them at boot,
# so they never appear in user data, CI logs or the repository.

resource "random_password" "indicator_key" {
  length  = 64
  special = false
}

resource "random_password" "grafana_admin" {
  length  = 24
  special = false
}

resource "aws_ssm_parameter" "indicator_key" {
  name  = "/scamshield/indicator-key-secret"
  type  = "SecureString"
  value = random_password.indicator_key.result
}

resource "aws_ssm_parameter" "grafana_admin" {
  name  = "/scamshield/grafana-admin-password"
  type  = "SecureString"
  value = random_password.grafana_admin.result
}

# --- IAM: SSM Session Manager instead of SSH, plus read access to the two secrets

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "scamshield-node"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.indicator_key.arn, aws_ssm_parameter.grafana_admin.arn]
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  name   = "read-scamshield-secrets"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_instance_profile" "node" {
  name = "scamshield-node"
  role = aws_iam_role.node.name
}

# --- Network: only the public API is exposed. No SSH; Grafana and Prometheus are
# bound to localhost and reached through an SSM port-forward.

resource "aws_security_group" "node" {
  name        = "scamshield"
  description = "ScamShield public API"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Public API"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Package, image and SSM endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Instance -----------------------------------------------------------------

resource "aws_instance" "node" {
  ami                    = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.node.name
  vpc_security_group_ids = [aws_security_group.node.id]

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region        = var.region
    image         = var.image
    repo_ref      = var.repo_ref
    key_param     = aws_ssm_parameter.indicator_key.name
    grafana_param = aws_ssm_parameter.grafana_admin.name
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_size = var.data_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "scamshield"
  }
}
