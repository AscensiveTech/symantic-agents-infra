// The wizard seeds recommended default text into four customer-editable
// fields (Role Instructions, Restrictions, Example Dialogues, Final
// Reminders) - see lib/mock-data/data.ts and lib/domain/industry-templates.ts
// in the frontend repo. Much of that text restates rules the generated
// prompt already has in its own sections, so sending it verbatim made the
// same instruction appear two or three times (platform section + Role
// Instructions + Final Reminders), sometimes with conflicting wording.
//
// This module recognises untouched seeded text and removes only the lines
// the generated prompt already covers for this agent's configuration.
// Matching is exact (after whitespace normalisation), line by line: any line
// the customer edited, or wrote themselves, is never touched. Seeded lines
// the platform does not cover (multiple locations, job openings, ...) stay.
//
// Untouched industry-template paragraphs and example dialogues are long, so
// they're matched by a short hash of their normalised text. They are
// replaced by capability-aware template guidance (templates.mjs) and
// generated example dialogues, because the seeded versions assume booking
// and transfers are on and quote times without checking the calendar.

import { createHash } from "node:crypto";

// When is a seeded line already said by the generated prompt?
//   always     - a section every agent gets
//   booking    - the scheduling sections (only when booking is on; when
//                booking is off the line refers to tools the agent lacks)
//   transfers  - CALL TRANSFERS while transfers are allowed (stale otherwise)
//   noTransfer - CALL TRANSFERS while transfers are not allowed (stale otherwise)
const SEEDED_LINES = [
  // Role Instructions - DEFAULT_ROLE_INSTRUCTIONS_PACING
  ["- Ask one thing at a time. Never ask two questions in the same turn, and never start a new topic while an earlier question is still unanswered.", "always", "ONE THING AT A TIME"],
  ["- If the caller asks something directly, answer that first before asking anything new - never answer a question with a question.", "always", "ONE THING AT A TIME"],
  ["- Don't narrate what you're doing (\"let me check that\", \"I'm looking into it\") - just do it and report back what you find.", "always", "ONE THING AT A TIME"],
  ["- Never make the caller repeat anything they've already given you.", "always", "CRITICAL RULES"],
  ["- Names, cities, addresses, and anything else spelled out or easy to mishear: read it back and ask the caller to confirm it's right. If they correct you, read the corrected version back once more. If it's still not confidently right after two rounds of this, stop asking, move on with what you have, and let the caller know someone will follow up to double-check it. When you report what you collected (a message, a summary, anything passed along), note which details were unconfirmed so whoever follows up knows exactly what to verify.", "always", "ONE THING AT A TIME"],
  // Role Instructions - BOOKING_ROLE_INSTRUCTIONS_ADDENDUM
  ["Your role as the AI receptionist is to answer caller questions and assist with booking, modifying, or canceling appointments.", "booking", "ROLE"],
  // Pre-2026-10-07 heading of the same block.
  ["When this agent can book, reschedule, or cancel appointments:", "booking", "BOOKING FLOW"],
  ["- The caller's phone number is the only key to look up, change, or cancel an appointment. Never look anything up by name, and never confirm or deny that an appointment exists based on a name alone. The moment a caller wants to change or cancel something, look up their number automatically - don't ask them to confirm it first.", "booking", "RESCHEDULING AND CANCELLING"],
  ["- After looking a caller up, read back what was found before asking what they want to do with it - the appointment type, day, date, and time for each one on file under that number. If there's more than one, read all of them and have the caller say which one they mean before touching anything - never guess which appointment a caller means when there's more than one.", "booking", "RESCHEDULING AND CANCELLING"],
  ["- If the number on the call doesn't turn up anything and the caller says they want to change or cancel an appointment, ask what number they used to book it, then look up that number instead. A number that actually finds a real appointment is all the confirmation needed to proceed - don't ask for anything else to \"verify\" it. If it still finds nothing, say so and offer to take a message.", "booking", "RESCHEDULING AND CANCELLING"],
  ["- Never invoke a booking tool until the caller has chosen a specific time and clearly said yes to it. A stated preference (\"sometime Thursday\", \"whenever works\") is not permission to book - read the exact time back and get a clear yes first.", "booking", "BOOKING FLOW"],
  ["- To change an existing appointment to a different time, get the new time confirmed first, then move that same appointment to it with a single reschedule action - never cancel the old one and create a separate new one for a modification. Cancelling first (even briefly) can lose the caller's original slot if the new time doesn't go through for any reason.", "booking", "RESCHEDULING AND CANCELLING"],
  ["- A time is only offerable if it's both far enough out (see each appointment type's Minimum Lead Time) and actually free on the calendar - never speak a time aloud that hasn't come back available from a real check. If a caller asks for something that doesn't clear an appointment type's lead time (like a same-day request), don't explain why - just offer the next time that does qualify.", "booking", "SCHEDULING RULES"],
  ["- Never tell a caller a change, reschedule, or cancellation went through before actually making that call - say something like \"one moment while I update that\" and only confirm once the tool call comes back successful. If it fails, say so plainly and offer to take a message instead - never say it worked when it didn't.", "booking", "CRITICAL RULES"],
  ["- After cancelling an appointment, always state the appointment type, day, date, and time that was cancelled - never just say \"that's cancelled\" or \"done\", even if there was only one appointment to begin with.", "booking", "RESCHEDULING AND CANCELLING"],
  ["- For an appointment type marked \"Happens at Customer's Location\", collect the full address only after the appointment is booked - never before. Read it back and get a clear yes. If it's still not right after two tries, stop asking, book it anyway, and let the caller know someone will call to confirm the address.", "booking", "BOOKING FLOW"],
  // Role Instructions - CALL_TRANSFER / NO_TRANSFER addenda (and the Home &
  // Field Services emergency suffix, which the wizard appends to the same line)
  ["- Transfer a call only when the caller's words match one of this agent's transfer phrases, using that rule's transfer. Anyone else asking for a person gets a message taken instead.", "transfers", "CALL TRANSFERS"],
  ["- Transfer a call only when the caller's words match one of this agent's transfer phrases, using that rule's transfer. Anyone else asking for a person gets a message taken instead. For a safety emergency, you may also offer an immediate transfer to the team.", "transfers", "CALL TRANSFERS"],
  ["- Transfer a call only when the caller's words match one of this agent's transfer phrases, using that rule's transfer. Anyone else asking for a person gets a message taken instead. For a safety emergency, you may also offer an immediate transfer instead of waiting for the soonest slot.", "transfers", "CALL TRANSFERS"],
  ["- This agent never transfers a call, under any circumstance. If a caller wants to talk to a person, say: \"I'm not authorized to make transfers, but I can make sure someone from the business gets your message and calls you back as soon as they're available.\" Then take a message.", "noTransfer", "CALL TRANSFERS"],
  // Restrictions - DEFAULT_RESTRICTIONS (only the lines a section covers)
  ["- Never ask for or repeat back sensitive financial information: card numbers, bank or routing numbers, passwords, or security codes.", "always", "CRITICAL RULES"],
  ["- If a caller flirts, makes sexual comments, or asks personal questions about you, don't engage or joke along - redirect once, then end the call if it continues.", "always", "OFF-TOPIC, FLIRTING AND ABUSE"],
  // Restrictions - BOOKING / NO_TRANSFER addenda
  ["- Never promise to send an email or text confirmation of a booking - confirm the appointment out loud instead.", "booking", "BOOKING FLOW"],
  ["- If a caller asks for a specific person (\"Is Jeff there?\", \"Can Jennifer call me back?\"), treat it as a normal request to reach them and take a message for that person. Never share private details about staff - whether someone still works here, their schedule or whereabouts, or personal contact information - and never volunteer a name.", "always", "REQUESTS FOR A SPECIFIC PERSON"],
  // Pre-2026-10-06 wording - agents saved earlier still carry it.
  ["- If a caller asks whether a specific person works here, say you're not able to share that kind of information - never confirm or deny it, never say they're unavailable or no longer here, and never volunteer a name. Just offer to pass along a message.", "always", "REQUESTS FOR A SPECIFIC PERSON"],
  // Final Reminders - DEFAULT_FINAL_REMINDERS
  ["- Be helpful without pretending to have access you do not have.", "always", "CRITICAL RULES"],
  ["- Answer from the knowledge base before taking a message when the answer is known.", "always", "KNOWLEDGE BASE"],
  ["- Ask one question at a time - including when taking a message.", "always", "ONE THING AT A TIME"],
  ["- Message-taking is the default handoff when a request can't be completed on the call.", "always", "TAKING A MESSAGE"],
  ["- Every completed message needs the caller's name, a callback number, and a one-line reason - never stop after only the name.", "always", "TAKING A MESSAGE"],
  ["- Never promise a callback time - say someone will call back as soon as they're available.", "always", "TAKING A MESSAGE"],
  ["- Never guess.", "always", "CRITICAL RULES"],
  ["- Wait for the caller to finish before closing.", "always", "CLOSING"],
];

