# Voice agent configuration: field mapping and pipeline

Where every AI Voice Agent setting ends up, and why. Source of truth for the
code in `lambda/bff/voice-agent/` (pipeline), `lambda/tools/` (call-time
enforcement) and the wizard in `symantic-agents-frontend`
(`components/agent-wizard.tsx`). Retell field names were checked against
docs.retellai.com on 2026-10-05.

## Pipeline

```
Wizard (agent-wizard.tsx) -- PUT /workspaces/me/agents/{id} --> agents table: agent.configuration
                                                                (+ businessProfile per agent,
                                                                 workspace profile as fallback)
        |
        v
buildVoiceAgentConfiguration      voice-agent/configuration.mjs   canonical, vendor-neutral
        |
        +--> buildToolPlan         voice-agent/tools.mjs           which tools exist
        +--> buildPrompt           voice-agent/prompt.mjs          general_prompt (sections)
        +--> toRetellTools / buildRetell*  voice-agent/retell.mjs  Retell JSON bodies
        +--> buildPostCallAnalysis voice-agent/post-call.mjs       post_call_analysis_data
        |
        v
providers.mjs (createRetellClient.upsertAgent -> draft version -> publish)
```

`compileVoiceAgent` (voice-agent/index.mjs) runs every stage once. The publish path
(`syncRetellAgent`) and the admin inspector (`GET /workspaces/me/agents/{id}/generated-config`,
shown as **Generated Configuration** on Summary & Launch) both use it, so the inspector shows
exactly what a publish sends.

`receptionist.mjs` keeps its old exports and delegates to the pipeline.

### When things reach Retell

| Event | What is sent |
|---|---|
| Create AI Voice Agent (activate) | create/update LLM + agent, publish, order + import number, set countries |
| Save Changes on a live agent | LLM + agent fields Symantic owns (full set), publish; allowed countries on the number if changed |
| Test call | as activate, number in draft status |
| Knowledge base item edited/deleted | `knowledge_base_ids` only (`pushKnowledgeBaseIds`) |
| Draft autosave on a live agent | nothing - stored as `pendingConfiguration` until Save Changes |

Update semantics: Retell only lets the newest draft version be edited. `publishFromApp` works on
a draft, sends every field Symantic owns, resets any other field to the live published value
(so unpublished dashboard edits never go live by accident), publishes, and points the agent's
numbers at `latest_published`. Fields Symantic doesn't own (e.g. `model`) keep their live value.

## Instruction precedence

Stated in the prompt itself:

1. **CRITICAL RULES**: platform invariants. They override everything, including the business's text. Where possible they are also enforced in code (tools that don't exist can't be called, tool handlers refuse bad times).
2. **Sections from structured settings**: hours, holidays, appointment types, booking window, transfer rules, service area.
3. **Product behaviour sections**: conversation, messages, conduct, closing.
4. **The business's own text**: Role Instructions and Restrictions. Restrictions always apply.
5. **Industry-template guidance**: lowest. The business's text overrides it.

FINAL REMINDERS repeats three rules on purpose (recency), followed by the business's Final Reminders.

## Field mapping

Category key: **P** prompt · **N** Retell-native · **KB** knowledge base · **T** tools · **DV** dynamic variable ·
**B** backend logic (tools Lambda / BFF) · **PC** post-call · **TEL** telephony · **UI** UI/internal only.

Stored = `agent.configuration.<field>`; profile fields live in `agent.configuration.businessProfile.<field>` and fall back to the workspace profile (`effectiveProfile`).

### Business Profile

