// Minimal SES v2 sender plus the invitation email. lambda/digest carries the
// same send helpers: each Lambda is packaged from its own directory.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function singleLine(value, max = 200) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

const EMAIL_PATTERN = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length <= 254 && EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

export function createSesSender({ client, SendEmailCommand, from, configurationSet }) {
  if (!from) throw new Error("EMAIL_FROM is required");
  return async function send({ to, subject, html, text }) {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      Content: {
        Simple: {
          Subject: { Data: singleLine(subject, 250), Charset: "UTF-8" },
          Body: {
            Html: { Data: html, Charset: "UTF-8" },
            Text: { Data: text, Charset: "UTF-8" },
          },
        },
      },
    }));
    return { messageId: result?.MessageId ?? null };
  };
}

let defaultSenderPromise;

export function getDefaultSender() {
  defaultSenderPromise ??= import("@aws-sdk/client-sesv2").then((ses) => createSesSender({
    client: new ses.SESv2Client({}),
    SendEmailCommand: ses.SendEmailCommand,
    from: process.env.EMAIL_FROM,
    configurationSet: process.env.EMAIL_CONFIGURATION_SET,
  }));
  return defaultSenderPromise;
}

export function describeSendFailure(error) {
  const message = String(error?.message ?? "");
  if (error?.name === "MessageRejected" && /not verified/i.test(message)) {
    return "This address can't receive email yet: sending is limited to verified addresses until email access is approved.";
  }
  if (error?.name === "AccountSuspendedException" || error?.name === "SendingPausedException") {
    return "Email sending is paused for this account.";
  }
  return "The email could not be sent.";
}

const INK = "#171714";
const MUTED = "#66655e";
const LINE = "#dedacf";
const PAPER = "#f2efe7";
const SURFACE = "#fffef8";
const ACCENT = "#dfff58";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderInviteEmail({ workspaceName, inviterName, url, ttlDays }) {
  const company = workspaceName || "Your team";
  const inviter = inviterName ? `${inviterName} at ${company}` : company;
  const subject = `${company} invited you to connect your calendar`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${SURFACE};border:1px solid ${LINE};border-radius:16px;">
        <tr><td style="padding:32px 32px 28px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};border:1px solid ${INK};vertical-align:middle;"></span>
          <span style="margin-left:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};vertical-align:middle;">Calendar invitation</span>
          <h1 style="margin:14px 0 12px;font-size:24px;line-height:1.25;color:${INK};">Connect your calendar for ${escapeHtml(company)}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK};">${escapeHtml(inviter)} has asked you to connect your calendar to their AI receptionist, so it can check your availability and book appointments for you.</p>
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:${INK};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Connect your calendar</a>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">You'll sign in with Google or Microsoft directly. You will never be asked for your password here, and the only permissions requested are checking availability and creating appointments.</p>
          <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">This link expires in ${ttlDays} days. If the button doesn't work, paste this address into your browser:<br><span style="color:${INK};word-break:break-all;">${escapeHtml(url)}</span></p>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid ${LINE};font-size:12px;line-height:1.6;color:${MUTED};">
          If you weren't expecting this, you can ignore this email — nothing is connected unless you sign in.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = [
    `Connect your calendar for ${company}`,
    "",
    `${inviter} has asked you to connect your calendar to their AI receptionist, so it can check your availability and book appointments for you.`,
    "",
    `Connect your calendar: ${url}`,
    "",
    "You'll sign in with Google or Microsoft directly. You will never be asked for your password here, and the only permissions requested are checking availability and creating appointments.",
    `This link expires in ${ttlDays} days.`,
    "",
    "If you weren't expecting this, you can ignore this email — nothing is connected unless you sign in.",
  ].join("\n");
  return { subject, html, text };
}
