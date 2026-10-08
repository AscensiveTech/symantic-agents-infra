import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { compileVoiceAgent } from "./index.mjs";
import { buildVoiceAgentConfiguration } from "./configuration.mjs";
import { unknownVariables } from "./dynamic-variables.mjs";
import { inspectVoiceAgent } from "./inspect.mjs";
import { mentionedToolNames, SECTION_IDS } from "./prompt.mjs";
import { buildRetellAgentPayload, validateRetellPayloads } from "./retell.mjs";
import { buildReceptionistConfig } from "../receptionist.mjs";
import { SEEDED_TEMPLATE_EXAMPLES, SEEDED_TEMPLATE_PARAGRAPHS, seedHash } from "./seeded-defaults.mjs";
import { TEMPLATE_TITLES } from "./templates.mjs";
import {
  BUILD,
  SPLIT_HOURS_WITH_24H_WEEKEND,
  WEEKDAYS_9_TO_5,
  fullAgent,
  knowledgeBases,
  minimalAgent,
  workspaceProfile,
} from "./test-fixtures.mjs";

const SEEDS = JSON.parse(readFileSync(new URL("./golden/frontend-seeds.json", import.meta.url), "utf8"));
const GOLDEN_DIR = new URL("./golden/", import.meta.url);

function compile(agent, { profile = workspaceProfile, kbs } = {}) {
  return compileVoiceAgent({ ...BUILD, agent, profile, knowledgeBases: kbs });
}

function updateAgentPayload(compiled, agent) {
  const { response_engine: _engine, ...body } = buildRetellAgentPayload({
    config: compiled.config, llmId: "llm_x", symanticAgentId: agent.id, agentName: agent.configuration.name,
  });
  return body;
}

const sectionTitles = (prompt) => prompt.split("\n").filter((line) => line.startsWith("# ")).map((line) => line.slice(2));
const section = (prompt, title) => {
  const start = prompt.indexOf(`# ${title}\n`);
  if (start === -1) return null;
  const next = prompt.indexOf("\n# ", start + 2);
  return prompt.slice(start, next === -1 ? undefined : next);
};

// What the wizard stores for a brand-new agent after picking a template and
// setting booking/transfers - mirrors expectedRoleInstructions/
// expectedRestrictions in the frontend's agent-wizard.tsx.
function seededDraft(templateId, { booking, transfers }) {
  const d = SEEDS.defaults;
  const template = SEEDS.templates[templateId];
  let role = template.roleInstructions
    ? `${d.DEFAULT_ROLE_INSTRUCTIONS_PACING}\n\n${template.roleInstructions}`
    : d.DEFAULT_ROLE_INSTRUCTIONS_PACING;
  if (booking) role += d.BOOKING_ROLE_INSTRUCTIONS_ADDENDUM;
  role += transfers ? d.CALL_TRANSFER_ROLE_INSTRUCTIONS_ADDENDUM : d.NO_TRANSFER_ROLE_INSTRUCTIONS_ADDENDUM;
  if (templateId === "home-field-services" && transfers) role += d.HOME_SERVICES_EMERGENCY_TRANSFER_ADDENDUM;
  let restrictions = d.DEFAULT_RESTRICTIONS;
  if (booking) restrictions += d.BOOKING_RESTRICTIONS_ADDENDUM;
  if (!transfers) restrictions += d.NO_TRANSFER_RESTRICTIONS_ADDENDUM;
  return {
    industryTemplate: templateId,
    roleInstructions: role,
    restrictions,
    finalReminders: d.DEFAULT_FINAL_REMINDERS,
    exampleDialogues: template.exampleDialogues ?? "",
    booking,
    allowCallTransfers: transfers,
    emergencyRules: transfers ? [{ id: "r", phrases: ["speak to a manager"], transferTarget: "+19375550160" }] : [],
    noTransferRules: transfers ? [] : [{ id: "n", phrases: [], message: "" }],
  };
}

// --- Scenarios --------------------------------------------------------------

const SCENARIOS = {
  "faq-only": () => ({
    agent: minimalAgent({
      spokenName: "Ava",
      allowCallTransfers: false,
      knowledgeBaseIds: ["kb-services"],
      roleInstructions: "- Mention our free annual inspection when callers ask about maintenance.",
    }),
    kbs: [knowledgeBases[0]],
  }),
  "booking-multiple-types": () => ({ agent: fullAgent(), kbs: knowledgeBases }),
  "transfer-enabled": () => ({
    agent: minimalAgent({
      spokenName: "Leo",
      allowCallTransfers: true,
      emergencyRules: [
        { id: "a", phrases: ["talk to a technician"], transferTarget: "+19375550170" },
        { id: "b", phrases: ["accounts payable"], transferTarget: "", extension: "301" },
        { id: "c", phrases: ["talk to a human"], action: "decline", message: "Everyone is with a customer - I'll take a message.", transferTarget: "" },
      ],
    }),
  }),
  "customer-support-template": () => ({
    agent: minimalAgent({ spokenName: "Sky", ...seededDraft("customer-support", { booking: false, transfers: true }) }),
    kbs: knowledgeBases,
  }),
  "knowledge-base-heavy": () => ({
    agent: minimalAgent({ spokenName: "Ivy", knowledgeBaseIds: ["kb-1", "kb-2", "kb-3"] }),
    kbs: [
      { knowledgeBaseId: "kb-1", retellKnowledgeBaseId: "knowledge_base_1" },
      { knowledgeBaseId: "kb-2", retellKnowledgeBaseId: "knowledge_base_2" },
      { knowledgeBaseId: "kb-3", retellKnowledgeBaseId: "knowledge_base_3" },
    ],
  }),
  "no-calendar-general-template": () => ({
    agent: minimalAgent({ spokenName: "Maya", ...seededDraft("general", { booking: false, transfers: false }) }),
  }),
  "legacy-agent": () => ({
    agent: {
      id: "agent-legacy",
      name: "Samantha- CWR Inc",
      configuration: {
        name: "Samantha- CWR Inc",
        voice: "Calm and natural",
        greeting: "Thanks for calling CWR.",
        intents: ["Scheduling"],
        escalation: "Transfer emergencies.",
        knowledgeBaseText: "Old private knowledge text.",
        emergencyRules: [
          { phrases: ["chest pain"], transferTarget: "703-555-0102" },
          { phrases: ["refund"], action: "decline", message: "Our billing team will call you back.", transferTarget: "720431997" },
        ],
      },
    },
    profile: { businessName: "CWR Solutions", timezone: "Mars/Olympus", hours: "Weekdays 8 to 4", ownerPhone: "703-555-0100" },
  }),
  "spanish-caller-first": () => ({
    agent: minimalAgent({ spokenName: "Lucía", language: "es-419", startSpeaker: "user", recordingDisclosure: true, allowCallTransfers: false }),
  }),
};