// sha256(normalised text), first 32 hex chars - computed from the frontend's
// INDUSTRY_TEMPLATES (lib/domain/industry-templates.ts) as of 2026-10-05.
// If the frontend seed text changes, add the new hash alongside the old one
// (agents saved earlier still carry the old text).
export const SEEDED_TEMPLATE_PARAGRAPHS = Object.freeze({
  // 2026-10-07: appointment wording removed from the template paragraphs.
  "c38291c6e84ac1265d26a9633315eae6": "medical-dental",
  "92642e7e809a02ec40ccba3401480ace": "restaurant",
  "cc983c367026225288969c19d71e7ab9": "salon-spa",
  "e4fb55a198b502182a0c419720fe8f8c": "home-field-services",
  "211b97b0874bb95b04db6ac6707b1e99": "professional-services",
  "fb17f6f5bce9d042b3dc1112d8e7a556": "customer-support",
  // Earlier wording - saved agents still carry it.
  cc95da3075603e2cb10a05a16a7b5d4b: "general",
  ce10a2795029d0da1072a8bbff78c49f: "medical-dental",
  e82f931836e04a89b0996dc83752d462: "restaurant",
  f41b04caa90b602874f30c279ff28999: "salon-spa",
  "2365b191422d161b42511adda4860864": "home-field-services",
  "77178fa4b9d021237dd5fe9de7be589f": "professional-services",
  "3337b9b67e43067516d1e3d1b36644b3": "customer-support",
});

