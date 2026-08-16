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

test("receptionist config exposes every Task 7 tool URL and transfer policy", () => {
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
    "+17035550199",
    "+17035550100",
    "+17035550188",
  ]);
  assert.deepEqual(
    config.tools.map(({ url }) => url),
    [
      "https://api.example.com/retell/tools/calendar.getAvailability",
      "https://api.example.com/retell/tools/calendar.createBooking",
      "https://api.example.com/retell/tools/calendar.rescheduleBooking",
      "https://api.example.com/retell/tools/calendar.cancelBooking",
      "https://api.example.com/retell/tools/lead.capture",
      "https://api.example.com/retell/tools/message.take",
      "https://api.example.com/retell/tools/call.transfer",
    ],
  );
  for (const tool of config.tools) {
    assert.equal(tool.parameters.properties.workspaceId.const, "workspace-123");
    assert.equal(tool.parameters.properties.callId.const, "{{call_id}}");
    assert.match(
      tool.parameters.properties.idempotencyKey.const,
      /^\{\{call_id\}\}-/,
    );
  }
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
  assert.deepEqual(
    config.tools.map(({ name }) => name),
    ["lead_capture", "message_take", "call_transfer"],
  );
});
