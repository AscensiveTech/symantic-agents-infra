// Canonical Voice Agent Configuration.
//
// The single place that reads the raw stored agent record (agent.configuration,
// as saved by the wizard) plus the workspace Business Profile, applies every
// default, clamp, and legacy fallback, and returns one plain, vendor-neutral
// object. Every downstream builder - prompt, tools, Retell payload, post-call,
// inspector - reads only this object, never agent.configuration directly, so a
// field's meaning is decided exactly once.
//
// Nothing in here knows Retell's field names. See retell.mjs for that.

import { isBusinessHours } from "../business-hours.mjs";
import { resolveSpokenForms } from "./spoken-forms.mjs";

export const CANONICAL_SCHEMA_VERSION = 1;

// Call-handling defaults + clamp bounds. Keep identical to the frontend
// mirror in lib/domain/call-handling.ts.
export const CALL_HANDLING = {
  silence: { defaultSec: 60, minSec: 10, maxSec: 300 },
  maxDuration: { defaultMin: 10, minMin: 1, maxMin: 30 },
};

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
export const UNEDITABLE_PROFILE_FIELDS = Object.freeze([
  "description",
  "faqs",
  "policies",
  "escalationContact",
  "fallbackPhone",
  "communicationStyle",
  "businessType",
]);

// Stored agent fields that have no screen any more, or that only drive the
// wizard itself. Listed so the inspector can say they were deliberately
// ignored rather than silently lost.
export const IGNORED_AGENT_FIELDS = Object.freeze({
  intents: "legacy - no screen edits it; never reaches the agent",
  escalation: "legacy - superseded by Call Transfer rules",
  template: "internal product key (always \"receptionist\")",
  businessConfirmed: "wizard progress flag",
  completedSteps: "wizard progress flag",
  tested: "wizard test status",
  testRunCount: "wizard test status",
  testCorrection: "wizard test notes",
  platformDid: "telephony record, set by provisioning",
  desiredPhoneNumber: "telephony - used only when ordering a number",
  phone: "used only to pick an area code when ordering a number",
  receptionistPlan: "billing plan",
  calendarSelectionId: "calendar connection record (calendar_connections table)",
  knowledgeBaseText: "legacy per-agent knowledge - migrated into the knowledge base hub on first sync",
  knowledgeBaseFiles: "legacy per-agent knowledge - migrated into the knowledge base hub on first sync",
  legacyKnowledgeMigrated: "migration marker",
});

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

// ISO 3166-1 alpha-2 list of countries allowed to call inbound. Empty =
// accept calls from anywhere.
export function resolveAllowedInboundCountries(agent) {
  const raw = agent?.configuration?.allowedInboundCountries;
  if (!Array.isArray(raw)) return [];
  return [...new Set(
    raw
      .map((code) => (typeof code === "string" ? code.trim().toUpperCase() : ""))
      .filter((code) => /^[A-Z]{2}$/.test(code)),
  )];
}

// Mirrored in the frontend's lib/domain/ambient-sound.ts. Anything else (a
// stale or hand-edited value) sends no sound rather than being rejected at
// publish time.
export const AMBIENT_SOUNDS = Object.freeze([
  "coffee-shop",
  "convention-hall",
  "summer-outdoor",
  "mountain-outdoor",
  "static-noise",
  "call-center",
]);

export function resolveAmbientSound(agent) {
  const value = text(agent?.configuration?.ambientSound);
  return AMBIENT_SOUNDS.includes(value) ? value : null;
}

const AMBIENT_SOUND_VOLUME_MIN = 0.1;
const AMBIENT_SOUND_VOLUME_MAX = 1;
const AMBIENT_SOUND_VOLUME_DEFAULT = 0.5;

export function resolveAmbientSoundVolume(agent) {
  const raw = agent?.configuration?.ambientSoundVolume;
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : AMBIENT_SOUND_VOLUME_DEFAULT;
  return Math.min(AMBIENT_SOUND_VOLUME_MAX, Math.max(AMBIENT_SOUND_VOLUME_MIN, value));
}

// Retell's own allowed alphabets also include pinyin/jyutping, but only IPA
// and CMU are offered in our UI.
export const PRONUNCIATION_ALPHABETS = Object.freeze(["ipa", "cmu"]);
const PRONUNCIATION_DICTIONARY_MAX_ENTRIES = 10;

// Keeps only complete, valid entries and caps at 10 - a server-side backstop
// behind the UI's own cap and validation.
export function resolvePronunciationDictionary(agent) {
  const raw = agent?.configuration?.pronunciationDictionary;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      word: text(entry.word),
      alphabet: text(entry.alphabet),
      phoneme: text(entry.phoneme),
    }))
    .filter((entry) => entry.word && entry.phoneme && PRONUNCIATION_ALPHABETS.includes(entry.alphabet))
    .slice(0, PRONUNCIATION_DICTIONARY_MAX_ENTRIES);
}

