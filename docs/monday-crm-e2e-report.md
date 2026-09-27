# monday.com CRM Integration — End-to-End Validation Report

Date: 27 September 2026  
Environment: `symantic-dev`, `https://agents.symantic.ai`  
Live run: `20260927T130336Z-22707`

## Executive summary

The implemented monday.com capabilities are working end to end against a real monday account. A real OAuth grant was obtained, a temporary board was created and mapped, a signed Retell `call_analyzed` event crossed the deployed post-call Lambda, SQS and CRM worker, and a real monday item was created, retrieved, updated and annotated. Replay, tenant-isolation, webhook-signature, token-refresh and cleanup checks also passed.

The integration is ready for the implemented workflow after the changes in this validation are deployed. It is not a general conversational monday CRUD tool. The receptionist automatically looks up an inbound caller by phone and synchronizes analyzed calls after the conversation. It does not expose LLM-selectable CRM tools, search by a spoken name, arbitrary contact edits, deals, companies or deletion.

Two issues were found and fixed:

1. Multiple monday records with the same phone/email could cause the newest record to be selected. Lookup now returns no CRM context and sync fails safely with `ambiguous_match`; neither record is modified.
2. The monday uninstall webhook removed tokens but retained monday-derived metadata. Uninstall now immediately deletes the connection and links and removes CRM-only fields from retained call-history rows.

One important limitation remains: no real telephone call was placed during this run. The deployed production path from a correctly signed `call_analyzed` webhook onward was exercised, and the lookup Lambda was exercised directly, but the Retell voice/LLM layer and the signed post-call path were not joined by an actual phone conversation. The integration UI was covered by automated tests, but the live Symantic UI could not be inspected because the browser did not have an authenticated Symantic session. These are marked PARTIAL rather than PASS.

## Actual architecture

```text
Inbound caller / Retell call
        ↓
BFF inbound lookup (automatic; no LLM CRM tool)
        ↓
CRM Lambda lookup
        ↓
provider-neutral CRM service
        ↓
monday GraphQL adapter
        ↓
monday.com

Retell call_analyzed webhook
        ↓
post-call Lambda → SQS → CRM worker
        ↓
monday adapter
        ↓
find/create item → mapped field updates → call note
```

There is no monday MCP integration and no generic CRM tool exposed to the language model.

## Implemented capability inventory

- Account-level monday app installation followed by workspace OAuth 2.1/PKCE consent
- KMS-encrypted access and refresh tokens, bound to workspace/provider/purpose encryption context
- Six-month reauthorization ceiling and proactive token keeper
- Board, column and user discovery; validated field mapping
- Caller lookup by linked item ID or normalized phone
- Post-call fallback lookup by normalized email
- First-time-caller item creation
- Call note creation
- Mapped status, outcome, appointment, follow-up, last-call, source, owner, phone and email fields
- Idempotent create/note mutation keys, phone leases, negative-lookup cache and monotonic last-call watermark
- Retry/backoff, daily-cap pause, partial-batch SQS handling and DLQ
- Install/uninstall lifecycle webhook authentication
- Tenant-scoped connections, links, calls and OAuth state
- Connection, mapping, reconnect, disconnect, retry and error-state UI

Not implemented: name search, general contact/customer CRUD, companies, deals, arbitrary activities/tasks, arbitrary phone/email edits, item deletion, monday board-change webhooks, MCP tools, or LLM-selectable CRM tools.

## Configuration and authentication evidence

- Deployed Lambda environment references all required CRM tables, queue, public URLs, KMS key and Secrets Manager secret.
- The monday secret contains the required app ID, client ID, client secret and signing secret keys. Values were never printed.
- Configured scopes: `me:read`, `account:read`, `boards:read`, `boards:write`, `updates:write`, `users:read`.
- OAuth callback returned to `/integrations?crm=connected` and an authenticated live board-discovery request returned HTTP 200.
- Tokens are ciphertext at rest and are never included in public API responses or application logs.
- Missing app registration returns a controlled `provider_not_configured` response.
- Denied consent, invalid/expired/replayed state, bad code, revoked grants and expired authorization have deterministic test coverage.

