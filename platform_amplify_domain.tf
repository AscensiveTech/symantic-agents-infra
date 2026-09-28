# Custom domain agents.symantic.ai. Amplify manages the ACM certificate.
# Route53 zone symantic.ai must already exist in this account.

locals {
  enable_custom_domain = var.app_url != ""

  app_host        = local.enable_custom_domain ? replace(var.app_url, "https://", "") : ""
  app_host_labels = local.enable_custom_domain ? split(".", local.app_host) : []
  # Amplify subdomain prefix cannot contain dots: agents.symantic.ai ->
  # domain_name = symantic.ai, prefix = agents
  app_prefix      = local.enable_custom_domain ? local.app_host_labels[0] : ""
  app_domain_name = local.enable_custom_domain ? join(".", slice(local.app_host_labels, 1, length(local.app_host_labels))) : ""
}

data "aws_route53_zone" "root" {
  count        = local.enable_custom_domain ? 1 : 0
  name         = var.domain_root_zone
  private_zone = false
}

resource "aws_amplify_domain_association" "frontend" {
  count       = local.enable_custom_domain ? 1 : 0
  app_id      = aws_amplify_app.frontend.id
  domain_name = local.app_domain_name

  # DNS verification completes async once Route53 records below exist.
  wait_for_verification = false

  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = local.app_prefix
  }
}

# Amplify emits certificate_verification_dns_record as "name TYPE value".
resource "aws_route53_record" "amplify_cert_verify" {
  count           = local.enable_custom_domain ? 1 : 0
  zone_id         = data.aws_route53_zone.root[0].zone_id
  name            = element(split(" ", aws_amplify_domain_association.frontend[0].certificate_verification_dns_record), 0)
  type            = element(split(" ", aws_amplify_domain_association.frontend[0].certificate_verification_dns_record), 1)
  ttl             = 300
  records         = [element(split(" ", aws_amplify_domain_association.frontend[0].certificate_verification_dns_record), 2)]
  allow_overwrite = true
}

# Subdomain CNAME -> Amplify (dns_record is also "name TYPE value").
resource "aws_route53_record" "amplify_subdomain" {
  count           = local.enable_custom_domain ? 1 : 0
  zone_id         = data.aws_route53_zone.root[0].zone_id
  name            = element(split(" ", one(aws_amplify_domain_association.frontend[0].sub_domain).dns_record), 0)
  type            = element(split(" ", one(aws_amplify_domain_association.frontend[0].sub_domain).dns_record), 1)
  ttl             = 300
  records         = [element(split(" ", one(aws_amplify_domain_association.frontend[0].sub_domain).dns_record), 2)]
  allow_overwrite = true
}
