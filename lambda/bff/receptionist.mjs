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
// Every field on an agent's Business Profile step belongs to that agent
// alone - two agents in one workspace can be two different locations with
// different hours, timezone, service area, and forwarding number. Values an
// agent hasn't saved for itself yet (agents created before this existed)
// fall back to the workspace profile until its next Save Changes.
export const AGENT_PROFILE_FIELDS = Object.freeze([
  "businessName",
  "phone",
  "address",
  "mailingAddress",
  "website",
  "timezone",
  "contactEmails",
  "serviceAreas",
  "businessHours",
  "hours",
  "holidays",
  "holidaysEnabled",
  "ownerPhone",
]);

// Workspace profile fields no screen can edit any more. Existing workspaces
// still carry sample-data values in them (a dental practice description,
// dental FAQs, a policy, and fake 555 escalation/fallback numbers), so they
// must never reach a live agent's instructions or transfer destinations.
const UNEDITABLE_PROFILE_FIELDS = Object.freeze([
  "description",
  "faqs",
  "policies",
  "escalationContact",
  "fallbackPhone",
  "communicationStyle",
  "businessType",
]);

export function effectiveProfile(agent, workspaceProfile) {
  const merged = { ...(workspaceProfile ?? {}) };
  for (const field of UNEDITABLE_PROFILE_FIELDS) delete merged[field];
  const own = agent?.configuration?.businessProfile;
  if (own && typeof own === "object") {
    for (const field of AGENT_PROFILE_FIELDS) {
      if (own[field] !== undefined) merged[field] = own[field];
    }
  }
  return merged;
}

// What the agent calls itself on calls - the AI Voice Agent Name. Agents
// saved before that field existed use their Internal Name up to the first
// dash ("Samantha- CWR Inc" -> "Samantha"), mirroring the wizard's
// defaultSpokenName. The Internal Name itself is admin-only: it labels the
// agent in Retell and the number in Telnyx, and is never spoken.
export function spokenAgentName(agent) {
  const saved = agent?.configuration?.spokenName;
  if (typeof saved === "string" && saved.trim()) return saved.trim();
  const internal = text(agent?.configuration?.name) || text(agent?.name);
  return internal.split("-")[0].trim() || internal || "the AI voice agent";
}

export function resolveGreeting(agent, workspaceProfile) {
  const profile = effectiveProfile(agent, workspaceProfile);
  const configured = text(agent?.configuration?.greeting);
  if (configured) return configured;
  const businessName = text(profile?.businessName) || "the business";
  const receptionistName = spokenAgentName(agent);
  const disclosure = agent?.configuration?.recordingDisclosure
    ? " This call may be recorded for quality assurance."
    : "";
  return `Thanks for calling ${businessName}.${disclosure} This is ${receptionistName}, the virtual receptionist. How can I help you today?`;
}

