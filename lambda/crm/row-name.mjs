// Rows the AI receptionist adds to the customer's own board are titled
// "<agent>-<caller name>", or "<agent>-New Contact" when it didn't get a
// name, so they stand out in Monday without adding any column. The caller's
// real name is saved with the link, so the AI greets them by it, never by
// the row title.

export const NEW_CONTACT = "New Contact";
const NAME_MAX = 255;

export function aiRowName(agentName, callerName) {
  const agent = typeof agentName === "string" && agentName.trim() ? agentName.trim() : "AI Receptionist";
  const caller = typeof callerName === "string" && callerName.trim() ? callerName.trim() : NEW_CONTACT;
  return `${agent}-${caller}`.slice(0, NAME_MAX);
}

// The caller's name for a row: while the row still has the title we gave it,
// the name we saved with it (null when it was "New Contact"); once a person
// has edited the row, its name as they wrote it.
export function personName(rowName, link) {
  if (link?.lastWrittenName && rowName === link.lastWrittenName && typeof link.aiName === "string") {
    return link.aiName || null;
  }
  return rowName ?? null;
}
