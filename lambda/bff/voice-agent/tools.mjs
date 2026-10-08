// The tools a voice agent is given, decided from the canonical configuration
// alone. Vendor-neutral: retell.mjs turns this plan into Retell's
// general_tools JSON, and the prompt builder may only name a tool that is in
// the plan (see requireTool in prompt.mjs) - so the prompt and the registered
// tools can never disagree.
//
// Webhook tools are served by lambda/tools (POST /retell/tools/*). The paths
// below must match that Lambda's ROUTES set.

export const TOOL = Object.freeze({
  findAppointment: "calendar_find_appointment",
  getAvailability: "calendar_get_availability",
  createBooking: "calendar_create_booking",
  rescheduleBooking: "calendar_reschedule_booking",
  cancelBooking: "calendar_cancel_booking",
  leadCapture: "lead_capture",
  messageTake: "message_take",
  serviceArea: "check_service_area",
  endCall: "end_call",
});

export const TRANSFER_TOOL_PREFIX = "transfer_call_";

// Section title the scheduling tools tell the model to look in. Shared with
// prompt.mjs so the tool descriptions always point at a section that exists.
export const APPOINTMENT_TYPES_SECTION = "APPOINTMENT TYPES";

const APPOINTMENT_TYPE_PARAMETER = {
  type: "string",
  description:
    `Name of one of this agent's configured appointment types, exactly as listed in # ${APPOINTMENT_TYPES_SECTION} - `
    + "when given, its Duration and Minimum Lead Time are authoritative and durationMinutes is ignored.",
};