| UI field | Stored | Cat. | Destination | Notes / transformation |
|---|---|---|---|---|
| Company Name | profile `businessName` | P, N | prompt ROLE / CRITICAL RULES / BUSINESS INFO / closing lines; default `begin_message`; Telnyx tag | Blank becomes "the business" (diagnostic). |
| Business Phone | profile `phone` | P, TEL | BUSINESS INFO; area code when ordering a number | Required for activation. |
| Physical Address | profile `address` | P, B | BUSINESS INFO; default booking `location` (tools) | |
| Mailing Address / Same as Physical | profile `mailingAddress` ("" = same) | P | BUSINESS INFO, only when it differs | |
| Company Website | profile `website` | P | BUSINESS INFO | Never crawled. |
| Timezone | profile `timezone` | P, N, B, DV | prompt clock `{{current_time_<zone>}}` and Timezone line; agent `timezone`; tools time parsing and hours enforcement | New activation rejects an invalid IANA zone. Legacy invalid values consistently fall back to UTC in the prompt, Retell (`Etc/UTC`) and calendar tools (diagnostic). |
| Emails + labels | profile `contactEmails[]` | P | BUSINESS INFO, "share only if asked" | |
| Service Area Coverage | profile `serviceAreas[]` | P, T | SERVICE AREA section + `check_service_area` tool (list and the business address baked in as `const`) | Absent: neither exists. The business's own town/ZIP always matches; a state entry ("Maryland") matches a place given with that state ("Beltsville, MD"). Anything else unmatched returns a `hint` to judge metro areas and states by geography - the prompt says the same. |
| Business Hours / closed days / Open 24 Hours / multiple ranges | profile `businessHours` (+ free-text `hours`) | P, B | BUSINESS INFO, SCHEDULING RULES; **enforced** by availability/create/reschedule | Structured hours win; free text shown as-is and not enforced. |
| Holidays (toggle + list) | profile `holidaysEnabled`, `holidays[]` | P, B | BUSINESS INFO, SCHEDULING RULES; closed holidays **enforced** | Toggle off means the list is ignored. Disabled entries are ignored. Special-hours text is prompt only. Dates are spelled out with the weekday, and the prompt states holidays override the weekly hours (including open 24 hours). |

### Template & Voice

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Template | `industryTemplate` | UI, P | Wizard seeds Role Instructions + Example Dialogues. Backend: an **untouched** seeded paragraph is replaced by capability-aware BUSINESS TYPE GUIDANCE (`templates.mjs`). | Edited text is kept verbatim with no guidance. "Other" has none. |
| (product key) | `template` = "receptionist" | UI | - | |
| Internal Name | `name` | N, TEL | agent `agent_name` = `Symantic {id} · {name}`; Telnyx tag | Never spoken. |
| AI Voice Agent Name | `spokenName` | P | ROLE, CONTEXT, default greeting | Legacy agents: Internal Name up to the first dash. |
| Tone | `tone` | P | ROLE | |
| Voice Source | `voiceMode` | N | selects voice id source | |
| Voice | `voice` | N | `voice_id` via provider-secret mapping (`resolveRetellVoiceId`) | Provider is implied by the id prefix. |
| Voice ID (cloned) | `voiceId` | N | `voice_id` | Used only when `voiceMode = cloned`. |
| Background Sound / volume | `ambientSound`, `ambientSoundVolume` | N | `ambient_sound` (null clears), `ambient_sound_volume` 0.1-1 (sent only with a sound) | |
| Language | `language` | N, P | agent `language`; for es-419 a "speak Spanish" line in ROLE and the Spanish sample greeting | Only en-US / es-419 offered. Anything else becomes en-US. The wizard swaps an untouched sample greeting when the language changes. |
| Who Speaks First | `startSpeaker` | N, P | LLM `start_speaker`; CONTEXT line (agent-first: "greeting already said"; caller-first: introduce yourself) | |
| Pause Before Speaking | `pauseBeforeSpeakingMs` | N | agent `begin_message_delay_ms` | 0 or 1000 for agent-first; explicitly 0 for caller-first so an old Retell delay cannot survive an update. |
| Call Recording Disclosure | `recordingDisclosure` | N | adds the disclosure sentence to the **default** greeting | Custom greeting without "record" gets a diagnostic. Prompt answers "is this recorded?" truthfully either way. |
| Custom Greeting Message | `greeting` | N | LLM `begin_message` only | Blank: the wizard's sample (`sampleGreeting`, identical to the wizard's `buildSampleGreeting`; never empty, since `""` would make the agent wait silently). A Spanish agent still carrying the untouched English sample is sent the Spanish sample. |

### Knowledge Base

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Assigned Knowledge Bases | `knowledgeBaseIds[]` (hub ids) | KB | LLM `knowledge_base_ids` = each hub record's `retellKnowledgeBaseId` | Unprocessed items (no Retell id) aren't sent. |
| Workspace library: pasted text / websites / uploaded files | knowledge-bases table (one Retell KB per item) | KB | Retell KB (text as a synthetic .txt file; URLs with optional 24 h auto-refresh; files via private S3 to Retell) | **Content is never copied into the prompt.** Retell retrieves chunks per turn under `## Related Knowledge Base Contexts`; the KNOWLEDGE BASE section tells the model how to use them. The wording works with zero or many KBs, so KB-only pushes can't leave it stale. |
| Source processing / status | hub record status | UI | - | |
| Pronunciations | `pronunciationDictionary[]` | N | agent `pronunciation_dictionary` (null clears) | ipa/cmu only, max 10. |
| (legacy) per-agent text/files | `knowledgeBaseText`, `knowledgeBaseFiles` | B | migrated once into a hub item on first sync (`legacyKnowledgeMigrated`) | Never deleted. |

