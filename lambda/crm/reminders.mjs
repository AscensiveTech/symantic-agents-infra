// Emails the workspace before (and when) its Monday grant ends. Monday grants
// hard-expire six months after consent and cannot be extended, so the only
// fix is a reconnect; these make sure someone knows to do it.

import { agentIdOf } from "./provider.mjs";

const DAY_MS = 86_400_000;
const STAGES = ["14d", "3d", "expired"];

export function reminderStage(connection, nowMs) {
  if (connection?.connectionState === "reauth_required") return "expired";
  if (connection?.connectionState !== "connected") return null;
  const expiry = Number(connection.refreshTokenExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;
  const left = expiry - nowMs;
  if (left <= 3 * DAY_MS) return "3d";
  if (left <= 14 * DAY_MS) return "14d";
  return null;
}

function isNewerStage(stage, sent) {
  return STAGES.indexOf(stage) > STAGES.indexOf(sent ?? "");
}

export function createReauthReminders({ store, sendEmail, appUrl, now = Date.now, log = console }) {
  // The admin who connected this agent's Monday (or, if they've left, every
  // active company admin) plus the people on the workspace's "Monday
  // Reconnect Reminders" list. Nobody when that setting is switched off.
  async function recipients(connection, settings) {
    if (settings?.enabled === false) return [];
    const connector = connection.authorizedBy ? await store.getMembership(connection.authorizedBy).catch(() => null) : null;
    const primary = connector?.workspaceId === connection.workspaceId && connector.status === "active" && connector.email
      ? [connector.email]
      : (await store.listWorkspaceAdmins(connection.workspaceId)).map((admin) => admin.email);
    const extra = Array.isArray(settings?.recipients) ? settings.recipients : [];
    return [...new Set([...primary, ...extra].filter(Boolean).map((email) => String(email).toLowerCase()))];
  }

  // One email per inactive spell when the Monday account itself is
  // suspended, closed or unpaid.
  async function notifyInactive(connection) {
    if (connection.accountInactiveNotifiedAt) return false;
    const settings = await store.getCrmReminderSettings?.(connection.workspaceId).catch(() => null);
    const to = await recipients(connection, settings);
    if (!to.length) return false;
    if (!await store.markAccountInactiveNotified(connection.workspaceId, connection.provider)) return false;
    const agentId = connection.agentId ?? agentIdOf(connection.provider);
    const agent = agentId ? await store.getAgent(connection.workspaceId, agentId).catch(() => null) : null;
    const message = renderInactiveEmail({ connection, appUrl, agentId, agentName: agent?.name ?? null });
    for (const address of to) {
      try {
        await sendEmail({ to: address, ...message });
      } catch (error) {
        log.warn?.("Monday account-inactive notice not sent", { workspaceId: connection.workspaceId, name: error?.name });
      }
    }
    return true;
  }

  return async function remind(connection) {
    if (!sendEmail) return false;
    if (connection.pauseReason === "account_inactive" && Number(connection.pausedUntil) > Number(now())) {
      return notifyInactive(connection);
    }
    const stage = reminderStage(connection, Number(now()));
    if (!stage || !isNewerStage(stage, connection.reauthReminderStage)) return false;
    const settings = await store.getCrmReminderSettings?.(connection.workspaceId).catch(() => null);
    const to = await recipients(connection, settings);
    if (!to.length) return false;
    // Claim the stage first: a crash after sending must not email twice.
    const claimed = await store.markReauthReminder(connection.workspaceId, connection.provider, stage, connection.reauthReminderStage ?? null);
    if (!claimed) return false;
    const agentId = connection.agentId ?? agentIdOf(connection.provider);
    const agent = agentId ? await store.getAgent(connection.workspaceId, agentId).catch(() => null) : null;
    const message = renderReauthEmail({ stage, connection, appUrl, agentId, agentName: agent?.name ?? null });
    for (const address of to) {
      try {
        await sendEmail({ to: address, ...message });
      } catch (error) {
        log.warn?.("Monday reconnect reminder not sent", { workspaceId: connection.workspaceId, stage, name: error?.name });
      }
    }
    return true;
  };
}

export function renderReauthEmail({ stage, connection, appUrl, agentId = null, agentName = null }) {
  const base = `${String(appUrl ?? "").replace(/\/+$/, "")}/integrations`;
  const link = agentId ? `${base}?agentId=${encodeURIComponent(agentId)}&crm=renew` : `${base}?crm=renew`;
  const account = connection.accountName ? ` (${connection.accountName})` : "";
  const forAgent = agentName ? ` for your "${agentName}" agent` : "";
  const expiry = Number(connection.refreshTokenExpiresAt);
  const when = Number.isFinite(expiry) && expiry > 0
    ? new Date(expiry).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    : null;
  const expired = stage === "expired";
  const subject = expired
    ? "Action needed: reconnect Monday to resume call logging"
    : `Reconnect Monday before ${when ?? "it expires"} to keep calls logging`;
  const lines = expired
    ? [
      `The AI Receptionist's connection to Monday${account}${forAgent} has ended, so new calls are no longer being logged to Monday.`,
      "Calls are still answered normally. Renew the connection and the calls missed in the meantime are logged automatically. Your boards and field mapping are kept - it takes one click.",
    ]
    : [
      `Monday requires the AI Receptionist's connection${account}${forAgent} to be renewed every six months. It ends on ${when}.`,
      "Renewing takes one click, and your boards and field mapping are kept. If it lapses, calls are still answered but stop being logged to Monday until you renew.",
    ];
  const text = [...lines, "", `Renew Monday Connection: ${link}`].join("\n");
  const html = [
    ...lines.map((line) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${escapeHtml(line)}</p>`),
    `<p style="margin:20px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1c1c17;color:#ffffff;text-decoration:none;font-weight:600;">Renew Monday Connection</a></p>`,
  ].join("");
  return { subject, text, html };
}

export function renderInactiveEmail({ connection, appUrl, agentId = null, agentName = null }) {
  const base = `${String(appUrl ?? "").replace(/\/+$/, "")}/integrations`;
  const link = agentId ? `${base}?agentId=${encodeURIComponent(agentId)}` : base;
  const account = connection.accountName ? ` (${connection.accountName})` : "";
  const forAgent = agentName ? ` for your "${agentName}" agent` : "";
  const lines = [
    `Monday says your account${account} is inactive - suspended, closed or unpaid - so calls${forAgent} are not being logged to Monday right now.`,
    "Calls are still answered normally. Reactivate the account in Monday, then click Check Again on the Monday card. Calls missed in the meantime are logged automatically.",
  ];
  const text = [...lines, "", `Open Monday settings: ${link}`].join("\n");
  const html = [
    ...lines.map((line) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${escapeHtml(line)}</p>`),
    `<p style="margin:20px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1c1c17;color:#ffffff;text-decoration:none;font-weight:600;">Open Monday Settings</a></p>`,
  ].join("");
  return { subject: "Monday account inactive: calls aren't being logged", text, html };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