const CALENDAR_TOOLS = [
  {
    name: TOOL.findAppointment,
    kind: "webhook",
    path: "/retell/tools/calendar.findAppointment",
    description:
      "Find the caller's existing appointment by caller phone and an optional date window before rescheduling or cancelling.",
    properties: {
      callerPhone: {
        type: "string",
        description: "Caller's phone number. Use the number on the call when available.",
      },
      startTime: { type: "string", description: "Optional start of the appointment search window." },
      endTime: { type: "string", description: "Optional end of the appointment search window." },
    },
    required: ["callerPhone"],
    speakable: "Each appointment's type (service), day, date, and time.",
    internal: "appointmentId and callerName - never read them out.",
  },
  {
    name: TOOL.getAvailability,
    kind: "webhook",
    path: "/retell/tools/calendar.getAvailability",
    description: "Check the connected business calendar before offering an appointment time.",
    properties: {
      startTime: {
        type: "string",
        description: "Requested ISO 8601 start time or a clear relative time such as tomorrow at 2 PM.",
      },
      endTime: { type: "string", description: "Optional ISO 8601 end time." },
      durationMinutes: {
        type: "number",
        description: "Appointment duration in minutes when endTime is omitted and no appointmentType is given.",
      },
      appointmentType: APPOINTMENT_TYPE_PARAMETER,
    },
    required: ["startTime"],
    speakable: "Whether that exact time is available.",
    internal: "busy ranges and UTC timestamps - never read them out.",
  },
  {
    name: TOOL.createBooking,
    kind: "webhook",
    path: "/retell/tools/calendar.createBooking",
    description:
      "Create an appointment only after calendar_get_availability confirms the time is available and the caller confirms it.",
    properties: {
      startTime: { type: "string", description: "Confirmed ISO 8601 or relative appointment start time." },
      endTime: { type: "string", description: "Optional ISO 8601 appointment end time." },
      durationMinutes: {
        type: "number",
        description: "Appointment duration in minutes when endTime is omitted and no appointmentType is given.",
      },
      appointmentType: APPOINTMENT_TYPE_PARAMETER,
      service: {
        type: "string",
        description: "Service the caller is booking - omit when appointmentType is given, since its name is used instead.",
      },
      description: { type: "string", description: "Short booking note with only information the caller supplied." },
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
    speakable: "That the appointment is booked, with its day and time.",
    internal: "appointmentId and provider details - never read them out.",
  },
  {
    name: TOOL.rescheduleBooking,
    kind: "webhook",
    path: "/retell/tools/calendar.rescheduleBooking",
    description:
      "Move an appointment returned by calendar_find_appointment after confirming the appointment and new time with the caller. "
      + "The appointment keeps its type and length.",
    properties: {
      appointmentId: { type: "string", description: "Symantic appointment ID returned by a prior booking." },
      startTime: { type: "string", description: "Confirmed new ISO 8601 or relative start time." },
      endTime: { type: "string", description: "Optional new ISO 8601 end time." },
      durationMinutes: { type: "number", description: "Appointment duration in minutes when endTime is omitted." },
    },
    required: ["appointmentId", "startTime"],
    speakable: "The old and new day and time.",
    internal: "appointmentId - never read it out.",
  },
  {
    name: TOOL.cancelBooking,
    kind: "webhook",
    path: "/retell/tools/calendar.cancelBooking",
    description:
      "Cancel an appointment returned by calendar_find_appointment only after the caller confirms cancellation.",
    properties: {
      appointmentId: { type: "string", description: "Symantic appointment ID to cancel." },
    },
    required: ["appointmentId"],
    speakable: "That the named appointment is cancelled.",
    internal: "appointmentId - never read it out.",
  },
];

const CORE_TOOLS = [
  {
    name: TOOL.leadCapture,
    kind: "webhook",
    path: "/retell/tools/lead.capture",
    description: "Capture a new caller or prospect for office follow-up when no appointment is booked.",
    properties: {
      name: { type: "string", description: "Caller name." },
      phone: { type: "string", description: "Caller phone number." },
      email: { type: "string", description: "Optional caller email address." },
      interest: { type: "string", description: "What the caller needs and any follow-up context." },
    },
    required: ["name", "phone", "interest"],
    speakable: "That the details were passed to the team.",
    internal: "leadId.",
  },
  {
    name: TOOL.messageTake,
    kind: "webhook",
    path: "/retell/tools/message.take",
    description: "Take a message for the office when the request cannot be completed during the call.",
    properties: {
      name: { type: "string", description: "Caller name." },
      phone: { type: "string", description: "Caller phone number." },
      email: { type: "string", description: "Optional caller email address." },
      message: { type: "string", description: "Concise message in the caller's own meaning." },
    },
    required: ["name", "phone", "message"],
    speakable: "That the message will be passed along.",
    internal: "messageId.",
  },
];

// Only registered when the business has configured a service area - the
// whole list travels with the tool definition as a `const` property, the
// same way workspaceId/agentId/callId are baked in. No database access at
// call time; the tools Lambda resolves places against a local Census
// dataset (lambda/tools/geo/) and returns a status the prompt follows.
function serviceAreaTool(serviceAreas, businessAddress) {
  return {
    name: TOOL.serviceArea,
    kind: "webhook",
    path: "/retell/tools/service-area.check",
    description:
      "Decide whether a place the caller named is inside the service area. Call it whenever the caller gives a "
      + "city, town, county, state, ZIP code, metro area or region that matters to an on-site visit. Returns "
      + "status covered, outside, ambiguous or unresolved.",
    properties: {
      location: {
        type: "string",
        description: "The caller's location as they said it, including the state or ZIP code if they gave one "
          + "(\"Silver Spring, Maryland\", \"20910\", \"Arlington\").",
      },
      serviceAreas: { type: "string", const: JSON.stringify(serviceAreas) },
      // The business's own town is always covered.
      ...(businessAddress ? { businessAddress: { type: "string", const: businessAddress } } : {}),
    },
    required: ["location", "serviceAreas"],
    speakable: "Whether the place is covered, the clarificationQuestion to ask, or the outside message.",
    internal: "matchedBy, matchedArea, confidence and canonicalLocation - never read them out.",
  };
}

export const TRANSFER_EXECUTION_MESSAGE = "Sure, I'll transfer your call to a staff member so they can assist you.";

const END_CALL_TOOL = {
  name: TOOL.endCall,
  kind: "end_call",
  description:
    "End the call politely once the conversation has clearly and naturally concluded - the "
    + "caller has said goodbye, confirmed there's nothing else they need, or is clearly a "
    + "recorded message, an automated system / IVR, or a telemarketer working from a script. "
    + "Do not use this on a hesitant or confused real caller, or to cut a caller off mid-request.",
};

// Every tool name a generated prompt could ever mention. Used to verify the
// prompt never names one that this particular agent doesn't have.
export const CATALOG_TOOL_NAMES = Object.freeze(Object.values(TOOL));

export function buildToolPlan(cfg) {
  const tools = [
    ...(cfg.scheduling.enabled ? CALENDAR_TOOLS : []),
    ...CORE_TOOLS,
    ...(cfg.business.serviceAreas.length ? [serviceAreaTool(cfg.business.serviceAreas, cfg.business.address)] : []),
    // If transfers are not allowed there are no rules here at all, so no
    // transfer tool exists - a guarantee rather than a prompt instruction
    // the model could ignore.
    ...cfg.transfers.rules.map((rule, index) => ({
      name: `${TRANSFER_TOOL_PREFIX}${index + 1}`,
      kind: "transfer",
      description: `Warm transfer when what the caller says means ${rule.phrases.map((phrase) => `"${phrase}"`).join(" or ")}.`,
      phrases: rule.phrases,
      number: rule.number,
      extension: rule.extension,
      executionMessage: TRANSFER_EXECUTION_MESSAGE,
    })),
    END_CALL_TOOL,
  ];
  return tools.map((tool) => ({ ...tool }));
}

export function toolNames(plan) {
  return plan.map((tool) => tool.name);
}