function goldenCheck(name, actual) {
  const file = new URL(name, GOLDEN_DIR);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `missing golden file ${name} - run with UPDATE_GOLDEN=1`);
  assert.equal(actual, readFileSync(file, "utf8"), `${name} changed - review the diff, then run with UPDATE_GOLDEN=1`);
}

for (const [name, build] of Object.entries(SCENARIOS)) {
  test(`scenario ${name}: golden prompt and Retell payload`, () => {
    const { agent, kbs, profile } = build();
    const compiled = compile(agent, { kbs, profile });
    goldenCheck(`${name}.prompt.txt`, `${compiled.prompt.text}\n`);
    goldenCheck(`${name}.retell.json`, `${JSON.stringify({
      updateRetellLlm: compiled.retell.llm,
      updateAgent: updateAgentPayload(compiled, agent),
      updatePhoneNumber: compiled.retell.phoneNumber,
    }, null, 2)}\n`);
  });

  test(`scenario ${name}: payload valid, prompt names only registered tools, every variable has a source, no duplicated rules`, () => {
    const { agent, kbs, profile } = build();
    const compiled = compile(agent, { kbs, profile });
    const llm = compiled.retell.llm;
    assert.deepEqual(validateRetellPayloads({ llm, agent: updateAgentPayload(compiled, agent) }), []);

    const registered = llm.general_tools.map((tool) => tool.name);
    for (const mentioned of mentionedToolNames(llm.general_prompt)) {
      assert.ok(registered.includes(mentioned), `prompt mentions unregistered tool ${mentioned}`);
    }
    assert.deepEqual(unknownVariables([llm.general_prompt, llm.begin_message, llm.general_tools]), []);

    const seen = new Map();
    for (const line of llm.general_prompt.split("\n").map((value) => value.trim()).filter((value) => value.length > 50)) {
      assert.ok(!seen.has(line), `duplicated line: ${line}`);
      seen.set(line, true);
    }
    assert.equal(compile(agent, { kbs, profile }).prompt.text, compiled.prompt.text, "not deterministic");
    assert.ok(compiled.diagnostics.every((item) => item.level !== "error"), JSON.stringify(compiled.diagnostics));
  });
}

// --- Minimal / full --------------------------------------------------------

