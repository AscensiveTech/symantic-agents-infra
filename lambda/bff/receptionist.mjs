import { formatBusinessHours, isBusinessHours } from "./business-hours.mjs";

// Call-handling defaults + clamp bounds. Collected in the Symantic UI and passed
// straight through to Retell (end_call_after_silence_ms / max_call_duration_ms).
// Keep these identical to the frontend mirror in lib/domain/call-handling.ts.
export const CALL_HANDLING = {
  silence: { defaultSec: 60, minSec: 10, maxSec: 300 },
  maxDuration: { defaultMin: 10, minMin: 1, maxMin: 30 },
};

// Never surfaced in the UI - the agent nudges a silent caller once, then the
// silence timeout above ends the call.
const REMINDER_TRIGGER_MS = 8000;
const REMINDER_MAX_COUNT = 1;

const END_CALL_TOOL = {
  type: "end_call",
  name: "end_call",
  description:
    "End the call politely when the caller is clearly a recorded message, an automated "
    + "system / IVR, or a telemarketer working from a script - i.e. there is no genuine "
    + "back-and-forth. Do not use this on a hesitant or confused real caller.",
};

const SPAM_ANALYSIS_FIELD = {
  type: "boolean",
  name: "is_spam",
  description:
    "True if the caller was a robocall, automated system / IVR, or a telemarketer rather "
    + "than a genuine prospective or existing customer.",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Read the customer's call-handling settings off the agent config, applying
// defaults and clamping to the supported Retell range.
export function resolveCallHandling(agent) {
  const config = agent?.configuration ?? {};
  const silenceRaw = Number(config.silenceTimeoutSec);
  const maxRaw = Number(config.maxCallDurationMin);
  const silenceSec = Number.isFinite(silenceRaw)
    ? clamp(Math.round(silenceRaw), CALL_HANDLING.silence.minSec, CALL_HANDLING.silence.maxSec)
    : CALL_HANDLING.silence.defaultSec;
  const maxDurationMin = Number.isFinite(maxRaw)
    ? clamp(Math.round(maxRaw), CALL_HANDLING.maxDuration.minMin, CALL_HANDLING.maxDuration.maxMin)
    : CALL_HANDLING.maxDuration.defaultMin;
  return { silenceSec, maxDurationMin };
}

// ISO 3166-1 alpha-2 list of countries allowed to call the receptionist inbound.
// Empty = accept calls from anywhere (Retell's default).
export function resolveAllowedInboundCountries(agent) {
  const raw = agent?.configuration?.allowedInboundCountries;
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw
      .map((code) => (typeof code === "string" ? code.trim().toUpperCase() : ""))
      .filter((code) => /^[A-Z]{2}$/.test(code)),
  )];
}

function spamScreeningEnabled(agent) {
  return agent?.configuration?.spamScreening !== false;
}

const CALENDAR_TOOLS = [
  {
    name: "calendar_find_appointment",
    path: "/retell/tools/calendar.findAppointment",
    description:
      "Find the caller's existing appointment by caller phone and an optional date window before rescheduling or cancelling.",
    properties: {
      callerPhone: {
        type: "string",
        description: "Caller's phone number. Use the number on the call when available.",
      },
      startTime: {
        type: "string",
        description: "Optional start of the appointment search window.",
      },
      endTime: {
        type: "string",
        description: "Optional end of the appointment search window.",
      },
    },
    required: ["callerPhone"],
  },
  {
    name: "calendar_get_availability",
    path: "/retell/tools/calendar.getAvailability",
    description:
      "Check the connected business calendar before offering an appointment time.",
    properties: {
      startTime: {
        type: "string",
        description:
          "Requested ISO 8601 start time or a clear relative time such as tomorrow at 2 PM.",
      },
      endTime: {
        type: "string",
        description: "Optional ISO 8601 end time.",
      },
      durationMinutes: {
        type: "number",
        description: "Appointment duration in minutes when endTime is omitted.",
      },
    },
    required: ["startTime"],
  },
  {
    name: "calendar_create_booking",
    path: "/retell/tools/calendar.createBooking",
    description:
      "Create an appointment only after calendar_get_availability confirms the time is available and the caller confirms it.",
    properties: {
      startTime: {
        type: "string",
        description: "Confirmed ISO 8601 or relative appointment start time.",
      },
      endTime: {
        type: "string",
        description: "Optional ISO 8601 appointment end time.",
      },
      durationMinutes: {
        type: "number",
        description: "Appointment duration in minutes when endTime is omitted.",
      },
      service: {
        type: "string",
        description: "Service the caller is booking.",
      },
      description: {
        type: "string",
        description: "Short booking note with only information the caller supplied.",
      },
      customer: {
        type: "object",
        description: "Caller contact details.",
        properties: {
          name: { type: "string", description: "Caller name." },
          phone: { type: "string", description: "Caller phone number." },
          email: { type: "string", description: "Caller email address." },
        },
      },
    },
    required: ["startTime", "customer"],
  },
  {
    name: "calendar_reschedule_booking",
    path: "/retell/tools/calendar.rescheduleBooking",
    description:
      "Move an appointment returned by calendar_find_appointment after confirming the appointment and new time with the caller.",
    properties: {
      appointmentId: {
        type: "string",
        description: "Symantic appointment ID returned by a prior booking.",
      },
      startTime: {
        type: "string",
        description: "Confirmed new ISO 8601 or relative start time.",
      },
      endTime: {
        type: "string",
        description: "Optional new ISO 8601 end time.",
      },
      durationMinutes: {
        type: "number",
        description: "Appointment duration in minutes when endTime is omitted.",
      },
    },
    required: ["appointmentId", "startTime"],
  },
  {
    name: "calendar_cancel_booking",
    path: "/retell/tools/calendar.cancelBooking",
    description:
      "Cancel an appointment returned by calendar_find_appointment only after the caller confirms cancellation.",
    properties: {
      appointmentId: {
        type: "string",
        description: "Symantic appointment ID to cancel.",
      },
    },
    required: ["appointmentId"],
  },
];

