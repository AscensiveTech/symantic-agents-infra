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
  const status = clean(contact.status);
  const owner = clean(contact.ownerName);
  if (!name && !status && !owner) return NO_CRM_CONTEXT;
  const parts = [
    "Existing contact in the business's CRM",
    name ? `name on file: ${name}` : null,
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