### Call Handling

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Allow Call Transfers | `allowCallTransfers` (absent = allowed) | T, P | Off: **no** transfer tools at all, plus the "never transfers" section | A guarantee rather than an instruction. |
| Transfer rules: phrases / destination / extension | `emergencyRules[]` | T, P | one `transfer_call_N` per rule with phrases and a number (own, else Default Transfer Number); `transfer_destination.number` + **`extension`**; warm transfer; static execution message; one prompt line per rule ("means", not "mentions") | Half-filled rules are skipped (diagnostic); the blank seeded row is ignored. |
| Legacy message rules | `emergencyRules[].action = "decline"` | P | "say X and don't transfer" lines | Never a tool. Kept for old agents. |
| Do Not Allow responses | `noTransferRules[]` | P | lines in CALL TRANSFERS, then the fixed fallback line | |
| Spam / robocall screening | `spamScreening` | P, PC | SPAM section; `is_spam` post-call field is always extracted | `end_call` always exists. |
| Hang Up After Silence | `silenceTimeoutSec` | N | `end_call_after_silence_ms` (10-300 s) | |
| Maximum Call Length | `maxCallDurationMin` | N | `max_call_duration_ms` (1-30 min) | |
| Allowed Inbound Countries | `allowedInboundCountries[]` | TEL | phone number `allowed_inbound_country_list` | Now also pushed on Save Changes of a live agent. |
| (hidden) reminder | - | N | `reminder_trigger_ms` 8000, `reminder_max_count` 1 | |

### Calendar & CRM

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Booking on/off | `booking` | T, P | five `calendar_*` tools + APPOINTMENT TYPES / SCHEDULING RULES / BOOKING FLOW / RESCHEDULING AND CANCELLING | Activation requires a connected, selected calendar. |
| Connected provider / calendar | calendar_connections table (per agent); `connections[]` | B | tools Lambda adapters (Google, Microsoft, Cal.com) | `connections` containing "cal-com" switches the type source. |
| Booking Window | `bookingWindowDays` (1-60, default 30) | P, B | SCHEDULING RULES; **enforced** by tools | |
| Invite Reminder | `inviteReminderMinutes` | B | calendar event reminder (Google/Microsoft) | Not in the prompt. |
| Start Time in Title | `inviteStartTimeInTitle` | B | calendar event title | Not in the prompt. |
| Booking invite email | `bookingInviteEmail` | B | stored on the appointment; Cal.com attendee | Never sent to Google/Microsoft; never in the prompt. |
| Appointment Types: name, duration | `appointmentTypes[].name/durationMin` | P, B | APPOINTMENT TYPES (spoken duration); tools use the type's duration (authoritative) | |
| Minimum lead time | `minimumLeadTimeMin` | P, B | stated + **enforced** on availability, create and (now) reschedule | |
| Before/After buffers | `blockBeforeMin/blockAfterMin` | B | provider calendar block only - **never spoken** | Caller-facing duration and calendar duration are separate. |
| Happens at customer location | `happensAtCustomerLocation` | P | city-before-availability, address-after-booking, can't-locate rule | |
| Cal.com event types | `calComEventTypes[]` | P | APPOINTMENT TYPES (Cal.com enforces its own notice/buffers) | |
| CRM (Monday) | crm tables | DV, B | inbound webhook fills `{{crm_context}}` (CALLER RECORD); post-call sync to the board | No CRM tools. Default "Not available." |

### Call Forwarding

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Default Transfer Number | profile `ownerPhone` | T | fallback number for transfer rules without their own | Required for activation. It is **not** a generic "talk to a person" transfer. |

### Conversation Rules & Guardrails

| UI field | Stored | Cat. | Destination | Notes |
|---|---|---|---|---|
| Role Instructions | `roleInstructions` | P | HOW THIS BUSINESS WANTS CALLS HANDLED | Seeded lines already covered are left out (see below). |
| Restrictions | `restrictions` | P | RESTRICTIONS - WHAT NOT TO SAY OR DO | Same. |
| Example Dialogues | `exampleDialogues` | P | EXAMPLE DIALOGUES | An untouched template example is replaced by generated examples that use the agent's real tool names. Empty also gets generated examples. Publishing is rejected if retained customer instructions affirm scheduling or transfers for which no tool exists; explicit prohibitions remain valid. |
| Final Reminders | `finalReminders` | P | last lines of FINAL REMINDERS | Seeded defaults are all covered, so they're left out. |

