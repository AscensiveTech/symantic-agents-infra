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

// A .txt attachment is just text - a few KB even for a long call - so a raw
// MIME message (the only SES v2 content shape that supports attachments) is
// built by hand here rather than pulling in a MIME library for one caller.
function buildRawMimeMessage({ from, to, subject, html, text, attachment }) {
  const boundaryMixed = `mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const boundaryAlt = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${singleLine(subject, 250)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${boundaryAlt}--`,
  ];
  if (attachment) {
    const base64 = Buffer.from(attachment.content, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
    lines.push(
      `--${boundaryMixed}`,
      `Content-Type: text/plain; charset="UTF-8"; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64,
    );
  }
  lines.push(`--${boundaryMixed}--`, "");
  return lines.join("\r\n");
}

export function createSesSender({ client, SendEmailCommand, from, configurationSet }) {
  if (!from) throw new Error("EMAIL_FROM is required");
  return async function send({ to, subject, html, text, attachment }) {
    const content = attachment
      ? {
        Raw: {
          Data: new TextEncoder().encode(buildRawMimeMessage({ from, to, subject, html, text, attachment })),
        },
      }
      : {
        Simple: {
          Subject: { Data: singleLine(subject, 250), Charset: "UTF-8" },
          Body: {
            Html: { Data: html, Charset: "UTF-8" },
            Text: { Data: text, Charset: "UTF-8" },
          },
        },
      };
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      Content: content,
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