const CORE_TOOLS = [
  {
    name: "lead_capture",
    path: "/retell/tools/lead.capture",
    description:
      "Capture a new caller or prospect for office follow-up when no appointment is booked.",
    properties: {
      name: { type: "string", description: "Caller name." },
      phone: { type: "string", description: "Caller phone number." },
      email: { type: "string", description: "Optional caller email address." },
      interest: {
        type: "string",
        description: "What the caller needs and any follow-up context.",
      },
    },
    required: ["name", "phone", "interest"],
  },
  {
    name: "message_take",
    path: "/retell/tools/message.take",
    description:
      "Take a message for the office when the request cannot be completed during the call.",
    properties: {
      name: { type: "string", description: "Caller name." },
      phone: { type: "string", description: "Caller phone number." },
      email: { type: "string", description: "Optional caller email address." },
      message: {
        type: "string",
        description: "Concise message in the caller's own meaning.",
      },
    },
    required: ["name", "phone", "message"],
  },
];

export function buildReceptionistPrompt(agent, profile) {
  const behavior = agent?.configuration ?? {};
  const faqs = Array.isArray(profile?.faqs) && profile.faqs.length
    ? profile.faqs
      .map(({ question, answer }) => `- Q: ${question}\n  A: ${answer}`)
      .join("\n")
    : "- No approved FAQs are configured. Take a message instead of guessing.";
  const intents = list(behavior.intents);
  const bookingInstruction = behavior.booking === true
    ? "Booking is enabled. Check availability before offering a time, and create a booking only after explicit caller confirmation."
    : "Booking is disabled. Do not promise or create appointments; take a message for office follow-up.";

  return [
    `You are ${text(behavior.name) || text(agent?.name) || "the AI receptionist"} for ${text(profile?.businessName) || "the business"}.`,
    `Speak in a ${text(behavior.tone) || text(profile?.communicationStyle) || "clear, professional"} style.`,
    "",
    "Business profile",
    `- Type: ${text(profile?.businessType) || "Not provided"}`,
    `- Services and business overview: ${text(profile?.description) || "Not provided"}`,
    `- Address: ${text(profile?.address) || "Not provided"}`,
    `- Timezone: ${text(profile?.timezone) || "UTC"}`,
    `- Hours: ${isBusinessHours(profile?.businessHours)
      ? formatBusinessHours(profile.businessHours)
      : (text(profile?.hours) || "Not provided")}`,
    "- Current local time at the start of this call: {{currentTime}} ({{timezone}}). "
      + "Treat this as the authoritative clock when the caller asks whether you are open right now.",
    "",
    "Approved caller intents",
    intents || "Use the approved FAQs and take a message for anything else.",
    "",
    "Approved answering guidance",
    text(behavior.guidance) || text(agent?.description) || "Answer only from the approved business information below.",
    "",
    "Policies",
    text(profile?.policies) || "No additional policies are configured.",
    "",
    "FAQs",
    faqs,
    "",
    "Booking",
    bookingInstruction,
    "",
    "Emergency and escalation rules",
    [
      formatEmergencyRules(behavior.emergencyRules),
      text(behavior.escalation),
    ].filter(Boolean).join("\n") ||
      "For emergencies or requests for a person, use the matching transfer_call tool. If transfer is unavailable, use message_take.",
    "",
    ...(spamScreeningEnabled(agent)
      ? [
        "Spam and robocall handling",
        "- If the caller is clearly a recording, an automated system, an IVR menu, or a "
        + "telemarketer reading a script (no real back-and-forth, ignores your questions, "
        + "repeats a pitch), say one brief polite line and call the end_call tool.",
        "- Be conservative. A slow, hesitant, or confused person is NOT spam - keep helping. "
        + "When unsure, continue the call.",
        "",
      ]
      : []),
    "Operating rules",
    "- Never invent business facts, prices, availability, medical advice, or policy.",
    "- Use only Symantic tool results as confirmation that an action completed.",
    "- Preserve the caller's meaning and collect the minimum information required.",
    "- If a tool fails, explain briefly and offer to take a message.",
  ].join("\n");
}

