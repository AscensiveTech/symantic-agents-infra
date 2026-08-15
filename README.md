# Symantic Agents Infra

Terraform for hosting **symantic-agents-frontend** on AWS Amplify (`WEB_COMPUTE` / Next.js SSR) at **https://agents.symantic.ai**, plus a GitHub Actions OIDC role that can start Amplify release jobs.

## Layout

| Path | Purpose |
|------|---------|
| `bootstrap/` | One-time S3 state bucket (versioned, encrypted, public blocked) |
| `amplify.tf` | Amplify app, production branch, SSR IAM role, registry secret |
| `amplify_domain.tf` | Route53 + Amplify domain association for `agents.symantic.ai` |
| `github_oidc.tf` | CI deploy role (`StartJob` / `GetJob` only) |
| `backend-config/` | Per-env S3 backend config (native `use_lockfile`) |

## Prerequisites

- AWS profile `ascensiveAdmin` (account `883155611064`)
- Terraform `>= 1.10` (native S3 locking)
- Public Route53 zone `symantic.ai` already in the account
- GitHub PAT with repo access for Amplify GitHub App connection
- Account already has GitHub OIDC provider (`create_github_oidc_provider = false`)

## Bootstrap state (once)

```cmd
cd bootstrap
terraform init
terraform apply
```

Copy the `backend_config_snippet` output into `backend-config/dev.hcl` (or copy `dev.hcl.example` and adjust).

## Apply root stack

```cmd
cd ..
copy terraform.tfvars.example terraform.tfvars
set TF_VAR_amplify_github_access_token=ghp_YOUR_TOKEN
terraform init -backend-config=backend-config/dev.hcl
terraform plan
terraform apply
```

## Wire GitHub (after apply)

From `terraform output`:

1. Repository **secret** `AWS_DEPLOY_ROLE_ARN` = `ci_deploy_role_arn`
2. Repository **variable** `AMPLIFY_APP_ID` = `amplify_app_id`

Push to `main` in `AscensiveTech/symantic-agents-frontend`. The deploy workflow runs `npm run check`, assumes the OIDC role, and calls Amplify `StartJob(RELEASE)`. Amplify **auto-build is disabled**.

## Notes

- `AGENT_REGISTRY_SECRET` is generated in Terraform and set on the Amplify branch (sensitive; lives in encrypted state).
- Future backend code can live under `backend/` in the app repo without changing Amplify `appRoot` (frontend stays at repo root).
- Shell conventions for AWS CLI in this org: `--profile ascensiveAdmin`, `--region us-east-1`.
