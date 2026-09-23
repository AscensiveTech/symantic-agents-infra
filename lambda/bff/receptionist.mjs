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
    "End the call politely once the conversation has clearly and naturally concluded - the "
    + "caller has said goodbye, confirmed there's nothing else they need, or is clearly a "
    + "recorded message, an automated system / IVR, or a telemarketer working from a script. "
    + "Do not use this on a hesitant or confused real caller, or to cut a caller off mid-request.",
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
        description: "Appointment duration in minutes when endTime is omitted and no appointmentType is given.",
      },
      appointmentType: {
        type: "string",
        description:
          "Name of one of this agent's configured appointment types, exactly as listed in # APPOINTMENT TYPES - "
          + "when given, its Duration and Minimum Lead Time are authoritative and durationMinutes is ignored.",
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
        description: "Appointment duration in minutes when endTime is omitted and no appointmentType is given.",
      },
      appointmentType: {
        type: "string",
        description:
          "Name of one of this agent's configured appointment types, exactly as listed in # APPOINTMENT TYPES - "
          + "when given, its Duration and Minimum Lead Time are authoritative and durationMinutes is ignored.",
      },
      service: {
        type: "string",
        description: "Service the caller is booking - omit when appointmentType is given, since its name is used instead.",
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

// Only built (and only registered as a tool) when the business has
// actually configured a service area - the whole list travels with the
// tool definition itself as a `const` property, the same way
// toRetellTool() already bakes workspaceId/agentId/callId in as consts.
// No database access at call time: zero added latency, zero added
// infra, pure string comparison in the handler. Editing the list already
// requires a republish to reach a live agent, same as every other
// configuration field.
function buildServiceAreaTool(profile) {
  const serviceAreas = Array.isArray(profile?.serviceAreas)
    ? profile.serviceAreas.map(text).filter(Boolean)
    : [];
  if (!serviceAreas.length) return null;
  return {
    name: "check_service_area",
    path: "/retell/tools/service-area.check",
    description:
      "Check whether a location the caller mentioned is in the published service area list - call this "
      + "before relying on your own judgment, whenever a caller states a city, region, or ZIP code.",
    properties: {
      location: {
        type: "string",
        description: "The city, region, or ZIP code the caller mentioned.",
      },
      serviceAreas: { type: "string", const: JSON.stringify(serviceAreas) },
    },
    required: ["location", "serviceAreas"],
  };
}

// The greeting the receptionist speaks first. Uses the configured Custom
// Greeting Message when the customer has set one; otherwise builds one from
// the real business/receptionist name rather than ever sending a blank or
// placeholder greeting live.
export function resolveGreeting(agent, profile) {
  const configured = text(agent?.configuration?.greeting);
  if (configured) return configured;
  const businessName = text(profile?.businessName) || "the business";
  const receptionistName = text(agent?.configuration?.name) || text(agent?.name) || "the AI voice agent";
  const disclosure = agent?.configuration?.recordingDisclosure
    ? " This call may be recorded for quality assurance."
    : "";
  return `Thanks for calling ${businessName}.${disclosure} We are currently away from our desk, likely at a job site. So, we have tasked our virtual receptionist, ${receptionistName}, to assist you while we are unable to do so. How can we help you today?`;
}

export function buildReceptionistPrompt(agent, profile) {
  const behavior = agent?.configuration ?? {};
  const businessName = text(profile?.businessName) || "the business";
  const receptionistName = text(behavior.name) || text(agent?.name) || "the AI voice agent";
  const tone = text(behavior.tone) || text(profile?.communicationStyle) || "clear, professional";
  const faqs = Array.isArray(profile?.faqs) && profile.faqs.length
    ? profile.faqs
      .map(({ question, answer }) => `- Q: ${question}\n  A: ${answer}`)
      .join("\n")
    : "- No approved FAQs are configured. Take a message instead of guessing.";
  const intents = list(behavior.intents);
  const hoursLine = isBusinessHours(profile?.businessHours)
    ? formatBusinessHours(profile.businessHours)
    : (text(profile?.hours) || "Not provided");
  const holidaysLine = formatHolidayClosures(profile?.holidays);
  const contactEmailsLine = formatContactEmails(profile?.contactEmails);
  const serviceAreaLine = formatServiceAreas(profile?.serviceAreas);
  const bookingInstruction = behavior.booking === true
    ? "Booking is enabled. Check availability before offering a time, and create a booking only after explicit caller confirmation."
    : "Booking is disabled. Do not promise or create appointments; take a message for office follow-up.";
  // A Cal.com agent books into the event types it chose there, which
  // replace its own Appointment Types (Cal.com enforces notice and buffers).
  const usesCalCom = Array.isArray(behavior.connections) && behavior.connections.includes("cal-com");
  const appointmentTypesLine = usesCalCom
    ? formatCalComEventTypes(behavior.calComEventTypes)
    : formatAppointmentTypes(behavior.appointmentTypes);
  const allowCallTransfers = behavior.allowCallTransfers !== false;
  const emergencyRules = formatEmergencyRules(behavior.emergencyRules);
  const noTransferPhrasesLine = formatNoTransferPhrases(behavior.noTransferPhrases);
  const escalation = text(behavior.escalation);
  const exampleDialogues = text(behavior.exampleDialogues);
  const finalReminders = text(behavior.finalReminders);

  return [
    "# ROLE",
    `You are ${receptionistName}, the AI voice agent for ${businessName}. `
      + `Speak in a ${tone} style. Answer questions and take messages or bookings - calm, `
      + "helpful, and honest.",
    "",
    "# CRITICAL RULES",
    "1) Never invent business facts, prices, availability, medical advice, or policy - "
      + "answer only from the approved information below. If you don't know, take a message.",
    "2) Never confirm a booking, callback, or any other action until the matching Symantic "
      + "tool has actually returned success - state the exact result the tool gives back. "
      + "Never fabricate a confirmation.",
    "3) If a tool fails, say so briefly and offer to take a message or try again. Never "
      + "pretend it worked.",
    "4) If asked whether you are an AI, a bot, or a real person, always answer honestly - "
      + "yes, you are an AI voice agent. Never claim to be human. Say so plainly and "
      + "briefly, then keep helping with their call.",
    "5) Preserve the caller's meaning and collect only the minimum information required - "
      + "never interrogate or run a checklist.",
    "6) For a genuine life-threatening emergency, tell the caller to call 911 (or their "
      + "local emergency number) right away. Say this immediately, before gathering any "
      + "routine details. Then take a message so the business knows the call came in - this "
      + "is separate from a caller simply asking to talk to a person, which the rules below "
      + "handle instead.",
    "",
    "# ONE THING AT A TIME",
    "- Never ask two questions in the same turn, and never open a new question while an "
      + "earlier one is unanswered.",
    "- If the caller asks about something specific, resolve that first before asking "
      + "anything new - never answer a question with a question.",
    "- Don't narrate your process out loud (\"let me check that\", \"I'd need to look "
      + "into it\") - just do it and report what comes back.",
    "",
    "# BUSINESS INFO",
    `- Services and business overview: ${text(profile?.description) || "Not provided"}`,
    `- Address: ${text(profile?.address) || "Not provided"}`,
    `- Timezone: ${text(profile?.timezone) || "UTC"}`,
    `- Hours: ${hoursLine}`,
    ...(holidaysLine ? [`- Holiday closures: ${holidaysLine}`] : []),
    "- Current local time at the start of this call: {{currentTime}} ({{timezone}}). "
      + "Treat this as the authoritative clock when the caller asks whether you are open right now.",
    ...(contactEmailsLine ? ["", "# CONTACT EMAILS", contactEmailsLine] : []),
    ...(serviceAreaLine
      ? [
        "",
        "# SERVICE AREA",
        `Published coverage: ${serviceAreaLine}`,
        "- The moment a caller states a city, region, or ZIP code, call check_service_area with it "
          + "before deciding anything yourself. If it comes back matched, say the location is within "
          + "the service area and the team will confirm the exact address. If it comes back "
          + "unmatched, fall back to your own judgment using the rules below - an unmatched result "
          + "isn't a refusal, just means nothing on the list was an exact/near-exact hit.",
        "- If a caller's location matches or is near one of these areas, say it's likely within the "
          + "service area and that the team will confirm the exact address.",
        "- If it's outside these areas, don't refuse - say it's outside the generally published "
          + "service area, but offer to take their details so the team can confirm.",
        "- Never guarantee coverage for an exact address, quote a mileage/travel-time radius, or "
          + "guess which office serves a location.",
      ]
      : []),
    "",
    "# APPROVED CALLER INTENTS",
    intents || "Use the approved FAQs and take a message for anything else.",
    "",
    "# ROLE AND APPROACH",
    text(behavior.roleInstructions) || text(agent?.description) || "Answer only from the approved business information below.",
    "",
    ...(text(behavior.restrictions)
      ? ["# RESTRICTIONS - WHAT NOT TO SAY OR DO", text(behavior.restrictions), ""]
      : []),
    ...(exampleDialogues
      ? [
        "# EXAMPLE DIALOGUES",
        "These are illustrative only - match this tone and approach, but never read them aloud "
          + "verbatim or treat their specifics (names, dates, numbers) as real.",
        exampleDialogues,
        "",
      ]
      : []),
    "# POLICIES",
    text(profile?.policies) || "No additional policies are configured.",
    "",
    "# KNOWLEDGE BASE / FAQS",
    faqs,
    "",
    "# BOOKING",
    bookingInstruction,
    ...(appointmentTypesLine ? ["", "# APPOINTMENT TYPES", appointmentTypesLine] : []),
    "",
    "# TALK TO A HUMAN",
    allowCallTransfers
      ? [emergencyRules, escalation].filter(Boolean).join("\n") ||
        "For a request to speak with a person, use the matching transfer_call tool. If transfer is unavailable, use message_take."
      : [
        NO_TRANSFER_FIXED_LINE,
        noTransferPhrasesLine ? `Example phrases a caller might use to ask for a person (not a strict match list, act on any request for a person the same way): ${noTransferPhrasesLine}` : "",
      ].filter(Boolean).join("\n"),
    "",
    "# LIVE PERSON REQUESTS",
    allowCallTransfers
      ? "- If the caller asks for a specific person, a manager, or to speak with \"someone\", "
        + "don't guess or state who does or doesn't work here. Use the matching transfer_call "
        + "tool from the rules above, or a configured escalation contact; otherwise let them "
        + "know everyone is currently unavailable and offer to take a message so the office "
        + "can follow up."
      : `- If the caller asks for a specific person, a manager, or to speak with "someone", ${NO_TRANSFER_FIXED_LINE}`,
    "",
    ...(spamScreeningEnabled(agent)
      ? [
        "# SPAM & ROBOCALLS",
        "- If the caller is clearly a recording, an automated system, an IVR menu, or a "
        + "telemarketer reading a script (no real back-and-forth, ignores your questions, "
        + "repeats a pitch), say one brief polite line and call the end_call tool.",
        "- Be conservative. A slow, hesitant, or confused person is NOT spam - keep helping. "
        + "When unsure, continue the call.",
        "",
      ]
      : []),
    "# OFF-TOPIC, ABUSE & NONSENSE",
    `- Stay on topic: only discuss ${businessName}, its services, and appointments.`,
    "- Off-topic requests (weather, news, trivia, or anything unrelated): give one polite "
      + "redirect back to how you can help. If it continues, end the call politely with the "
      + "end_call tool.",
    "- Abuse, insults, or gibberish/nonsense speech: don't engage, argue, or match their "
      + "tone. Give one calm redirect; if it continues, end the call politely with the "
      + "end_call tool.",
    "",
    "# CLOSING",
    "- Before ending the call, ask if there's anything else you can help with, and wait "
      + "for a real answer - hesitation (\"well...\", \"um...\", a pause) is not a no.",
    "- Once the caller has said goodbye, confirmed there's nothing else they need, or the "
    + "request is clearly finished, say a brief polite closing line and call the end_call tool. "
    + "Don't let the call trail off in silence, cut the caller off mid-sentence, or keep "
    + "talking after they're done.",
    // Deliberately last - models tend to weigh instructions stated most
    // recently more heavily, so this short recap of the agent's own
    // already-configured rules reinforces what matters most right before
    // the prompt ends.
    ...(finalReminders ? ["", "# FINAL REMINDERS", finalReminders] : []),
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
  const serviceAreaTool = buildServiceAreaTool(profile);
  const definitions = [
    ...(bookingEnabled ? [...CALENDAR_TOOLS, ...CORE_TOOLS] : CORE_TOOLS),
    ...(serviceAreaTool ? [serviceAreaTool] : []),
  ];
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
      END_CALL_TOOL,
    ],
    voice: voiceId,
    transferNumbers: transferDefinitions.map(
      ({ transfer_destination }) => transfer_destination.number,
    ),
    bookingEnabled,
    language: resolveLanguage(agent),
    startSpeaker: resolveStartSpeaker(agent),
    pauseBeforeSpeakingMs: resolvePauseBeforeSpeakingMs(agent),
    // Agent-level Retell settings, spread into the create/update-agent body.
    retellAgent: {
      end_call_after_silence_ms: callHandling.silenceSec * 1000,
      max_call_duration_ms: callHandling.maxDurationMin * 60_000,
      reminder_trigger_ms: REMINDER_TRIGGER_MS,
      reminder_max_count: REMINDER_MAX_COUNT,
      post_call_analysis_data: [SPAM_ANALYSIS_FIELD],
      language: resolveLanguage(agent),
      ...(resolveStartSpeaker(agent) === "agent" && resolvePauseBeforeSpeakingMs(agent) > 0
        ? { begin_message_delay_ms: resolvePauseBeforeSpeakingMs(agent) }
        : {}),
    },
    allowedInboundCountries: resolveAllowedInboundCountries(agent),
  };
}