### Internal / legacy (never sent)

`intents`, `escalation` (legacy, no screen) · `businessConfirmed`, `completedSteps`, `tested`, `testRunCount`, `testCorrection` (wizard) ·
`platformDid`, `desiredPhoneNumber`, `phone` (telephony) · `receptionistPlan` (billing) · `calendarSelectionId` ·
workspace-profile sample fields `description`, `faqs`, `policies`, `escalationContact`, `fallbackPhone`, `communicationStyle`, `businessType`.
The inspector lists any of these present on an agent under `canonicalConfiguration.ignoredFields`.

## Seeded text de-duplication

The wizard seeds recommended text into Role Instructions, Restrictions, Example Dialogues and
Final Reminders. Much of it restates rules the prompt already has. `seeded-defaults.mjs` removes a
seeded **line** only when it is still byte-for-byte the default (whitespace-normalised) **and**
a generated section covers it for this configuration. It also drops stale booking/transfer lines
that contradict the current settings. Lines the customer edited or wrote are never touched;
seeded lines with no platform equivalent (multiple locations, refunds, job openings, staying in
character, message completeness) stay. The inspector's Checks tab lists every removed line and why.

Booking/transfer lines the customer edited can't be recognised, so they would reach Retell and
contradict the settings. Two layers prevent that:

