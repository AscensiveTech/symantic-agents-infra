# monday.com company account integration

Setup completed on **2026-09-27 (IST)** for the AscensiveTech monday.com account, using the repository guide `docs/monday-app-setup.pdf`.

This record intentionally excludes the monday.com account password, OAuth client secret, and signing secret. Those values must remain in their source system or AWS Secrets Manager and must never be committed to Git.

## Result

- App name: `Symantic AI Receptionist`
- Permanent app slug: `ascensivetech_symantic-ai-receptionist`
- App ID: `12252613`
- Client ID: `81c24cfddc43c303933a5e32e92913b3`
- App version: `v1`
- App version ID: `18306262`
- App feature ID: `125126820`
- Version status: `Active` and `Live`
- Distribution status: `Published`
- Installation access: `All accounts`
- AscensiveTech account status: `App installed`
- Installation link: <https://auth.monday.com/oauth2/authorize?client_id=81c24cfddc43c303933a5e32e92913b3&response_type=install>

## Configuration applied

### OAuth permissions

The following six scopes were selected and saved:

- `me:read`
- `account:read`
- `boards:read`
- `boards:write`
- `updates:write`
- `users:read`

The **New OAuth Flow** option is enabled.

### OAuth redirect

The redirect URL is:

```text
https://d51fcxtxo8.execute-api.us-east-1.amazonaws.com/crm/oauth/monday/callback
```

### Lifecycle webhook

The **All Events** lifecycle webhook is:

```text
https://d51fcxtxo8.execute-api.us-east-1.amazonaws.com/crm/monday/lifecycle
```

The webhook covers the monday.com application lifecycle events exposed by the Developer Center, including installation and uninstallation.

### Release and distribution

1. Promoted `v1` to Live.
2. Accepted the monday.com Developer Terms for app distribution.
3. Published the app.
4. Selected **All accounts** for installation access, consistent with the product's multi-tenant integration model.
5. Installed the app into the AscensiveTech monday.com account.

## Secret storage

The app credentials were transferred directly to AWS Secrets Manager. Secret values were not printed to the terminal, included in this document, or written to a repository file.

- AWS account: `883155611064`
- Region: `us-east-1`
- Secret name: `symantic/dev/monday-oauth`
- Secret keys: `clientId`, `clientSecret`, `signingSecret`, `appId`
- Current version ID: `5df393c4-c321-4c7c-a484-ff490bfe7749`
- Current version created: `2026-09-27 16:59:51 IST`
- Secret resource ownership: Terraform-managed shell; value supplied operationally

Do not replace the Terraform-managed secret resource. Rotate its value by adding a new secret version when credentials change.

## Verification performed

- Confirmed exact redirect URL in the monday.com Developer Center.
- Confirmed exact lifecycle webhook URL in the monday.com Developer Center.
- Confirmed all six required OAuth scopes.
- Confirmed New OAuth Flow is enabled.
- Confirmed `v1` is both Active and Live.
- Confirmed app status is Published and installation is allowed for all accounts.
- Confirmed the app is installed in the AscensiveTech monday.com account.
- Confirmed AWS Secrets Manager has one `AWSCURRENT` version for the credential payload.
- Confirmed the CRM Lambda log group received one `install` lifecycle event after installation.
- Confirmed zero `ERROR` events in the CRM Lambda log group during the setup window.

## Remaining application-level validation

The monday.com app and backend credentials are configured. End-to-end user OAuth still needs an authenticated Symantic workspace session:

1. Sign in to <https://agents.symantic.ai/integrations> with an authorized Symantic workspace account.
2. Select **Connect Monday**. Symantic displays a two-step account setup panel.
3. Select **Open monday install**, choose the intended customer account, and have that account's monday administrator approve installation.
4. Return to Symantic and select **I've installed it — authorize**. Choose the same monday account and approve the six listed permissions.
5. Map the target monday.com board and columns in the Symantic integration settings.
6. Place a test receptionist call that creates or updates a lead.
7. Verify the expected item and update in monday.com, then confirm the corresponding success entry in the CRM worker logs.

No Symantic workspace credentials were available during this setup, so the OAuth connection, board mapping, and test-call write were not attempted.

## OAuth account-selection troubleshooting

If the monday.com authorization screen reports **App is not installed**, check the account selector in the upper-right corner before changing the app configuration.

The app is installed in the AscensiveTech company account. Installations are account-specific, so another account, such as `kotlasaisaranreddys-team`, must install the app before it can authorize access. Installing it in AscensiveTech does not install it for any other monday account.

The Symantic backend still includes `force_install_if_needed=true` in authorization URLs as a fallback. In testing, monday.com's OAuth 2.1 page did not consistently perform that automatic installation handoff and instead left the **Authorize** button disabled. Symantic therefore uses an explicit install-first flow:

1. The signed-in Symantic workspace administrator requests the setup link.
2. Symantic returns the public monday install URL; no OAuth state or token is created yet.
3. A monday administrator installs the app in the account that owns the desired boards.
4. The Symantic administrator returns and starts OAuth; a fresh one-time state and PKCE pair are created at this point.
5. monday authorizes the already-installed app and returns the customer to Symantic for board mapping.

A non-administrator cannot bypass monday's account-level approval. They must send the installation link to an administrator of their monday account, then return to Symantic to complete authorization.

The banner stating that the app has not been reviewed or approved by monday.com is expected for this privately distributed app and is separate from the installation error.

## Security follow-up

- Rotate the monday.com account password because it was shared in a chat message.
- Enable multi-factor authentication for the monday.com administrator account if it is not already enabled.
- Keep the OAuth client secret and signing secret only in monday.com and AWS Secrets Manager.
- If credentials are regenerated, update `symantic/dev/monday-oauth` immediately and repeat the OAuth connection test.

## Repository context

This operational setup started from the `infra` repository at commit `a559ceb`. The initial seamless-install change was merged through pull request 49. The explicit install-first customer flow is tracked on branch `codex/monday-install-first-flow` for review through the normal pull-request workflow.
