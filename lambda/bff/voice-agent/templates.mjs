// Industry-template guidance, as structured defaults.
//
// The wizard's templates (lib/domain/industry-templates.ts) seed one long
// paragraph into Role Instructions. Those paragraphs restate the platform
// rules (one question at a time, confirm spellings, never guess) and assume
// capabilities the agent may not have - "help callers book" with booking
// off, "escalate to a human right away" with transfers off, "offer to text
// or email a link" when the agent can't send either.
//
// When that paragraph is still untouched (seeded-defaults.mjs recognises it),
// the prompt uses the guidance below instead: only what is specific to the
// business type, adapted to whether booking and transfers are on. A customer
// who edited the paragraph keeps their own text and gets none of this.
//
// "Other" has no guidance - it is the blank-slate template.

export const TEMPLATE_TITLES = Object.freeze({
  general: "General Receptionist",
  "medical-dental": "Medical & Dental",
  restaurant: "Restaurant",
  "salon-spa": "Salon & Spa",
  "home-field-services": "Home & Field Services",
  "professional-services": "Professional Services",
  "customer-support": "Customer Support",
  other: "Other",
});

const GUIDANCE = {
  general: ({ booking }) => [
    "You're the business's front desk: answer questions about hours, location, and services, and make sure no caller is left without a next step - an answer, "
      + (booking ? "an appointment, " : "")
      + "or a message for the team.",
  ],
  "medical-dental": ({ booking }) => [
    "This is a medical or dental practice. Callers ask about services, hours, and insurance; answer insurance questions only from the knowledge base.",
    ...(booking
      ? ["For a booking, ask whether they're a new or returning patient and add it to the booking note."]
      : ["You can't book appointments: for a booking request, take a message so the front desk can call back to schedule, and note whether they're a new or returning patient."]),
    "Never give medical advice, a diagnosis, or an opinion on a treatment plan - for a clinical question, offer to have a staff member call back.",
    "If a caller describes worsening symptoms such as swelling, heavy bleeding, or severe pain, tell them not to wait: call back right away, or go to urgent care. Anything life-threatening is an emergency - see CRITICAL RULES.",
  ],
  restaurant: ({ booking }) => [
    "This is a restaurant. Callers ask about the menu, hours, parking, and private events - answer from the knowledge base and summarize menus rather than reading them item by item.",
    ...(booking
      ? ["For a reservation, also ask the party size before checking availability, and put the party size and any dietary notes in the booking note."]
      : ["You can't take reservations yourself - the restaurant does: take a message with the party size, date, and time they'd like, so the team can call back to confirm."]),
    "For large parties, catering, or private events, take their details for the events team rather than quoting anything.",
  ],
  "salon-spa": ({ booking }) => [
    "This is a salon or spa. When a caller describes what they want, suggest the matching service from the knowledge base"
      + (booking ? " and offer to book it." : " and offer to take a message so the team can book it."),
    "Exact pricing and timing are confirmed at check-in - never quote a final price unless the knowledge base states it.",
  ],
  "home-field-services": ({ booking, transfers }) => [
    "This is a home or field services company. Find out what the issue is, where it is, and how urgent it is.",
    "Treat anything involving safety as urgent - a gas smell, an active leak, no heat in freezing weather, sparking or smoking electrical. "
      + (transfers ? "If one of the CALL TRANSFERS rules covers it, offer that transfer. " : "")
      + (booking ? "Otherwise offer the soonest available visit." : "Otherwise take an urgent message for the team."),
    "Never promise a quote or an arrival time - the technician confirms cost before doing any work.",
  ],
  "professional-services": ({ booking }) => [
    "This is a professional services firm (legal, financial, consulting, or similar). Ask briefly what the caller needs help with, so the right person follows up.",
    booking
      ? "Then offer a consultation, and put a one-line description of their situation in the booking note."
      : "Then take a message with a one-line description of their situation.",
    "Never give legal, financial, or professional advice, and never discuss case or account specifics - only a licensed team member can.",
  ],
  "customer-support": ({ booking, transfers }) => [
    (booking ? "You're customer support first. " : "You're customer support, not a scheduler. ")
      + "Answer frequently asked questions from the knowledge base and walk callers through troubleshooting one step at a time, checking each step worked before the next.",
    transfers
      ? "If basic troubleshooting doesn't solve it, or the caller is frustrated, use a CALL TRANSFERS rule if one covers it; otherwise take a message with everything they've tried so they don't have to repeat it."
      : "If basic troubleshooting doesn't solve it, or the caller is frustrated, take a message with everything they've tried so they don't have to repeat it.",
  ],
};

export function templateGuidance(templateId, cfg) {
  const build = GUIDANCE[templateId];
  if (!build) return [];
  return build({ booking: cfg.scheduling.enabled, transfers: cfg.transfers.rules.length > 0 });
}
