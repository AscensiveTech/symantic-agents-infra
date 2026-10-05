# Voice agent configuration pipeline - release notes (2026-10-05)

What changed in how Symantic builds the AI receptionist's Retell configuration,
and what has to be checked by hand on real calls. Field-by-field detail:
[voice-agent-configuration.md](voice-agent-configuration.md).

PRs: symantic-agents-infra `feat/voice-agent-config-pipeline`,
symantic-agents-frontend `feat/voice-agent-config-pipeline`.

## What changed

### New structure (infra `lambda/bff/voice-agent/`)

One pipeline replaces the single 1,000-line prompt function:

1. **Canonical configuration** (`configuration.mjs`) - the only code that reads the
   stored agent and business profile. Applies every default and legacy fallback.
   No Retell field names.
2. **Tool plan** (`tools.mjs`) - decides which tools the agent has.
3. **Prompt** (`prompt.mjs`) - 24 sections in a fixed order, each included only when
   relevant. Compilation diagnoses a section that names a tool the agent doesn't have,
   and publishing rejects the error before writing to Retell.
4. **Retell payloads** (`retell.mjs`, `post-call.mjs`) - the only place that knows
   Retell field names, plus a validator for Retell's documented enums, ranges,
   E.164 numbers, and `{{variables}}`.
5. **Inspector** (`inspect.mjs`) - read-only view of every stage.

`receptionist.mjs` keeps its old exports and calls the pipeline.
`providers.mjs` now sends what `retell.mjs` builds.

### Fixes

