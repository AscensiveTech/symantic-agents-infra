import assert from "node:assert/strict";
import test from "node:test";

import {
  CALL_HANDLING,
  buildReceptionistConfig,
  buildReceptionistPrompt,
  resolveAllowedInboundCountries,
  resolveAmbientSound,
  resolveAmbientSoundVolume,
  resolveCallHandling,
  resolveConfiguredVoiceId,
  resolveGreeting,
  resolveLanguage,
  resolvePauseBeforeSpeakingMs,
  resolveStartSpeaker,
  spokenAgentName,
} from "./receptionist.mjs";

const profile = {
  businessName: "Arc Dental",
  businessType: "dental practice",
  description: "Family dentistry",
  address: "123 Main Street",
  timezone: "America/New_York",
  hours: "Mon-Fri, 8:00 AM-5:00 PM",
  faqs: [
    {
      question: "Do you accept insurance?",
      answer: "Yes, most PPO plans.",
    },
    {
      question: "Do you see children?",
      answer: "Yes, ages three and older.",
    },
  ],
  policies: "Give 24 hours notice for cancellations.",
  escalationContact: "+17035550199",
  ownerPhone: "+17035550100",
  fallbackPhone: "+17035550188",
  communicationStyle: "Warm and concise",
};

const agent = {
  id: "agent-123",
  name: "Maya",
  role: "Phone operations",
  description: "Answers calls",
  status: "active",
  capabilities: ["Inbound calls", "Calendar"],
  configuration: {
    name: "Maya",
    voice: "Calm and natural",
    tone: "Warm, concise, and professional",
    greeting: "Thanks for calling Arc Dental. How can I help?",
    roleInstructions: "You are the front-desk receptionist for a dental clinic.",
    restrictions: "Never provide a diagnosis or promise insurance coverage.",
    intents: ["Scheduling", "Insurance", "Urgent care"],
    booking: true,
    escalation:
      "For severe bleeding or trouble breathing, tell the caller to contact emergency services, then transfer to the office.",
    emergencyRules: [
      { phrases: ["chest pain", "can't breathe"], transferTarget: "+17035550102" },
    ],
  },
};

test("allowCallTransfers: false means no transfer_call tool exists at all, even with rules, escalation, and owner/fallback numbers all configured", () => {
  const noTransferAgent = {
    ...agent,
    configuration: { ...agent.configuration, allowCallTransfers: false },
  };
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: noTransferAgent,
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.equal(config.tools.filter(({ type }) => type === "transfer_call").length, 0);
  assert.deepEqual(config.transferNumbers, []);
});

test("an extension is dialed as a DTMF pause after the transfer number", () => {
  const withExtensionAgent = {
    ...agent,
    configuration: {
      ...agent.configuration,
      emergencyRules: [
        { phrases: ["billing"], transferTarget: "+17035550102", extension: "204" },
      ],
    },
  };
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: withExtensionAgent,
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.ok(config.transferNumbers.includes("+17035550102,,,204"));
});

test("resolveGreeting uses the configured greeting when set, otherwise builds one from the real business/receptionist name", () => {
  assert.equal(resolveGreeting(agent, profile), agent.configuration.greeting);
  assert.equal(
    resolveGreeting({ ...agent, configuration: { ...agent.configuration, greeting: "" } }, profile),
    "Thanks for calling Arc Dental. This is Maya, the virtual receptionist. How can I help you today?",
  );
  assert.equal(
    resolveGreeting({ ...agent, configuration: { ...agent.configuration, greeting: "  " } }, { ...profile, businessName: "" }),
    "Thanks for calling the business. This is Maya, the virtual receptionist. How can I help you today?",
  );
  assert.equal(
    resolveGreeting({ configuration: {} }, { businessName: "Rivertown Plumbing" }),
    "Thanks for calling Rivertown Plumbing. This is the AI voice agent, the virtual receptionist. How can I help you today?",
  );
});