export function buildReceptionistConfig({
  workspaceId,
  agent,
  profile,
  toolBaseUrl,
  voiceId,
}) {
  const agentId = text(agent?.id) || text(agent?.agentId);
  if (!text(workspaceId) || !agentId) {
    throw new Error("workspaceId and Symantic agent id are required");
  }
  if (!text(toolBaseUrl)) throw new Error("toolBaseUrl is required");
  if (!text(voiceId)) throw new Error("Retell voice id is required");

  const bookingEnabled = agent?.configuration?.booking === true;
  const definitions = bookingEnabled
    ? [...CALENDAR_TOOLS, ...CORE_TOOLS]
    : CORE_TOOLS;
  const transferDefinitions = buildTransferTools(agent, profile);
  const callHandling = resolveCallHandling(agent);
  return {
    prompt: buildReceptionistPrompt(agent, profile),
    tools: [
      ...definitions.map((definition) =>
        toRetellTool(definition, {
          workspaceId,
          agentId,
          toolBaseUrl,
        })
      ),
      ...transferDefinitions,
      ...(spamScreeningEnabled(agent) ? [END_CALL_TOOL] : []),
    ],
    voice: voiceId,
    transferNumbers: transferDefinitions.map(
      ({ transfer_destination }) => transfer_destination.number,
    ),
    bookingEnabled,
    // Agent-level Retell settings, spread into the create/update-agent body.
    retellAgent: {
      end_call_after_silence_ms: callHandling.silenceSec * 1000,
      max_call_duration_ms: callHandling.maxDurationMin * 60_000,
      reminder_trigger_ms: REMINDER_TRIGGER_MS,
      reminder_max_count: REMINDER_MAX_COUNT,
      post_call_analysis_data: [SPAM_ANALYSIS_FIELD],
    },
    allowedInboundCountries: resolveAllowedInboundCountries(agent),
  };
}

function toRetellTool(definition, {
  workspaceId,
  agentId,
  toolBaseUrl,
}) {
  const commonProperties = {
    workspaceId: {
      type: "string",
      const: workspaceId,
    },
    agentId: {
      type: "string",
      const: agentId,
    },
    callId: {
      type: "string",
      const: "{{call_id}}",
    },
  };
  return {
    type: "custom",
    name: definition.name,
    description: definition.description,
    url: `${toolBaseUrl.replace(/\/+$/, "")}${definition.path}`,
    method: "POST",
    parameters: {
      type: "object",
      properties: {
        ...commonProperties,
        ...definition.properties,
      },
      required: [
        "workspaceId",
        "agentId",
        "callId",
        ...definition.required,
      ],
    },
    speak_during_execution: true,
    speak_after_execution: true,
    timeout_ms: 10_000,
    max_retry: 1,
  };
}

function buildTransferTools(agent, profile) {
  const rules = Array.isArray(agent?.configuration?.emergencyRules)
    ? agent.configuration.emergencyRules
    : [];
  const destinations = [
    ...rules.flatMap((rule) => {
      const number = toE164(rule?.transferTarget);
      if (!number) return [];
      const phrases = Array.isArray(rule?.phrases)
        ? rule.phrases.map(text).filter(Boolean)
        : [];
      return [{
        number,
        description: phrases.length
          ? `Warm transfer when the caller mentions ${phrases.join(", ")}.`
          : "Warm transfer for this configured emergency rule.",
      }];
    }),
    ...[
      profile?.escalationContact,
      profile?.ownerPhone,
      profile?.fallbackPhone,
    ].flatMap((value) => {
      const number = toE164(value);
      return number
        ? [{ number, description: "Warm transfer for escalation or a request for a person." }]
        : [];
    }),
  ];
  const uniqueDestinations = destinations.filter(
    ({ number }, index) =>
      destinations.findIndex((candidate) => candidate.number === number) === index,
  );
  return uniqueDestinations.map(({ number, description }, index) => ({
    type: "transfer_call",
    name: `transfer_call_${index + 1}`,
    description,
    transfer_destination: {
      type: "predefined",
      number,
    },
    transfer_option: {
      type: "warm_transfer",
      show_transferee_as_caller: false,
    },
    speak_during_execution: true,
    execution_message_type: "static_text",
    execution_message_description: "Please hold while I connect you.",
  }));
}

export function resolveConfiguredVoiceId(configuration, resolveVoiceId) {
  if (configuration?.voiceMode === "cloned") {
    const cloned = text(configuration.voiceId);
    if (cloned) return cloned;
  }
  return resolveVoiceId(configuration?.voice);
}

function formatEmergencyRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  return rules.flatMap((rule) => {
    const phrases = Array.isArray(rule?.phrases)
      ? rule.phrases.map(text).filter(Boolean)
      : [];
    const target = text(rule?.transferTarget);
    if (!phrases.length || !target) return [];
    return [
      `- If the caller mentions ${phrases.map((phrase) => `"${phrase}"`).join(", ")}: transfer to ${target}.`,
    ];
  }).join("\n");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean).map((item) => `- ${item}`).join("\n")
    : "";
}

function toE164(value) {
  const raw = text(value);
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