// Only these two are offered in our UI today.
export const SUPPORTED_LANGUAGES = Object.freeze({
  "en-US": "English",
  "es-419": "Spanish (Latin American)",
});

export function resolveLanguage(agent) {
  const raw = text(agent?.configuration?.language);
  return Object.hasOwn(SUPPORTED_LANGUAGES, raw) ? raw : "en-US";
}

export function resolveStartSpeaker(agent) {
  return agent?.configuration?.startSpeaker === "user" ? "user" : "agent";
}

// The UI exposes just 0 or 1 second.
export function resolvePauseBeforeSpeakingMs(agent) {
  const raw = Number(agent?.configuration?.pauseBeforeSpeakingMs);
  return raw === 1000 ? 1000 : 0;
}

// How far ahead a booking agent may schedule, 1-60 days; agents saved before
// the setting existed get 30. Mirrored in lambda/tools/handlers/appointment-types.mjs.
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

// The greeting the agent speaks first: the Custom Greeting Message when set,
// otherwise one built from the real business/agent name - never a blank or
// placeholder greeting. Mirrors buildSampleGreeting in the wizard.
export function resolveGreeting(agent, workspaceProfile) {
  return greetingFor(agent, effectiveProfile(agent, workspaceProfile)).text;
}

// Mirrors buildSampleGreeting in the wizard (agent-wizard.tsx), which writes
// this text into `greeting` for every new agent and promises that a blank
// greeting uses it - so blank and untouched behave the same.
export function sampleGreeting(language, businessName, agentName, withDisclosure) {
  if (language === "es-419") {
    const business = businessName || "su negocio";
    const agent = agentName || "su agente de voz";
    const disclosure = withDisclosure ? " Esta llamada puede ser grabada para fines de calidad." : "";
    return `Gracias por llamar a ${business}.${disclosure} En este momento no estamos en la oficina, probablemente estamos `
      + `en un trabajo. Por eso, le pedimos a nuestra recepcionista virtual, ${agent}, que le atienda mientras no podemos `
      + "hacerlo. ¿En qué le podemos ayudar hoy?";
  }
  const business = businessName || "your business";
  const agent = agentName || "your AI Voice Agent";
  const disclosure = withDisclosure ? " This call may be recorded for quality assurance." : "";
  return `Thanks for calling ${business}.${disclosure} We are currently away from our desk, likely at a job site. So, `
    + `we have tasked our virtual receptionist, ${agent}, to assist you while we are unable to do so. How can we help you today?`;
}

// The default greeting the backend sent before 2026-10-05 (blank greeting).
// Only used to recognise an untouched live agent in retellEditStatus.
export function legacyDefaultGreeting(agent, workspaceProfile) {
  const profile = effectiveProfile(agent, workspaceProfile);
  const disclosure = agent?.configuration?.recordingDisclosure ? " This call may be recorded for quality assurance." : "";
  return `Thanks for calling ${text(profile?.businessName) || "the business"}.${disclosure} This is ${spokenAgentName(agent)}, `
    + "the virtual receptionist. How can I help you today?";
}

// True for a prompt with the structure every Symantic generator version has
// produced, as opposed to one written by hand in the Retell dashboard.
export function looksAppGeneratedPrompt(prompt) {
  return typeof prompt === "string"
    && /^# ROLE\nYou are .+, the AI receptionist for /.test(prompt)
    && prompt.includes("\n# CRITICAL RULES\n")
    && prompt.includes("\n# CLOSING\n");
}

function greetingFor(agent, profile) {
  const configured = text(agent?.configuration?.greeting);
  const language = resolveLanguage(agent);
  const businessName = text(profile?.businessName);
  const receptionistName = spokenAgentName(agent);
  const disclosure = agent?.configuration?.recordingDisclosure === true;
  const defaultGreeting = { text: sampleGreeting(language, businessName, receptionistName, disclosure), source: "default" };
  if (!configured) return defaultGreeting;
  // The wizard seeds the English sample before a language is picked, so a
  // Spanish agent whose greeting is still that untouched sample gets the
  // Spanish one instead of greeting callers in English.
  if (language !== "en-US"
    && [true, false].some((withDisclosure) => configured === sampleGreeting("en-US", businessName, receptionistName, withDisclosure))) {
    return defaultGreeting;
  }
  return { text: configured, source: "custom" };
}