## Controlled real-environment test

Harness: `scripts/monday-live-e2e.sh`. It refuses to run unless `MONDAY_LIVE_E2E=1` is explicitly set and has an EXIT cleanup trap.

The passing run performed the following against real deployed AWS services and monday GraphQL:

1. Used a real OAuth grant from the AscensiveTech monday account.
2. Created a uniquely named temporary board and nine mapped columns.
3. Discovered the board through the deployed CRM API and saved a mapping.
4. Submitted an invalid mapping and verified that the valid mapping was preserved.
5. Sent a correctly signed `call_analyzed` event to the deployed post-call Lambda.
6. Observed the real SQS/worker pipeline create one monday item and one note.
7. Retrieved the item directly from monday and compared name, phone, email, IDs and mapped values.
8. Exercised deployed call-time lookup and received grounded caller context.
9. Sent a callback-request call and verified reuse of the same item plus note, status, outcome and follow-up-date changes.
10. Replayed the event and verified that no duplicate item or note appeared.
11. Sent a forged Retell webhook and received HTTP 401.
12. Attempted cross-tenant board access and received only `not_connected`.
13. Forced token expiry and invoked the deployed token keeper; token version increased after rotation.
14. Deleted the temporary board, test calls and link; reset the mapping; revoked/disconnected OAuth.

Measured wall-clock results:

| Operation | Observed |
|---|---:|
| Temporary board plus columns | 16.9 s |
| Deployed board discovery | 2.4 s |
| Post-call create pipeline | 6.5 s |
| Post-call update/follow-up pipeline | 7.5 s |
| Call-time lookup metric | 360 ms |

The post-call times include asynchronous polling and are not user-facing call latency. The live lookup was within its 1.1-second provider budget. Known callers use a single fetch; unknown callers search once. Returning-caller note and field writes are combined into one monday mutation.

## Test matrix

Status definitions are literal: PASS means the stated path was exercised; PARTIAL identifies a missing live layer; NOT TESTED means no claim is made.