| # | Problem | Fix |
|---|---|---|
| 1 | Prompt clock `{{currentTime}}` was only filled by our inbound webhook. Dashboard and web test calls showed the raw placeholder, and the value had no year. | Prompt uses Retell's `{{current_time_<business timezone>}}` (every call type, includes the year). Agent `timezone` is set too. |
| 2 | Seeded wizard text repeated prompt rules up to 5 times. | Untouched seeded lines that a generated section already covers are left out. Edited text is never touched. |
| 3 | Template text assumed booking and transfers were on, and example dialogues offered times without checking the calendar. | An untouched template paragraph is replaced by guidance that follows the agent's Booking and Transfer settings. Untouched template examples are replaced by generated ones that call the calendar first. |
| 4 | The 911 rule (which overrides everything) blocked the business's own emergency transfers ("gas leak", "flooding", "chest pain"). | "Flood" removed from the 911 list. If a transfer rule also matches, the agent says the 911 line, then transfers. |
| 5 | Reschedule ignored the appointment type: a 2-hour visit came back as 30 minutes, with no lead time or buffers. | Reschedule keeps the type's length (or the original length), lead time, and calendar buffers. |
| 6 | Business hours and holidays were only in the prompt. | Calendar tools refuse times outside hours or on closed holidays (`outside_business_hours`, `closed_holiday`). |
| 7 | Allowed Inbound Countries didn't update on Save Changes of a live agent. | Save Changes now updates the phone number when the list changed. |
| 8 | Transfer extensions were appended to the number as `,,,digits`. | Uses Retell's documented `transfer_destination.extension`. |
| 9 | Spanish agents got an English default greeting and no instruction to speak Spanish. When the caller speaks first, the prompt still said the greeting had been said. | Spanish default greeting and a "speak Spanish" line. A caller-first context line. |
| 10 | Wizard: Final Reminders showed the default when the saved value was empty. The Default Transfer Number hint promised a transfer that doesn't happen. | Field shows the saved value. Hint now says transfers happen only when a Call Transfer rule matches. |
| 11 | `tests/contract` was already failing on main (fake store missing slot locks). | Fixed. |
| 12 | (Found in the final audit.) The wizard seeds an English sample greeting into every new agent, so Spanish agents still greeted in English. A blank greeting also sent different text from the default the wizard shows. | A blank greeting sends the wizard's own sample. A Spanish agent's untouched English sample becomes the Spanish sample, and the wizard swaps it when the language changes. A test in each repo fails if the two copies drift. |
| 13 | (Found in the final audit.) With a matching emergency transfer rule, the 911 rule said "hang up and call 911" and then transferred. | With a matching rule the agent says "if anyone is in danger, hang up and call 911 - otherwise I'll connect you now", then transfers. |
| 14 | (Found in the final audit.) Small inconsistencies: transfer tool descriptions said "mentions" while the prompt matches by meaning; TAKING A MESSAGE didn't defer to transfer rules; CLOSING didn't list NO PROGRESS as an early end. | All three aligned. |
| 15 | (Found in the second audit.) Live agents with no stored publish fingerprint would all show "Manually Edited by Admin in Retell" right after deploy, because the fallback compared their live prompt with the new generator's output. | Without a fingerprint, only a prompt that lacks the app-generated structure, or a greeting matching neither the current nor the previous default, is flagged. The next Save Changes stores fingerprints. |
| 16 | (Found in the second audit.) Activation sent the stored country list without normalising it. | Normalised the same way as everywhere else. The inspector also notes when the next publish will migrate legacy per-agent knowledge. |
| 17 | Phone reconciliation called Retell's removed legacy list endpoint and assumed an unpaginated array response. | Uses the current paginated `/v2/list-phone-numbers` endpoint and consumes `items`; provider and publish-flow tests cover it. |
| 18 | Clearing a timezone or changing from agent-first to caller-first could leave stale values in Retell because its PATCH updates preserve omitted fields. | Every owned update now sends `timezone` (`Etc/UTC` for a legacy invalid/cleared value) and `begin_message_delay_ms` (`0` when caller-first). |
| 19 | Error-level compile diagnostics were visible in the inspector but did not prevent publication. | The publish configuration boundary rejects them with `invalid_voice_agent_configuration` before any Retell request. |
| 20 | With scheduling disabled, generated prompt examples no longer mentioned booking, but customer-authored examples could still claim a booking succeeded without calendar tools. | Generated examples are capability-aware; contradictory custom examples produce a blocking diagnostic. |
| 21 | The frontend draft round trip marked only six of eight wizard steps complete. | `forward` and `guardrails` are included, with a round-trip unit test. |
| 22 | Retell payload validation was visible in the inspector but not enforced at the write boundary. | The exact generated LLM and agent payloads are validated before publication; invalid configurations receive a 422 and make no Retell request. |
| 23 | Scheduling/transfer contradictions written without an exact tool name could survive in customer instructions. | Retained customer instruction clauses are checked for affirmative disabled capabilities; explicit prohibitions and stripped legacy seed text are not blocked. |
| 24 | Invalid timezone values could make the prompt use UTC, Retell use its account default, and calendar tools fail. | New activation rejects invalid IANA zones; legacy values consistently use UTC in prompt, Retell and calendar tools. |
| 25 | Activation-time configuration errors fell through to a generic HTTP 500. | Configuration errors now return a stable `422 invalid_voice_agent_configuration` response with actionable diagnostics. |
| 26 | Save Changes wrote a deterministic invalid configuration into an active Symantic record before discovering that Retell could not publish it. | Active saves and reactivations preflight the candidate before persistence, preventing guaranteed state drift while retaining valid edits when a genuine provider outage occurs. |
| 27 | A transient Retell failure left Symantic's requested configuration marked live with no unpublished flag even though Retell still had the previous version. | The route restores the prior live record and stages the requested configuration as an unpublished, retryable draft. |
| 28 | Phone-number persistence could overwrite newly stored legacy-KB migration IDs/markers; losing a marker could duplicate the migrated Retell KB. | Activation and test-call updates merge the latest stored configuration, failed publishes retain migration fields, and migration reuses an existing tenant-scoped migration record. |
| 29 | Telnyx number retagging ran before Retell publication, so metadata failure could block and misreport the actual agent publish. | Retell publication is authoritative; retagging runs afterward as isolated best-effort metadata. |

### New: Generated Configuration (admins only)

`GET /workspaces/me/agents/{agentId}/generated-config` (`?source=pending` for unpublished
changes), shown as a collapsed **Generated Configuration** panel on the wizard's Summary &
Launch step. It shows the prompt, the exact Retell request bodies the next Save Changes
would send, the canonical configuration, and checks (problems found, and every seeded line
left out of the prompt with the reason). It never includes credentials or storage keys.

### Instruction precedence (stated in the prompt)

1. CRITICAL RULES (platform invariants)
2. Sections built from settings (hours, appointment types, booking window, transfer rules, service area)
3. Product behaviour (conversation, messages, conduct, closing)
4. The business's own Role Instructions and Restrictions
5. Industry-template guidance

## Rollout facts

- **Live agents don't change until they're saved again.** The prompt is rebuilt only on
  Save Changes, activation, or a test call. The inbound webhook still sends the old
  `currentTime`/`timezone` variables, so prompts published earlier keep working.
- **First re-save of each agent changes:** the prompt, the owned agent `timezone` and
  greeting-delay fields (including explicit clearing), and the transfer extension format.
- **Nothing is deleted from storage.** Legacy fields (`intents`, `escalation`, legacy
  message rules, old knowledge text) are kept and reported as ignored.
- **Terraform** adds one API Gateway route (`generated-config`) and redeploys the BFF and
  tools Lambdas.