test("resolveGreeting adds a short recording disclosure line when recordingDisclosure is on", () => {
  assert.equal(
    resolveGreeting({ configuration: { recordingDisclosure: true, name: "Maya" } }, { businessName: "Arc Dental" }),
    "Thanks for calling Arc Dental. This call may be recorded for quality assurance. This is Maya, the virtual receptionist. How can I help you today?",
  );
});

test("the agent's chosen ambient sound reaches the Retell config, and an unknown one sends none", () => {
  const build = (ambientSound) => buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: { ...agent, configuration: { ...agent.configuration, ambientSound } },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.equal(build("coffee-shop").ambientSound, "coffee-shop");
  assert.equal(build("").ambientSound, null);
  assert.equal(build("rainforest").ambientSound, null);
  assert.equal(resolveAmbientSound({ configuration: {} }), null);
});

test("the agent's chosen ambient sound volume reaches the Retell config, clamped into Retell's 0.1-1 range and defaulted when unset", () => {
  const build = (ambientSoundVolume) => buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: { ...agent, configuration: { ...agent.configuration, ambientSound: "coffee-shop", ambientSoundVolume } },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.equal(build(0.3).ambientSoundVolume, 0.3);
  assert.equal(build(undefined).ambientSoundVolume, 0.5);
  assert.equal(build(5).ambientSoundVolume, 1);
  assert.equal(build(-2).ambientSoundVolume, 0.1);
  assert.equal(resolveAmbientSoundVolume({ configuration: {} }), 0.5);
});

test("resolveCallHandling applies defaults and clamps to the Retell range", () => {
  assert.deepEqual(resolveCallHandling({ configuration: {} }), {
    silenceSec: CALL_HANDLING.silence.defaultSec,
    maxDurationMin: CALL_HANDLING.maxDuration.defaultMin,
  });
  assert.deepEqual(
    resolveCallHandling({ configuration: { silenceTimeoutSec: 20, maxCallDurationMin: 5 } }),
    { silenceSec: 20, maxDurationMin: 5 },
  );
  assert.deepEqual(
    resolveCallHandling({ configuration: { silenceTimeoutSec: 5, maxCallDurationMin: 45 } }),
    { silenceSec: CALL_HANDLING.silence.minSec, maxDurationMin: CALL_HANDLING.maxDuration.maxMin },
  );
});

test("resolveAllowedInboundCountries normalizes to unique upper-case ISO codes", () => {
  assert.deepEqual(resolveAllowedInboundCountries({ configuration: {} }), []);
  assert.deepEqual(
    resolveAllowedInboundCountries({ configuration: { allowedInboundCountries: ["us", " ca ", "US", "bad", 7] } }),
    ["US", "CA"],
  );
});

test("holidays never reach the prompt while the holidays toggle is off or was never set, even if a list is saved", () => {
  const holidays = [{ id: "h1", name: "Thanksgiving", date: "2026-11-26", closed: true }];
  for (const holidaysEnabled of [false, undefined]) {
    const prompt = buildReceptionistPrompt(agent, { ...profile, holidays, holidaysEnabled });
    assert.doesNotMatch(prompt, /- Holidays:/);
    assert.doesNotMatch(prompt, /Thanksgiving/);
  }
});

test("a Cal.com agent's prompt lists its chosen event types instead of its own Appointment Types", () => {
  const prompt = buildReceptionistPrompt({
    ...agent,
    configuration: {
      ...agent.configuration,
      connections: ["cal-com"],
      calComEventTypes: [
        { id: "101", name: "Estimate Visit", lengthInMinutes: 60 },
        { id: "202", name: "Quick Call", lengthInMinutes: 15 },
      ],
      appointmentTypes: [{ id: "t1", name: "Stale Type", durationMin: 30, minimumLeadTimeMin: 60 }],
    },
  }, profile);

  const typesSection = prompt.split("# APPOINTMENT TYPES")[1].split("\n\n")[0];
  assert.match(typesSection, /- Estimate Visit \(1 hour\)/);
  assert.match(typesSection, /- Quick Call \(15 minutes\)/);
  assert.doesNotMatch(prompt, /Stale Type/);
});

