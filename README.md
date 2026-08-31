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

Terraform also writes the BFF URL and Cognito Hosted UI configuration directly
to the Amplify production branch. The frontend uses Authorization Code + PKCE
at `/auth/callback`; no Cognito client secret is created or exposed to the
browser. Apply this stack before releasing a frontend build that enables remote
API mode.

The BFF persists proposals, proposal templates, and parts in DynamoDB and signs
PDF uploads/downloads against the private proposal-assets bucket. A dedicated
workspace-membership table maps each Cognito `sub` to a company workspace, so
company users share proposal data without sharing credentials. Cognito groups
define `super-admin`, `company-admin`, and `quotation-builder` roles; the BFF
checks the group claim and membership on every authenticated request. Company
administrators can provision and revoke quotation-builder accounts from the
Agents UI without storing passwords in DynamoDB.

## Notes

- `AGENT_REGISTRY_SECRET` is generated in Terraform and set on the Amplify branch (sensitive; lives in encrypted state).
- Future backend code can live under `backend/` in the app repo without changing Amplify `appRoot` (frontend stays at repo root).
- Shell conventions for AWS CLI in this org: `--profile ascensiveAdmin`, `--region us-east-1`.

## Telnyx to Retell SIP mapping

This stack intentionally does not create or mutate a live Telnyx SIP trunk. Before using agent activation, create the connection manually and store only credentials/configuration in the existing placeholders:

`symantic/{env}/telnyx`:

```json
{ "apiKey": "...", "connectionId": "pre-created-telnyx-connection-id" }
```

`symantic/{env}/retell`:

```json
{
  "apiKey": "...",
  "defaultVoiceId": "retell-provider-voice-id",
  "voiceIds": { "product voice label": "retell-provider-voice-id" }
}
```

Intended production mapping:

1. Create a Telnyx FQDN SIP connection to `sip.retellai.com` using SRV, `+E.164` inbound number format, `G722`/`G711U`/`G711A`, and TCP.
2. Configure the Telnyx outbound voice profile and Retell-required SIP authentication/header settings.
3. Activation orders the DID onto that existing `connectionId`; it does not create the trunk.
4. Import the DID into Retell as a custom-telephony number and bind the Retell agent named `Symantic <agentId> · <name>`.
5. Route signed DID configuration requests to `POST /retell/inbound-lookup`; the response contains the current prompt, tools, voice, transfer numbers, and booking flag.

Do not put API keys or SIP credentials in Terraform variables, source files, or committed examples. See the current Retell Telnyx/custom-telephony guides before live setup because SIP IP allowlists and provider settings can change.

## SignWell proposal signing

Terraform creates the SignWell secret and the public, HMAC-verified webhook
route. After applying the stack, configure the provider once from this repo:

```sh
read -s SIGNWELL_API_KEY
export SIGNWELL_API_KEY
node scripts/configure-signwell.mjs
unset SIGNWELL_API_KEY
```

The script reuses an existing callback when present, otherwise registers
`terraform output -raw signwell_webhook_url`, then writes
`apiKey`, `webhookId`, and `testMode` to `symantic/dev/signwell`. It sends the
secret JSON to AWS CLI through standard input and never prints the API key.
Test mode is intentionally the default. After end-to-end verification, opt in
to legally binding live requests with `SIGNWELL_TEST_MODE=false` and rerun the
same command.

SignWell sends the signature-request and completion emails. RapidProposal does
not need SES for this workflow. The Lambda receives document status webhooks,
stores only document/recipient status in the existing proposals table, and
retrieves the completed PDF from SignWell only after all recipients sign.