- **Open product decision:** should "let me talk to a person" transfer to the Default
  Transfer Number when no rule matches? Today it takes a message (unchanged).

## Automated tests

| Suite | Result |
|---|---|
| Infra full Node suite (`find infra/lambda -name '*.test.mjs'`) | **PASS - 844/844** (includes 8 golden prompt + payload scenarios, provider/versioning, tools, contract, post-call and integrations) |
| Frontend lint | **PASS** |
| Frontend typecheck | **PASS** |
| Frontend Vitest | **PASS - 123 files, 977 tests** |
| Frontend production build | **PASS** |
| Receptionist-focused Playwright suite | **PASS - 12/12** |
| Full Chromium Playwright run | **FAIL - 49/53 initially**; the one receptionist copy assertion was corrected and its focused suite passed. Three remaining failures are outside this pipeline: Analytics accessibility, Proposal accessibility, and Proposal PDF preview. |
| Diff whitespace check | **PASS** |

Golden files: `lambda/bff/voice-agent/golden/`. After an intended prompt change,
regenerate with `cd lambda/bff && UPDATE_GOLDEN=1 node --test voice-agent/voice-agent.test.mjs`
and review the diff.

No production Retell agent was modified and no real call was claimed. Retell writes were tested
at the repository boundary with an in-memory fake that enforces the create/draft/update/publish
versioning rules. The manual cases below remain required in the team's actual environment.

## Manual verification (real Symantic + Retell)

**Before you start:** open a test agent, click **Save Changes**, then open **Generated
Configuration** on Summary & Launch. Checks must show no errors.

| # | Scenario | Setup | Say | Expected | Check in the Retell call log |
|---|---|---|---|---|---|
| 1 | Greeting | Blank greeting, disclosure on | (answer) | Default greeting including the recording line | `begin_message` |
| 2 | Clock on a web call | Any | "Are you open right now?" (from the Retell dashboard test) | Correct local answer | Rendered prompt has a real time, no `{{` left |
| 3 | Knowledge base | 1 KB assigned | A question the KB answers | Answer from the KB | KB chunks retrieved |
| 4 | Unknown question | - | Something not in the KB | No guess, offers to take a message | `message_take` |
| 5 | Availability | Booking on, 2 types | "Anything Thursday morning?" | Only times the tool said were free | One `calendar_get_availability` per time offered |
| 6 | Booking | - | Pick a time | Reads it back, books only after a yes | `calendar_create_booking`; calendar event includes buffers |
| 7 | Outside hours | Closed day set | Ask for that day, or after closing | Offers another time | Tool result `outside_business_hours` |
| 8 | Holiday | Closed holiday on | Ask for the holiday | Offers another day | `closed_holiday` |
| 9 | Reschedule | Existing appointment of a 2-hour type | "I need to move my appointment" | Looks up your number without asking, then reschedules | `calendar_find_appointment` -> `calendar_reschedule_booking`; calendar event still 2 hours |
| 10 | Cancel | - | "Cancel it" | Confirms, then says type/day/date/time cancelled | `calendar_cancel_booking` |
| 11 | Transfer + extension | Rule "billing" with an extension | "I have a billing question" | Fixed transfer line, call connects, extension dialled | `transfer_call_N` |
| 12 | Transfers off | Do Not Allow | "Let me talk to a person" | Configured response, then takes a message | No transfer tool in the config |
| 13 | Emergency + rule | Rule "gas leak" | "I smell gas" | "If anyone is in danger, hang up and call 911 - otherwise I'll connect you", then transfers | `transfer_call_N` after that line |
| 14 | Specific person | - | "Is Maria there?" | Never confirms or denies | - |
| 15 | Spam | Spam screening on | A sales pitch | Polite close | `end_call`; post-call `is_spam: true` |
| 16 | Off-topic / abuse | - | Off-topic twice | One redirect, then close | `end_call` |
| 17 | Silence | Silence timeout 30 s | Stay silent | One nudge, then hang-up | Disconnection reason |
| 18 | Spanish | New agent: pick Spanish in the wizard without editing the greeting | Speak Spanish | Spanish greeting and replies | Agent `language`; `begin_message` is Spanish |
| 19 | Caller speaks first | Who Speaks First = caller | "Hi, are you open?" | Introduces itself, then answers | `start_speaker: user` |
| 20 | Closing | - | "Well..." then "No thanks" | Waits; closing line + `end_call` once | - |
| 21 | Countries | Add CA on a live agent, Save | - | - | Number's `allowed_inbound_country_list` includes CA |
| 22 | Existing agents | A live agent not yet re-saved | Normal call | Behaves as before; Agents list shows no "Manually Edited by Admin in Retell" badge unless someone really edited it in Retell | Old prompt still has a real time |
