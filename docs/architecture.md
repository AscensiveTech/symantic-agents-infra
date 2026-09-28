# Infrastructure architecture

This repository is the Terraform and Lambda source for the production
application at `https://agents.symantic.ai`. The deployed stack uses the
historical Terraform environment name `dev`, but it is production traffic and
must be treated as production-critical.

## State and deployment guardrails

- AWS account: `883155611064`; region: `us-east-1`.
- Remote state: `s3://symantic-tfstate-883155611064-us-east-1/symantic-agents-infra/dev/terraform.tfstate`.
- Terraform remains one root module. File names organize ownership but do not
  participate in resource addresses.
- Moving a resource block between root `.tf` files does not change its address;
  moving it into a Terraform module would and requires an explicit `moved`
  block/state migration.
- Never apply an unexplained replacement or delete. A directory/file cleanup is
  not a reason to recreate a production resource.

## Source layout

```text
platform_*.tf                Amplify, Cognito, API Gateway/BFF, legal,
                             memberships, GitHub deployment identity
product_data.tf              shared DynamoDB table factory
product_storage.tf           product-owned S3 buckets
provider_secrets.tf          provider secret identities only (not values)
receptionist_*.tf            Receptionist runtimes and integrations
lambda/bff/                  shared API compatibility facade
lambda/tools/                Retell callable tools
lambda/oauth/                calendar connection/invitation API
lambda/postcall/             Retell call-ended ingestion
lambda/digest/               scheduled call-summary email
lambda/kb-refresh/           scheduled URL knowledge refresh
lambda/most-asked-refresh/   scheduled premium digest refresh
lambda/crm/                  Monday adapter, API, lookup, worker
bootstrap/                   one-time remote-state bucket
```

The root file prefixes are navigation aids only. Resource addresses, names,
logical IDs, policies, routes, archive contents, and dependencies are unchanged.

## Product inventory

### Shared platform

Hosting and identity:

- Amplify `WEB_COMPUTE` app `symantic-dev-agents`, production branch `main`
- `agents.symantic.ai` Amplify domain association and Route53 records
- Amplify SSR role and GitHub Actions OIDC release role
- Cognito pool, public web client, hosted domain, and groups
  `super-admin`, `company-admin`, `quotation-builder`
- HTTP API Gateway, JWT authorizer, default stage, BFF integration, access
  throttles, and public Retell/SignWell webhooks

Shared runtime/data:

- BFF Lambda, log group, IAM policies, and API route set
- `workspaces`, `workspace-memberships`, and `activity-log` DynamoDB data
- versioned `legal-documents` and append-only `legal-acceptances` tables
- `workspace-usage`, shared by the product billing views
- provider secret resources and the public API/Amplify outputs

Authentication and entitlement enforcement occurs in the BFF on every
authenticated request. Frontend visibility is not the security boundary.

### AI Receptionist

Data and storage:

- DynamoDB: `business-profiles`, `agents`, `phone-numbers`,
  `calendar-connections`, `appointments`, `calls`, `blocked-numbers`,
  `contacts`, `leads`, `messages`, `knowledge-bases`, `most-asked-digests`,
  `calendar-invites`, `oauth-states`, `crm-connections`, and `crm-links`
- S3: private `knowledge-assets` and `call-artifacts` (400-day recording
  lifecycle); shared workspace-usage records
- KMS: calendar-token and CRM-token keys/aliases

Compute and events:

- `tools` Lambda and live alias with provisioned concurrency
- `oauth`, `postcall`, `call-digest`, `kb-refresh`, and
  `most-asked-refresh` Lambdas
- `crm` API/lookup Lambda, live alias, provisioned concurrency, CRM worker,
  SQS queue/DLQ, event-source mapping, token-keeper schedule, and alarms
- EventBridge schedules for call digests, knowledge refresh, most-asked
  refresh, and Monday token refresh
- SES identity, DKIM, MAIL FROM, SPF, monitor-only DMARC, and configuration set

External contracts:

- Retell voice agents, inbound lookup, tool calls, and post-call webhooks
- Telnyx phone provisioning
- Google Calendar, Microsoft Calendar, and Cal.com
- Monday OAuth 2.1/GraphQL and lifecycle webhook
- Anthropic digest generation and SES delivery

### RapidProposal

Data and storage:

- DynamoDB: `proposals`, `proposal-parts`, and `proposal-templates`
- shared `workspaces`, `workspace-memberships`, and `workspace-usage`
- private S3 `proposal-assets`

Compute and external contracts:

- proposal/template/parts/usage/payment methods in the shared BFF
- SignWell API secret, public HMAC-verified webhook, status synchronization,
  and completed signed-PDF archival
- Cognito roles and workspace `rapidProposal` entitlement

RapidProposal has no separate Lambda because its compatibility API is part of
the shared BFF. That is an explicit platform dependency, not ownership by the
Receptionist product.

## Configuration inventory

Terraform variables:

- account/platform: `aws_region`, `aws_profile`, `aws_account_id`, `project`,
  `environment`, `company`
- hosting/DNS: `amplify_repository_url`, `amplify_github_access_token`,
  `amplify_branch`, `app_url`, `domain_root_zone`
- GitHub identity: `github_owner_repo`, `github_org_id`, `github_repo_id`,
  `create_github_oidc_provider`