| Area | Test | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|
| OAuth | Real connect/consent/callback/token use | Connected account and usable token | Real callback succeeded; live board request 200 | PASS | Live run and Lambda/API response |
| OAuth | State/PKCE/redirect abuse | Reject invalid/replayed/expired state and off-site redirect | Rejected; return URL stayed on app origin | PASS | Automated flow tests |
| OAuth | Refresh rotation | Expired access token rotates once | Token version incremented | PASS | Live run plus concurrency tests |
| OAuth | Revoked/six-month-expired grant | Controlled reconnect state | `reauth_required`; future calls skip CRM | PASS | Automated flow tests |
| OAuth | Disconnect | Tokens revoked/removed; calls unaffected | Passed; mapping retained for reconnect | PASS | Automated test and live cleanup |
| Connectivity | monday GraphQL reachable | Authenticated response parses | Real board/user discovery succeeded | PASS | Live run |
| Mapping | Discover board/columns/users | Board visible and typed suggestion generated | One real board/user set parsed | PASS | Live run |
| Mapping | Invalid board/column/label/owner | Specific rejection; no bad save | Controlled 422/provider errors | PASS | Live invalid mapping plus tests |
| Read | Existing caller by phone | Correct record/context | Correct live item returned | PASS | Live lookup and direct monday comparison |
| Read | Linked item deleted | Fall back to search | Replacement found | PASS | Automated integration test |
| Read | Search by spoken name | Safe result/clarification | Not an implemented operation | NOT TESTED | Architecture review |
| Create | First-time caller | One item with correct mapped fields and ID | One real item created and verified | PASS | Live post-call pipeline |
| Create | Note/activity | One note with summary/outcome/reference | Real note present | PASS | Direct monday verification |
| Update | Callback/follow-up | Reuse item; update mapped fields and note | Status/outcome/date/note changed | PASS | Live second event |
| Update | Arbitrary phone/email change | Only requested field changes | Not an implemented operation | NOT TESTED | Architecture review |
| Delete | CRM item deletion | Authorized delete | Not supported by product | NOT TESTED | Architecture review |
| Integrity | Name/phone/email/status/note/custom fields/IDs | Round-trip without corruption | Direct monday comparison passed | PASS | Live run |
| Integrity | Assigned owner | Correct default owner on create; preserved later | Passed with fake monday schema | PASS | Automated integration test |
| Integrity | Out-of-order calls | Older call cannot overwrite newer fields | Watermark prevented overwrite | PASS | Automated integration test |
| Duplicate | Same event/retry | One item and one note | Replay created neither duplicate | PASS | Live run |
| Duplicate | Concurrent/lost response | One lead/note despite workers/network loss | Idempotency and lease tests passed | PASS | Automated integration tests |
| Ambiguity | Same phone/email on multiple items | Do not select or write arbitrarily | No context; sync fails `ambiguous_match` | PASS | New regression tests |
| Negative | No caller match | No invented context; create after analyzed call | No-context and first-time create paths passed | PASS | Automated lookup plus live create |
| Negative | Bad email/phone/missing input/status | Controlled validation/failure | Validation and provider error paths passed | PASS | Automated tests |
| Failure | Timeout/5xx/network/malformed response | Call continues; bounded retry; no corruption | Classified, retried or safely skipped | PASS | Automated tests |
| Failure | Rate/daily limit | Backoff/pause then resume | Provider delay honored; UTC reset handled | PASS | Automated tests |
| Failure | Database/SQS interruption | Retry without duplicate writes | Conditional writes/requeue paths passed | PASS | Automated tests |
| Webhook | Retell signature | Forgery rejected | Live forged event returned 401 | PASS | Live run |
| Webhook | monday lifecycle JWT | Reject forged/expired/cross-app/account JWT | All rejected | PASS | Automated tests |
| Webhook | Live monday uninstall | Purge and tolerate duplicate delivery | Destructive live uninstall not performed | PARTIAL | Production path tested with behavioral store |
| Privacy | Uninstall data removal | Remove monday-derived local data | Connection/links deleted; call CRM fields scrubbed | PASS | New automated lifecycle test |
| Tenancy | Cross-workspace access | No data/token leakage | Foreign workspace saw only `not_connected` | PASS | Live run and isolation tests |
| Security | Token exposure | Never reach browser/logs | Public views/log summaries exclude token material | PASS | Code review and automated tests |
| Security | Prompt asks for all data/token/delete/other tenant | Backend makes bypass impossible | No LLM CRM tools; APIs derive tenant from verified identity | PASS | Architecture/code tests (not prompt behavior) |
| MCP | Discovery/tools/schema | Correct tools | MCP is not used | NOT TESTED | Architecture review |
| UI | Connect/status/mapping/reconnect/disconnect/errors/loading/empty | Accurate state and copy | 18 focused tests and full frontend suite passed | PASS | Vitest |
| UI | Live authenticated integrations page | Same state as backend | Browser lacked a Symantic session | PARTIAL | monday consent page only |
| Agent | Real phone conversation through voice/LLM | Lookup during ringing and post-call sync | Deployed lookup + signed post-call paths tested separately | PARTIAL | No real phone call placed |
| Performance | Lookup/create/update | Within bounded operational targets | 360 ms / 6.5 s / 7.5 s observed | PASS | Live metrics/timings |
| Cleanup | No test data/messages left | Board/calls/link/grant removed; queues empty | Connection disconnected/unconfigured; queue and DLQ = 0 | PASS | Post-run AWS inspection |

## Problems found, root causes and fixes

### 1. Ambiguous contacts could be selected

