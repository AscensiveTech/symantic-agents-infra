// Deleting an agent is all-or-nothing from the customer's point of view: the
// agent is only marked deleted once every outside connection is verifiably
// gone. Steps run in order and stop at the first failure; each result is
// saved on the agent, so a retry skips what already succeeded. "Already
// gone" (404) always counts as done, which makes every step safe to repeat.

export const TEARDOWN_STEPS = Object.freeze([
  "calendar",
  "crm",
  "retell_agent",
  "retell_number",
  "telnyx_number",
]);

const FINISHED = new Set(["done", "none"]);

const RETRY_FIX = "Nothing else is needed from you. Click Retry Deletion in a few minutes. If it keeps failing, contact support.";
// Next step for failures only our team can fix; the agent id lets support
// find it.
const supportFix = (agentId) => `This needs our team. Contact support and mention reference ${agentId}.`;

// Reason and next step for a provider error: outages say retry, auth or
// config problems say contact support.
function providerFailure(vendor, what, error, agentId) {
  const status = Number(error?.providerStatus);
  if (!Number.isFinite(status) || status >= 500 || status === 429 || status === 408) {
    return { reason: `${vendor} didn't respond, so ${what} hasn't happened yet.`, fix: RETRY_FIX };
  }
  if (status === 401 || status === 403) {
    return { reason: `${vendor} rejected the request (${status}), so ${what} hasn't happened yet.`, fix: supportFix(agentId) };
  }
  return { reason: `${vendor} returned an error (${status}), so ${what} hasn't happened yet.`, fix: supportFix(agentId) };
}

// Already deleted at the provider counts as done, so retries are safe.
const isGone = (error) => Number(error?.providerStatus) === 404;

/**
 * Runs whatever steps haven't finished yet. Returns { complete, steps } where
 * steps is the full, ordered checklist (earlier results carried over).
 *
 * services: {
 *   disconnectCalendar({ workspaceId, agentId }) -> { status, provider?, accountEmail?, code? }
 *   disconnectCrm({ workspaceId, agentId })      -> { status, accountName?, code? }
 *   retell: { deleteAgentAndLlm, deletePhoneNumber }
 *   telnyx: { releaseNumber }
 * }
 */
export async function runAgentTeardown({ workspaceId, agent, phoneNumber, previous = [], services }) {
  const agentId = agent.agentId;
  const byId = new Map((Array.isArray(previous) ? previous : []).map((step) => [step.id, step]));
  const steps = [];
  let failed = false;

  const runners = {
    // Disconnects this agent's calendar via the oauth Lambda; nothing
    // connected is "none".
    async calendar() {
      let result;
      try {
        result = await services.disconnectCalendar({ workspaceId, agentId });
      } catch {
        return { status: "failed", reason: "Our calendar service didn't respond, so the calendar isn't disconnected yet.", fix: RETRY_FIX };
      }
      if (result?.status === "none") return { status: "none" };
      if (result?.status === "done") return { status: "done", provider: result.provider ?? null, accountEmail: result.accountEmail ?? null };
      const vendor = result?.provider === "google-calendar" ? "Google" : "The calendar provider";
      return result?.code === "provider_unavailable"
        ? { status: "failed", provider: result.provider ?? null, reason: `${vendor} didn't respond, so the calendar isn't disconnected yet.`, fix: RETRY_FIX }
        : { status: "failed", provider: result?.provider ?? null, reason: "We couldn't disconnect the calendar.", fix: supportFix(agentId) };
    },

    // Disconnects this agent's Monday via the CRM Lambda; the calls board
    // stays in Monday.
    async crm() {
      let result;
      try {
        result = await services.disconnectCrm({ workspaceId, agentId });
      } catch {
        return { status: "failed", reason: "Our CRM service didn't respond, so Monday isn't disconnected yet.", fix: RETRY_FIX };
      }
      if (result?.status === "none") return { status: "none" };
      if (result?.status === "done") return { status: "done", accountName: result.accountName ?? null };
      return { status: "failed", reason: "We couldn't disconnect Monday.", fix: supportFix(agentId) };
    },

    // Deletes the Retell agent and its LLM. Never published means "none".
    async retell_agent() {
      if (!agent.retellAgentId) return { status: "none" };
      try {
        await services.retell.deleteAgentAndLlm(agent.retellAgentId);
      } catch (error) {
        if (!isGone(error)) return { status: "failed", ...providerFailure("Retell", "the AI agent's removal", error, agentId) };
      }
      return { status: "done" };
    },

    // Removes the number from Retell.
    async retell_number() {
      if (!phoneNumber?.retellPhoneNumberId) return { status: "none" };
      try {
        await services.retell.deletePhoneNumber(phoneNumber.retellPhoneNumberId);
      } catch (error) {
        if (!isGone(error)) return { status: "failed", ...providerFailure("Retell", "unlinking the phone number", error, agentId) };
      }
      return { status: "done", phoneNumber: phoneNumber.telnyxPhoneNumber ?? null };
    },

    // Releases the number at Telnyx so it stops billing.
    async telnyx_number() {
      if (!phoneNumber?.telnyxNumberId) return { status: "none" };
      try {
        await services.telnyx.releaseNumber(phoneNumber.telnyxNumberId);
      } catch (error) {
        if (!isGone(error)) return { status: "failed", phoneNumber: phoneNumber.telnyxPhoneNumber ?? null, ...providerFailure("Telnyx", `releasing ${phoneNumber.telnyxPhoneNumber ?? "the phone number"}`, error, agentId) };
      }
      return { status: "done", phoneNumber: phoneNumber.telnyxPhoneNumber ?? null };
    },
  };

  for (const id of TEARDOWN_STEPS) {
    const earlier = byId.get(id);
    if (earlier && FINISHED.has(earlier.status)) {
      steps.push(earlier);
      continue;
    }
    if (failed) {
      steps.push({ id, status: "pending" });
      continue;
    }
    const result = await runners[id]();
    steps.push({ id, ...result });
    if (!FINISHED.has(result.status)) failed = true;
  }
  return { complete: !failed, steps };
}