test("minimal agent: safe defaults, core tools only, no optional sections", () => {
  const compiled = compile(minimalAgent());
  const titles = sectionTitles(compiled.prompt.text);
  assert.deepEqual(compiled.retell.llm.general_tools.map((tool) => tool.name), ["lead_capture", "message_take", "end_call"]);
  for (const absent of ["SERVICE AREA", "APPOINTMENT TYPES", "SCHEDULING RULES", "BOOKING FLOW", "RESCHEDULING AND CANCELLING",
    "HOW THIS BUSINESS WANTS CALLS HANDLED", "RESTRICTIONS - WHAT NOT TO SAY OR DO"]) {
    assert.ok(!titles.includes(absent), absent);
  }
  assert.ok(!titles.some((title) => title.startsWith("BUSINESS TYPE GUIDANCE")));
  assert.match(section(compiled.prompt.text, "CALL TRANSFERS"), /No transfer rules are set up, so you can't transfer calls\./);
  assert.match(section(compiled.prompt.text, "EXAMPLE DIALOGUES"), /\[message_take|\[lead_capture/);
  assert.deepEqual(compiled.retell.llm.knowledge_base_ids, []);
  assert.equal(compiled.retell.agentSettings.end_call_after_silence_ms, 60_000);
  assert.equal(compiled.retell.agentSettings.max_call_duration_ms, 600_000);
  assert.equal(compiled.retell.agentSettings.language, "en-US");
  assert.equal(compiled.retell.agentSettings.timezone, "America/New_York");
  assert.equal(compiled.config.ambientSound, null);
});

test("fully configured agent: every setting reaches its one destination", () => {
  const agent = fullAgent();
  const compiled = compile(agent, { kbs: knowledgeBases });
  const { llm, agentSettings, phoneNumber } = compiled.retell;
  const prompt = llm.general_prompt;
  const body = updateAgentPayload(compiled, agent);

  // Retell-native settings - never prose.
  assert.equal(body.voice_id, "11labs-Hailey");
  assert.equal(body.ambient_sound, "call-center");
  assert.equal(body.ambient_sound_volume, 0.3);
  assert.deepEqual(body.pronunciation_dictionary, [{ word: "Brightwater", alphabet: "ipa", phoneme: "ˈbraɪtˌwɔtər" }]);
  assert.equal(agentSettings.begin_message_delay_ms, 1000);
  assert.equal(agentSettings.end_call_after_silence_ms, 45_000);
  assert.equal(agentSettings.max_call_duration_ms, 900_000);
  assert.deepEqual(phoneNumber, { allowed_inbound_country_list: ["US", "CA"] });
  assert.deepEqual(llm.knowledge_base_ids, ["knowledge_base_svc", "knowledge_base_price"]);
  for (const prose of [/call-center/, /ambient/i, /ˈbraɪt/, /pronunciation/i, /45 seconds|15 minutes long/, /\bUS, CA\b/, /11labs/]) {
    assert.doesNotMatch(prompt, prose);
  }
  // Greeting: Retell's begin_message, built with the disclosure, not in the prompt.
  assert.equal(llm.begin_message, "Thanks for calling Brightwater Plumbing & Heating. This call may be recorded for quality assurance. We are currently away from our desk, likely at a job site. So, we have tasked our virtual receptionist, Nora, to assist you while we are unable to do so. How can we help you today?");
  assert.doesNotMatch(prompt, /away from our desk/);

  // Prompt sections from structured settings.
  assert.match(prompt, /You are Nora, the AI receptionist for Brightwater Plumbing & Heating/);
  assert.match(section(prompt, "BUSINESS INFO"), /Mon–Tue 8:00 AM–12:00 PM, 1:00 PM–6:00 PM; Wed closed; Thu–Fri 8:00 AM–12:00 PM, 1:00 PM–6:00 PM; Sat–Sun Open 24 hours/);
  assert.match(section(prompt, "BUSINESS INFO"), /Thanksgiving \(Thursday, November 26, 2026\): closed; Christmas Eve \(Thursday, December 24, 2026\): open 8 AM - 12 PM/);
  assert.doesNotMatch(prompt, /Labor Day/);
  assert.match(section(prompt, "BUSINESS INFO"), /Mailing address: PO Box 88/);
  assert.match(section(prompt, "BUSINESS INFO"), /Billing: billing@brightwater\.example/);
  assert.match(section(prompt, "SCHEDULING RULES"), /inside a single range/);
  assert.match(section(prompt, "SCHEDULING RULES"), /Never offer or book a holiday the business is closed/);
  assert.match(section(prompt, "SCHEDULING RULES"), /Only book up to 21 days ahead/);
  const types = section(prompt, "APPOINTMENT TYPES");
  assert.match(types, /- Phone Consultation \(15 minutes, must be booked at least 1 hour in advance\)/);
  assert.match(types, /- In-Home Estimate \(45 minutes, must be booked at least 1 day in advance, held at the caller's location\)/);
  assert.doesNotMatch(types, /30 minutes/, "buffers are never spoken");
  assert.match(section(prompt, "SERVICE AREA"), /Published coverage: Dayton, OH, Kettering, OH, 45402/);
  assert.match(section(prompt, "BOOKING FLOW"), /what city are you in\?" Apply SERVICE AREA\./);
  assert.match(section(prompt, "CALL TRANSFERS"), /"gas leak" or "flooding": use transfer_call_1\./);

  // Customer text in its own sections, in order, Final Reminders last.
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /rental or owner-occupied/);
  assert.match(section(prompt, "RESTRICTIONS - WHAT NOT TO SAY OR DO"), /Never discuss competitors/);
  assert.match(section(prompt, "EXAMPLE DIALOGUES"), /Do you fix water heaters\?/);
  assert.match(prompt.trimEnd(), /Always mention the 24-hour emergency line only if asked\.$/);

  // Internal / legacy fields never reach Retell.
  const everything = JSON.stringify({ llm, body });
  for (const hidden of [/Old free-text escalation/, /growth/, /\+19375550199/, /SAMPLE DESCRIPTION/, /Sample FAQ/, /office@brightwater/]) {
    assert.doesNotMatch(everything, hidden);
  }
  // Booking invite email and invite options are backend-only (tools Lambda).
  assert.doesNotMatch(prompt, /calendar invite|60 minutes before|start time in the title/i);
});

// --- Templates ---------------------------------------------------------------

test("seeded template hashes match the frontend seed snapshot", () => {
  for (const [id, { roleInstructions, exampleDialogues }] of Object.entries(SEEDS.templates)) {
    if (!roleInstructions) continue;
    assert.equal(SEEDED_TEMPLATE_PARAGRAPHS[seedHash(roleInstructions)], id);
    assert.equal(SEEDED_TEMPLATE_EXAMPLES[seedHash(exampleDialogues)], id);
  }
});

for (const templateId of Object.keys(SEEDS.templates)) {
  test(`template ${templateId}: an untouched seeded draft compiles without restating platform rules`, () => {
    for (const booking of [false, true]) {
      for (const transfers of [false, true]) {
        const agent = minimalAgent({ ...seededDraft(templateId, { booking, transfers }), appointmentTypes: [] });
        const compiled = compile(agent);
        const prompt = compiled.prompt.text;
        const guidance = sectionTitles(prompt).find((title) => title.startsWith("BUSINESS TYPE GUIDANCE"));
        if (templateId === "other") {
          assert.equal(guidance, undefined);
        } else {
          assert.equal(guidance, `BUSINESS TYPE GUIDANCE (${TEMPLATE_TITLES[templateId]} template)`);
          // The long seeded paragraph is replaced, not sent alongside the guidance.
          assert.doesNotMatch(prompt, /This is a live phone call, so keep replies short and natural, ask one question at a time/);
        }
        // Seeded pacing rules and Final Reminders defaults are not repeated.
        assert.doesNotMatch(prompt, /Ask one thing at a time\. Never ask two questions in the same turn/);
        assert.doesNotMatch(prompt, /Message-taking is the default handoff/);
        // Seeded lines the platform doesn't cover survive.
        assert.match(section(prompt, "RESTRICTIONS - WHAT NOT TO SAY OR DO"), /job opening/);
        assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /more than one location/);
        // The seeded example quoting un-checked times is replaced.
        assert.doesNotMatch(prompt, /I have an opening tomorrow at 10 AM|I have 7:00 or 7:30 available/);
        if (!booking) {
          assert.doesNotMatch(prompt, /calendar_/);
          assert.doesNotMatch(prompt, /book, reschedule, or cancel appointments/);
        }
        if (!transfers) assert.doesNotMatch(prompt, /transfer_call_/);
        assert.ok(compiled.prompt.removedInstructions.length > 5);
      }
    }
  });
}

test("template guidance follows the agent's capabilities", () => {
  const medicalNoBooking = compile(minimalAgent(seededDraft("medical-dental", { booking: false, transfers: false }))).prompt.text;
  assert.match(medicalNoBooking, /You can't book appointments: for a booking request, take a message/);
  const restaurantBooking = compile(minimalAgent(seededDraft("restaurant", { booking: true, transfers: false }))).prompt.text;
  assert.match(restaurantBooking, /ask the party size before checking availability/);
  assert.doesNotMatch(restaurantBooking, /text or email a link/);
  const supportNoTransfer = compile(minimalAgent(seededDraft("customer-support", { booking: false, transfers: false }))).prompt.text;
  assert.doesNotMatch(section(supportNoTransfer, "BUSINESS TYPE GUIDANCE (Customer Support template)"), /CALL TRANSFERS rule/);
  const supportTransfer = compile(minimalAgent(seededDraft("customer-support", { booking: false, transfers: true }))).prompt.text;
  assert.match(section(supportTransfer, "BUSINESS TYPE GUIDANCE (Customer Support template)"), /use a CALL TRANSFERS rule if one covers it/);
});

test("an edited template paragraph is the customer's own text: kept verbatim, no template guidance added", () => {
  const draft = seededDraft("salon-spa", { booking: true, transfers: false });
  draft.roleInstructions = draft.roleInstructions.replace("You are the front-desk receptionist for a salon or spa.", "You are the front desk for Luxe Salon.");
  const prompt = compile(minimalAgent(draft)).prompt.text;
  assert.ok(!sectionTitles(prompt).some((title) => title.startsWith("BUSINESS TYPE GUIDANCE")));
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /You are the front desk for Luxe Salon\./);
});

test("Other / blank template: only the customer's own text", () => {
  const prompt = compile(minimalAgent({ industryTemplate: "other", roleInstructions: "Greet regulars by first name." })).prompt.text;
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /Greet regulars by first name\./);
  assert.ok(!sectionTitles(prompt).some((title) => title.startsWith("BUSINESS TYPE GUIDANCE")));
});

test("a stale booking addendum left in customised text is dropped when booking is off", () => {
  const roleInstructions = `My own rule.\n${SEEDS.defaults.BOOKING_ROLE_INSTRUCTIONS_ADDENDUM}`;
  const compiled = compile(minimalAgent({ booking: false, roleInstructions }));
  assert.equal(section(compiled.prompt.text, "HOW THIS BUSINESS WANTS CALLS HANDLED").trimEnd().split("\n").at(-1), "My own rule.");
  assert.ok(compiled.prompt.removedInstructions.some((entry) => /booking is off/.test(entry.reason)));
});

// --- Knowledge base -----------------------------------------------------------

test("knowledge bases: none, one, several - ids attached, content never copied, wording valid either way", () => {
  const none = compile(minimalAgent());
  const one = compile(minimalAgent({ knowledgeBaseIds: ["kb-services"] }), { kbs: [knowledgeBases[0]] });
  const two = compile(minimalAgent({ knowledgeBaseIds: ["kb-services", "kb-pricing"] }), { kbs: knowledgeBases });
  assert.deepEqual(none.retell.llm.knowledge_base_ids, []);
  assert.deepEqual(one.retell.llm.knowledge_base_ids, ["knowledge_base_svc"]);
  assert.deepEqual(two.retell.llm.knowledge_base_ids, ["knowledge_base_svc", "knowledge_base_price"]);
  for (const compiled of [none, one, two]) {
    assert.match(section(compiled.prompt.text, "KNOWLEDGE BASE"), /## Related Knowledge Base Contexts/);
  }
  // The KB section doesn't depend on how many are attached, so a KB-only
  // push (pushKnowledgeBaseIds) can never leave the prompt stale.
  assert.equal(none.prompt.text, two.prompt.text);
  // An assigned id with no Retell KB yet is not sent.
  const pending = compile(minimalAgent({ knowledgeBaseIds: ["kb-new"] }), { kbs: [] });
  assert.deepEqual(pending.retell.llm.knowledge_base_ids, []);
});

// --- Scheduling ----------------------------------------------------------------

test("scheduling off: no calendar tools and no scheduling sections; on: all five tools and sections", () => {
  const off = compile(minimalAgent({ booking: false, appointmentTypes: [{ name: "Visit", durationMin: 30, minimumLeadTimeMin: 0 }] }));
  assert.ok(!off.retell.llm.general_tools.some((tool) => tool.name.startsWith("calendar_")));
  assert.doesNotMatch(off.prompt.text, /calendar_|APPOINTMENT TYPES|Only book up to|earliest openings|every time you say or book/);
  const on = compile(minimalAgent({ booking: true, appointmentTypes: [{ name: "Visit", durationMin: 30, minimumLeadTimeMin: 0 }] }));
  assert.deepEqual(on.retell.llm.general_tools.filter((tool) => tool.name.startsWith("calendar_")).map((tool) => tool.name), [
    "calendar_find_appointment", "calendar_get_availability", "calendar_create_booking", "calendar_reschedule_booking", "calendar_cancel_booking",
  ]);
  for (const title of ["APPOINTMENT TYPES", "SCHEDULING RULES", "BOOKING FLOW", "RESCHEDULING AND CANCELLING"]) {
    assert.ok(section(on.prompt.text, title), title);
  }
});

test("scheduling off rejects affirmative scheduling instructions but permits explicit prohibitions", () => {
  for (const exampleDialogues of [
    "You: I have an opening tomorrow. You're scheduled for 2 PM.",
    "You: I've booked you for 2 PM.",
    "You: You're all set for tomorrow at 2.",
    "You: Your appointment has been confirmed.",
    "You: I can set up an appointment for Friday.",
    "Arrange a visit whenever the caller requests one.",
  ]) {
    const agent = minimalAgent({ booking: false, exampleDialogues });
    const compiled = compile(agent);
    assert.ok(compiled.diagnostics.some((item) => item.code === "disabled_scheduling_in_examples"));
    assert.throws(() => buildReceptionistConfig({
      ...BUILD,
      agent,
      profile: workspaceProfile,
      knowledgeBases: [],
    }), /The Example Dialogues box has an appointment-booking example, but appointment booking is turned off. Where: Conversation Rules & Guardrails step → Example Dialogues box./);
  }
  const prohibition = compile(minimalAgent({
    booking: false,
    roleInstructions: "Never book or schedule an appointment. When a caller asks to book, take a message instead.",
  }));
  assert.ok(!prohibition.diagnostics.some((item) => item.code === "disabled_scheduling_in_examples"));
  const mixed = compile(minimalAgent({
    booking: false,
    roleInstructions: "Never transfer a caller, but schedule appointments when asked.",
  }));
  assert.ok(mixed.diagnostics.some((item) => item.code === "disabled_scheduling_in_examples"));
});

test("an agent without a transfer tool rejects affirmative transfer instructions but permits no-transfer rules", () => {
  for (const roleInstructions of [
    "Transfer the caller to the owner when they ask for a person.",
    "Connect the caller to the owner when they ask for a person.",
    "Put the caller through to a representative.",
  ]) {
    const contradiction = compile(minimalAgent({ allowCallTransfers: false, roleInstructions }));
    assert.ok(contradiction.diagnostics.some((item) => item.code === "disabled_transfers_in_custom_instructions"));
  }
  const prohibition = compile(minimalAgent({
    allowCallTransfers: false,
    roleInstructions: "Never transfer a call. For transfer requests, take a message instead.",
  }));
  assert.ok(!prohibition.diagnostics.some((item) => item.code === "disabled_transfers_in_custom_instructions"));
});

test("one appointment type vs several: several asks the model to name the type on every call", () => {
  const one = compile(minimalAgent({ booking: true, appointmentTypes: [{ name: "Visit", durationMin: 30, minimumLeadTimeMin: 0 }] }));
  assert.doesNotMatch(one.prompt.text, /Pass the type's exact name/);
  const two = compile(fullAgent(), { kbs: knowledgeBases });
  assert.match(section(two.prompt.text, "APPOINTMENT TYPES"), /Pass the type's exact name as appointmentType on every calendar tool call/);
  // Tool schema and prompt agree on the section name the tool points at.
  const availability = two.retell.llm.general_tools.find((tool) => tool.name === "calendar_get_availability");
  assert.match(availability.parameters.properties.appointmentType.description, /# APPOINTMENT TYPES/);
});

test("the prompt never invents availability: every offered time must come back from the availability tool", () => {
  const prompt = compile(fullAgent(), { kbs: knowledgeBases }).prompt.text;
  assert.match(section(prompt, "SCHEDULING RULES"), /calendar_get_availability checks one exact time\. Check every time before you say it/);
  assert.match(section(prompt, "EXAMPLE DIALOGUES"), /Do you fix water heaters/);
  const generated = compile(fullAgent({ exampleDialogues: "" }), { kbs: knowledgeBases }).prompt.text;
  assert.match(section(generated, "EXAMPLE DIALOGUES"), /\[calendar_get_availability Thursday 10:00 AM \(appointmentType "Phone Consultation"\) -> available/);
});

test("business hours: closed days, 24-hour days, split ranges, free-text fallback, no hours", () => {
  const split = compile(minimalAgent(), { profile: { ...workspaceProfile, businessHours: SPLIT_HOURS_WITH_24H_WEEKEND } }).prompt.text;
  assert.match(split, /Wed closed/);
  assert.match(split, /Sat–Sun Open 24 hours/);
  assert.match(split, /8:00 AM–12:00 PM, 1:00 PM–6:00 PM/);
  const weekdays = compile(minimalAgent(), { profile: { ...workspaceProfile, businessHours: WEEKDAYS_9_TO_5 } }).prompt.text;
  assert.match(weekdays, /Mon–Fri 9:00 AM–5:00 PM; Sat–Sun closed/);
  const textOnly = compile(minimalAgent(), { profile: { ...workspaceProfile, businessHours: undefined, hours: "By appointment" } }).prompt.text;
  assert.match(textOnly, /- Hours: By appointment/);
  const none = compile(minimalAgent(), { profile: { ...workspaceProfile, businessHours: undefined, hours: "" } });
  assert.match(none.prompt.text, /No hours are listed/);
  assert.ok(none.diagnostics.some((item) => item.code === "hours_missing"));
});

test("holidays reach the prompt only while the holiday setting is on", () => {
  const holidays = [{ id: "h", name: "New Year's Day", date: "2027-01-01", closed: true }];
  const off = compile(minimalAgent(), { profile: { ...workspaceProfile, holidays, holidaysEnabled: false } }).prompt.text;
  assert.doesNotMatch(off, /New Year/);
  const on = compile(minimalAgent({ booking: true }), { profile: { ...workspaceProfile, holidays, holidaysEnabled: true } }).prompt.text;
  assert.match(on, /New Year's Day \(Friday, January 1, 2027\): closed/);
  assert.match(on, /Never offer or book a holiday the business is closed/);
});

test("timezone: the zoned clock variable and Retell's agent timezone follow the business; invalid zones fall back", () => {
  const la = compile(minimalAgent(), { profile: { ...workspaceProfile, timezone: "America/Los_Angeles" } });
  assert.match(la.prompt.text, /\{\{current_time_America\/Los_Angeles\}\}/);
  assert.equal(la.retell.agentSettings.timezone, "America/Los_Angeles");
  const bad = compile(minimalAgent(), { profile: { ...workspaceProfile, timezone: "Nowhere" } });
  assert.match(bad.prompt.text, /\{\{current_time_Etc\/UTC\}\}/);
  assert.equal(bad.retell.agentSettings.timezone, "Etc/UTC", "legacy invalid zones use the same explicit UTC fallback in Retell");
  assert.ok(bad.diagnostics.some((item) => item.code === "timezone_invalid"));
});

test("the publish boundary rejects a Retell-invalid payload with an actionable 422 error", () => {
  assert.throws(() => buildReceptionistConfig({
    ...BUILD,
    toolBaseUrl: "http://insecure.example",
    agent: minimalAgent(),
    profile: workspaceProfile,
    knowledgeBases: [],
  }), (error) => {
    assert.equal(error.code, "invalid_voice_agent_configuration");
    assert.equal(error.statusCode, 422);
    assert.equal(error.payload?.code, "invalid_voice_agent_configuration");
    assert.ok(error.details.diagnostics.some((item) => item.code === "invalid_retell_payload"));
    assert.match(error.message, /must be an https URL/);
    return true;
  });
});

test("service area: tool and section only when configured", () => {
  const none = compile(minimalAgent());
  assert.ok(!none.retell.llm.general_tools.some((tool) => tool.name === "check_service_area"));
  assert.equal(section(none.prompt.text, "SERVICE AREA"), null);
  const some = compile(minimalAgent(), { profile: { ...workspaceProfile, serviceAreas: ["Dayton, OH"] } });
  assert.equal(some.retell.llm.general_tools.find((tool) => tool.name === "check_service_area").parameters.properties.serviceAreas.const, "[\"Dayton, OH\"]");
  assert.match(section(some.prompt.text, "SERVICE AREA"), /call check_service_area/);
});

// --- Transfers -------------------------------------------------------------------

test("transfers: disabled means no transfer tool under any configuration; enabled means one per usable rule", () => {
  const rules = [{ phrases: ["manager"], transferTarget: "+19375550170" }];
  const disabled = compile(minimalAgent({ allowCallTransfers: false, emergencyRules: rules }));
  assert.ok(!disabled.retell.llm.general_tools.some((tool) => tool.type === "transfer_call"));
  assert.match(section(disabled.prompt.text, "CALL TRANSFERS"), /This agent never transfers a call/);
  const enabled = compile(minimalAgent({ allowCallTransfers: true, emergencyRules: [...rules, { phrases: [], transferTarget: "937 555 0199" }] }));
  const transfers = enabled.retell.llm.general_tools.filter((tool) => tool.type === "transfer_call");
  assert.deepEqual(transfers.map((tool) => tool.name), ["transfer_call_1"]);
  assert.ok(enabled.diagnostics.some((item) => item.code === "transfer_rule_unusable"));
});

// --- Customer fields ---------------------------------------------------------------

test("custom greeting goes to begin_message only; a blank one keeps the built default", () => {
  const custom = compile(minimalAgent({ greeting: "Hi, Brightwater here - what can we fix today?" }));
  assert.equal(custom.retell.llm.begin_message, "Hi, Brightwater here - what can we fix today?");
  assert.doesNotMatch(custom.prompt.text, /what can we fix today/);
  const blank = compile(minimalAgent({ greeting: "  ", recordingDisclosure: false }));
  // Same text the wizard shows as the default and seeds into new agents.
  assert.equal(blank.retell.llm.begin_message, "Thanks for calling Brightwater Plumbing & Heating. We are currently away from our desk, likely at a job site. So, we have tasked our virtual receptionist, Ava, to assist you while we are unable to do so. How can we help you today?");
  const noDisclosure = compile(minimalAgent({ greeting: "Hi there!", recordingDisclosure: true }));
  assert.ok(noDisclosure.diagnostics.some((item) => item.code === "recording_disclosure_missing"));
});

test("custom instruction fields each land in their own section, in precedence order", () => {
  const prompt = compile(minimalAgent({
    roleInstructions: "ROLE-TEXT", restrictions: "RESTRICT-TEXT", exampleDialogues: "EXAMPLE-TEXT", finalReminders: "FINAL-TEXT",
  })).prompt.text;
  const order = ["CRITICAL RULES", "HOW THIS BUSINESS WANTS CALLS HANDLED", "RESTRICTIONS - WHAT NOT TO SAY OR DO", "EXAMPLE DIALOGUES", "FINAL REMINDERS"]
    .map((title) => prompt.indexOf(`# ${title}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(section(prompt, "CRITICAL RULES"), /override everything else in this prompt, including the business's own instructions/);
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /ROLE-TEXT/);
  assert.match(section(prompt, "EXAMPLE DIALOGUES"), /EXAMPLE-TEXT/);
  assert.ok(prompt.trimEnd().endsWith("FINAL-TEXT"));
});

test("a custom instruction naming a tool the agent lacks is flagged", () => {
  const compiled = compile(minimalAgent({ booking: false, roleInstructions: "Always use calendar_create_booking." }));
  assert.ok(compiled.diagnostics.some((item) => item.code === "prompt_mentions_unregistered_tool"));
  assert.throws(() => buildReceptionistConfig({
    ...BUILD,
    agent: minimalAgent({ booking: false, roleInstructions: "Always use calendar_create_booking." }),
    profile: workspaceProfile,
    knowledgeBases: [],
  }), /prompt mentions calendar_create_booking, which this agent doesn't have/);
});

// --- Voice / language / speech ------------------------------------------------------

test("changing the voice changes only voice_id - never the prompt", () => {
  const a = compileVoiceAgent({ ...BUILD, agent: minimalAgent(), profile: workspaceProfile, voiceId: "11labs-Hailey" });
  const b = compileVoiceAgent({ ...BUILD, agent: minimalAgent(), profile: workspaceProfile, voiceId: "cartesia-Cleo" });
  assert.equal(a.prompt.text, b.prompt.text);
  assert.deepEqual(a.retell.llm, b.retell.llm);
  const bodyA = updateAgentPayload(a, minimalAgent());
  const bodyB = updateAgentPayload(b, minimalAgent());
  assert.deepEqual(Object.keys(bodyA).filter((key) => JSON.stringify(bodyA[key]) !== JSON.stringify(bodyB[key])), ["voice_id"]);
});

test("changing Role Instructions changes only the prompt - voice, tools, knowledge bases, and agent settings stay", () => {
  const before = compile(fullAgent(), { kbs: knowledgeBases });
  const after = compile(fullAgent({ roleInstructions: "- Something new." }), { kbs: knowledgeBases });
  const changed = (left, right) => Object.keys(left).filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
  assert.deepEqual(changed(before.retell.llm, after.retell.llm), ["general_prompt"]);
  assert.deepEqual(changed(updateAgentPayload(before, fullAgent()), updateAgentPayload(after, fullAgent())), []);
});

test("language: Spanish sets Retell's language, a Spanish default greeting, and tells the model to speak Spanish", () => {
  const compiled = compile(minimalAgent({ language: "es-419", recordingDisclosure: true }));
  assert.equal(compiled.retell.agentSettings.language, "es-419");
  assert.match(compiled.retell.llm.begin_message, /^Gracias por llamar a Brightwater Plumbing & Heating\. Esta llamada puede ser grabada/);
  assert.match(section(compiled.prompt.text, "ROLE"), /Speak only Spanish \(Latin American\)/);
  const english = compile(minimalAgent({ language: "fr-FR" }));
  assert.equal(english.retell.agentSettings.language, "en-US");
  assert.doesNotMatch(english.prompt.text, /Speak only Spanish/);
  assert.ok(compile(minimalAgent({ language: "es-419", greeting: "Thanks for calling!" })).diagnostics.some((item) => item.code === "greeting_language_mismatch"));
});

test("a Spanish agent still carrying the wizard's untouched English sample greeting greets in Spanish; an edited one is kept", () => {
  for (const disclosure of [false, true]) {
    const englishSample = `Thanks for calling Brightwater Plumbing & Heating.${disclosure ? " This call may be recorded for quality assurance." : ""} We are currently away from our desk, likely at a job site. So, we have tasked our virtual receptionist, Lucía, to assist you while we are unable to do so. How can we help you today?`;
    const spanish = compile(minimalAgent({ spokenName: "Lucía", language: "es-419", recordingDisclosure: true, greeting: englishSample }));
    assert.match(spanish.retell.llm.begin_message, /^Gracias por llamar a Brightwater Plumbing & Heating\. Esta llamada puede ser grabada/);
    assert.ok(!spanish.diagnostics.some((item) => item.code === "greeting_language_mismatch"));
    // English agents keep the sample untouched.
    assert.equal(compile(minimalAgent({ spokenName: "Lucía", greeting: englishSample })).retell.llm.begin_message, englishSample);
  }
  const edited = compile(minimalAgent({ spokenName: "Lucía", language: "es-419", greeting: "Thanks for calling, how can I help?" }));
  assert.equal(edited.retell.llm.begin_message, "Thanks for calling, how can I help?");
  assert.ok(edited.diagnostics.some((item) => item.code === "greeting_language_mismatch"));
});

test("transfer tool descriptions use the same match-by-meaning wording as the prompt", () => {
  const compiled = compile(minimalAgent({ allowCallTransfers: true, emergencyRules: [{ phrases: ["billing", "invoices"], transferTarget: "+19375550170" }] }));
  const tool = compiled.retell.llm.general_tools.find((candidate) => candidate.type === "transfer_call");
  assert.equal(tool.description, 'Warm transfer when what the caller says means "billing" or "invoices".');
  assert.doesNotMatch(JSON.stringify(compiled.retell.llm), /caller mentions/);
});

test("emergency rule never says 'hang up' and 'I'll transfer you' as one instruction without the danger condition", () => {
  const withRule = section(compile(minimalAgent({ allowCallTransfers: true, emergencyRules: [{ phrases: ["gas leak"], transferTarget: "+19375550170" }] })).prompt.text, "CRITICAL RULES");
  assert.match(withRule, /if anyone is in danger, hang up and call 911 right away\. Otherwise, I'll connect you with our team now\." and make that transfer/);
  const withoutRule = section(compile(minimalAgent({ allowCallTransfers: false })).prompt.text, "CRITICAL RULES");
  assert.doesNotMatch(withoutRule, /connect you with our team|make that transfer/);
});

test("who speaks first: the context line and begin_message_delay_ms follow it", () => {
  const agentFirst = compile(minimalAgent({ startSpeaker: "agent", pauseBeforeSpeakingMs: 1000 }));
  assert.match(agentFirst.prompt.text, /The greeting has already introduced you/);
  assert.equal(agentFirst.retell.agentSettings.begin_message_delay_ms, 1000);
  const callerFirst = compile(minimalAgent({ startSpeaker: "user", pauseBeforeSpeakingMs: 1000 }));
  assert.match(callerFirst.prompt.text, /The caller speaks first\. In your first reply, say briefly that you're Ava with Brightwater/);
  assert.equal(callerFirst.retell.llm.start_speaker, "user");
  assert.equal(callerFirst.retell.agentSettings.begin_message_delay_ms, 0, "caller-first clears a previously published delay");
});

// --- Legacy -------------------------------------------------------------------------

test("legacy agent: old fields are ignored and reported, never dropped from storage or sent", () => {
  const { agent, profile } = SCENARIOS["legacy-agent"]();
  const cfg = buildVoiceAgentConfiguration(agent, profile);
  assert.deepEqual(cfg.ignoredFields.sort(), ["escalation", "intents", "knowledgeBaseText"]);
  assert.equal(cfg.identity.spokenName, "Samantha");
  assert.equal(cfg.transfers.allowed, true, "absent allowCallTransfers means allowed");
  assert.deepEqual(cfg.transfers.rules.map((rule) => rule.number), ["+17035550102"]);
  assert.deepEqual(cfg.transfers.legacyMessageRules, [{ phrases: ["refund"], message: "Our billing team will call you back." }]);
  const compiled = compile(agent, { profile });
  assert.match(section(compiled.prompt.text, "CALL TRANSFERS"), /"refund": say "Our billing team will call you back\." and don't transfer\./);
  assert.doesNotMatch(compiled.prompt.text, /720431997|Old private knowledge text|Transfer emergencies\./);
  assert.match(compiled.prompt.text, /- Hours: Weekdays 8 to 4/);
  // The input object is never mutated.
  assert.equal(agent.configuration.escalation, "Transfer emergencies.");
});

// --- Inspector ---------------------------------------------------------------------

test("inspector shows every stage, matches the publish payload, and carries no credentials or storage keys", () => {
  const agent = fullAgent({ knowledgeBaseFiles: [{ id: "f", name: "menu.pdf", key: "workspaces/ws-test/knowledge/secret-key.pdf", contentType: "application/pdf", size: 10 }] });
  const view = inspectVoiceAgent({ ...BUILD, agent, profile: workspaceProfile, knowledgeBases, source: "saved" });
  const compiled = compile(agent, { kbs: knowledgeBases });
  assert.equal(view.prompt.text, compiled.prompt.text);
  assert.deepEqual(view.retellRequests.updateRetellLlm, compiled.retell.llm);
  assert.deepEqual(view.retellRequests.updateAgent, updateAgentPayload(compiled, agent));
  assert.deepEqual(view.validation, []);
  assert.deepEqual(view.prompt.sections.map((entry) => entry.id).filter((id) => !SECTION_IDS.includes(id)), []);
  assert.ok(view.dynamicVariables.some((entry) => entry.name === "crm_context" && entry.defaultWhenMissing === "Not available."));
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /secret-key\.pdf|apiKey|api_key|Bearer/);
});

test("inspector without a resolvable voice still renders, with a warning", () => {
  const view = inspectVoiceAgent({ ...BUILD, voiceId: null, agent: minimalAgent(), profile: workspaceProfile, source: "saved" });
  assert.ok(view.diagnostics.some((item) => item.code === "voice_unresolved"));
});

// --- Validator -------------------------------------------------------------------

test("the payload validator catches what Retell would reject", () => {
  const compiled = compile(minimalAgent());
  const body = updateAgentPayload(compiled, minimalAgent());
  const broken = validateRetellPayloads({
    llm: {
      ...compiled.retell.llm,
      begin_message: "",
      general_prompt: `${compiled.retell.llm.general_prompt} {{currentTime}}`,
      general_tools: [...compiled.retell.llm.general_tools, { type: "transfer_call", name: "bad name!", description: "x", transfer_destination: { type: "predefined", number: "+1555,,,22" }, transfer_option: { type: "warm_transfer" }, execution_message_type: "static_text" }],
    },
    agent: { ...body, ambient_sound: "rainforest", max_call_duration_ms: 10, language: "xx-XX" },
  });
  const paths = broken.map((problem) => problem.path);
  for (const expected of ["llm.begin_message", "llm", "agent.ambient_sound", "agent.max_call_duration_ms", "agent.language"]) {
    assert.ok(paths.includes(expected), expected);
  }
  assert.ok(paths.some((path) => path.endsWith(".name")));
  assert.ok(paths.some((path) => path.endsWith("transfer_destination.number")));
});

test("sampleGreeting matches the wizard's buildSampleGreeting (hashes shared with the frontend seed-sync test)", async () => {
  const { sampleGreeting } = await import("./configuration.mjs");
  const { createHash } = await import("node:crypto");
  const exact = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
  assert.deepEqual({
    "en-US false": exact(sampleGreeting("en-US", "Arc Dental", "Maya", false)),
    "en-US true": exact(sampleGreeting("en-US", "Arc Dental", "Maya", true)),
    "es-419 false": exact(sampleGreeting("es-419", "Arc Dental", "Maya", false)),
    "es-419 true": exact(sampleGreeting("es-419", "Arc Dental", "Maya", true)),
  }, {
    "en-US false": "15da335b0b0b68074662d457b16c6359",
    "en-US true": "b837c53ae9a0ba01f8b7ed77352b71b4",
    "es-419 false": "f209ca5d29f94e14009ef3081a21fe31",
    "es-419 true": "22cfeb764112ba06b31e4a6ebdf6cc8c",
  });
});

test("inspector says when the next publish will migrate legacy per-agent knowledge", () => {
  const legacy = inspectVoiceAgent({ ...BUILD, agent: minimalAgent({ knowledgeBaseText: "Old notes" }), profile: workspaceProfile, source: "saved" });
  assert.ok(legacy.diagnostics.some((item) => item.code === "legacy_knowledge_pending"));
  const migrated = inspectVoiceAgent({ ...BUILD, agent: minimalAgent({ knowledgeBaseText: "Old notes", legacyKnowledgeMigrated: true }), profile: workspaceProfile, source: "saved" });
  assert.ok(!migrated.diagnostics.some((item) => item.code === "legacy_knowledge_pending"));
});