- Classification: data integrity / safety, high
- Root cause: the monday adapter returned the most recently updated matching item plus `matchCount`, but the lookup and sync layers did not stop when `matchCount > 1`.
- Impact: caller context or a call note could be associated with the wrong person when records shared a phone/email.
- Fix: lookup returns `ambiguous` with no context or cached record; sync raises the permanent `ambiguous_match` error before saving a link or writing to monday; the UI tells an admin to merge/correct duplicates and retry.
- Verification: new call-time and post-call duplicate tests pass; neither duplicate receives an update.

### 2. Uninstall retained monday-derived metadata

- Classification: privacy/compliance, high
- Root cause: lifecycle uninstall reused ordinary Disconnect semantics, which intentionally retain mapping/link metadata for easy reconnection.
- Impact: monday-derived account, board, item and link metadata could outlive app uninstall.
- Fix: uninstall has dedicated purge semantics. It deletes connection and provider links, removes monday CRM fields from retained product call history, and deletes the connection last so retried lifecycle events can complete a partial purge safely.
- Verification: lifecycle test proves connection/link deletion, CRM-field scrubbing, preservation of independent call history, isolation of an unrelated account and harmless duplicate delivery. IAM and Terraform validation pass.

### 3. Initial live board discovery failed before this audit

- Classification: API compatibility, previously fixed
- Root cause: the board query requested an unsupported workspace field and a deprecated column field outside the granted scopes/API shape.
- Fix: query now requests only scope-compatible board/column data.
- Verification: deployed live board discovery returned HTTP 200 with a real board and users.

## Security findings

- Tokens are KMS encrypted with tenant-bound encryption context and omitted from APIs/logs.
- OAuth uses PKCE, one-time expiring state and a same-origin return path.
- monday lifecycle events use the client-secret-signed JWT and verify account/app claims.
- Retell post-call forgery returned 401 in the live environment.
- Tenant identity is derived from verified membership/claims, not caller-supplied workspace IDs on public endpoints.
- Cross-tenant live access returned no board or connection data.
- CRM content is sanitized before becoming receptionist context, reducing prompt-injection risk.
- No generic high-power GraphQL or MCP tool is exposed to the LLM.
- App uninstall now purges monday-derived local data immediately.

## Observability findings

- Provider operations emit structured latency/outcome metrics; lookup, OAuth, webhook, sync success/failure, ambiguity, retries and rate limits are counted.
- Calls carry a stable call ID; monday notes contain a bounded `Ref:` correlation identifier.
- Logs include workspace/operation/error codes but suppress provider bodies, tokens and full phone numbers.
- Retry state and last error are stored for the integration UI; SQS has a DLQ after bounded attempts.

## Automated regression results

- Backend: 454/454 tests passed.
- CRM focused: 95/95 tests passed.
- Frontend: 626/626 tests passed across 78 files.
- Frontend lint, TypeScript and production Next.js build passed.
- Terraform formatting and validation passed.
- Existing unrelated React `act(...)` warnings remain in knowledge-base tests; they did not fail the suite and are not caused by this integration.

## Remaining limitations and recommended next steps

1. **High:** Place one real inbound telephone call after deployment, speak a callback request, and verify caller context plus the resulting monday note/fields. This closes the only missing voice-layer link.
2. **High:** Run a live authenticated browser check of `/integrations` with a test Symantic admin to verify the exact deployed UI state and screenshots.
3. **Medium:** If public marketplace distribution is intended, complete monday's app review. Until then, monday correctly shows that the app is unreviewed and each customer account admin must install it before authorizing.
4. **Medium:** Add the gated live harness to a manually approved staging workflow; never run it automatically against customer boards.
5. **Low:** Add CloudWatch alarms for `AmbiguousMatch`, `SyncFailed`, DLQ depth, OAuth failures and sustained lookup latency.

After deployment, the workspace is intentionally disconnected. The next user must install the app in their own monday account, authorize it from the Symantic Integrations page, and choose their board/fields.
