import assert from "node:assert/strict";
import test from "node:test";

import {
  CALL_HANDLING,
  buildReceptionistConfig,
  buildReceptionistPrompt,
  resolveAllowedInboundCountries,
  resolveCallHandling,
  resolveConfiguredVoiceId,
  resolveGreeting,
  resolveLanguage,
  resolvePauseBeforeSpeakingMs,
  resolveStartSpeaker,
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

test("prompt builder includes hours, FAQs, and emergency rules", () => {
  const prompt = buildReceptionistPrompt(agent, profile);

  assert.match(prompt, /Mon-Fri, 8:00 AM-5:00 PM/);
  assert.match(prompt, /- Services and business overview: Family dentistry/);
  assert.doesNotMatch(prompt, /^- Description:/m);
  assert.doesNotMatch(prompt, /^- Services:/m);
  assert.match(prompt, /Do you accept insurance\?/);
  assert.match(prompt, /Yes, most PPO plans\./);
  assert.match(prompt, /Do you see children\?/);
  assert.match(prompt, /severe bleeding or trouble breathing/);
  assert.match(prompt, /chest pain/);
  assert.match(prompt, /can't breathe/);
  assert.match(prompt, /# ROLE AND APPROACH\nYou are the front-desk receptionist for a dental clinic\./);
  assert.match(prompt, /# RESTRICTIONS - WHAT NOT TO SAY OR DO\nNever provide a diagnosis or promise insurance coverage\./);
  assert.match(prompt, /\+17035550102/);
});

test("Restrictions section is omitted entirely when the receptionist has none configured", () => {
  const noRestrictions = {
    ...agent,
    configuration: { ...agent.configuration, restrictions: "" },
  };
  const prompt = buildReceptionistPrompt(noRestrictions, profile);

  assert.doesNotMatch(prompt, /# RESTRICTIONS - WHAT NOT TO SAY OR DO/);
  assert.match(prompt, /# ROLE AND APPROACH\nYou are the front-desk receptionist for a dental clinic\./);
});

test("a 'decline' emergency rule tells the agent to say a message instead of transferring", () => {
  const declineAgent = {
    ...agent,
    configuration: {
      ...agent.configuration,
      emergencyRules: [
        { phrases: ["fire", "smoke"], action: "decline", message: "We're sorry, we can't help with that. Please call 911." },
        { phrases: ["chest pain"], transferTarget: "+17035550102" },
      ],
    },
  };
  const prompt = buildReceptionistPrompt(declineAgent, profile);

  assert.match(prompt, /fire.*smoke.*say "We're sorry, we can't help with that\. Please call 911\."/s);
  assert.match(prompt, /do not transfer/);
  assert.match(prompt, /chest pain.*transfer to \+17035550102/s);
});

test("prompt always instructs honesty about being an AI - never claim to be human", () => {
  const prompt = buildReceptionistPrompt(agent, profile);
  assert.match(prompt, /always answer honestly.*yes, you are an AI voice agent/is);
  assert.match(prompt, /Never claim to be human/);
});

test("prompt carries spam / robocall handling rules by default and drops them when screening is off", () => {
  const withScreening = buildReceptionistPrompt(agent, profile);
  assert.match(withScreening, /# SPAM & ROBOCALLS/);
  assert.match(withScreening, /telemarketer reading a script/);
  assert.match(withScreening, /call the end_call tool/);

  const off = buildReceptionistPrompt(
    { ...agent, configuration: { ...agent.configuration, spamScreening: false } },
    profile,
  );
  assert.doesNotMatch(off, /# SPAM & ROBOCALLS/);
});

test("prompt follows the ROLE / CRITICAL RULES / ONE THING AT A TIME structure and carries the new behavioral sections", () => {
  const prompt = buildReceptionistPrompt(agent, profile);

  assert.match(prompt, /^# ROLE\n/);
  assert.match(prompt, /# CRITICAL RULES/);
  assert.match(prompt, /Never confirm a booking, callback, or any other action until the matching Symantic tool has actually returned success/);
  assert.match(prompt, /# ONE THING AT A TIME/);
  assert.match(prompt, /Never ask two questions in the same turn/);
  assert.match(prompt, /# LIVE PERSON REQUESTS/);
  assert.match(prompt, /# OFF-TOPIC, ABUSE & NONSENSE/);
  assert.match(prompt, /Abuse, insults, or gibberish\/nonsense speech: don't engage, argue, or match their tone/);
  assert.match(prompt, /Off-topic requests .*give one polite redirect/);
  assert.match(prompt, /# CLOSING/);
  assert.match(prompt, /wait for a real answer - hesitation .*is not a no/);
});

test("prompt always instructs the AI-disclosure rule as part of CRITICAL RULES", () => {
  const prompt = buildReceptionistPrompt(agent, profile);
  assert.match(prompt, /# CRITICAL RULES[\s\S]*always answer honestly.*yes, you are an AI voice agent/);
  assert.match(prompt, /Never claim to be human/);
});

test("a 'decline' emergency rule's transferTarget never becomes a transfer_call tool, even if it looks like a valid phone number", () => {
  const declineAgent = {
    ...agent,
    configuration: {
      ...agent.configuration,
      emergencyRules: [
        { phrases: ["talk to a human"], action: "decline", transferTarget: "+17035550102", message: "We'll call you back." },
      ],
    },
  };
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent: declineAgent,
    profile,
    toolBaseUrl: "https://api.example.com",
    voiceId: "retell-voice-1",
  });
  // "+17035550102" is the decline rule's own transferTarget - it must never
  // appear as a transfer destination. profile still legitimately contributes
  // its own 3 (escalationContact, ownerPhone, fallbackPhone).
  assert.ok(!config.transferNumbers.includes("+17035550102"));
  assert.equal(config.tools.filter(({ type }) => type === "transfer_call").length, 3);
});

test("resolveGreeting uses the configured greeting when set, otherwise builds one from the real business/receptionist name", () => {
  assert.equal(resolveGreeting(agent, profile), agent.configuration.greeting);
  assert.equal(
    resolveGreeting({ ...agent, configuration: { ...agent.configuration, greeting: "" } }, profile),
    "Thanks for calling Arc Dental. I'm Maya. How can I help today?",
  );
  assert.equal(
    resolveGreeting({ ...agent, configuration: { ...agent.configuration, greeting: "  " } }, { ...profile, businessName: "" }),
    "Thanks for calling the business. I'm Maya. How can I help today?",
  );
  assert.equal(
    resolveGreeting({ configuration: {} }, { businessName: "Rivertown Plumbing" }),
    "Thanks for calling Rivertown Plumbing. I'm the AI voice agent. How can I help today?",
  );
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

test("prompt prefers structured business hours (with split intervals) and carries the call clock", () => {
  const open = (intervals) => ({ closed: false, intervals });
  const structured = buildReceptionistPrompt(agent, {
    ...profile,
    hours: "ignored free text",
    businessHours: {
      mon: open([{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }]),
      tue: open([{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }]),
      wed: open([{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }]),
      thu: open([{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }]),
      fri: open([{ open: "08:00", close: "12:00" }, { open: "13:00", close: "17:00" }]),
      sat: open([{ open: "09:00", close: "13:00" }]),
      sun: { closed: true, intervals: [{ open: "09:00", close: "13:00" }] },
    },
  });

  assert.match(
    structured,
    /Mon–Fri 8:00 AM–12:00 PM, 1:00 PM–5:00 PM; Sat 9:00 AM–1:00 PM; Sun closed/,
  );
  assert.doesNotMatch(structured, /ignored free text/);
  assert.match(structured, /\{\{currentTime\}\} \(\{\{timezone\}\}\)/);
  assert.match(structured, /whether you are open right now/);

  const fallback = buildReceptionistPrompt(agent, { ...profile, businessHours: { mon: "bad" } });
  assert.match(fallback, /Mon-Fri, 8:00 AM-5:00 PM/);
});

test("prompt includes configured holiday closures, contact emails, and service area coverage", () => {
  const withAll = buildReceptionistPrompt(agent, {
    ...profile,
    holidays: [
      { id: "h1", name: "Thanksgiving", date: "2026-11-26", closed: true },
      { id: "h2", name: "Not Closed", date: "2026-12-01", closed: false },
    ],
    contactEmails: [
      { label: "Billing / AR", email: "billing@example.com" },
      { label: "", email: "info@example.com" },
    ],
    serviceAreas: ["Maryland", "Washington D.C."],
  });

  assert.match(withAll, /Holiday closures: Thanksgiving \(2026-11-26\)/);
  assert.doesNotMatch(withAll, /Not Closed/);
  assert.match(withAll, /# CONTACT EMAILS/);
  assert.match(withAll, /Billing \/ AR: billing@example\.com/);
  assert.match(withAll, /- info@example\.com/);
  assert.match(withAll, /# SERVICE AREA/);
  assert.match(withAll, /Published coverage: Maryland, Washington D\.C\./);

  const withNone = buildReceptionistPrompt(agent, profile);
  assert.doesNotMatch(withNone, /Holiday closures:/);
  assert.doesNotMatch(withNone, /# CONTACT EMAILS/);
  assert.doesNotMatch(withNone, /# SERVICE AREA/);
});

test("prompt renders configured appointment types by name, duration, and lead time only - never the before/after buffers", () => {
  const withTypes = buildReceptionistPrompt({
    ...agent,
    configuration: {
      ...agent.configuration,
      appointmentTypes: [
        { id: "t1", name: "Quick Call", durationMin: 15, minimumLeadTimeMin: 60, blockBeforeMin: 0, blockAfterMin: 0, happensAtCustomerLocation: false },
        { id: "t2", name: "On-Site Visit", durationMin: 30, minimumLeadTimeMin: 1440, blockBeforeMin: 60, blockAfterMin: 60, happensAtCustomerLocation: true },
        { id: "t3", name: "No Restriction", durationMin: 45, minimumLeadTimeMin: 0 },
      ],
    },
  }, profile);

  assert.match(withTypes, /# APPOINTMENT TYPES/);
  assert.match(withTypes, /Quick Call \(15 minutes, must be booked at least 1 hour in advance\)/);
  assert.match(withTypes, /On-Site Visit \(30 minutes, must be booked at least 24 hours in advance\)/);
  assert.match(withTypes, /No Restriction \(45 minutes\)$/m);
  const typesSection = withTypes.split("# APPOINTMENT TYPES")[1].split("\n\n")[0];
  assert.doesNotMatch(typesSection, /\b60\b/); // no raw buffer minutes ever rendered
  assert.doesNotMatch(typesSection, /blockBefore|blockAfter/i);

  const withNone = buildReceptionistPrompt(agent, profile);
  assert.doesNotMatch(withNone, /# APPOINTMENT TYPES/);
});

test("prompt renders Example Dialogues after Restrictions, and Final Reminders last (deliberately, for the recency effect)", () => {
  const withBoth = buildReceptionistPrompt({
    ...agent,
    configuration: {
      ...agent.configuration,
      exampleDialogues: "Caller: Hi, do you have any openings?\nYou: We do - what day works for you?",
      finalReminders: "- Never guess.\n- Wait for the caller to finish before closing.",
    },
  }, profile);

  assert.match(withBoth, /# EXAMPLE DIALOGUES/);
  assert.match(withBoth, /Caller: Hi, do you have any openings\?/);
  assert.match(withBoth, /# FINAL REMINDERS/);
  assert.match(withBoth, /- Never guess\./);

  // Restrictions -> Example Dialogues -> ... -> Final Reminders, in that order
  assert.ok(withBoth.indexOf("# RESTRICTIONS") < withBoth.indexOf("# EXAMPLE DIALOGUES"));
  assert.ok(withBoth.indexOf("# FINAL REMINDERS") > withBoth.lastIndexOf("# CLOSING"));
  // Final Reminders is the very last section in the whole prompt
  assert.ok(withBoth.trimEnd().endsWith("Wait for the caller to finish before closing."));

  const withNeither = buildReceptionistPrompt(agent, profile);
  assert.doesNotMatch(withNeither, /# EXAMPLE DIALOGUES/);
  assert.doesNotMatch(withNeither, /# FINAL REMINDERS/);
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

test("receptionist config exposes lookup tools, invocation-safe functions, and native warm transfer", () => {
  const config = buildReceptionistConfig({
    workspaceId: "workspace-123",
    agent,
    profile,
    toolBaseUrl: "https://api.example.com/",
    voiceId: "retell-voice-1",
  });

  assert.equal(config.voice, "retell-voice-1");
  assert.equal(config.bookingEnabled, true);
  assert.deepEqual(config.transferNumbers, [
    "+17035550102",
    "+17035550199",
    "+17035550100",
    "+17035550188",
  ]);
  const customTools = config.tools.filter(({ type }) => type === "custom");
  assert.deepEqual(
    customTools.map(({ url }) => url),
    [
      "https://api.example.com/retell/tools/calendar.findAppointment",
      "https://api.example.com/retell/tools/calendar.getAvailability",
      "https://api.example.com/retell/tools/calendar.createBooking",
      "https://api.example.com/retell/tools/calendar.rescheduleBooking",
      "https://api.example.com/retell/tools/calendar.cancelBooking",
      "https://api.example.com/retell/tools/lead.capture",
      "https://api.example.com/retell/tools/message.take",
    ],
  );
  for (const tool of customTools) {
    assert.equal(tool.parameters.properties.workspaceId.const, "workspace-123");
    assert.equal(tool.parameters.properties.callId.const, "{{call_id}}");
    assert.equal(tool.parameters.properties.idempotencyKey, undefined);
    assert.ok(!tool.parameters.required.includes("idempotencyKey"));
  }
  const endCall = config.tools.filter(({ type }) => type === "end_call");
  assert.equal(endCall.length, 1);
  assert.equal(endCall[0].name, "end_call");

  assert.equal(config.retellAgent.end_call_after_silence_ms, 60_000);
  assert.equal(config.retellAgent.max_call_duration_ms, 600_000);
  assert.deepEqual(config.retellAgent.post_call_analysis_data, [
    { type: "boolean", name: "is_spam", description: config.retellAgent.post_call_analysis_data[0].description },
  ]);
  assert.match(config.retellAgent.post_call_analysis_data[0].description, /robocall|telemarketer/i);
  assert.deepEqual(config.allowedInboundCountries, []);

  const transferTools = config.tools.filter(({ type }) => type === "transfer_call");
  assert.equal(transferTools.length, 4);
  assert.deepEqual(transferTools[0].transfer_destination, {
    type: "predefined",
    number: "+17035550102",
  });
  assert.deepEqual(transferTools[0].transfer_option, {
    type: "warm_transfer",
    show_transferee_as_caller: false,
  });
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
