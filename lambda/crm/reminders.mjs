// Emails the workspace before (and when) its Monday grant ends. Monday grants
// hard-expire six months after consent and cannot be extended, so the only
// fix is a reconnect; these make sure someone knows to do it.

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
  async function recipients(connection) {
    const connector = connection.authorizedBy ? await store.getMembership(connection.authorizedBy).catch(() => null) : null;
    if (connector?.workspaceId === connection.workspaceId && connector.status === "active" && connector.email) {
      return [connector.email];
    }
    const admins = await store.listWorkspaceAdmins(connection.workspaceId);
    return [...new Set(admins.map((admin) => admin.email).filter(Boolean))];
  }

  return async function remind(connection) {
    if (!sendEmail) return false;
    const stage = reminderStage(connection, Number(now()));
    if (!stage || !isNewerStage(stage, connection.reauthReminderStage)) return false;
    const to = await recipients(connection);
    // Claim the stage first: a crash after sending must not email twice.
    const claimed = await store.markReauthReminder(connection.workspaceId, connection.provider, stage, connection.reauthReminderStage ?? null);
    if (!claimed) return false;
    const message = renderReauthEmail({ stage, connection, appUrl });
    for (const address of to) {
      try {
        await sendEmail({ to: address, ...message });
      } catch (error) {
        log.warn?.("Monday reconnect reminder not sent", { workspaceId: connection.workspaceId, stage, name: error?.name });
      }
    }
    return to.length > 0;
  };
}

export function renderReauthEmail({ stage, connection, appUrl }) {
  const link = `${String(appUrl ?? "").replace(/\/+$/, "")}/integrations`;
  const account = connection.accountName ? ` (${connection.accountName})` : "";
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
      `The AI Receptionist's connection to Monday${account} has ended, so new calls are no longer being logged to Monday.`,
      "Calls are still answered normally. Reconnect Monday and the calls that were missed in the meantime are logged automatically.",
    ]
    : [
      `Monday requires the AI Receptionist's connection${account} to be renewed every six months. It ends on ${when}.`,
      "Reconnecting takes one click and keeps your field mapping. If it lapses, calls are still answered but stop being logged to Monday until you reconnect.",
    ];
  const text = [...lines, "", `Reconnect Monday: ${link}`].join("\n");
  const html = [
    ...lines.map((line) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.5;">${escapeHtml(line)}</p>`),
    `<p style="margin:20px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1c1c17;color:#ffffff;text-decoration:none;font-weight:600;">Reconnect Monday</a></p>`,
  ].join("");
  return { subject, text, html };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