export function isIanaTimezone(value) {
  if (typeof value !== "string" || !value.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the canonical configuration.
 *
 * @param agent             stored agent record ({ id, name, configuration, ... })
 * @param workspaceProfile  workspace Business Profile (per-agent values win)
 * @param options.knowledgeBases  [{ knowledgeBaseId, retellKnowledgeBaseId, name? }]
 *        the agent's assigned knowledge bases, already resolved by the caller.
 *        When omitted, the assigned ids on the agent are used without Retell ids.
 */
export function buildVoiceAgentConfiguration(agent, workspaceProfile, { knowledgeBases } = {}) {
  const config = agent?.configuration ?? {};
  const profile = effectiveProfile(agent, workspaceProfile);
  const timezoneRaw = text(profile.timezone);
  const timezoneValid = isIanaTimezone(timezoneRaw);
  const usesCalCom = Array.isArray(config.connections) && config.connections.includes("cal-com");
  const bookingEnabled = config.booking === true;
  const allowTransfers = config.allowCallTransfers !== false;
  const defaultTransferNumber = toE164(profile.ownerPhone);
  const callHandling = resolveCallHandling(agent);
  const greeting = greetingFor(agent, profile);

  const assignedIds = Array.isArray(config.knowledgeBaseIds)
    ? config.knowledgeBaseIds.filter((id) => typeof id === "string" && id)
    : [];
  const resolvedKnowledgeBases = Array.isArray(knowledgeBases)
    ? knowledgeBases
      .filter((item) => item && text(item.retellKnowledgeBaseId))
      .map((item) => ({
        knowledgeBaseId: text(item.knowledgeBaseId) || null,
        retellKnowledgeBaseId: text(item.retellKnowledgeBaseId),
        ...(text(item.name) ? { name: text(item.name) } : {}),
      }))
    : assignedIds.map((knowledgeBaseId) => ({ knowledgeBaseId, retellKnowledgeBaseId: null }));

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    identity: {
      agentId: text(agent?.id) || text(agent?.agentId) || null,
      internalName: text(config.name) || text(agent?.name) || null,
      spokenName: spokenAgentName(agent),
      templateId: text(config.industryTemplate) || null,
    },
    business: {
      name: sanitizeName(profile.businessName) || "the business",
      nameProvided: Boolean(sanitizeName(profile.businessName)),
      phone: text(profile.phone) || null,
      address: text(profile.address) || null,
      mailingAddress: text(profile.mailingAddress) && text(profile.mailingAddress) !== text(profile.address)
        ? text(profile.mailingAddress)
        : null,
      website: text(profile.website) || null,
      timezone: timezoneValid ? timezoneRaw : "UTC",
      timezoneConfigured: timezoneRaw || null,
      timezoneValid,
      weeklyHours: isBusinessHours(profile.businessHours) ? profile.businessHours : null,
      hoursText: text(profile.hours) || null,
      holidays: resolveHolidays(profile),
      contactEmails: Array.isArray(profile.contactEmails)
        ? profile.contactEmails
          .filter((entry) => text(entry?.email))
          .map((entry) => ({ label: text(entry.label) || null, email: text(entry.email) }))
        : [],
      serviceAreas: Array.isArray(profile.serviceAreas) ? profile.serviceAreas.map(text).filter(Boolean) : [],
      defaultTransferNumber,
    },
    voice: {
      mode: config.voiceMode === "cloned" ? "cloned" : "platform",
      catalogVoice: text(config.voice) || null,
      clonedVoiceId: config.voiceMode === "cloned" ? text(config.voiceId) || null : null,
      tone: text(config.tone) || null,
      language: resolveLanguage(agent),
      ambientSound: resolveAmbientSound(agent),
      ambientSoundVolume: resolveAmbientSoundVolume(agent),
      pronunciations: resolvePronunciationDictionary(agent),
      spokenForms: resolveSpokenForms(agent),
    },
    conversation: {
      startSpeaker: resolveStartSpeaker(agent),
      pauseBeforeSpeakingMs: resolvePauseBeforeSpeakingMs(agent),
      greeting: greeting.text,
      greetingSource: greeting.source,
      recordingDisclosure: config.recordingDisclosure === true,
    },
    knowledge: {
      assignedKnowledgeBaseIds: assignedIds,
      knowledgeBases: resolvedKnowledgeBases,
    },
    scheduling: {
      enabled: bookingEnabled,
      provider: usesCalCom ? "cal-com" : "calendar",
      bookingWindowDays: resolveBookingWindowDays(agent),
      appointmentTypes: usesCalCom ? [] : resolveAppointmentTypes(config.appointmentTypes),
      calComEventTypes: usesCalCom ? resolveCalComEventTypes(config.calComEventTypes) : [],
      invites: {
        startTimeInTitle: config.inviteStartTimeInTitle === true,
        reminderMinutes: Number.isFinite(Number(config.inviteReminderMinutes))
          && config.inviteReminderMinutes !== null && config.inviteReminderMinutes !== ""
          ? Math.round(Number(config.inviteReminderMinutes))
          : null,
        bookingInviteEmail: text(config.bookingInviteEmail) || null,
      },
    },
    transfers: {
      allowed: allowTransfers,
      rules: allowTransfers ? resolveTransferRules(config.emergencyRules, defaultTransferNumber) : [],
      legacyMessageRules: resolvePhraseMessageRules(
        (Array.isArray(config.emergencyRules) ? config.emergencyRules : []).filter((rule) => rule?.action === "decline"),
      ),
      noTransferRules: allowTransfers ? [] : resolvePhraseMessageRules(config.noTransferRules),
      droppedRules: allowTransfers ? droppedTransferRules(config.emergencyRules, defaultTransferNumber) : [],
    },
    callHandling: {
      spamScreening: config.spamScreening !== false,
      silenceTimeoutSec: callHandling.silenceSec,
      maxCallDurationMin: callHandling.maxDurationMin,
      allowedInboundCountries: resolveAllowedInboundCountries(agent),
    },
    customInstructions: {
      roleInstructions: text(config.roleInstructions),
      restrictions: text(config.restrictions),
      exampleDialogues: text(config.exampleDialogues),
      finalReminders: text(config.finalReminders),
    },
    ignoredFields: Object.keys(IGNORED_AGENT_FIELDS).filter((field) => config[field] !== undefined),
  };
}

// Off (or never set) means the business keeps its normal hours on every
// holiday. Disabled entries are suggestions the owner didn't add.
function resolveHolidays(profile) {
  if (profile?.holidaysEnabled !== true || !Array.isArray(profile?.holidays)) return [];
  return profile.holidays
    .filter((holiday) => !holiday?.disabled && text(holiday?.name) && text(holiday?.date))
    .map((holiday) => ({
      name: text(holiday.name),
      date: text(holiday.date),
      closed: holiday.closed === true,
      hours: holiday.closed === true ? null : text(holiday.hours) || null,
    }));
}

function resolveAppointmentTypes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((type) => text(type?.name))
    .map((type) => ({
      name: text(type.name),
      durationMin: positiveMinutes(type.durationMin) ?? 30,
      minimumLeadTimeMin: positiveMinutes(type.minimumLeadTimeMin) ?? 0,
      blockBeforeMin: positiveMinutes(type.blockBeforeMin) ?? 0,
      blockAfterMin: positiveMinutes(type.blockAfterMin) ?? 0,
      atCustomerLocation: type.happensAtCustomerLocation === true,
    }));
}