export function buildReceptionistPrompt(agent, workspaceProfile) {
  const profile = effectiveProfile(agent, workspaceProfile);
  const behavior = agent?.configuration ?? {};
  const businessName = text(profile?.businessName) || "the business";
  const receptionistName = spokenAgentName(agent);
  const tone = (text(behavior.tone) || "clear and professional").replace(/^./, (letter) => letter.toLowerCase());
  const hoursLine = isBusinessHours(profile?.businessHours)
    ? formatBusinessHours(profile.businessHours)
    : (text(profile?.hours) || "Not provided");
  const holidaysLine = formatHolidays(profile);
  const contactEmailsLine = formatContactEmails(profile?.contactEmails);
  const serviceAreaLine = formatServiceAreas(profile?.serviceAreas);
  const booking = behavior.booking === true;
  const usesCalCom = Array.isArray(behavior.connections) && behavior.connections.includes("cal-com");
  const appointmentTypesLine = usesCalCom
    ? formatCalComEventTypes(behavior.calComEventTypes)
    : formatAppointmentTypes(behavior.appointmentTypes);
  const hasOnSiteTypes = !usesCalCom && Array.isArray(behavior.appointmentTypes)
    && behavior.appointmentTypes.some((type) => type?.happensAtCustomerLocation === true);
  const bookingWindowDays = resolveBookingWindowDays(agent);
  const allowCallTransfers = behavior.allowCallTransfers !== false;
  const transferRules = transferRuleTools(agent, profile);
  const declineRules = formatDeclineRules(behavior.emergencyRules);
  const noTransferRulesLines = formatNoTransferRules(behavior.noTransferRules);
  const roleInstructions = text(behavior.roleInstructions);
  const restrictions = text(behavior.restrictions);
  const exampleDialogues = text(behavior.exampleDialogues);
  const finalReminders = text(behavior.finalReminders);
  const whatYouDo = [
    "answer questions about the business and its services",
    "take messages for the team",
    ...(booking ? ["book, reschedule, and cancel appointments"] : []),
    ...(allowCallTransfers && transferRules.length ? ["transfer callers when one of the business's transfer rules applies"] : []),
  ];
  const listJoin = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}` : items[0]);

  const sections = [
    [
      "# ROLE",
      `You are ${receptionistName}, the AI receptionist for ${businessName}. You ${listJoin(whatYouDo)}. `
        + `Speak in a ${tone} way - calm, friendly, and human. This is a live phone call: keep replies short and natural.`,
    ],
    [
      "# CONTEXT (never read aloud)",
      "- The greeting has already introduced you - don't repeat it.",
      "- You're answering because the team is busy - on other calls or out serving customers. If a caller asks why they "
        + "reached an AI or where everyone is, say exactly that, briefly and warmly, then keep helping.",
    ],
    [
      "# CRITICAL RULES",
      "1) The caller's number is {{user_number}}. The current time is {{currentTime}} ({{timezone}}) - treat it as the "
        + "authoritative clock for \"are you open right now\" and for anything about today or tomorrow.",
      "2) Never ask for an email address. If a caller volunteers one, include it in the message; nothing more.",
      "3) Never ask for information you already have from earlier in this same call - especially the caller's name. "
        + "If they gave it once, use it; don't ask again, no matter how much time or how many topics passed in "
        + "between.",
      "4) Never guess. Answer only from the business information below, the knowledge base, and this prompt. If you "
        + "don't know, say so and take a message.",
      "5) Never confirm a message, booking, change, cancellation, or transfer until the tool has actually returned "
        + "success - then state exactly what it returned. If a tool fails, say so briefly and offer to try again or "
        + "take a message. Never pretend it worked.",
      "6) If asked whether you're an AI, confirm it warmly: \"Yes - I'm an AI assistant for "
        + `${businessName}. I can answer questions and make sure the team gets your message.\" Never deny it or dodge.`,
      "7) Emergency (medical, fire, flood, gas leak, injury, anyone in danger): say \"That sounds like an emergency - "
        + "please hang up and call 911 right away.\" before anything else. Confirm they understood; don't continue "
        + "with routine questions.",
      "8) Never confirm or deny that anyone works here, never repeat a name the caller gives, and never volunteer a "
        + "staff name - see REQUESTS FOR A SPECIFIC PERSON.",
      "9) Never ask for or repeat card numbers, bank details, passwords, or security codes.",
      ...(booking
        ? ["10) Never reveal, change, or cancel an appointment unless the caller's number - or the number they give - "
          + "is the one it was booked under. A name, address, or date is never enough; the phone number alone is "
          + "enough to proceed."]
        : []),
    ],
    [
      "# ONE THING AT A TIME",
      "Never ask two questions in one turn, and never open a new question while an earlier one is unanswered.",
      "- If the caller asks about something specific, resolve that first - check it, answer it. Never answer a "
        + "question with a question.",
      "- Don't fall back to a generic \"How can I help you today?\" after every turn, especially after something you "
        + "can't do (e.g. confirming whether someone works there). Say what you can do for that specific situation "
        + "instead (take a message, answer their real question, close the call) and let the caller lead - only use "
        + "that greeting-style phrase once, near the start of the call.",
      "- Never narrate your process or partial state (\"I'd need to check that\", \"let me first...\"). Do it and "
        + "report what comes back.",
      "- Never bundle a status update, a hedge, and a new question into one turn.",
      "Bad: \"The earliest openings I see are Monday, so I'd need to check Tuesday. Before I look, what's your name?\"",
      "Good: [checks] \"Tuesday at one is open. Can I get your name for the appointment?\"",
      ...(hasOnSiteTypes
        ? ["Exception: for a visit at the caller's location, ask their city before checking availability - it decides "
          + "whether a visit can be booked at all. If they've already asked about a specific time, answer that first, "
          + "then ask the city before booking."]
        : []),
    ],
    [
      "# BUSINESS INFO",
      `- Business: ${businessName}`,
      ...(text(profile?.phone) ? [`- Phone: ${text(profile.phone)}`] : []),
      `- Address: ${text(profile?.address) || "Not provided"}`,
      ...(text(profile?.mailingAddress) && text(profile.mailingAddress) !== text(profile?.address)
        ? [`- Mailing address: ${text(profile.mailingAddress)}`]
        : []),
      ...(text(profile?.website) ? [`- Website: ${text(profile.website)}`] : []),
      `- Timezone: ${text(profile?.timezone) || "UTC"}`,
      `- Hours: ${hoursLine}`,
      ...(holidaysLine ? [`- Holidays: ${holidaysLine}`] : []),
      ...(contactEmailsLine ? ["- Contact emails (share only if asked):", contactEmailsLine] : []),
      "Go strictly by these hours: a day is open or closed exactly as listed, weekends included - never call a "
        + "weekend closed or harder unless the hours say so.",
    ],
    ...(serviceAreaLine
      ? [[
        "# SERVICE AREA",
        `Published coverage: ${serviceAreaLine}`,
        "- The moment a caller gives a city, region, or ZIP, call check_service_area with it before deciding anything. "
          + "Matched: say it's within the area and the team will confirm the exact address. Unmatched isn't a refusal - "
          + "use judgment: nearby places are usually fine.",
        "- Clearly outside: don't refuse and don't confirm. Say the team confirms coverage for addresses out that way "
          + "and take a message so they can follow up. Never quote a mileage, radius, or travel time.",
        "- Speech-to-text mangles place names. If what you heard isn't a real place, it's a mishearing - never accept it "
          + "or read it back as real. Try twice, varying the approach: first offer the closest real place (\"Sorry, did "
          + "you say Stafford?\"), then ask them to spell it. If it's still unclear, move on and reconfirm it later in "
          + "the call.",
        ...(hasOnSiteTypes
          ? ["- For a visit at the caller's location, if the town still can't be identified after that, don't book the "
            + "visit - we can't locate it. Take a message instead so the team can call back and sort it out."]
          : []),
      ]]
      : []),
    [
      "# KNOWLEDGE BASE",
      "- Answer questions about services, policies, and the company from the knowledge base.",
      "- \"What do you do?\" gets the actual services from the knowledge base"
        + (booking ? " - never the appointment types; those are ways to book, not services." : "."),
      "- If the answer isn't in the knowledge base or this prompt, don't guess: \"That's a good question - I want to "
        + "make sure you get an accurate answer. Let me take a message so the team can get back to you.\"",
      "- Never quote a price, discount, special, coupon, or promotion unless the knowledge base states it explicitly. "
        + "Never say one definitely exists or doesn't - offer to take a message so the team can go over it.",
    ],
    ...(booking
      ? [
        [
          "# APPOINTMENT TYPES",
          "These are ways to book, not services - never offer them as an answer to what we do. Confirm the type out loud "
            + "before checking availability. Say only the duration listed - never mention any extra time blocked "
            + "around an appointment.",
          appointmentTypesLine || "- Ask what the appointment is for and book it as described.",
        ],
        [
          "# SCHEDULING RULES",
          "- Every appointment must fit inside the business hours above and finish before closing, given its duration.",
          "- Respect each type's minimum lead time. If a request is too soon (like a same-day visit), don't explain why "
            + "- just offer the earliest time that works. Never mention crew schedules or how the day is filling up.",
          `- Only book up to ${bookingWindowDays} days ahead. If asked for later: "I can only schedule up to `
            + `${bookingWindowDays} days out - what works in that window?"`,
          "- Never speak a time aloud that hasn't come back available from calendar_get_availability, alternatives "
            + "included. If a time is taken, offer only what the check returns.",
        ],
        [
          "# BOOKING FLOW",
          "1. Name: \"Can I have your name for the appointment?\" A first name is fine.",
          "2. Number: \"Is the number you're calling from the best one for the appointment?\" If they ask what number "
            + "that is, tell them ({{user_number}}). If not, take the one they give.",
          ...(hasOnSiteTypes
            ? ["3. City (visits at the caller's location only - every time, before checking availability): \"And what "
              + "city are you in?\" Apply SERVICE AREA."]
            : []),
          `${hasOnSiteTypes ? 4 : 3}. Preference: "What day works best, and do you prefer mornings or afternoons?" This `
            + "narrows the search - it is not a booking.",
          `${hasOnSiteTypes ? 5 : 4}. Check with calendar_get_availability at the right appointment type, then offer two `
            + "or three open times: \"I have Thursday at ten, Thursday at one-thirty, or Friday at eleven. Which works "
            + "best?\" Nothing close? Say so and offer the closest open times. Check again as often as needed.",
          `${hasOnSiteTypes ? 6 : 5}. Confirm: read the chosen time back and get a clear yes - "Just to confirm, Thursday `
            + "the 14th at one-thirty. Shall I book that?\"",
          `${hasOnSiteTypes ? 7 : 6}. Book with calendar_create_booking only after that yes, then confirm it's done with `
            + "the day and time.",
          ...(hasOnSiteTypes
            ? ["8. Address (visits at the caller's location only, after booking): \"What's the full address for the "
              + "visit?\" Read it back and get a yes; spell back anything unusual. If it's still not right after two "
              + "tries, stop asking: \"No problem - the team will confirm the details with you before the visit.\""]
            : []),
          "Capture anything useful the caller volunteers (parking, pets, rooms, timing) in the booking note - never run "
            + "a checklist.",
          "Never book without confirmation: a stated preference (\"sometime Thursday\", \"the earliest you have\") is "
            + "never permission to book. Never pick a slot for them or book while they're deciding.",
          "You can't send email or text confirmations - never promise one. Confirm the appointment out loud instead.",
        ],
        [
          "# RESCHEDULING AND CANCELLING",
          "- The booking phone number is the only key. The moment a caller wants to change or cancel, call "
            + "calendar_find_appointment with {{user_number}} - don't ask them to confirm their number first.",
          "- If nothing comes back, retry in other formats (with and without the country code or leading 1, digits "
            + "only) before concluding anything. A formatting mismatch is likelier than a missing booking.",
          "- Found: read back each appointment (type, day, date, time) and have the caller say which one - never assume. "
            + "Nothing on this number: \"What number would it have been booked under?\" and search that the same way.",
          "- Reschedule: run the booking flow's check-offer-confirm loop for the new time, then move that same "
            + "appointment with calendar_reschedule_booking - never cancel and rebook. Confirm both the old and new time.",
          "- Cancel: confirm the exact appointment, call calendar_cancel_booking, then say back exactly what was "
            + "cancelled (type, day, date, time) - even when there was only one. Offer once to book a new time.",
          "- Still not found, or the tool fails: say so plainly and take a message. Never search by name, address, or "
            + "date.",
        ],
      ]
      : []),
    [
      "# TAKING A MESSAGE",
      "When a caller wants a person, or needs something you can't do on the call:",
      `1. "Everyone's busy helping other customers right now, so no one can come to the phone. I can make sure the `
        + "team gets your message and calls you back as soon as they're available.\"",
      "2. Ask their name first - unless you already have it from earlier in this call, in which case use that.",
      "3. Ask what the call is about - they may decline, but always ask - and sum it up in one line.",
      "4. Confirm the callback number: \"Is the number you're calling from the best one to reach you?\" If they ask "
        + "what it is, tell them. If not, take the number they give.",
      "5. Save it with message_take, then confirm: \"I'll pass this along - someone will call you back as soon as "
        + "they're available.\"",
      "Never promise a callback time. Never ask for an email. For someone interested in the business's services, use "
        + "lead_capture with the same details instead.",
    ],
    [
      "# CALL TRANSFERS",
      ...(allowCallTransfers
        ? [
          ...(transferRules.length
            ? [
              "Transfer only when what the caller says matches the MEANING of one of these rules - never require their "
                + "exact wording. \"I need to talk to a staff member\" matches a rule phrased \"talk to a human\"; asking "
                + "for someone by a name listed as a phrase matches that rule too. While transferring, say exactly: "
                + "\"Sure, I'll transfer your call to a staff member so they can assist you.\" Never say who you're "
                + "transferring to.",
              ...transferRules.map(({ phrases, toolName }) =>
                `- If what the caller says means ${phrases.map((phrase) => `"${phrase}"`).join(" or ")}: use ${toolName}.`),
            ]
            : []),
          ...(declineRules ? [declineRules] : []),
          "- Anything else, including a request for a person that matches no rule above: don't transfer - use TAKING "
            + "A MESSAGE.",
        ]
        : [
          "This agent never transfers a call.",
          "Match by the MEANING of what the caller says, never their exact wording - \"I need to talk to a staff "
            + "member\" matches a response phrased \"talk to a human\".",
          ...(noTransferRulesLines ? [noTransferRulesLines] : []),
          ...(declineRules ? [declineRules] : []),
          `- For anything that doesn't match one of the responses above, ${NO_TRANSFER_FIXED_LINE}`,
        ]),
    ],
    [
      "# REQUESTS FOR A SPECIFIC PERSON",
      "\"Is Maria there?\", \"Can I speak to Dave?\", \"Does Sarah still work there?\" - never confirm or deny that anyone "
        + "by that name works here, and never repeat the name back in any form.",
      "- Never say \"no one here by that name\", \"they don't work here anymore\", \"they're not in today\", or \"let me "
        + "check if they're in\" - each one confirms or denies something.",
      `- Say only: "Someone from ${businessName} will call you back - let me take a message." Then follow TAKING A `
        + "MESSAGE"
        + (allowCallTransfers && transferRules.length ? ", unless one of the CALL TRANSFERS rules matches." : "."),
      "- If they press, repeat the same line once. Stay warm - don't explain the policy or sound suspicious.",
    ],
    ...(spamScreeningEnabled(agent)
      ? [[
        "# SPAM",
        "Within about the first 30 seconds, judge whether it's spam: a sales or marketing pitch (SEO, web design, leads, "
          + "insurance, merchant services, business loans), asking for \"the owner\" with no reason tied to the business, "
          + "pre-recorded audio, long silence, or an obvious script.",
        "- If it is, never say the word \"spam\" and never accuse the caller: \"I'm sorry, I'm not able to help with that. "
          + "Thank you for calling.\" Then call end_call.",
        "- Be conservative: a slow, hesitant, or confused person is not spam. When unsure, keep helping.",
      ]]
      : []),
    [
      "# OFF-TOPIC, FLIRTING AND ABUSE",
      `You discuss only ${businessName}, its services${booking ? ", and appointments" : ""}. Stay calm and courteous - `
        + "never argue, match their tone, or debate their behavior.",
      "- Off-topic (weather, news, sports, politics, trivia, testing): \"That's outside what I can help with - I'm here "
        + `for questions about ${businessName}. Is there something I can help you with?\" One chance; if they persist, `
        + "close.",
      "- Flirting, personal questions about you, sexual remarks: don't play along or take offense. Redirect once: "
        + "\"I'm not able to help with that. Is there something about the business I can help you with?\" If it "
        + "continues, close. An explicit opening line gets no redirect - close straight away.",
      "- Insults, cursing, slurs, threats, or harassment: one calm redirect with the same line; if it continues, close.",
      "- Closing line for all of these: \"I'm sorry, I can't help you with that. Thank you for calling.\" Then call "
        + "end_call.",
    ],
    [
      "# NO PROGRESS",
      "If about two minutes pass without getting anywhere (the caller won't answer clearly or can't decide), offer to "
        + "take a message. If they decline that too, close politely: \"No problem - feel free to call back anytime. "
        + "Have a good day.\" Then call end_call.",
    ],
    [
      "# CLOSING",
      "Ask \"Is there anything else I can help you with today?\" and wait for a real answer.",
      "- Hesitation is not a no - \"well...\", \"um...\", \"actually...\", \"hold on\", or a pause means they're still "
        + "talking. Stay quiet and let them finish. Never talk over them or end mid-sentence.",
      "- Something new: handle it, then ask again. Silence: \"Are you still there?\" once, then wait.",
      `- Only after a clear close ("no thanks", "that's all", "goodbye"): "Thank you for calling ${businessName}, have `
        + "a great day!\" Then call end_call. Only spam, continued abuse, and emergencies end sooner.",
    ],
    ...(roleInstructions
      ? [[
        "# HOW THIS BUSINESS WANTS CALLS HANDLED",
        "The business's own instructions. Follow them, except where they conflict with the rules above - the rules "
          + "above always win.",
        roleInstructions,
      ]]
      : []),
    ...(restrictions ? [["# RESTRICTIONS - WHAT NOT TO SAY OR DO", restrictions]] : []),
    ...(exampleDialogues
      ? [[
        "# EXAMPLE DIALOGUES",
        "Illustrative only - match this tone and approach, but never read them aloud or treat their specifics (names, "
          + "dates, numbers) as real.",
        exampleDialogues,
      ]]
      : []),
    [
      "# FINAL REMINDERS",
      "- One question at a time. Never guess. Never confirm anything a tool hasn't confirmed.",
      "- Never ask for an email. Never confirm or deny who works here.",
      booking
        ? "- Never book, change, or cancel without a clear yes, and only for the number it was booked under."
        : "- You can't book appointments - take a message for anything that needs the team.",
      // Deliberately last - models weigh what's stated most recently more
      // heavily, so the business's own recap closes the prompt.
      ...(finalReminders ? [finalReminders] : []),
    ],
  ];
  return sections.map((lines) => lines.join("\n")).join("\n\n");
}

