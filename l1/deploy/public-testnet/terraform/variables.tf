# Interface sketch only. Do not run terraform init or terraform apply.
# No provider credentials, account ids, or real addresses belong in this file.

variable "role_name" {
  type        = string
  description = "One of validator-a, validator-b, validator-c, bootstrap-a, bootstrap-b, bootstrap-c, rpc-a, rpc-b, archive-a, monitoring-a."
}

variable "failure_domain" {
  type        = string
  description = "region-a, region-b, or region-c. Not a cloud provider."
}

variable "ssh_private_key" {
  type        = string
  sensitive   = true
  description = "Operator-supplied. Never commit a value."
  default     = null
}

variable "genesis_file" {
  type        = string
  description = "Path supplied by the operator after governance builds a genesis. Empty until then."
  default     = null
}
