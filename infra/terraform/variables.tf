variable "region" {
  description = "AWS region. Mumbai is closest to Indian users."
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "EC2 instance type for the single-host cluster (3 shards + gateway + Prometheus + Grafana)."
  type        = string
  default     = "t3.medium"
}

variable "image" {
  description = "Container image published by CI, e.g. ghcr.io/vedantjhunjhunwal/scamshield:<git-sha>."
  type        = string
}

variable "repo_ref" {
  description = "Git ref of this repository to fetch compose and observability config from."
  type        = string
  default     = "main"
}

variable "data_volume_gb" {
  description = "Size of the encrypted root volume holding shard WALs."
  type        = number
  default     = 20
}
