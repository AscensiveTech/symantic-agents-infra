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
   relevant. Building fails if a section names a tool the agent doesn't have.
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
- **First re-save of each agent changes:** the prompt, the new agent `timezone` field,
  and the transfer extension format.
- **Nothing is deleted from storage.** Legacy fields (`intents`, `escalation`, legacy
  message rules, old knowledge text) are kept and reported as ignored.
- **Terraform** adds one API Gateway route (`generated-config`) and redeploys the BFF and
  tools Lambdas.
- **Open product decision:** should "let me talk to a person" transfer to the Default
  Transfer Number when no rule matches? Today it takes a message (unchanged).

## Automated tests

| Suite | Result |
|---|---|
| Infra BFF (`node --test`, includes 8 golden prompt + payload scenarios) | 498 pass |
| Infra tools | 64 pass |
| Infra oauth, postcall, digest, kb-refresh, most-asked-refresh, crm | 262 pass |
| Infra contract | 2 pass |
| Terraform fmt + validate | clean |
| Frontend lint, typecheck, unit tests, build | clean, 973 pass |

Golden files: `lambda/bff/voice-agent/golden/`. After an intended prompt change,
regenerate with `cd lambda/bff && UPDATE_GOLDEN=1 node --test voice-agent/voice-agent.test.mjs`
and review the diff.

No real calls were made and no Retell account was used: Retell was replaced by an
in-memory fake that enforces its versioning rules.

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
| 13 | Emergency + rule | Rule "gas leak" | "I smell gas" | 911 line first, then the transfer | Order of speech and tool call |
| 14 | Specific person | - | "Is Maria there?" | Never confirms or denies | - |
| 15 | Spam | Spam screening on | A sales pitch | Polite close | `end_call`; post-call `is_spam: true` |
| 16 | Off-topic / abuse | - | Off-topic twice | One redirect, then close | `end_call` |
| 17 | Silence | Silence timeout 30 s | Stay silent | One nudge, then hang-up | Disconnection reason |
| 18 | Spanish | Language es-419, blank greeting | Speak Spanish | Spanish greeting and replies | Agent `language` |
| 19 | Caller speaks first | Who Speaks First = caller | "Hi, are you open?" | Introduces itself, then answers | `start_speaker: user` |
| 20 | Closing | - | "Well..." then "No thanks" | Waits; closing line + `end_call` once | - |
| 21 | Countries | Add CA on a live agent, Save | - | - | Number's `allowed_inbound_country_list` includes CA |
| 22 | Existing agents | A live agent not yet re-saved | Normal call | Behaves as before | Old prompt still has a real time |