export const SEEDED_TEMPLATE_EXAMPLES = Object.freeze({
  "92de1e4d7b4b03a4ae715d2b92253312": "general",
  "42caf444056eb0c7ddd3a40565ba6c06": "medical-dental",
  "199d3cafc44b03214192db03e08dd29c": "restaurant",
  "2c7b2eb6933069c1b8aac157bcd7e975": "salon-spa",
  "9dd67fd71fe5c6d2ae12dee6c12e2bc0": "home-field-services",
  "2905236f7db4328620aebae1f6b4cfb1": "professional-services",
  bcf23f7367f90e962226a67f6742ee8d: "customer-support",
  // The same examples for an agent without appointment booking.
  "2165d4cddaed51f47c681c68b62eeffd": "medical-dental",
  "2cdc13957062b66690def45409c6ac28": "restaurant",
  "6658bb4a35d3d3558f999fa069921bf3": "salon-spa",
  ca61027a4b39f8abb7af45a117e24098: "home-field-services",
  "440dcfbd1e5dab0019d1e568c6d097da": "professional-services",
});

export function normalizeLine(line) {
  return String(line ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map(normalizeLine).join("\n").trim();
}

export function seedHash(value) {
  return createHash("sha256").update(normalizeText(value), "utf8").digest("hex").slice(0, 32);
}

const SEEDED_LINE_INDEX = new Map(
  SEEDED_LINES.map(([line, coverage, section]) => [normalizeLine(line), { coverage, section }]),
);

function coveredFor(coverage, cfg) {
  switch (coverage) {
    case "always": return { drop: true };
    case "booking": return cfg.scheduling.enabled
      ? { drop: true }
      : { drop: true, stale: "booking is off - the line refers to scheduling tools this agent does not have" };
    case "transfers": return cfg.transfers.allowed
      ? { drop: true }
      : { drop: true, stale: "transfers are not allowed - the line contradicts that setting" };
    case "noTransfer": return cfg.transfers.allowed
      ? { drop: true, stale: "transfers are allowed - the line contradicts that setting" }
      : { drop: true };
    default: return { drop: false };
  }
}

/**
 * Removes seeded lines the generated prompt already covers.
 * Returns { text, removed: [{ field, line, reason }], templateParagraph }
 * where templateParagraph is the template id whose untouched paragraph was
 * removed (so the prompt can add that template's guidance instead).
 */
export function stripCoveredSeedText(field, value, cfg) {
  const removed = [];
  let templateParagraph = null;
  const kept = [];
  for (const rawLine of String(value ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = normalizeLine(rawLine);
    if (!line) {
      kept.push("");
      continue;
    }
    const known = SEEDED_LINE_INDEX.get(line);
    if (known) {
      const verdict = coveredFor(known.coverage, cfg);
      if (verdict.drop) {
        removed.push({
          field,
          line,
          reason: verdict.stale ?? `already covered by the generated # ${known.section} section`,
        });
        continue;
      }
    }
    if (field === "roleInstructions" && line.length > 200) {
      const templateId = SEEDED_TEMPLATE_PARAGRAPHS[seedHash(line)];
      if (templateId) {
        templateParagraph = templateId;
        removed.push({
          field,
          line: `${line.slice(0, 80)}...`,
          reason: `untouched "${templateId}" template text - replaced by that template's guidance for this configuration`,
        });
        continue;
      }
    }
    kept.push(rawLine.trimEnd());
  }
  return { text: collapseBlankLines(kept), removed, templateParagraph };
}

// An untouched seeded example dialogue (whole field) - returns its template id.
export function seededExampleTemplate(value) {
  const normalized = normalizeText(value);
  return normalized ? SEEDED_TEMPLATE_EXAMPLES[seedHash(normalized)] ?? null : null;
}

function collapseBlankLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim() && (!out.length || !out.at(-1).trim())) continue;
    out.push(line);
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.join("\n").trim();
}