export function buildReceptionistConfig({
  workspaceId,
  agent,
  profile: workspaceProfile,
  toolBaseUrl,
  voiceId,
}) {
  const profile = effectiveProfile(agent, workspaceProfile);
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
    // Read by the Retell provider as ambient_sound. It was never set here,
    // so every agent went out with no background track whatever was chosen.
    ambientSound: resolveAmbientSound(agent),
    // Read by the Retell provider as ambient_sound_volume, only sent when
    // ambientSound is set. See resolveAmbientSoundVolume below.
    ambientSoundVolume: resolveAmbientSoundVolume(agent),
  };
}

// Retell's fixed list - mirrored in the frontend's lib/domain/ambient-sound.ts.
// Anything else (a stale or hand-edited value) sends no sound rather than
// being rejected by Retell at publish time.
const AMBIENT_SOUNDS = new Set([
  "coffee-shop",
  "convention-hall",
  "summer-outdoor",
  "mountain-outdoor",
  "static-noise",
  "call-center",
]);

export function resolveAmbientSound(agent) {
  const value = text(agent?.configuration?.ambientSound);
  return AMBIENT_SOUNDS.has(value) ? value : null;
}

// Mirrors the frontend's lib/domain/ambient-sound.ts clamp/default - kept in
// sync by hand since the two repos don't share code.
const AMBIENT_SOUND_VOLUME_MIN = 0.1;
const AMBIENT_SOUND_VOLUME_MAX = 1;
const AMBIENT_SOUND_VOLUME_DEFAULT = 0.5;