- The wizard (`syncGuardrailAddenda`, `agent-wizard.tsx`) adds, swaps, or removes its own seeded
  booking/transfer blocks, verbatim and wherever they sit in the text, on every Booking or Call
  Transfers change on any step. The industry-template paragraphs never mention appointments; the
  booking block (which opens with the receptionist's appointment role) is the only appointment text,
  and it's present only while booking is on. Customer-written text is never touched.
- Publishing rejects (422) a retained line that rules out an enabled capability outright -
  `custom_instructions_forbid_enabled_transfers` ("This agent never transfers a call" with a
  transfer tool) and `custom_instructions_forbid_enabled_scheduling` ("You can't book
  appointments" with booking on). The message quotes the line. Qualified rules ("Never transfer
  calls about billing") are valid restrictions and pass.

When the wizard's seed text changes, the frontend test `tests/unit/voice-agent-seed-sync.test.ts`
fails. Add the new text/hash to `seeded-defaults.mjs` (keep the old ones, because saved agents
still carry them) and regenerate `voice-agent/golden/frontend-seeds.json`.

## Tools

| Tool | When registered | Use (per prompt) | Speakable | Internal |
|---|---|---|---|---|
| `calendar_get_availability` | booking on | check each exact time before saying it | available yes/no | busy ranges, UTC times |
| `calendar_create_booking` | booking on | only after the caller picks a time and says yes | booked day/time | appointmentId |
| `calendar_find_appointment` | booking on | immediately with `{{user_number}}` on change/cancel; retry formats | type/day/date/time | appointmentId, callerName |
| `calendar_reschedule_booking` | booking on | after the check-offer-confirm loop; keeps type and length | old and new time | appointmentId |
| `calendar_cancel_booking` | booking on | after explicit confirmation; then say exactly what was cancelled | what was cancelled | appointmentId |
| `message_take` | always | caller wants a person / can't be done on the call | "passed along" | messageId |
| `lead_capture` | always | prospect interested in services | "passed along" | leadId |
| `check_service_area` | service areas set | the moment a caller names a place | in area or not | - |
| `transfer_call_N` | transfers allowed + usable rule | caller's meaning matches the rule | fixed line | number never spoken |
| `end_call` | always | in the same turn as the closing line; spam/abuse/no-progress closes | - | - |

All webhook tools get `workspaceId`, `agentId` (baked in as `const`) and `callId` (`{{call_id}}`),
a 10 s timeout and one retry. A failure comes back as a speakable `ok: false` with an `action`,
and the prompt says to follow it. `disableBookingTools` means stop using calendar tools for the
rest of the call. Compilation emits an error-level diagnostic if prompt text names a tool that
isn't registered; publish rejects any error-level diagnostic before making a Retell write.

## Dynamic variables

| Variable | Source | Missing |
|---|---|---|
| `{{user_number}}`, `{{call_id}}` | Retell system | always present on phone calls (`user_number` absent on web calls) |
| `{{current_time_<IANA zone>}}` | Retell system (business zone, includes year) | always present |
| `{{crm_context}}` | inbound webhook (CRM lookup, latency-capped) | LLM default "Not available." |
| `workspaceId`, `agentId`, `currentTime`, `timezone` | inbound webhook / test call | legacy - no longer referenced by new prompts, still sent for agents published earlier |

`validateRetellPayloads` fails any `{{name}}` in the prompt, greeting or tools that nothing supplies.

## Post-call

`post_call_analysis_data` = `is_spam` (read by `lambda/postcall` `inferOutcome`). Retell adds
call_summary, user_sentiment and call_successful. Booking, lead, message and transfer outcomes
are derived from the tool calls that actually succeeded, not extracted by the LLM.

## Tests

`lambda/bff/voice-agent/voice-agent.test.mjs` holds the scenarios with golden prompts and payloads
in `voice-agent/golden/`. After an intended prompt change, regenerate with:

```
cd lambda/bff && UPDATE_GOLDEN=1 node --test voice-agent/voice-agent.test.mjs
```

Then review the diff. Also covered: `publish-flow.test.mjs` (create/update through the
versioning-enforcing fake Retell), `lambda/tools/handlers/business-hours.test.mjs`, and
reschedule/hours tests in `lambda/tools/index.test.mjs`.

## Sanitized generated examples

The checked-in `booking-multiple-types` golden fixture is the complete, reviewable example for a
fictional plumbing business. It is generated by the production builders, not hand-written audit
documentation:

- `lambda/bff/voice-agent/golden/booking-multiple-types.prompt.txt` is the exact final prompt. It
  demonstrates conditional scheduling, KB-use instructions without KB content, business hours,
  holidays, service area, transfers, confirmation gates, failure behavior and closing.
- `lambda/bff/voice-agent/golden/booking-multiple-types.retell.json` is the corresponding sanitized
  Retell request. Its top-level operations are `updateRetellLlm`, `updateAgent` and
  `postCallAnalysis`; fixture IDs, phone numbers, tool URLs and KB IDs are non-production values.

The `faq-only`, `no-calendar-general-template`, `knowledge-base-heavy`, `transfer-enabled`,
`customer-support-template`, `spanish-caller-first` and `legacy-agent` pairs prove that sections,
tools and native settings are added or removed by capability instead of being concatenated into
one universal prompt.

## Audit defects and disposition

| Evidence-backed defect | Disposition |
|---|---|
| Phone reconciliation used Retell's removed legacy list endpoint and did not paginate. | Uses paginated `GET /v2/list-phone-numbers`; fake-provider and publish-flow coverage added. |
| PATCH updates could retain a removed timezone or a prior greeting delay because omitted Retell fields are merged. | Builder always sends a valid timezone (`Etc/UTC` for a legacy invalid value) and sends `begin_message_delay_ms: 0` when clearing the delay. |
| Error diagnostics, including prompt references to absent tools, did not stop publish. | `buildReceptionistConfig` rejects error-level diagnostics before the provider boundary and returns an actionable 422 response on activation. |
| Scheduling-disabled agents could retain customer examples or instructions that positively confirmed a booking; transfer-disabled agents could retain affirmative transfer instructions. | Capability-aware generated examples omit disabled behavior; retained customer instructions are checked clause-by-clause while explicit prohibitions remain valid. |
| Retell payload schema validation existed only in the inspector and tests. | The publish boundary now validates the exact LLM and agent payloads before any Retell write. |
| Legacy invalid timezone values produced a UTC prompt, Retell's default timezone, and failing calendar tools. | New activations reject invalid zones; legacy records use the same UTC fallback across all three runtime layers. |
| Wizard round trips omitted Call Forwarding and Guardrails from `completedSteps`. | Draft domain now includes all eight steps, with unit coverage. |
| Save Changes persisted a deterministically invalid configuration for a live agent before Retell rejected it, guaranteeing Symantic/Retell drift. | Live saves and reactivations now compile and validate locally before persistence; transient provider failures still preserve the customer's valid edit and return `retellSync.status = failed`. |
| A transient Retell rejection left the requested configuration marked live in Symantic and cleared the unpublished flag. | The prior published configuration is restored, the valid edit is retained as `pendingConfiguration`, and `hasUnpublishedChanges` remains true for retry. |
| Legacy-KB migration state could be overwritten by later phone-number persistence, and a lost marker could create the same migrated KB again. | Phone persistence merges from the latest stored agent; failed publishes preserve migration-owned IDs/markers; migration also reuses an existing tenant-scoped `migratedFromAgentId` record. |
| A Telnyx display-tag failure ran before Retell publication and could incorrectly report that the live agent update failed. | Retell publishes first; number retagging is isolated best-effort metadata with separate error reporting. |

The unresolved product decision is intentionally not hidden: a generic human request takes a
message unless a configured transfer rule matches; the Default Transfer Number is not a catch-all.