const SUPPORTED_LANGUAGES = new Set(["en-US", "es-419"]);

// At least English and Spanish, per the requirement - Retell supports many
// more locales, but only these two are offered in our UI today.
export function resolveLanguage(agent) {
  const raw = text(agent?.configuration?.language);
  return SUPPORTED_LANGUAGES.has(raw) ? raw : "en-US";
}

export function resolveStartSpeaker(agent) {
  return agent?.configuration?.startSpeaker === "user" ? "user" : "agent";
}

// Retell only supports 0 or 5000ms via begin_message_delay_ms in practice for
// this product - we expose just 0 or 1 second, per the requirement.
export function resolvePauseBeforeSpeakingMs(agent) {
  const raw = Number(agent?.configuration?.pauseBeforeSpeakingMs);
  return raw === 1000 ? 1000 : 0;
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

// Appends a configured extension to an already-validated E.164 number, as
// three commas (a DTMF pause) followed by the extension digits - Retell's
// own documented example for dialing an extension after a transfer
// connects: "+44203XXXXXXX,,,2000"
// (community.retellai.com/t/dynamic-extension-dialing/2641). Retell's
// docs also describe a separate dedicated "Extension Number" field in
// their dashboard UI, but its exact API field name isn't confirmed here -
// this comma-pause form is the one with a documented working example, so
// it's what's implemented.
function withExtension(number, extension) {
  const digits = text(extension).replace(/\D/g, "").slice(0, 6);
  return digits ? `${number},,,${digits}` : number;
}

// If allowCallTransfers is explicitly false, this agent must never be
// able to transfer a call under any circumstance - returning no tools at
// all here (rather than relying on a prompt instruction the model could
// ignore) is what makes that an actual guarantee, not just a suggestion.
function buildTransferTools(agent, profile) {
  if (agent?.configuration?.allowCallTransfers === false) return [];
  const rules = Array.isArray(agent?.configuration?.emergencyRules)
    ? agent.configuration.emergencyRules
    : [];
  const destinations = [
    ...rules.flatMap((rule) => {
      // A "decline" rule only speaks its configured message - see
      // formatEmergencyRules above - so its transferTarget (often a stale
      // leftover from when the rule was previously set to "transfer") must
      // never turn into a real transfer_call tool. Legacy - the UI no
      // longer offers this, but an already-stored decline rule keeps
      // behaving exactly as before.
      if (rule?.action === "decline") return [];
      const number = toE164(rule?.transferTarget);
      if (!number) return [];
      const phrases = Array.isArray(rule?.phrases)
        ? rule.phrases.map(text).filter(Boolean)
        : [];
      return [{
        number: withExtension(number, rule?.extension),
        description: phrases.length
          ? `Warm transfer when the caller mentions ${phrases.join(", ")}.`
          : "Warm transfer for this configured call transfer rule.",
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

function formatHolidayClosures(holidays) {
  if (!Array.isArray(holidays) || !holidays.length) return "";
  return holidays
    .filter((holiday) => holiday?.closed && text(holiday?.name) && text(holiday?.date))
    .map((holiday) => `${text(holiday.name)} (${text(holiday.date)})`)
    .join(", ");
}

function formatContactEmails(contactEmails) {
  if (!Array.isArray(contactEmails) || !contactEmails.length) return "";
  return contactEmails
    .filter((entry) => text(entry?.email))
    .map((entry) => {
      const label = text(entry?.label);
      return label ? `- ${label}: ${text(entry.email)}` : `- ${text(entry.email)}`;
    })
    .join("\n");
}

function formatServiceAreas(serviceAreas) {
  if (!Array.isArray(serviceAreas) || !serviceAreas.length) return "";
  return serviceAreas.map(text).filter(Boolean).join(", ");
}

// Caller-facing only - Name, Duration, and Minimum Lead Time. The
// Before/After calendar buffers are deliberately never rendered here or
// anywhere else in the prompt - they only ever reach the actual booking
// tool call (see lambda/tools/handlers/appointment-types.mjs).
function formatAppointmentTypes(appointmentTypes) {
  if (!Array.isArray(appointmentTypes) || !appointmentTypes.length) return "";
  return appointmentTypes
    .filter((type) => text(type?.name))
    .map((type) => {
      const duration = formatMinutesLabel(type.durationMin);
      const leadTime = Number(type.minimumLeadTimeMin) > 0
        ? `, must be booked at least ${formatMinutesLabel(type.minimumLeadTimeMin)} in advance`
        : "";
      return `- ${text(type.name)} (${duration}${leadTime})`;
    })
    .join("\n");
}

function formatCalComEventTypes(eventTypes) {
  if (!Array.isArray(eventTypes) || !eventTypes.length) return "";
  return eventTypes
    .filter((eventType) => text(eventType?.name))
    .map((eventType) => Number(eventType.lengthInMinutes) > 0
      ? `- ${text(eventType.name)} (${formatMinutesLabel(eventType.lengthInMinutes)})`
      : `- ${text(eventType.name)}`)
    .join("\n");
}

function formatMinutesLabel(minutes) {
  const value = Number(minutes) || 0;
  if (value % 60 === 0 && value > 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${value} minutes`;
}

function formatEmergencyRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  return rules.flatMap((rule) => {
    const phrases = Array.isArray(rule?.phrases)
      ? rule.phrases.map(text).filter(Boolean)
      : [];
    if (!phrases.length) return [];
    const phraseList = phrases.map((phrase) => `"${phrase}"`).join(", ");
    if (rule?.action === "decline") {
      const message = text(rule?.message);
      if (!message) return [];
      return [
        `- If the caller mentions ${phraseList}: say "${message}" and do not transfer or take any other action.`,
      ];
    }
    const target = text(rule?.transferTarget);
    if (!target) return [];
    return [
      `- If the caller mentions ${phraseList}: transfer to ${target}.`,
    ];
  }).join("\n");
}

// Matches the exact wording the frontend seeds into Role Instructions
// (NO_TRANSFER_ROLE_INSTRUCTIONS_ADDENDUM, lib/mock-data/data.ts) - kept
// as one literal string here too so the two can't quietly drift apart.
const NO_TRANSFER_FIXED_LINE = "say: \"My apologies. Since no one is "
  + "available at the moment, please leave a message and I will ask the "
  + "team to call you as soon as they are available.\" Then take a message.";

function formatNoTransferPhrases(phrases) {
  if (!Array.isArray(phrases) || !phrases.length) return "";
  return phrases.map(text).filter(Boolean).map((phrase) => `"${phrase}"`).join(", ");
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
