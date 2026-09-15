// Minimal SES v2 sender. lambda/oauth carries the same helpers: each Lambda is
// packaged from its own directory, so the two cannot share a module.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Subjects and header-adjacent values must never carry a line break.
export function singleLine(value, max = 200) {
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

// While SES is in its sandbox it rejects any recipient that is not a verified
// identity. Say that plainly rather than relaying SES's identity-check wording.
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
