// Shared fixtures for the voice-agent tests. Businesses are invented.

const open = (...intervals) => ({ closed: false, intervals: intervals.map(([o, c]) => ({ open: o, close: c })) });
const closed = { closed: true, intervals: [{ open: "09:00", close: "17:00" }] };
const allDay = { closed: false, allDay: true, intervals: [] };

export const WEEKDAYS_9_TO_5 = {
  mon: open(["09:00", "17:00"]),
  tue: open(["09:00", "17:00"]),
  wed: open(["09:00", "17:00"]),
  thu: open(["09:00", "17:00"]),
  fri: open(["09:00", "17:00"]),
  sat: closed,
  sun: closed,
};

export const SPLIT_HOURS_WITH_24H_WEEKEND = {
  mon: open(["08:00", "12:00"], ["13:00", "18:00"]),
  tue: open(["08:00", "12:00"], ["13:00", "18:00"]),
  wed: closed,
  thu: open(["08:00", "12:00"], ["13:00", "18:00"]),
  fri: open(["08:00", "12:00"], ["13:00", "18:00"]),
  sat: allDay,
  sun: allDay,
};

export const workspaceProfile = {
  businessName: "Brightwater Plumbing & Heating",
  businessType: "plumbing",
  description: "SAMPLE DESCRIPTION THAT MUST NEVER APPEAR",
  faqs: [{ question: "Sample FAQ?", answer: "Sample answer that must never appear." }],
  policies: "Sample policy that must never appear.",
  escalationContact: "+15555550199",
  fallbackPhone: "+15555550188",
  communicationStyle: "Sample style",
  address: "410 Canal Street, Dayton, OH 45402",
  timezone: "America/New_York",
  phone: "(937) 555-0140",
  hours: "Mon-Fri 9-5",
  businessHours: WEEKDAYS_9_TO_5,
  ownerPhone: "(937) 555-0141",
};

export function minimalAgent(overrides = {}) {
  return {
    id: "agent-min",
    name: "Ava",
    configuration: { name: "Ava", ...overrides },
  };
}

// Everything on, as a customer who filled in every screen would have it.
export function fullAgent(overrides = {}) {
  return {
    id: "agent-full",
    name: "Brightwater - Main Line",
    status: "active",
    configuration: {
      template: "receptionist",
      industryTemplate: "home-field-services",
      name: "Brightwater - Main Line",
      spokenName: "Nora",
      voice: "11labs-Hailey",
      voiceMode: "platform",
      voiceId: "",
      tone: "Warm, concise, and professional",
      greeting: "",
      recordingDisclosure: true,
      language: "en-US",
      startSpeaker: "agent",
      pauseBeforeSpeakingMs: 1000,
      ambientSound: "call-center",
      ambientSoundVolume: 0.3,
      pronunciationDictionary: [{ word: "Brightwater", alphabet: "ipa", phoneme: "ˈbraɪtˌwɔtər" }],
      roleInstructions: "- Ask whether the home is a rental or owner-occupied.",
      restrictions: "- Never discuss competitors.",
      exampleDialogues: "Caller: Do you fix water heaters?\nYou: We do - is it gas or electric?",
      finalReminders: "- Always mention the 24-hour emergency line only if asked.",
      knowledgeBaseIds: ["kb-services", "kb-pricing"],
      booking: true,
      bookingWindowDays: 21,
      bookingInviteEmail: "office@brightwater.example",
      inviteStartTimeInTitle: true,
      inviteReminderMinutes: 60,
      connections: ["google-calendar"],
      appointmentTypes: [
        { id: "t1", name: "Phone Consultation", durationMin: 15, minimumLeadTimeMin: 60 },
        { id: "t2", name: "In-Home Estimate", durationMin: 45, minimumLeadTimeMin: 1440, blockBeforeMin: 30, blockAfterMin: 30, happensAtCustomerLocation: true },
      ],
      allowCallTransfers: true,
      emergencyRules: [
        { id: "r1", phrases: ["gas leak", "flooding"], transferTarget: "(937) 555-0150" },
        { id: "r2", phrases: ["billing"], transferTarget: "", extension: "12" },
      ],
      spamScreening: true,
      silenceTimeoutSec: 45,
      maxCallDurationMin: 15,
      allowedInboundCountries: ["us", "CA"],
      businessProfile: {
        businessName: "Brightwater Plumbing & Heating",
        phone: "(937) 555-0140",
        address: "410 Canal Street, Dayton, OH 45402",
        mailingAddress: "PO Box 88, Dayton, OH 45401",
        website: "https://brightwater.example",
        timezone: "America/New_York",
        hours: "Mon-Fri 8-6",
        businessHours: SPLIT_HOURS_WITH_24H_WEEKEND,
        holidaysEnabled: true,
        holidays: [
          { id: "h1", name: "Thanksgiving", date: "2026-11-26", closed: true },
          { id: "h2", name: "Christmas Eve", date: "2026-12-24", closed: false, hours: "8 AM - 12 PM" },
          { id: "h3", name: "Labor Day", date: "2026-09-07", closed: true, disabled: true },
        ],
        contactEmails: [{ label: "Billing", email: "billing@brightwater.example" }],
        serviceAreas: ["Dayton, OH", "Kettering, OH", "45402"],
        ownerPhone: "(937) 555-0141",
      },
      // Legacy / internal fields that must not reach Retell.
      intents: ["Scheduling"],
      escalation: "Old free-text escalation that must never appear.",
      platformDid: "+19375550199",
      receptionistPlan: "growth",
      ...overrides,
    },
  };
}

export const knowledgeBases = [
  { knowledgeBaseId: "kb-services", retellKnowledgeBaseId: "knowledge_base_svc", name: "Services" },
  { knowledgeBaseId: "kb-pricing", retellKnowledgeBaseId: "knowledge_base_price", name: "Pricing" },
];

export const BUILD = {
  workspaceId: "ws-test",
  toolBaseUrl: "https://tools.example.com",
  voiceId: "11labs-Hailey",
};
