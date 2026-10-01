// What the live receptionist is told about a caller the CRM recognises.
// CRM fields are text anyone at the business can edit, so they are treated
// as untrusted: stripped of anything that could read as markup, template
// syntax or instructions, capped in length, and presented as labelled data.
// The prompt section that receives this (receptionist.mjs) tells the agent
// to use it only to personalise, never to disclose it.

export const NO_CRM_CONTEXT = "Not available.";

const FIELD_MAX = 60;

export function buildCallerContext(contact) {
  if (!contact) return NO_CRM_CONTEXT;
  const name = clean(contact.name);
  // The columns the admin picked for the AI to read, as "Title: value".
  const details = (contact.details ?? [])
    .map((detail) => {
      const title = clean(detail.title);
      const text = clean(detail.text);
      return title && text ? `${title}: ${text}` : null;
    })
    .filter(Boolean)
    .slice(0, 5);
  // Older setups read status and owner instead.
  const status = details.length ? null : clean(contact.status);
  const owner = details.length ? null : clean(contact.ownerName);
  if (!name && !details.length && !status && !owner) return NO_CRM_CONTEXT;
  const parts = [
    "Existing contact in the business's CRM",
    name ? `name on file: ${name}` : null,
    ...details,
    status ? `status: ${status}` : null,
    owner ? `account owner: ${owner}` : null,
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

function clean(value) {
  if (typeof value !== "string") return null;
  const text = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[{}<>[\]`#*_|\\"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX - 1).trim()}…` : text;
}