- email: `email_sender_address`, `email_sender_name`
- Receptionist runtime: `tools_provisioned_concurrency`,
  `crm_provisioned_concurrency`, `crm_alarm_topic_arn`, `monday_api_version`

Lambda environment variables are generated from Terraform references; names
are compatibility contracts:

- BFF: `WORKSPACES_TABLE`, `BUSINESS_PROFILES_TABLE`, `AGENTS_TABLE`,
  `PHONE_NUMBERS_TABLE`, `CALENDAR_CONNECTIONS_TABLE`, `CALLS_TABLE`,
  `WORKSPACE_USAGE_TABLE`, `BLOCKED_NUMBERS_TABLE`, `PROPOSALS_TABLE`,
  `PROPOSAL_PARTS_TABLE`, `PROPOSAL_TEMPLATES_TABLE`,
  `WORKSPACE_MEMBERSHIPS_TABLE`, `LEGAL_DOCUMENTS_TABLE`,
  `LEGAL_ACCEPTANCES_TABLE`, `KNOWLEDGE_BASES_TABLE`,
  `MOST_ASKED_DIGESTS_TABLE`, `CONTACTS_TABLE`, `ACTIVITY_LOG_TABLE`,
  `COGNITO_USER_POOL_ID`, the three asset bucket names, four provider secret
  ARNs, `PUBLIC_API_BASE_URL`, `CALL_DIGEST_FUNCTION_NAME`,
  `CRM_LOOKUP_FUNCTION_NAME`, `CRM_CONNECTIONS_TABLE`, and
  `EMAIL_SENDER_ADDRESS`.
- calendar OAuth: `APP_URL`, `OAUTH_REDIRECT_BASE_URL`,
  `OAUTH_STATE_TTL_SECONDS`, `OAUTH_STATES_TABLE`,
  `CALENDAR_CONNECTIONS_TABLE`, `CALENDAR_INVITES_TABLE`,
  `CALENDAR_INVITE_TTL_DAYS`, `WORKSPACES_TABLE`,
  `WORKSPACE_MEMBERSHIPS_TABLE`, `CALENDAR_TOKENS_KMS_KEY_ID`, both calendar
  OAuth secret ARNs, `EMAIL_FROM`, and `EMAIL_CONFIGURATION_SET`.
- CRM API/worker: `APP_URL`, `PUBLIC_API_BASE_URL`, `CRM_CONNECTIONS_TABLE`,
  `CRM_LINKS_TABLE`, `CALLS_TABLE`, `BUSINESS_PROFILES_TABLE`,
  `WORKSPACE_MEMBERSHIPS_TABLE`, `OAUTH_STATES_TABLE`,
  `CRM_TOKENS_KMS_KEY_ID`, `MONDAY_OAUTH_SECRET_ARN`, `MONDAY_API_VERSION`,
  and `CRM_SYNC_QUEUE_URL`.
- post-call/tools/schedulers use the relevant table, bucket, KMS, secret,
  queue, email, and function names above. Their exact maps remain in the
  corresponding `receptionist_*.tf` file.

Secret identities are `symantic/{environment}/retell`, `telnyx`,
`google-oauth`, `microsoft-oauth`, `signwell`, `monday-oauth`, and `anthropic`.
Terraform owns the secret resources, not credential values.

## Networking and domains

The application is public through Amplify and `agents.symantic.ai`. API Gateway
is public with JWT authorization on authenticated routes and deliberately
unauthenticated, provider-verified routes for Retell, SignWell, calendar OAuth
callbacks/invitations, Monday callbacks, and Monday lifecycle events. DynamoDB,
S3, SQS, KMS, and Lambdas are accessed through AWS service endpoints; this
stack does not create a VPC, subnet, load balancer, RDS database, ECS/EKS
cluster, or CloudFront distribution separate from Amplify's managed delivery.

## IAM and observability

Each Lambda has a dedicated role and least-purpose inline policies plus the AWS
basic logging policy. The BFF may administer Cognito users and invoke only the
named digest/CRM capabilities. CloudWatch log groups are retained for every
Lambda. CRM adds alarms for worker errors, sync failures, queue age, DLQ depth,
and lookup degradation. EventBridge and API Gateway invoke permissions are
explicit resources.

## Dependency rules

1. `platform_*` owns entry points, authentication, shared API transport, and
   cross-product policy—not product business behavior.
2. `receptionist_*` may depend on platform identity/API resources and on
   Receptionist data; it must not depend on proposal implementation details.
3. RapidProposal resources in shared factories retain explicit keys/names and
   are documented as product-owned even while served by the shared BFF.
4. Lambda source folders are deployment archive boundaries. Moving or nesting
   them can change archive hashes/import paths and requires a separate plan.
5. Never rename a Terraform resource label, `for_each` key, table/bucket name,
   secret name, route key, environment variable, or CloudFormation-style
   logical identity without a migration and reviewed plan.

## Adding infrastructure

- Add shared control-plane resources to a `platform_*.tf` file.
- Add Receptionist runtimes/integrations to a `receptionist_*.tf` file.
- Add product data/storage to the existing factories only when preserving
  existing `for_each` keys; otherwise use a clearly product-prefixed root file.
- Generate a remote-state plan before merge and record exact create/update/
  replace/delete counts in the pull request.