test("prompt renders an allDay day as 'Open 24 hours', not raw interval text", () => {
  const open = (intervals) => ({ closed: false, intervals });
  const prompt = buildReceptionistPrompt(agent, {
    ...profile,
    businessHours: {
      mon: open([{ open: "08:00", close: "17:00" }]),
      tue: open([{ open: "08:00", close: "17:00" }]),
      wed: open([{ open: "08:00", close: "17:00" }]),
      thu: open([{ open: "08:00", close: "17:00" }]),
      fri: open([{ open: "08:00", close: "17:00" }]),
      sat: { closed: false, allDay: true, intervals: [] },
      sun: { closed: false, allDay: true, intervals: [] },
    },
  });
  assert.match(prompt, /Mon–Fri 8:00 AM–5:00 PM; Sat–Sun Open 24 hours/);
});

test("cloned voice mode uses the stored voiceId instead of the catalog map", () => {
  const resolveVoiceId = (requested) => `mapped:${requested}`;
  assert.equal(
    resolveConfiguredVoiceId({ voiceMode: "cloned", voiceId: "11labs-cloned-maya" }, resolveVoiceId),
    "11labs-cloned-maya",
  );
  assert.equal(
    resolveConfiguredVoiceId({ voiceMode: "platform", voice: "Calm and natural" }, resolveVoiceId),
    "mapped:Calm and natural",
  );
  assert.equal(
    resolveConfiguredVoiceId({ voiceMode: "cloned", voiceId: "  ", voice: "Calm and natural" }, resolveVoiceId),
    "mapped:Calm and natural",
  );
});

test("check_service_area tool is omitted when no service area is configured, and included with the list baked in as a const when it is", () => {
  const withoutAreas = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent,
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.ok(!withoutAreas.tools.some(({ name }) => name === "check_service_area"));

  const withAreas = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent,
    profile: { ...profile, serviceAreas: ["Arlington, VA", "Alexandria, VA"] },
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  const serviceAreaTool = withAreas.tools.find(({ name }) => name === "check_service_area");
  assert.ok(serviceAreaTool);
  assert.equal(serviceAreaTool.url, "https://api.example.com/retell/tools/service-area.check");
  assert.equal(
    serviceAreaTool.parameters.properties.serviceAreas.const,
    JSON.stringify(["Arlington, VA", "Alexandria, VA"]),
  );
  assert.ok(serviceAreaTool.parameters.required.includes("location"));
});

test("booking-disabled agents omit calendar tools", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: {
      ...agent,
      configuration: { ...agent.configuration, booking: false },
    },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });

  assert.equal(config.bookingEnabled, false);
  assert.deepEqual(config.tools.filter(({ type }) => type === "custom")
    .map(({ name }) => name), ["lead_capture", "message_take"]);
  assert.ok(config.tools.some(({ type }) => type === "transfer_call"));
  assert.ok(config.tools.some(({ type }) => type === "end_call"));
});

test("resolveLanguage falls back to en-US for anything outside the supported set", () => {
  assert.equal(resolveLanguage({ configuration: { language: "es-419" } }), "es-419");
  assert.equal(resolveLanguage({ configuration: { language: "fr-FR" } }), "en-US");
  assert.equal(resolveLanguage({ configuration: {} }), "en-US");
});

test("resolveStartSpeaker and resolvePauseBeforeSpeakingMs clamp to the supported Welcome Message options", () => {
  assert.equal(resolveStartSpeaker({ configuration: { startSpeaker: "user" } }), "user");
  assert.equal(resolveStartSpeaker({ configuration: {} }), "agent");
  assert.equal(resolvePauseBeforeSpeakingMs({ configuration: { pauseBeforeSpeakingMs: 1000 } }), 1000);
  assert.equal(resolvePauseBeforeSpeakingMs({ configuration: { pauseBeforeSpeakingMs: 3000 } }), 0);
});

