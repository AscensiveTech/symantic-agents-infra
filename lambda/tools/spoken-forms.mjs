// "Say It As" pronunciations: a word the voice mispronounces (an acronym
// like "C.W.R.") paired with plain words that say it right ("See
// Double-You Are"). Unlike IPA/CMU entries this works on every voice model
// and language: only what we send Retell (the prompt and greeting) uses the
// spoken form, and everything people read - transcripts, summaries,
// messages, emails, the CRM - is turned back into the real word.
//
// This file is copied verbatim into lambda/postcall and lambda/tools (each
// Lambda is packaged on its own); spoken-forms.test.mjs checks the copies
// match.

const MAX_SPOKEN_FORMS = 10;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The agent's Say It As entries: [{ word, sayAs }]. */
export function resolveSpokenForms(agent) {
  const raw = agent?.configuration?.pronunciationDictionary;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object" && entry.alphabet === "plain")
    .map((entry) => ({ word: text(entry.word), sayAs: text(entry.phoneme) }))
    .filter((entry) => entry.word && entry.sayAs && entry.word.toLowerCase() !== entry.sayAs.toLowerCase())
    .slice(0, MAX_SPOKEN_FORMS);
}

// An acronym ("C.W.R.", "CWR", "C W R") matches however it's punctuated or
// spaced; anything else matches as written, ignoring case and spacing.
function wordPattern(word) {
  const letters = word.replace(/[.\s]/g, "");
  const isAcronym = /^[A-Za-z0-9]{2,8}$/.test(letters) && (/[.\s]/.test(word) || letters === letters.toUpperCase());
  const body = isAcronym
    ? letters.split("").map(escapeRegex).join("[.\\s]*") + "\\.?"
    : word.split(/\s+/).map(escapeRegex).join("\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi");
}

// The spoken form as it comes back in a transcript: any mix of spaces,
// hyphens or commas between its words, any case.
function sayAsPattern(sayAs) {
  const body = sayAs.split(/[\s\-–—,.]+/).filter(Boolean).map(escapeRegex).join("[\\s\\-–—,.]*");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "gi");
}

/** Text the voice will read: each word becomes its spoken form. */
export function toSpokenText(value, forms) {
  if (typeof value !== "string" || !forms?.length) return value;
  return forms.reduce((result, { word, sayAs }) => result.replace(wordPattern(word), sayAs), value);
}

/** Text a person will read: each spoken form becomes the real word again. */
export function toWrittenText(value, forms) {
  if (typeof value !== "string" || !forms?.length) return value;
  return forms.reduce((result, { word, sayAs }) => result.replace(sayAsPattern(sayAs), word), value);
}

/** Applies toWrittenText to every string inside a value (objects, arrays). */
export function toWrittenDeep(value, forms) {
  if (!forms?.length) return value;
  if (typeof value === "string") return toWrittenText(value, forms);
  if (Array.isArray(value)) return value.map((item) => toWrittenDeep(item, forms));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWrittenDeep(item, forms)]));
  }
  return value;
}

/** The prompt rule for words that reach the agent some other way (the
 *  knowledge base, the caller, a tool result). */
export function spokenFormsRule(forms) {
  if (!forms?.length) return "";
  return [
    "# SAYING NAMES",
    "Whenever you say one of these, write it exactly as shown after the arrow so it's pronounced correctly - in every reply, even if it appears differently in the knowledge base or a tool result:",
    ...forms.map(({ word, sayAs }) => `- ${word} -> ${sayAs}`),
  ].join("\n");
}
