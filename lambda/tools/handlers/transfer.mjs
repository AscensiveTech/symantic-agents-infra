export async function handleTransfer(input, { store }) {
  const [agent, profile] = await Promise.all([
    store.getAgent(input.workspaceId, stringOrUndefined(input.agentId)),
    store.getBusinessProfile(input.workspaceId),
  ]);
  const configuration = agent?.configuration ?? {};
  const reason = stringOrUndefined(input.reason) || "";
  const emergency = /emergency|urgent|danger|life[- ]?threat/i.test(reason);
  const policyCandidates = emergency
    ? [
      configuration.emergencyTransferTarget,
      configuration.emergencyPhone,
      configuration.escalationTransferTarget,
      configuration.escalationPhone,
      configuration.escalation,
    ]
    : [
      configuration.escalationTransferTarget,
      configuration.escalationPhone,
      configuration.transferTarget,
      configuration.escalation,
    ];
  const transferTarget = [
    ...policyCandidates,
    profile?.escalationContact,
    profile?.ownerPhone,
    profile?.fallbackPhone,
  ].map(extractPhone).find(Boolean);

  if (!transferTarget) {
    return {
      ok: false,
      action: "take_message",
      code: "transfer_unavailable",
      message: "I’m unable to transfer you right now. I can take a message for the office.",
    };
  }
  return {
    ok: true,
    action: "transfer",
    transferTarget,
    message: "Please hold while I connect you.",
  };
}

function extractPhone(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\+?\d[\d().\s-]{7,}\d/);
  if (!match) return null;
  const hasPlus = match[0].trim().startsWith("+");
  const digits = match[0].replace(/\D/g, "");
  if (hasPlus && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