export function resolveAmbientSoundVolume(agent) {
  const raw = agent?.configuration?.ambientSoundVolume;
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : AMBIENT_SOUND_VOLUME_DEFAULT;
  return Math.min(AMBIENT_SOUND_VOLUME_MAX, Math.max(AMBIENT_SOUND_VOLUME_MIN, value));
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
// One entry per Allow rule that can actually transfer: it needs at least
// one phrase, and a number - its own, or the agent's Default Transfer
// Number when it has none. Legacy "decline" rules only speak a message and
// never become a tool. Shared by the tools and the prompt, so each prompt
// line names the exact tool its rule became.
function transferRuleTools(agent, profile) {
  if (agent?.configuration?.allowCallTransfers === false) return [];
  const rules = Array.isArray(agent?.configuration?.emergencyRules) ? agent.configuration.emergencyRules : [];
  const fallback = toE164(profile?.ownerPhone);
  return rules.flatMap((rule) => {
    if (rule?.action === "decline") return [];
    const phrases = Array.isArray(rule?.phrases) ? rule.phrases.map(text).filter(Boolean) : [];
    const number = toE164(rule?.transferTarget) || fallback;
    if (!phrases.length || !number) return [];
    return [{ phrases, number: withExtension(number, rule?.extension) }];
  }).map((entry, index) => ({ ...entry, toolName: `transfer_call_${index + 1}` }));
}

// If allowCallTransfers is explicitly false, this agent must never be
// able to transfer a call under any circumstance - returning no tools at
// all here (rather than relying on a prompt instruction the model could
// ignore) is what makes that an actual guarantee, not just a suggestion.
function buildTransferTools(agent, profile) {
  return transferRuleTools(agent, profile).map(({ phrases, number, toolName }) => ({
    type: "transfer_call",
    name: toolName,
    description: `Warm transfer when the caller mentions ${phrases.join(", ")}.`,
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
    execution_message_description: "Sure, I'll transfer your call to a staff member so they can assist you.",
  }));
}

// How far ahead a booking agent may schedule (Calendar & Booking step),
// 1-60 days; agents saved before the setting existed get 30.
export function resolveBookingWindowDays(agent) {
  const raw = Math.round(Number(agent?.configuration?.bookingWindowDays));
  return Number.isFinite(raw) && raw >= 1 && raw <= 60 ? raw : 30;
}

export function resolveConfiguredVoiceId(configuration, resolveVoiceId) {
  if (configuration?.voiceMode === "cloned") {
    const cloned = text(configuration.voiceId);
    if (cloned) return cloned;
  }
  return resolveVoiceId(configuration?.voice);
}

// Off (or never set) means the business keeps its normal hours on every
// holiday, so the agent gets no holiday line at all. Removed entries are
// suggestions the owner didn't add, never real closures.
function formatHolidays(profile) {
  if (profile?.holidaysEnabled !== true || !Array.isArray(profile?.holidays)) return "";
  return profile.holidays
    .filter((holiday) => !holiday?.disabled && text(holiday?.name) && text(holiday?.date))
    .map((holiday) => {
      const label = `${text(holiday.name)} (${text(holiday.date)})`;
      if (holiday.closed) return `${label}: closed`;
      const hours = text(holiday.hours);
      return hours ? `${label}: open ${hours}` : `${label}: open, normal hours`;
    })
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

// Legacy "respond with a message" rules (the UI shows them as Message
// (Legacy)): say the message, never transfer.
function formatDeclineRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  return rules.flatMap((rule) => {
    if (rule?.action !== "decline") return [];
    const phrases = Array.isArray(rule?.phrases) ? rule.phrases.map(text).filter(Boolean) : [];
    const message = text(rule?.message);
    if (!phrases.length || !message) return [];
    const phraseList = phrases.map((phrase) => `"${phrase}"`).join(" or ");
    return [`- If what the caller says means ${phraseList}: say "${message}" and don't transfer.`];
  }).join("\n");
}

// Matches the exact wording the frontend seeds into Role Instructions
// (NO_TRANSFER_ROLE_INSTRUCTIONS_ADDENDUM, lib/mock-data/data.ts) - kept
// as one literal string here too so the two can't quietly drift apart.
const NO_TRANSFER_FIXED_LINE = "say: \"My apologies. Since no one is "
  + "available at the moment, please leave a message and I will ask the "
  + "team to call you as soon as they are available.\" Then take a message.";

function formatNoTransferRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return "";
  return rules.flatMap((rule) => {
    const phrases = Array.isArray(rule?.phrases)
      ? rule.phrases.map(text).filter(Boolean)
      : [];
    const message = text(rule?.message);
    if (!phrases.length || !message) return [];
    const phraseList = phrases.map((phrase) => `"${phrase}"`).join(" or ");
    return [`- If what the caller says means ${phraseList}: say "${message}" and take a message.`];
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
