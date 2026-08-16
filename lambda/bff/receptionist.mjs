const CALENDAR_TOOLS = [
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
      "Move an existing appointment after confirming its appointment ID and a new time with the caller.",
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
      "Cancel an existing appointment only after the caller confirms cancellation.",
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
  {
    name: "call_transfer",
    path: "/retell/tools/call.transfer",
    description:
      "Resolve the approved transfer destination for emergencies, escalations, or a caller asking for a person.",
    properties: {
      reason: {
        type: "string",
        description: "Why the caller needs a transfer.",
      },
    },
    required: ["reason"],
  },
];

export function buildReceptionistPrompt(agent, profile) {
  const behavior = agent?.configuration ?? {};
  const faqs = Array.isArray(profile?.faqs) && profile.faqs.length
    ? profile.faqs
      .map(({ question, answer }) => `- Q: ${question}\n  A: ${answer}`)
      .join("\n")
    : "- No approved FAQs are configured. Take a message instead of guessing.";
  const services = list(profile?.services);
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
    `- Description: ${text(profile?.description) || "Not provided"}`,
    `- Address: ${text(profile?.address) || "Not provided"}`,
    `- Timezone: ${text(profile?.timezone) || "UTC"}`,
    `- Hours: ${text(profile?.hours) || "Not provided"}`,
    `- Services: ${services || "Not provided"}`,
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
    text(behavior.escalation) ||
      "For emergencies or requests for a person, use call_transfer. If transfer is unavailable, use message_take.",
    "",
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
  return {
    prompt: buildReceptionistPrompt(agent, profile),
    tools: definitions.map((definition) =>
      toRetellTool(definition, {
        workspaceId,
        agentId,
        toolBaseUrl,
      })
    ),
    voice: voiceId,
    transferNumbers: unique([
      profile?.escalationContact,
      profile?.ownerPhone,
      profile?.fallbackPhone,
    ]),
    bookingEnabled,
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
    idempotencyKey: {
      type: "string",
      const: `{{call_id}}-${definition.name}`,
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
        "idempotencyKey",
        ...definition.required,
      ],
    },
    speak_during_execution: true,
    speak_after_execution: true,
    timeout_ms: 10_000,
    max_retry: 1,
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean).map((item) => `- ${item}`).join("\n")
    : "";
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}
