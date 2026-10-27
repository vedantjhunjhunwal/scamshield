terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in S3 so CI and laptops share it. Supply bucket/key/region at init:
  #   terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=scamshield.tfstate" -backend-config="region=ap-south-1"
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "scamshield"
      ManagedBy = "terraform"
    }
  }
}
