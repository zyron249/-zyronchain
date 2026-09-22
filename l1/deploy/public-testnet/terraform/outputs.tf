# Interface sketch only. No resources are declared, so apply would create nothing useful.
# Do not add a provider block with credentials.

output "role_name" {
  value = var.role_name
}

output "failure_domain" {
  value = var.failure_domain
}
