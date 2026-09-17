import { escapeHtml, singleLine } from "./email.mjs";

const INK = "#171714";
const MUTED = "#66655e";
const LINE = "#dedacf";
const PAPER = "#f2efe7";
const SURFACE = "#fffef8";
const ACCENT = "#dfff58";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function formatDateTime(iso, timezone) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// A short nudge, not a report: it tells you calls came in and sends you back
// into the app to look at them - no caller names, outcomes, or transcript
// text ever appear in the email body itself, regardless of whether it's 1
// call or 100.
export function renderDigest({
  workspaceName,
  calls,
  timezone,
  windowStart,
  windowEnd,
  dashboardUrl,
  settingsUrl,
  isTest = false,
}) {
  const company = workspaceName || "Your workspace";
  const count = calls.length;
  const plural = count === 1 ? "call" : "calls";
  const range = `${formatDateTime(windowStart, timezone)} – ${formatDateTime(windowEnd, timezone)}`;
  const subject = isTest
    ? `Test: ${company} notification`
    : `${company}: ${count} new ${plural}`;
  const heading = count
    ? `${count} new ${plural} since your last check`
    : "No new calls since your last check";
  const body = count
    ? `Open Call History to see ${count === 1 ? "it" : "them"}.`
    : "There were no new calls since your last check.";
  const preheader = count ? `${count} new ${plural} — ${body}` : body;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(singleLine(preheader, 140))}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding:0 4px 18px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};border:1px solid ${INK};vertical-align:middle;"></span>
          <span style="margin-left:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};vertical-align:middle;">${escapeHtml(company)} · AI Voice Agent</span>
        </td></tr>
        <tr><td style="padding:0 0 22px;background:${SURFACE};border:1px solid ${LINE};border-radius:12px;">
          <div style="padding:22px 24px;">
            <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;color:${INK};">${escapeHtml(heading)}</h1>
            <p style="margin:0 0 4px;font-size:13px;color:${MUTED};">${escapeHtml(range)}</p>
            <p style="margin:14px 0 18px;font-size:14px;line-height:1.55;color:${INK};">${escapeHtml(body)}</p>
            <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:11px 18px;border-radius:10px;background:${INK};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open Call History</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:${MUTED};">
          You received this because ${escapeHtml(company)} turned on call notifications for its AI Voice Agent.
          If you would like to change the schedule, frequency, or recipients, please contact your administrator.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${company} · AI Voice Agent`,
    heading,
    range,
    "",
    body,
    "",
    `Open Call History: ${dashboardUrl}`,
    "If you would like to change the schedule, frequency, or recipients, please contact your administrator.",
  ].join("\n");

  return { subject, html, text };
}

const TRANSCRIPT_PREVIEW_CHARS = 500;

function transcriptText(transcript) {
  if (!Array.isArray(transcript)) return "";
  return transcript
    .map((line) => `${line?.speaker ?? "Caller"}: ${line?.text ?? ""}`)
    .join("\n");
}

// Sent as soon as a call's sentiment analysis comes back negative - unlike
// the digest above, this names the caller, includes a short transcript
// preview inline, and attaches the full transcript as plain text so the
// recipient has everything without clicking through, while the email body
// itself stays short (the ~500-char cap is well within any provider's size
// limit even for a very long call).
export function renderNegativeSentimentAlert({
  workspaceName,
  call,
  recipients,
  timezone,
  dashboardUrl,
}) {
  const company = workspaceName || "Your workspace";
  const callerLabel = call.callerName?.trim() || call.callerNumber || "An unknown caller";
  const when = formatDateTime(call.startedAt, timezone);
  const summary = call.callSummary?.trim() || "No summary was generated for this call.";
  const fullTranscript = transcriptText(call.transcript);
  const preview = fullTranscript.length > TRANSCRIPT_PREVIEW_CHARS
    ? `${fullTranscript.slice(0, TRANSCRIPT_PREVIEW_CHARS)}…`
    : fullTranscript;
  const callLink = `${dashboardUrl}?callId=${encodeURIComponent(call.callId)}`;
  const subject = `${company}: negative-sentiment call with ${callerLabel}`;
  const sentToLine = `This alert was sent to: ${recipients.join(", ")}.`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding:0 4px 18px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#ff6b4a;border:1px solid ${INK};vertical-align:middle;"></span>
          <span style="margin-left:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};vertical-align:middle;">${escapeHtml(company)} · Negative-Sentiment Alert</span>
        </td></tr>
        <tr><td style="padding:0 0 22px;background:${SURFACE};border:1px solid ${LINE};border-radius:12px;">
          <div style="padding:22px 24px;">
            <h1 style="margin:0 0 6px;font-size:20px;line-height:1.3;color:${INK};">A call with ${escapeHtml(callerLabel)} came back negative</h1>
            <p style="margin:0 0 14px;font-size:13px;color:${MUTED};">${escapeHtml(when)}</p>
            <p style="margin:0 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">Summary</p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${INK};">${escapeHtml(summary)}</p>
            ${preview ? `<p style="margin:0 0 4px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">Transcript preview</p>
            <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:${INK};white-space:pre-wrap;">${escapeHtml(preview)}</p>` : ""}
            <p style="margin:0 0 18px;font-size:13px;color:${MUTED};">The full transcript is attached as a text file.</p>
            <a href="${escapeHtml(callLink)}" style="display:inline-block;padding:11px 18px;border-radius:10px;background:${INK};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open in Call History</a>
          </div>
        </td></tr>
        <tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:${MUTED};">
          ${escapeHtml(sentToLine)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${company} · Negative-Sentiment Alert`,
    `A call with ${callerLabel} came back negative`,
    when,
    "",
    "Summary:",
    summary,
    ...(preview ? ["", "Transcript preview:", preview] : []),
    "",
    "The full transcript is attached as a text file.",
    `Open in Call History: ${callLink}`,
    "",
    sentToLine,
  ].join("\n");

  return {
    subject,
    html,
    text,
    attachment: {
      filename: `transcript-${call.callId}.txt`,
      content: fullTranscript || "No transcript is available for this call.",
    },
  };
}
