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
| Timezone | profile `timezone` | P, N, B, DV | prompt clock `{{current_time_<zone>}}` and Timezone line; agent `timezone`; tools time parsing and hours enforcement | Invalid zone: `Etc/UTC` clock and no agent `timezone` (diagnostic). |
| Emails + labels | profile `contactEmails[]` | P | BUSINESS INFO, "share only if asked" | |
| Service Area Coverage | profile `serviceAreas[]` | P, T | SERVICE AREA section + `check_service_area` tool (list baked in as `const`) | Absent: neither exists. |
| Business Hours / closed days / Open 24 Hours / multiple ranges | profile `businessHours` (+ free-text `hours`) | P, B | BUSINESS INFO, SCHEDULING RULES; **enforced** by availability/create/reschedule | Structured hours win; free text shown as-is and not enforced. |
| Holidays (toggle + list) | profile `holidaysEnabled`, `holidays[]` | P, B | BUSINESS INFO, SCHEDULING RULES; closed holidays **enforced** | Toggle off means the list is ignored. Disabled entries are ignored. Special-hours text is prompt only. |

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
| Language | `language` | N, P | agent `language`; for es-419 a "speak Spanish" line in ROLE and a Spanish default greeting | Only en-US / es-419 offered. Anything else becomes en-US. |
| Who Speaks First | `startSpeaker` | N, P | LLM `start_speaker`; CONTEXT line (agent-first: "greeting already said"; caller-first: introduce yourself) | |
| Pause Before Speaking | `pauseBeforeSpeakingMs` | N | agent `begin_message_delay_ms` (agent-first only) | 0 or 1000. |
| Call Recording Disclosure | `recordingDisclosure` | N | adds the disclosure sentence to the **default** greeting | Custom greeting without "record" gets a diagnostic. Prompt answers "is this recorded?" truthfully either way. |
| Custom Greeting Message | `greeting` | N | LLM `begin_message` only | Blank: built default (never empty; `""` would make the agent wait silently). |

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
| Example Dialogues | `exampleDialogues` | P | EXAMPLE DIALOGUES | An untouched template example is replaced by generated examples that use the agent's real tool names. Empty also gets generated examples. |
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
rest of the call. `buildPrompt` throws if a section names a tool that isn't registered.

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