test("buildReceptionistConfig sets language and begin_message_delay_ms when the agent speaks first with a pause", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: {
      ...agent,
      configuration: { ...agent.configuration, language: "es-419", startSpeaker: "agent", pauseBeforeSpeakingMs: 1000 },
    },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.equal(config.language, "es-419");
  assert.equal(config.retellAgent.language, "es-419");
  assert.equal(config.retellAgent.begin_message_delay_ms, 1000);
});

test("buildReceptionistConfig omits begin_message_delay_ms when the caller speaks first", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: {
      ...agent,
      configuration: { ...agent.configuration, startSpeaker: "user", pauseBeforeSpeakingMs: 1000 },
    },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.equal(config.startSpeaker, "user");
  assert.equal(config.retellAgent.begin_message_delay_ms, undefined);
});

test("end_call is always available, independent of spamScreening - the agent also uses it to end calls gracefully", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: { ...agent, configuration: { ...agent.configuration, spamScreening: false } },
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  assert.ok(config.tools.some(({ type }) => type === "end_call"));
});

// --- Prompt overhaul (2026-09-24): structure and behavior to the standard
// of the two reference prompts, driven only by the agent's own settings. ---

const sectionsOf = (prompt) => prompt.split("\n").filter((line) => line.startsWith("# ")).map((line) => line.slice(2));
const section = (prompt, title) => {
  const start = prompt.indexOf(`# ${title}\n`);
  if (start === -1) return null;
  const next = prompt.indexOf("\n# ", start + 2);
  return prompt.slice(start, next === -1 ? undefined : next);
};

test("sections come in the reference order, with the business's own text after the fixed rules and Final Reminders last", () => {
  const prompt = buildReceptionistPrompt({
    ...agent,
    configuration: { ...agent.configuration, exampleDialogues: "Caller: Hi\nYou: Hello!", finalReminders: "- Always be kind." },
  }, profile);

  assert.deepEqual(sectionsOf(prompt), [
    "ROLE", "CONTEXT (never read aloud)", "CRITICAL RULES", "ONE THING AT A TIME", "BUSINESS INFO", "KNOWLEDGE BASE",
    "APPOINTMENT TYPES", "SCHEDULING RULES", "BOOKING FLOW", "RESCHEDULING AND CANCELLING", "TAKING A MESSAGE",
    "CALL TRANSFERS", "REQUESTS FOR A SPECIFIC PERSON", "SPAM", "OFF-TOPIC, FLIRTING AND ABUSE", "NO PROGRESS", "CLOSING",
    "HOW THIS BUSINESS WANTS CALLS HANDLED", "RESTRICTIONS - WHAT NOT TO SAY OR DO", "EXAMPLE DIALOGUES", "FINAL REMINDERS",
  ]);
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /the rules above always win/);
  assert.match(section(prompt, "HOW THIS BUSINESS WANTS CALLS HANDLED"), /You are the front-desk receptionist for a dental clinic\./);
  assert.match(section(prompt, "RESTRICTIONS - WHAT NOT TO SAY OR DO"), /Never provide a diagnosis/);
  assert.match(prompt.trimEnd(), /- Always be kind\.$/);
});

test("sample-data profile fields and hidden, uneditable agent fields never reach the prompt", () => {
  const prompt = buildReceptionistPrompt(agent, profile);

  assert.doesNotMatch(prompt, /Family dentistry|Do you accept insurance\?|Give 24 hours notice|Warm and concise/);
  // intents and escalation have no screen; their stored text is ignored.
  assert.doesNotMatch(prompt, /APPROVED CALLER INTENTS|Urgent care/);
  assert.doesNotMatch(prompt, /severe bleeding or trouble breathing/);
  assert.doesNotMatch(prompt, /\+17035550199|\+17035550188/);
});