function resolveCalComEventTypes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((eventType) => text(eventType?.name))
    .map((eventType) => ({
      name: text(eventType.name),
      durationMin: positiveMinutes(eventType.lengthInMinutes),
    }));
}

// One entry per Allow rule that can actually transfer: it needs at least one
// phrase, and a number - its own, or the agent's Default Transfer Number when
// it has none. Legacy "decline" rules only speak a message and never transfer.
function resolveTransferRules(rules, fallback) {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) => {
    if (rule?.action === "decline") return [];
    const phrases = Array.isArray(rule?.phrases) ? rule.phrases.map(text).filter(Boolean) : [];
    const number = toE164(rule?.transferTarget) || fallback;
    if (!phrases.length || !number) return [];
    const extension = text(rule?.extension).replace(/\D/g, "").slice(0, 6);
    return [{
      phrases,
      number,
      extension: extension || null,
      usesDefaultNumber: !toE164(rule?.transferTarget),
    }];
  });
}

function droppedTransferRules(rules, fallback) {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule, index) => {
    if (rule?.action === "decline") return [];
    const phrases = Array.isArray(rule?.phrases) ? rule.phrases.map(text).filter(Boolean) : [];
    const number = toE164(rule?.transferTarget) || fallback;
    if (phrases.length && number) return [];
    // A blank seeded row (no phrases, no number) is the wizard's starting
    // state, not a broken rule - only report rows someone half-filled.
    if (!phrases.length && !text(rule?.transferTarget)) return [];
    return [{ index, reason: phrases.length ? "no valid transfer number" : "no phrases" }];
  });
}

function resolvePhraseMessageRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule) => {
    const phrases = Array.isArray(rule?.phrases) ? rule.phrases.map(text).filter(Boolean) : [];
    const message = text(rule?.message);
    return phrases.length && message ? [{ phrases, message }] : [];
  });
}

function positiveMinutes(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sanitizeName(value) {
  return text(value).replace(/\s+/g, " ");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function toE164(value) {
  const raw = text(value);
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
