# GitHub Actions OIDC deploy role for Amplify StartJob / GetJob.
# Account 883155611064 already has the GitHub OIDC provider; keep
# create_github_oidc_provider = false unless bootstrapping a new account.

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn

  amplify_jobs_arn = "arn:aws:amplify:${var.aws_region}:${data.aws_caller_identity.current.account_id}:apps/${aws_amplify_app.frontend.id}/branches/${var.amplify_branch}/jobs/*"
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # AscensiveTech org setting: "Use unique IDs for OIDC subject claims".
    # CloudTrail sub is repo:Owner@ORG_ID/Name@REPO_ID:ref:refs/heads/main
    # not repo:Owner/Name:ref:refs/heads/main. Name-only trust always 403s.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${split("/", var.github_owner_repo)[0]}@${var.github_org_id}/${split("/", var.github_owner_repo)[1]}@${var.github_repo_id}:ref:refs/heads/${var.amplify_branch}",
      ]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${local.name_prefix}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json

  tags = {
    Name = "${local.name_prefix}-ci-deploy"
  }
}

resource "aws_iam_role_policy" "ci_deploy_amplify" {
  name = "amplify-start-get-job"
  role = aws_iam_role.ci_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AmplifyReleaseJobs"
      Effect = "Allow"
      Action = [
        "amplify:StartJob",
        "amplify:GetJob",
      ]
      Resource = [local.amplify_jobs_arn]
    }]
  })
}