test("critical rules: caller number, clock, no email, never guess, tool-confirmed actions, AI disclosure, 911, staff names", () => {
  const rules = section(buildReceptionistPrompt(agent, profile), "CRITICAL RULES");

  assert.match(rules, /\{\{user_number\}\}/);
  assert.match(rules, /\{\{currentTime\}\} \(\{\{timezone\}\}\)/);
  assert.match(rules, /Never ask for an email address/);
  assert.match(rules, /Never guess/);
  assert.match(rules, /until the tool has actually returned\s+success/);
  assert.match(rules, /Yes - I'm an AI assistant for Arc Dental/);
  assert.match(rules, /please hang up and call 911 right away/);
  assert.match(rules, /Never confirm or deny that anyone works here/);
  assert.match(rules, /the phone number alone is enough/);

  const noBooking = section(buildReceptionistPrompt({ ...agent, configuration: { ...agent.configuration, booking: false } }, profile), "CRITICAL RULES");
  assert.doesNotMatch(noBooking, /booked under/);
});

test("the context line explains why the AI is answering, and the message flow asks name, reason, and confirms the number one at a time", () => {
  const prompt = buildReceptionistPrompt(agent, profile);

  assert.match(section(prompt, "CONTEXT (never read aloud)"), /busy - on other calls or out serving customers/);
  const message = section(prompt, "TAKING A MESSAGE");
  assert.match(message, /Everyone's busy helping other customers/);
  assert.ok(message.indexOf("name first") < message.indexOf("what the call is about"));
  assert.match(message, /If they ask\s+what it is, tell them/);
  assert.match(message, /message_take/);
  assert.match(message, /Never promise a callback time\. Never ask for an email/);
  assert.match(section(prompt, "ONE THING AT A TIME"), /Bad: .*\nGood: /);
});

test("Allow transfers: each rule becomes its own tool (its number, or the Default Transfer Number), named in the prompt, with the fixed line and never a generic 'talk to a person' transfer", () => {
  const allow = {
    ...agent,
    configuration: {
      ...agent.configuration,
      allowCallTransfers: true,
      emergencyRules: [
        { phrases: ["chest pain"], transferTarget: "+17035550102" },
        { phrases: ["Sunny", "billing"], transferTarget: "" },
        { phrases: ["service desk"], transferTarget: "+17035550103", extension: "204" },
        { phrases: [], transferTarget: "+17035550104" },
        { phrases: ["I want to talk to a human."], transferTarget: "720431997", action: "decline", message: "No one is available - I'll take a message." },
      ],
    },
  };
  const config = buildReceptionistConfig({ workspaceId: "w", agent: allow, profile, toolBaseUrl: "https://api.example.com", voiceId: "v" });
  const transfers = config.tools.filter((tool) => tool.type === "transfer_call");

  assert.deepEqual(transfers.map((tool) => [tool.name, tool.transfer_destination.number]), [
    ["transfer_call_1", "+17035550102"],
    ["transfer_call_2", "+17035550100"],
    ["transfer_call_3", "+17035550103,,,204"],
  ]);
  for (const tool of transfers) assert.equal(tool.execution_message_description, "Sure, I'll transfer your call to a staff member so they can assist you.");
  const rules = section(config.prompt, "CALL TRANSFERS");
  assert.match(rules, /"chest pain": use transfer_call_1\./);
  assert.match(rules, /"Sunny" or "billing": use transfer_call_2\./);
  assert.match(rules, /"I want to talk to a human\.": say "No one is available - I'll take a message\." and don't transfer/);
  assert.match(rules, /Transfer only when what the caller says matches the MEANING/);
  assert.match(rules, /matches no rule above: don't transfer - use TAKING\s+A MESSAGE/);
  assert.match(rules, /Never say who you're transferring to/);
  assert.doesNotMatch(config.prompt, /transfer to \+?\d/);
  assert.doesNotMatch(config.prompt, /720431997/);
});

test("Do Not Allow: no transfer tools at all, each rule's own response, then the fixed fallback line", () => {
  const noTransfer = {
    ...agent,
    configuration: {
      ...agent.configuration,
      allowCallTransfers: false,
      emergencyRules: [{ phrases: ["chest pain"], transferTarget: "+17035550102" }],
      noTransferRules: [
        { phrases: ["talk to a supervisor"], message: "I'll pass that along and someone will call you back." },
        { phrases: ["billing question"], message: "" },
      ],
    },
  };
  const config = buildReceptionistConfig({ workspaceId: "w", agent: noTransfer, profile, toolBaseUrl: "https://api.example.com", voiceId: "v" });

  assert.equal(config.tools.filter((tool) => tool.type === "transfer_call").length, 0);
  const rules = section(config.prompt, "CALL TRANSFERS");
  assert.match(rules, /This agent never transfers a call\./);
  assert.match(rules, /"talk to a supervisor": say "I'll pass that along/);
  assert.doesNotMatch(rules, /billing question/);
  assert.match(rules, /My apologies\. Since no one is available/);
  assert.doesNotMatch(config.prompt, /transfer_call/);
  assert.match(rules, /Match by the MEANING of what the caller says, never their exact wording/);
});

test("phrase matching is by meaning, not literal text: a rule's tool line and a legacy/no-transfer rule's own line both read 'means', never 'mentions'", () => {
  const withEverything = {
    ...agent,
    configuration: {
      ...agent.configuration,
      allowCallTransfers: true,
      emergencyRules: [
        { phrases: ["talk to a human"], transferTarget: "+17035550102" },
        { phrases: ["911 emergency"], transferTarget: "720431997", action: "decline", message: "Please call 911." },
      ],
    },
  };
  const allowPrompt = buildReceptionistPrompt(withEverything, profile);
  assert.match(allowPrompt, /If what the caller says means "talk to a human": use transfer_call_1\./);
  assert.match(allowPrompt, /If what the caller says means "911 emergency": say "Please call 911\." and don't transfer\./);
  assert.doesNotMatch(allowPrompt, /If the caller mentions/);

  const noTransferPrompt = buildReceptionistPrompt({
    ...agent,
    configuration: {
      ...agent.configuration,
      allowCallTransfers: false,
      noTransferRules: [{ phrases: ["talk to a staff"], message: "Someone will call you back." }],
    },
  }, profile);
  assert.match(noTransferPrompt, /If what the caller says means "talk to a staff": say "Someone will call you back\."/);
  assert.doesNotMatch(noTransferPrompt, /If the caller mentions/);
});

test("requests for a specific person never confirm, deny, or repeat a name", () => {
  const person = section(buildReceptionistPrompt(agent, profile), "REQUESTS FOR A SPECIFIC PERSON");
  assert.match(person, /never confirm or deny that anyone\s+by that name works here/);
  assert.match(person, /never repeat the name back/);
  assert.match(person, /Someone from Arc Dental will call you back/);
});

test("spam, off-topic, flirting, abuse, and no-progress handling - never accusing the caller", () => {
  const prompt = buildReceptionistPrompt(agent, profile);
  assert.match(section(prompt, "SPAM"), /never say the word "spam" and never accuse the caller/);
  const conduct = section(prompt, "OFF-TOPIC, FLIRTING AND ABUSE");
  assert.match(conduct, /Flirting/);
  assert.match(conduct, /An explicit opening line gets no redirect/);
  assert.match(conduct, /cursing/);
  assert.match(section(prompt, "NO PROGRESS"), /about two minutes/);
  const noSpam = buildReceptionistPrompt({ ...agent, configuration: { ...agent.configuration, spamScreening: false } }, profile);
  assert.equal(section(noSpam, "SPAM"), null);
});

test("booking on: types (no buffers), scheduling window, full booking and reschedule/cancel flows naming the calendar functions; off: none of it", () => {
  const booking = {
    ...agent,
    configuration: {
      ...agent.configuration,
      bookingWindowDays: 10,
      appointmentTypes: [
        { id: "a", name: "Quick Call", durationMin: 15, minimumLeadTimeMin: 60, blockBeforeMin: 60, blockAfterMin: 60 },
        { id: "b", name: "On-Site Visit", durationMin: 30, minimumLeadTimeMin: 1440, happensAtCustomerLocation: true },
      ],
    },
  };
  const prompt = buildReceptionistPrompt(booking, { ...profile, serviceAreas: ["Rockville, MD"] });

  const types = section(prompt, "APPOINTMENT TYPES");
  assert.match(types, /ways to book, not services/);
  assert.match(types, /Quick Call \(15 minutes, must be booked at least 1 hour in advance\)/);
  assert.doesNotMatch(types, /\b60 minutes|blockBefore|blockAfter/);
  assert.match(section(prompt, "SCHEDULING RULES"), /Only book up to 10 days ahead/);
  const flow = section(prompt, "BOOKING FLOW");
  assert.match(flow, /calendar_get_availability/);
  assert.match(flow, /calendar_create_booking only after that yes/);
  assert.match(flow, /what\s+city are you in/);
  assert.match(flow, /full address for the\s+visit/);
  const changes = section(prompt, "RESCHEDULING AND CANCELLING");
  for (const tool of ["calendar_find_appointment", "calendar_reschedule_booking", "calendar_cancel_booking"]) assert.match(changes, new RegExp(tool));
  assert.match(changes, /with and without the country code/);
  assert.match(section(prompt, "SERVICE AREA"), /don't book the\s+visit - we can't locate it\. Take a message instead/);
  assert.match(section(prompt, "ONE THING AT A TIME"), /ask their city before checking availability/);

  const noBooking = buildReceptionistPrompt({ ...booking, configuration: { ...booking.configuration, booking: false } }, profile);
  for (const title of ["APPOINTMENT TYPES", "SCHEDULING RULES", "BOOKING FLOW", "RESCHEDULING AND CANCELLING"]) assert.equal(section(noBooking, title), null);
  assert.doesNotMatch(noBooking, /calendar_/);
});

test("the booking window defaults to 30 days and stays within 1-60", () => {
  const days = (bookingWindowDays) => section(
    buildReceptionistPrompt({ ...agent, configuration: { ...agent.configuration, bookingWindowDays } }, profile),
    "SCHEDULING RULES",
  ).match(/Only book up to (\d+) days/)[1];
  assert.equal(days(undefined), "30");
  assert.equal(days(45), "45");
  assert.equal(days(0), "30");
  assert.equal(days(90), "30");
});

test("business info: structured hours win over free text, the call clock is authoritative, holidays only when enabled, contact emails, pricing guard", () => {
  const withAll = buildReceptionistPrompt(agent, {
    ...profile,
    hours: "ignored free text",
    businessHours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, day === "tue"
      ? { closed: true, intervals: [{ open: "09:00", close: "13:00" }] }
      : { closed: false, intervals: [{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }] }])),
    holidaysEnabled: true,
    holidays: [
      { id: "h1", name: "Thanksgiving", date: "2026-11-26", closed: true },
      { id: "h2", name: "Labor Day", date: "2026-09-07", closed: true, disabled: true },
    ],
    contactEmails: [{ label: "Billing / AR", email: "billing@example.com" }],
  });
  const info = section(withAll, "BUSINESS INFO");
  assert.doesNotMatch(info, /ignored free text/);
  assert.match(info, /- Holidays: Thanksgiving \(2026-11-26\): closed$/m);
  assert.doesNotMatch(info, /Labor Day/);
  assert.match(info, /Billing \/ AR: billing@example\.com/);
  assert.match(info, /weekends included/);
  assert.match(section(withAll, "KNOWLEDGE BASE"), /Never quote a price, discount, special/);

  const disabled = buildReceptionistPrompt(agent, { ...profile, holidaysEnabled: false, holidays: [{ id: "h1", name: "Thanksgiving", date: "2026-11-26", closed: true }] });
  assert.doesNotMatch(disabled, /Thanksgiving/);
});

test("an agent's own Business Profile replaces the workspace's - two agents in one workspace can be two different locations", () => {
  const maryland = {
    ...agent,
    configuration: {
      ...agent.configuration,
      greeting: "",
      allowCallTransfers: true,
      emergencyRules: [{ phrases: ["manager"], transferTarget: "" }],
      businessProfile: {
        businessName: "Arc Dental Maryland",
        timezone: "America/New_York",
        hours: "Tue-Thu, 9:00 AM-1:00 PM",
        serviceAreas: ["Bethesda, MD"],
        ownerPhone: "+13015550111",
      },
    },
  };
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: maryland,
    profile: { ...profile, serviceAreas: ["Charleston, SC"] },
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });

  assert.match(config.prompt, /the AI receptionist for Arc Dental Maryland/);
  assert.match(config.prompt, /Tue-Thu, 9:00 AM-1:00 PM/);
  assert.doesNotMatch(config.prompt, /Mon-Fri, 8:00 AM-5:00 PM/);
  assert.match(config.prompt, /Published coverage: Bethesda, MD/);
  assert.doesNotMatch(config.prompt, /Charleston/);
  // The rule has no number of its own, so it uses this agent's Default Transfer Number.
  assert.deepEqual(config.tools.filter((tool) => tool.type === "transfer_call").map((tool) => tool.transfer_destination.number), ["+13015550111"]);
  assert.match(config.prompt, /Address: 123 Main Street/);
  assert.match(resolveGreeting(maryland, profile), /^Thanks for calling Arc Dental Maryland\./);
});

test("the agent speaks its AI Voice Agent Name; agents saved before that field fall back to the Internal Name up to the first dash", () => {
  const named = (configuration) => ({ ...agent, name: "Samantha- CWR Inc", configuration: { ...agent.configuration, name: "Samantha- CWR Inc", greeting: "", ...configuration } });

  assert.equal(spokenAgentName(named({})), "Samantha");
  assert.equal(spokenAgentName(named({ spokenName: "Sam" })), "Sam");
  assert.equal(spokenAgentName(named({ spokenName: "   " })), "Samantha");
  assert.equal(spokenAgentName({ name: "Hailey", configuration: { name: "Hailey" } }), "Hailey");

  const prompt = buildReceptionistPrompt(named({ spokenName: "Sam" }), profile);
  assert.match(prompt, /You are Sam, the AI receptionist for Arc Dental/);
  assert.doesNotMatch(prompt, /CWR Inc/);
  assert.match(resolveGreeting(named({ spokenName: "Sam" }), profile), /This is Sam, the virtual receptionist/);
});

test("receptionist config: invocation-safe tools, end_call, call handling, and one warm transfer tool per rule", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent,
    profile,
    toolBaseUrl: "https://api.example.com/",
    voiceId: "retell-voice-1",
  });

  assert.equal(config.voice, "retell-voice-1");
  for (const tool of config.tools.filter((candidate) => candidate.type === "custom")) {
    assert.equal(tool.parameters.properties.workspaceId.const, "workspace-123");
    assert.equal(tool.parameters.properties.callId.const, "{{call_id}}");
    assert.match(tool.url, /^https:\/\/api\.example\.com\/retell\/tools\//);
  }
  assert.equal(config.tools.filter((tool) => tool.name === "end_call").length, 1);
  assert.equal(config.retellAgent.end_call_after_silence_ms, 60_000);
  assert.equal(config.retellAgent.max_call_duration_ms, 600_000);
  const transfers = config.tools.filter((tool) => tool.type === "transfer_call");
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0].transfer_destination, { type: "predefined", number: "+17035550102" });
  assert.deepEqual(transfers[0].transfer_option, { type: "warm_transfer", show_transferee_as_caller: false });
});

