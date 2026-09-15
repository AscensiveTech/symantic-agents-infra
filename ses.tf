# Outbound email for calendar invitations and call-summary digests, sent from
# var.email_sender_address. The sending domain is verified with Easy DKIM and a
# custom MAIL FROM subdomain. Only *new* records are added: the domain's
# existing mail (MX, SPF, and other providers' DKIM keys) is left untouched.
#
# A new SES account starts in the sandbox, where it can only send to verified
# addresses. Production access is requested from AWS separately - it is an
# account-level review, not something Terraform can grant.

locals {
  email_sender_domain    = split("@", var.email_sender_address)[1]
  email_from             = "${var.email_sender_name} <${var.email_sender_address}>"
  email_mail_from_domain = "bounce.${local.email_sender_domain}"

  # Shared by every Lambda that sends. In the sandbox SES also authorizes the
  # recipient identity, hence identity/*; the From condition keeps this role
  # from sending as anyone but the configured address.
  ses_send_statement = {
    Sid    = "SendNotificationEmail"
    Effect = "Allow"
    Action = ["ses:SendEmail"]
    Resource = [
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
      aws_sesv2_configuration_set.notifications.arn,
    ]
    Condition = {
      StringLike = {
        "ses:FromAddress" = [
          var.email_sender_address,
          "*<${var.email_sender_address}>",
        ]
      }
    }
  }
}

data "aws_route53_zone" "email_sender" {
  name         = local.email_sender_domain
  private_zone = false
}

resource "aws_sesv2_configuration_set" "notifications" {
  configuration_set_name = "${local.name_prefix}-notifications"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  # Hard bounces and complaints stop further sends to that address, which
  # protects the sender's reputation without any code in the Lambdas.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_email_identity" "sender" {
  email_identity         = local.email_sender_domain
  configuration_set_name = aws_sesv2_configuration_set.notifications.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "ses_dkim" {
  count = 3

  zone_id = data.aws_route53_zone.email_sender.zone_id
  name    = "${aws_sesv2_email_identity.sender.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.email_sender_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.sender.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "sender" {
  email_identity         = aws_sesv2_email_identity.sender.email_identity
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
  mail_from_domain       = local.email_mail_from_domain
}

resource "aws_route53_record" "ses_mail_from_mx" {
  zone_id = data.aws_route53_zone.email_sender.zone_id
  name    = local.email_mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

# Monitor-only DMARC (p=none). Receivers such as Gmail and Yahoo expect a
# sending domain to publish a policy, but p=none changes how nothing is
# delivered - including Zoho's own mail for this domain. Only tighten to
# quarantine/reject after confirming every legitimate sender (SES, Zoho, Clerk)
# passes aligned DKIM or SPF.
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.email_sender.zone_id
  name    = "_dmarc.${local.email_sender_domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=none"]
}

resource "aws_route53_record" "ses_mail_from_spf" {
  zone_id = data.aws_route53_zone.email_sender.zone_id
  name    = local.email_mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}
