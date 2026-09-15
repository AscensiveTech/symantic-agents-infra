import { escapeHtml, singleLine } from "./email.mjs";

// Gmail clips a message past ~102 KB. Every call is always listed in the
// overview table at the top, so clipping only ever hides detail, never a call.
const MAX_DETAILED_CALLS = 40;
const MAX_TRANSCRIPT_LINES = 120;

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

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(total) || total === 0) return "—";
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function callerLabel(call) {
  return call.callerName || call.callerNumber || "Unknown caller";
}

function outcomeLabel(outcome) {
  const text = String(outcome ?? "").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Completed";
}

function speakerLabel(speaker) {
  const value = String(speaker ?? "");
  if (/agent|assistant|receptionist/i.test(value)) return "Receptionist";
  if (/user|caller|customer/i.test(value)) return "Caller";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Speaker";
}

function transcriptLines(call) {
  return Array.isArray(call.transcript)
    ? call.transcript.filter((entry) => typeof entry?.text === "string" && entry.text.trim())
    : [];
}

export function renderDigest({
  workspaceName,
  calls,
  agentNames = new Map(),
  timezone,
  windowStart,
  windowEnd,
  includeTranscripts,
  dashboardUrl,
  settingsUrl,
  isTest = false,
}) {
  const company = workspaceName || "Your workspace";
  const sorted = [...calls].sort(
    (left, right) => Date.parse(right.startedAt ?? 0) - Date.parse(left.startedAt ?? 0),
  );
  const count = sorted.length;
  const plural = count === 1 ? "call" : "calls";
  const range = `${formatDateTime(windowStart, timezone)} – ${formatDateTime(windowEnd, timezone)}`;
  const subject = isTest
    ? `Test: ${company} call summary`
    : `${company}: ${count} new ${plural}`;
  const heading = isTest
    ? "This is a test of your call summary"
    : `${count} new ${plural}`;
  const agentName = (call) => agentNames.get(call.agentId) ?? "";

  const overviewRows = sorted.map((call) => `
        <tr>
          <td style="padding:10px 12px;border-top:1px solid ${LINE};font-size:13px;color:${MUTED};white-space:nowrap;">${escapeHtml(formatDateTime(call.startedAt, timezone))}</td>
          <td style="padding:10px 12px;border-top:1px solid ${LINE};font-size:13px;color:${INK};font-weight:600;">${escapeHtml(callerLabel(call))}</td>
          <td style="padding:10px 12px;border-top:1px solid ${LINE};font-size:13px;color:${INK};">${escapeHtml(outcomeLabel(call.outcome))}</td>
          <td style="padding:10px 12px;border-top:1px solid ${LINE};font-size:13px;color:${MUTED};text-align:right;white-space:nowrap;">${escapeHtml(formatDuration(call.durationMs))}</td>
        </tr>`).join("");

  const detailed = sorted.slice(0, MAX_DETAILED_CALLS);
  const detailBlocks = detailed.map((call) => {
    const lines = includeTranscripts ? transcriptLines(call) : [];
    const shown = lines.slice(0, MAX_TRANSCRIPT_LINES);
    const transcriptHtml = shown.length
      ? `
          <p style="margin:16px 0 6px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Transcript</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            ${shown.map((entry) => `
            <tr>
              <td style="padding:4px 10px 4px 0;vertical-align:top;font-size:12px;font-weight:700;color:${MUTED};white-space:nowrap;">${escapeHtml(speakerLabel(entry.speaker))}</td>
              <td style="padding:4px 0;font-size:13px;line-height:1.5;color:${INK};">${escapeHtml(entry.text)}</td>
            </tr>`).join("")}
          </table>
          ${lines.length > shown.length || call.transcriptTruncated
            ? `<p style="margin:8px 0 0;font-size:12px;color:${MUTED};">The transcript continues in the dashboard.</p>`
            : ""}`
      : "";
    const meta = [
      formatDateTime(call.startedAt, timezone),
      formatDuration(call.durationMs),
      agentName(call),
      call.callerName && call.callerNumber ? call.callerNumber : "",
    ].filter((item) => item && item !== "—");
    return `
      <tr><td style="padding:0 0 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:${SURFACE};border:1px solid ${LINE};border-radius:12px;">
          <tr><td style="padding:18px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="font-size:16px;font-weight:700;color:${INK};">${escapeHtml(callerLabel(call))}</td>
              <td style="text-align:right;"><span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${PAPER};font-size:11px;font-weight:700;color:${INK};">${escapeHtml(outcomeLabel(call.outcome))}</span></td>
            </tr></table>
            <p style="margin:4px 0 0;font-size:12px;color:${MUTED};">${meta.map(escapeHtml).join(" · ")}</p>
            <p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:${INK};">${escapeHtml(call.callSummary || "No summary was produced for this call.")}</p>
            ${transcriptHtml}
          </td></tr>
        </table>
      </td></tr>`;
  }).join("");

  const overflow = count > detailed.length
    ? `<p style="margin:0 0 16px;font-size:13px;color:${MUTED};">${count - detailed.length} more ${count - detailed.length === 1 ? "call is" : "calls are"} listed above — open the dashboard for their full details.</p>`
    : "";

  const emptyNote = count === 0
    ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${INK};">There were no completed calls in the last 24 hours. When calls come in, each one will appear here with its summary${includeTranscripts ? " and full transcript" : ""}.</p>`
    : "";

  const preheader = count
    ? singleLine(sorted[0].callSummary || `${count} new ${plural}`, 140)
    : "A preview of how your call summaries will look.";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:0 4px 18px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${ACCENT};border:1px solid ${INK};vertical-align:middle;"></span>
          <span style="margin-left:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};vertical-align:middle;">${escapeHtml(company)} · AI Receptionist</span>
          <h1 style="margin:10px 0 4px;font-size:26px;line-height:1.2;color:${INK};">${escapeHtml(heading)}</h1>
          <p style="margin:0;font-size:13px;color:${MUTED};">${escapeHtml(range)}</p>
        </td></tr>
        ${count ? `
        <tr><td style="padding:0 0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:${SURFACE};border:1px solid ${LINE};border-radius:12px;">
            <tr>
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Time</th>
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Caller</th>
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Outcome</th>
              <th align="right" style="padding:10px 12px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Length</th>
            </tr>${overviewRows}
          </table>
        </td></tr>` : ""}
        <tr><td>${emptyNote}</td></tr>
        ${detailBlocks}
        <tr><td>${overflow}</td></tr>
        <tr><td style="padding:4px 0 22px;">
          <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:${INK};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Open call history</a>
        </td></tr>
        <tr><td style="padding:16px 4px 0;border-top:1px solid ${LINE};font-size:12px;line-height:1.6;color:${MUTED};">
          You receive this because ${escapeHtml(company)} turned on call summaries for its AI Receptionist.
          An administrator can change the schedule or recipients in <a href="${escapeHtml(settingsUrl)}" style="color:${INK};">Call Summaries settings</a>.
          ${includeTranscripts ? "Transcripts can contain personal information — please handle this email accordingly." : ""}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textLines = [
    `${company} · AI Receptionist`,
    heading,
    range,
    "",
  ];
  if (!count) {
    textLines.push("There were no completed calls in the last 24 hours.", "");
  }
  for (const call of detailed) {
    textLines.push(
      `${callerLabel(call)} — ${outcomeLabel(call.outcome)}`,
      [formatDateTime(call.startedAt, timezone), formatDuration(call.durationMs), agentName(call)]
        .filter((item) => item && item !== "—").join(" · "),
      call.callSummary || "No summary was produced for this call.",
    );
    if (includeTranscripts) {
      const lines = transcriptLines(call).slice(0, MAX_TRANSCRIPT_LINES);
      if (lines.length) {
        textLines.push("", "Transcript:");
        for (const entry of lines) textLines.push(`${speakerLabel(entry.speaker)}: ${entry.text}`);
      }
    }
    textLines.push("", "----", "");
  }
  if (count > detailed.length) {
    textLines.push(`${count - detailed.length} more calls are in the dashboard.`, "");
  }
  textLines.push(
    `Open call history: ${dashboardUrl}`,
    `Change these emails: ${settingsUrl}`,
  );

  return { subject, html, text: textLines.join("\n") };
}
