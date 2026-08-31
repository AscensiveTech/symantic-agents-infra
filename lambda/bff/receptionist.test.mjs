import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReceptionistConfig,
  buildReceptionistPrompt,
  resolveConfiguredVoiceId,
} from "./receptionist.mjs";

const profile = {
  businessName: "Arc Dental",
  businessType: "dental practice",
  description: "Family dentistry",
  address: "123 Main Street",
  timezone: "America/New_York",
  hours: "Mon-Fri, 8:00 AM-5:00 PM",
  services: ["Cleanings", "Emergency exams"],
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
    guidance: "Never provide a diagnosis or promise insurance coverage.",
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
  assert.match(prompt, /Do you accept insurance\?/);
  assert.match(prompt, /Yes, most PPO plans\./);
  assert.match(prompt, /Do you see children\?/);
  assert.match(prompt, /severe bleeding or trouble breathing/);
  assert.match(prompt, /chest pain/);
  assert.match(prompt, /can't breathe/);
  assert.match(prompt, /\+17035550102/);
});

test("prompt prefers structured business hours and always carries the call clock", () => {
  const structured = buildReceptionistPrompt(agent, {
    ...profile,
    hours: "ignored free text",
    businessHours: {
      mon: { closed: false, open: "08:00", close: "17:00" },
      tue: { closed: false, open: "08:00", close: "17:00" },
      wed: { closed: false, open: "08:00", close: "17:00" },
      thu: { closed: false, open: "08:00", close: "17:00" },
      fri: { closed: false, open: "08:00", close: "17:00" },
      sat: { closed: false, open: "09:00", close: "13:00" },
      sun: { closed: true, open: "09:00", close: "13:00" },
    },
  });

  assert.match(structured, /Mon–Fri 8:00 AM–5:00 PM, Sat 9:00 AM–1:00 PM, Sun closed/);
  assert.doesNotMatch(structured, /ignored free text/);
  assert.match(structured, /\{\{currentTime\}\} \(\{\{timezone\}\}\)/);
  assert.match(structured, /whether you are open right now/);

  const fallback = buildReceptionistPrompt(agent, { ...profile, businessHours: { mon: "bad" } });
  assert.match(fallback, /Mon-Fri, 8:00 AM-5:00 PM/);
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
});
