"""Builds docs/monday-crm-integration.pdf - the Monday CRM integration design.

    python3 docs/monday-crm-integration/build.py

Figures that come from a deployed environment live in VERIFICATION below;
update them there and rebuild rather than editing the PDF.
"""

from pathlib import Path

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = Path(__file__).resolve().parents[1] / "monday-crm-integration.pdf"

INK = colors.HexColor("#171714")
MUTED = colors.HexColor("#5f5e58")
LINE = colors.HexColor("#dedacf")
PAPER = colors.HexColor("#f8f5ed")
LIME = colors.HexColor("#dfff58")
BLUE = colors.HexColor("#e7eefc")
AMBER = colors.HexColor("#fff4d6")
GREEN = colors.HexColor("#e8f3e5")
RED = colors.HexColor("#fbe7e3")

VERIFICATION = {
    "status": "Pre-deployment (local + integration suites). Deployed figures are added after rollout.",
    "rows": [
        ["CRM Lambda unit + flow tests", "82 passing", "Adapter, OAuth, sessions, sync, lookup, worker, webhook, isolation"],
        ["Post-call Lambda tests", "29 passing (6 new)", "Enqueue gating, test/spam/anonymous skips, retry on enqueue failure"],
        ["BFF tests", "403 passing (6 new)", "Inbound lookup budget, fail-open, no CRM call for rejected callers"],
        ["Other Lambda suites", "142 passing", "tools, oauth, digest, kb-refresh, most-asked-refresh (regression)"],
        ["Frontend unit tests", "625 passing (17 new)", "Connect, callback errors, mapping editor, states, disconnect, retry"],
        ["Frontend lint / typecheck / build", "clean", "eslint --max-warnings=0, tsc, next build"],
        ["Terraform", "fmt + validate clean", "Plan against dev: 36 add, 8 in-place, 0 destroy"],
    ],
}

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=20, leading=24,
                    textColor=INK, spaceAfter=4)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13.5, leading=17,
                    textColor=INK, spaceBefore=12, spaceAfter=5)
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontName="Helvetica-Bold", fontSize=10.5, leading=13,
                    textColor=INK, spaceBefore=6, spaceAfter=3)
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.2, leading=12.8,
                      textColor=INK, alignment=TA_LEFT, spaceAfter=5)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8, leading=10.5, textColor=MUTED)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=8, leading=10.3, spaceAfter=0)
CELLB = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")
CODE = ParagraphStyle("Code", parent=BODY, fontName="Courier", fontSize=7.8, leading=10, textColor=INK,
                      backColor=PAPER, borderPadding=6, spaceBefore=3, spaceAfter=8)
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=11, bulletIndent=2, spaceAfter=2.5)

W = A4[0] - 36 * mm


def p(text, style=BODY):
    return Paragraph(text, style)


def signatures():
    rows = [
        ("findContactByPhone(session, e164)", "CrmContact | null"),
        ("findContactByEmail(session, email)", "CrmContact | null"),
        ("getContact(session, externalId)", "CrmContact | null"),
        ("createLead(session, lead, {idempotencyKey})", "CrmContact"),
        ("logCallActivity(session, id, activity, {fields, idempotencyKey})", None),
        ("", "{activityId, fieldsApplied}"),
        ("findActivityByRef(session, externalId, ref)", "activityId | null"),
    ]
    lines = [(call.ljust(46) + ("-> " + result if result else "")).replace(" ", "&nbsp;") for call, result in rows]
    lines.append("All methods throw CrmError {code, retryable, retryAfterSeconds}")
    return "<br/>".join(lines)


def bullets(items):
    return [Paragraph(item, BULLET, bulletText="•") for item in items]


def table(rows, widths, header=True, shade_first_col=False):
    data = [[Paragraph(str(c), CELLB if (header and r == 0) or (shade_first_col and i == 0) else CELL)
             for i, c in enumerate(row)] for r, row in enumerate(rows)]
    t = Table(data, colWidths=[w * W for w in widths], repeatRows=1 if header else 0)
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), PAPER))
    t.setStyle(TableStyle(style))
    return t


# ----------------------------------------------------------------- diagrams --

def box(d, x, y, w, h, title, sub=None, fill=colors.white, stroke=INK, title_size=8.2):
    d.add(Rect(x, y, w, h, rx=5, ry=5, fillColor=fill, strokeColor=stroke, strokeWidth=0.8))
    ty = y + h / 2 + (3 if sub else -3)
    d.add(String(x + w / 2, ty, title, fontName="Helvetica-Bold", fontSize=title_size, fillColor=INK,
                 textAnchor="middle"))
    if sub:
        for i, line in enumerate(sub.split("\n")):
            d.add(String(x + w / 2, ty - 10 - i * 8.5, line, fontName="Helvetica", fontSize=6.6,
                         fillColor=MUTED, textAnchor="middle"))


def arrow(d, x1, y1, x2, y2, label=None, dashed=False, color=INK, label_dx=0, label_dy=3):
    line = Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=0.9)
    if dashed:
        line.strokeDashArray = [3, 2]
    d.add(line)
    import math
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 4.5
    p1 = (x2 - size * math.cos(angle - 0.4), y2 - size * math.sin(angle - 0.4))
    p2 = (x2 - size * math.cos(angle + 0.4), y2 - size * math.sin(angle + 0.4))
    d.add(Polygon([x2, y2, p1[0], p1[1], p2[0], p2[1]], fillColor=color, strokeColor=color, strokeWidth=0.5))
    if label:
        lx, ly = (x1 + x2) / 2 + label_dx, (y1 + y2) / 2 + label_dy
        width = stringWidth(label, "Helvetica", 6.4) + 4
        d.add(Rect(lx - width / 2, ly - 2, width, 8.5, fillColor=colors.white, strokeColor=None, fillOpacity=0.9))
        d.add(String(lx, ly, label, fontName="Helvetica", fontSize=6.4, fillColor=MUTED, textAnchor="middle"))


def zone(d, x, y, w, h, label, fill):
    d.add(Rect(x, y, w, h, rx=8, ry=8, fillColor=fill, strokeColor=LINE, strokeWidth=0.6))
    d.add(String(x + 7, y + h - 11, label, fontName="Helvetica-Bold", fontSize=7, fillColor=MUTED))


def architecture_diagram():
    d = Drawing(W, 262)
    zone(d, 0, 0, 96, 262, "EXTERNAL", PAPER)
    zone(d, 104, 0, W - 104 - 96, 262, "SYMANTIC (AWS)", BLUE)
    zone(d, W - 88, 0, 88, 262, "MONDAY.COM", AMBER)

    box(d, 6, 206, 84, 36, "Workspace admin", "Integrations page")
    box(d, 6, 156, 84, 36, "Monday app", "uninstall webhook")
    box(d, 6, 104, 84, 36, "Retell", "voice runtime")

    bx, cx, cw = 150, 290, 94
    box(d, bx, 206, 92, 36, "API Gateway", "JWT + 2 public routes")
    box(d, bx, 156, 92, 36, "BFF Lambda", "inbound webhook")
    box(d, bx, 104, 92, 36, "Post-call Lambda", "call_analyzed")
    box(d, bx, 14, 92, 60, "State (DynamoDB)", "crm-connections\n(KMS-encrypted tokens)\ncrm-links, calls.crm*")
    box(d, cx, 156, cw, 86, "crm Lambda", "settings API, OAuth,\nwebhook, call lookup", fill=LIME)
    box(d, cx, 104, cw, 36, "SQS crm-sync", "DLQ after 8 attempts")
    box(d, cx, 38, cw, 44, "crm-worker Lambda", "post-call sync", fill=LIME)

    box(d, W - 82, 150, 76, 56, "GraphQL API", "api.monday.com\npinned version")
    box(d, W - 82, 60, 76, 46, "OAuth 2.1", "auth.monday.com")

    arrow(d, 90, 224, bx, 228, "settings, OAuth", label_dy=5)
    arrow(d, 90, 174, bx, 214, "uninstall (JWT)", label_dx=-4, label_dy=-10)
    arrow(d, 90, 128, bx, 170, "call_inbound", label_dx=-2, label_dy=-10)
    arrow(d, 90, 116, bx, 118, "call_analyzed", label_dy=-9)
    arrow(d, bx + 92, 228, cx, 228, "HTTP")
    arrow(d, bx + 92, 174, cx, 174, "invoke, 1.5 s")
    arrow(d, bx + 92, 122, cx, 122, "enqueue")
    arrow(d, cx + cw / 2, 104, cx + cw / 2, 82, "")
    arrow(d, cx, 54, bx + 92, 50, "state", label_dy=4)
    arrow(d, cx + cw, 200, W - 82, 186, "1 read", label_dy=6)
    arrow(d, cx + cw, 70, W - 82, 162, "writes", label_dx=6, label_dy=-4)
    arrow(d, cx + cw, 166, W - 82, 94, "tokens", dashed=True, label_dx=8, label_dy=-6)
    return d


def layering_diagram():
    d = Drawing(W, 120)
    rows = [
        ("Receptionist domain", "sync.mjs, lookup.mjs, facts.mjs, activity.mjs, context.mjs - provider-neutral", GREEN),
        ("CrmProvider contract", "provider.mjs - CrmContact, CrmFieldPatch, CrmActivity, CrmError", colors.white),
        ("MondayCrmAdapter", "monday/adapter.mjs - columns, labels, board scoping; monday/session.mjs - tokens", LIME),
        ("Monday GraphQL + OAuth clients", "monday/graphql.mjs, monday/oauth.mjs - HTTP, errors, idempotency keys", AMBER),
    ]
    h = 24
    for i, (title, sub, fill) in enumerate(rows):
        y = 120 - (i + 1) * (h + 5)
        d.add(Rect(0, y, W, h, rx=4, ry=4, fillColor=fill, strokeColor=INK, strokeWidth=0.7))
        d.add(String(8, y + 14, title, fontName="Helvetica-Bold", fontSize=8.4, fillColor=INK))
        d.add(String(8, y + 5, sub, fontName="Helvetica", fontSize=6.8, fillColor=MUTED))
    return d


def lookup_diagram():
    d = Drawing(W, 176)
    lanes = ["Caller / Retell", "BFF inbound-lookup", "crm Lambda", "Monday"]
    lw = W / len(lanes)
    for i, name in enumerate(lanes):
        x = i * lw + lw / 2
        d.add(String(x, 166, name, fontName="Helvetica-Bold", fontSize=7.6, fillColor=INK, textAnchor="middle"))
        ln = Line(x, 12, x, 160, strokeColor=LINE, strokeWidth=0.8)
        ln.strokeDashArray = [2, 2]
        d.add(ln)
    xs = [i * lw + lw / 2 for i in range(4)]
    steps = [
        (0, 1, 150, "call_inbound (caller hears ringing)"),
        (1, 1, 134, "DID -> agent, profile, blocklist (unchanged)"),
        (1, 1, 118, "GetItem crm-connections: connected + valid?"),
        (1, 2, 100, "Invoke lookup (abort at 1.5s)"),
        (2, 3, 82, "get item by id  |  phone search (1 call)"),
        (3, 2, 64, "name, status, owner"),
        (2, 1, 46, "sanitized context string"),
        (1, 0, 28, "dynamic_variables.crm_context"),
    ]
    for a, b, y, label in steps:
        if a == b:
            d.add(Rect(xs[a] - 3, y - 3, 6, 6, fillColor=INK, strokeColor=INK))
            d.add(String(xs[a] + 8, y - 2, label, fontName="Helvetica", fontSize=6.6, fillColor=MUTED))
        else:
            arrow(d, xs[a], y, xs[b], y, label)
    d.add(String(W / 2, 4, "Any timeout, error, pause or missing connection returns \"Not available.\" and the call proceeds.",
                 fontName="Helvetica-Oblique", fontSize=6.8, fillColor=INK, textAnchor="middle"))
    return d


def sync_diagram():
    d = Drawing(W, 132)
    y = 76
    bw, gap = 88, 12
    items = [
        ("call_analyzed", "Retell webhook", colors.white),
        ("Post-call Lambda", "persist call; mark\ncrmStatus=pending", colors.white),
        ("SQS crm-sync", "{workspaceId, callId}", BLUE),
        ("crm-worker", "per-phone lease,\nresolve, note, fields", LIME),
        ("Monday", "create_item /\nupdate + columns", AMBER),
    ]
    for i, (t, s, f) in enumerate(items):
        x = i * (bw + gap)
        box(d, x, y, bw, 44, t, s, fill=f)
        if i:
            arrow(d, x - gap, y + 22, x, y + 22)
    box(d, 2 * (bw + gap), 8, bw, 36, "DLQ", "after 8 attempts", fill=RED)
    arrow(d, 2 * (bw + gap) + bw / 2, y, 2 * (bw + gap) + bw / 2, 44, "exhausted", label_dx=18)
    d.add(String(3 * (bw + gap) + bw / 2, 58, "retryable error: visibility", fontName="Helvetica", fontSize=6.4,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(3 * (bw + gap) + bw / 2, 50, "= backoff / retry_in_seconds", fontName="Helvetica", fontSize=6.4,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(3 * (bw + gap) + bw / 2, 30, "permanent error: crmStatus=failed,", fontName="Helvetica", fontSize=6.4,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(3 * (bw + gap) + bw / 2, 22, "admin notified in UI; retried on fix", fontName="Helvetica", fontSize=6.4,
                 fillColor=MUTED, textAnchor="middle"))
    return d


def oauth_diagram():
    d = Drawing(W, 96)
    items = [
        ("Admin: Connect", "POST /crm/monday/start", colors.white),
        ("state + PKCE", "one-time, 10 min,\nbound to workspace", BLUE),
        ("Monday consent", "scopes: boards r/w,\nupdates:write, users/me", AMBER),
        ("Callback", "consume state,\nexchange code+verifier", BLUE),
        ("Store + validate", "KMS-encrypt tokens;\nre-check mapping", LIME),
    ]
    bw, gap = 88, 12
    for i, (t, s, f) in enumerate(items):
        x = i * (bw + gap)
        box(d, x, 36, bw, 44, t, s, fill=f)
        if i:
            arrow(d, x - gap, 58, x, 58)
    d.add(String(W / 2, 14, "Access token: 1 h, refreshed under a row lock with version compare-and-swap.  "
                 "Refresh token: rotates every use; hard 6-month limit -> admin reconnects.",
                 fontName="Helvetica", fontSize=6.8, fillColor=MUTED, textAnchor="middle"))
    return d


# ------------------------------------------------------------------ content --

def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 10 * mm, "Symantic Agents - Monday CRM integration")
    canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"{doc.page}")
    canvas.setFillColor(LIME)
    canvas.rect(18 * mm, A4[1] - 12 * mm, 24 * mm, 1.6 * mm, stroke=0, fill=1)
    canvas.restoreState()


story = []
story += [
    p("Monday CRM integration", H1),
    p("How the AI receptionist uses Monday.com, and why it is built this way. Describes the implementation "
      "merged in symantic-agents-infra and symantic-agents-frontend (branch feat/monday-crm).", SMALL),
    Spacer(1, 8),
    p("<b>What it does.</b> When a call comes in, the receptionist looks the caller up in the business's Monday "
      "board and, if they are known, greets them with that context. After every call, a background worker finds or "
      "creates the caller's Monday record and adds one note with the summary, outcome, appointment and follow-up, "
      "and keeps a few columns the receptionist owns up to date. Each business connects its own Monday account with "
      "OAuth and chooses which board and columns are used."),
    table([
        ["Decision", "Choice"],
        ["Integration path", "Direct Monday GraphQL API, authorized per business through a Monday OAuth 2.1 app"],
        ["Domain boundary", "CrmProvider contract; Monday lives only in lambda/crm/monday/"],
        ["Live call", "One bounded read (1.5 s cap, fail-open) during the inbound webhook; no writes"],
        ["After the call", "SQS queue -> crm-worker Lambda -> Monday; DLQ after 8 attempts"],
        ["Inbound events", "Only Monday's app-uninstall webhook; no board webhooks, no polling"],
        ["Duplicates", "Per-phone lease, search-before-create, Monday Idempotency-Key, Ref: marker, watermark"],
    ], [0.25, 0.75], shade_first_col=True),

    KeepTogether([p("1. Architecture", H2), architecture_diagram()]),
    p("Two new Lambdas share one package (lambda/crm): <b>crm</b> serves the settings API, the OAuth callback, "
      "the lifecycle webhook and the call-time lookup; <b>crm-worker</b> consumes the sync queue. Only these two "
      "hold the Monday KMS key and app secret. The BFF can only invoke the lookup and read connection status; "
      "the post-call Lambda can only read connection status and enqueue.", SMALL),

    KeepTogether([p("2. Layering: CrmProvider -> Monday adapter -> Monday API", H2), layering_diagram()]),
    Spacer(1, 4),
    p("The sync and lookup code never sees a board id, column id, label or GraphQL shape - only these domain "
      "types. A HubSpot or Salesforce adapter implements the same six methods and registers in the provider "
      "registry; nothing in the receptionist changes.", BODY),
    p(signatures(), CODE),

    p("3. Why direct API + OAuth app", H2),
    p("The receptionist needs one fast, predictable read during a live call and a few exactly-once writes after "
      "it, for many independent businesses. That rules the options in or out:"),
    table([
        ["Option", "Verdict", "Deciding reasons"],
        ["Direct GraphQL API + OAuth 2.1 app", "Chosen", "Per-business consent with scopes; revocation and uninstall "
         "events; full control of timeouts, batching (note + fields in one call), error codes, idempotency keys and "
         "rate-limit handling; no third party in the data path."],
        ["Personal API tokens", "Rejected", "A pasted token carries the user's full access with no scopes, never "
         "expires, and its revocation is invisible to us. Poor multi-tenant onboarding."],
        ["Monday MCP server", "Rejected for this path", "A user-scoped wrapper over the same GraphQL API with the same "
         "daily cap, plus an extra hop and tool-schema indirection that hides the error codes retries depend on. "
         "Letting the voice LLM write to the CRM freely would also let a caller steer CRM changes. Suitable later "
         "for a staff-facing 'ask your CRM' feature."],
        ["Zapier / Make / n8n", "Rejected", "Each business must build and maintain its own zap; no call-time lookup; "
         "per-task cost; debugging split across vendors; credentials held by a third party."],
        ["Board webhooks mirroring Monday", "Not needed now", "The only Monday-owned data we use (name, status, "
         "owner) is read fresh with one targeted query when a call arrives - no polling and no mirror to keep "
         "consistent. Revisit if Symantic UI must show CRM status or react to Monday changes."],
    ], [0.24, 0.14, 0.62]),

    KeepTogether([p("4. Authentication and tenant configuration", H2), oauth_diagram()]),
    *bullets([
        "Legacy Monday tokens stop working on 2026-10-01; this is built on OAuth 2.1 only (PKCE S256, rotating refresh "
        "tokens). Access tokens (1 h) and refresh tokens are KMS-encrypted with a dedicated key; the encryption "
        "context binds each ciphertext to its workspace and purpose.",
        "Refresh is serialized across Lambda containers by a short lock on the connection row and committed with a "
        "tokenVersion compare-and-swap, so a rotated refresh token is never lost to a race. A rejected refresh or a "
        "second 401 marks the connection <i>reauth_required</i>; the UI shows Reconnect.",
        "Monday caps a grant at six months from consent. The UI shows 'Reconnect by' and prompts 14 days ahead. "
        "Reconnecting keeps the mapping, re-validates it, and re-queues calls that failed meanwhile.",
        "Field mapping: the admin picks a board (only boards with a Phone column), then which columns hold phone "
        "(required), email, status, owner, last call, outcome, follow-up date, next appointment and source, plus the "
        "new-lead and follow-up status labels and a default owner. It is validated live against Monday; column types "
        "are taken from Monday, never from the browser.",
        "Disconnect revokes the grant at Monday (best effort) and deletes our tokens. Monday's app-uninstall webhook "
        "(HS256 JWT, client secret, account and app claims checked) disconnects every workspace on that account.",
    ]),

    KeepTogether([p("5. During the call: caller lookup", H2), lookup_diagram()]),
    *bullets([
        "Started only after the call is accepted (a blocked or rejected caller costs no Monday call), in parallel "
        "with the overage check. Hard budget: 1.5 s including the Lambda invoke; the invoke is aborted at the "
        "deadline. Retell allows 10 s here while the caller hears ringing.",
        "Workspaces without a usable connection skip the invoke after a single DynamoDB read.",
        "Known callers are fetched by record id; unknown ones cost one phone search. The answer is written to "
        "crm-links so the post-call sync can skip a repeat search.",
        "CRM text is untrusted: markup, template braces and control characters are stripped, fields capped at 60 "
        "characters. The prompt's CALLER RECORD section tells the agent to confirm the name before using it and "
        "never to disclose what the record says. A Retell LLM default makes test and web calls read "
        "'Not available.'",
    ]),

    KeepTogether([p("6. After the call: asynchronous sync", H2), sync_diagram()]),
    p("One job per call, keyed by callId. Test calls, spam and callers with no number are never enqueued. The worker:"),
    *bullets([
        "takes a lease on the caller's phone (crm-links) so two calls from one new number cannot create two leads;",
        "resolves the record: stored link -> phone search -> email search -> create (with a 'creating' marker first, "
        "so a crash after Monday commits is followed by a search, not a second create);",
        "posts one note and, for existing records, updates the columns we own <b>in the same GraphQL request</b>;",
        "advances a per-phone watermark so an older call processed late never overwrites a newer call's fields.",
    ]),
    table([
        ["Caller", "Monday API calls per call", "Requests"],
        ["Returning (known at call time)", "2", "get item (lookup) + note & fields (sync)"],
        ["New", "3", "search (lookup) + create_item + note (sync)"],
        ["New, lookup skipped/failed", "4", "+1 search in the worker"],
    ], [0.34, 0.2, 0.46]),
    p("Monday's daily cap is per account and shared with the business's other integrations (1,000 on Standard, "
      "10,000 on Pro). Worker concurrency is capped at 5, below Monday's lowest concurrency limit (40).", SMALL),

    p("7. Idempotency and duplicate protection", H2),
    table([
        ["Risk", "Protection"],
        ["Retell repeats call_analyzed / SQS redelivers", "calls.crmStatus=synced short-circuits; re-arming a synced "
         "call is a conditional write that fails"],
        ["Two calls from the same new number at once", "Per-phone lease (conditional write, 2 min) - the second job "
         "backs off 15 s"],
        ["create_item committed but response lost", "'creating' marker forces a search on retry; plus Monday "
         "Idempotency-Key (30 min replay window)"],
        ["Note committed but response lost", "Idempotency-Key within 30 min; after that, the item's recent updates are "
         "searched for the note's 'Ref: &lt;callId&gt;' line before posting"],
        ["Request changed between attempts (mapping fixed)", "Idempotency keys are call + intent + hash of the request "
         "body, so a changed request is new, an identical retry is a replay"],
        ["Out-of-order calls", "lastAppliedEndedAt watermark on the phone link; notes are always recorded"],
        ["Record deleted in Monday", "not_found on write -> link cleared -> resolved again once (find or create)"],
    ], [0.36, 0.64]),

    p("8. Source of truth and field mapping", H2),
    table([
        ["Data", "Owner", "Sync"],
        ["Call, transcript, recording, summary, intent, outcome", "Symantic", "Summary and outcome into the note; "
         "transcript and recording never leave Symantic (the note links back)"],
        ["Appointment", "Calendar provider (via Symantic)", "One-way: 'Next appointment' date; cleared only if the "
         "cancelled appointment is the one we wrote"],
        ["Lead/contact record, name, email", "Monday", "Written only when we create the record"],
        ["Lead status", "Monday", "Set on creation; set to the follow-up label only if the admin chose one"],
        ["Owner / salesperson", "Monday", "Default owner on creation only; never changed afterwards"],
        ["Last call, call outcome, follow-up date", "Symantic", "One-way, newest call wins"],
        ["Caller phone -> Monday item", "Symantic (crm-links)", "Reference only"],
    ], [0.36, 0.2, 0.44]),
    p("Nothing syncs in both directions, so there is no loop to break.", SMALL),
    table([
        ["Receptionist field", "Monday column type", "Written when"],
        ["Phone (required)", "phone", "new lead; also the match key"],
        ["Email", "email", "new lead; secondary match key"],
        ["Lead status", "status", "new lead ('new lead' label); follow-up label if configured"],
        ["Owner", "people", "new lead (default owner)"],
        ["Last call / Follow-up date / Next appointment", "date", "every call (newest wins)"],
        ["Call outcome / Lead source", "text or long text", "every call / new lead"],
        ["Call note", "item update", "every call, exactly once"],
    ], [0.4, 0.2, 0.4]),

    p("9. Failure handling", H2),
    table([
        ["Condition", "During the call", "Post-call sync"],
        ["Monday slow / timeout / 5xx", "No context; call continues", "Retry: 30 s, 60 s, 2 min ... 15 min, then DLQ"],
        ["Rate limited (429, complexity)", "No context", "Retry after Monday's retry_in_seconds"],
        ["Daily API cap", "No context; lookups paused", "Connection paused until 00:05 UTC; messages wait, then catch up"],
        ["Token expired", "Refreshed if the lock is free", "Refreshed; one retry on 401"],
        ["Grant revoked / 6-month limit", "No context", "reauth_required; call marked failed; re-queued on reconnect"],
        ["Board or column deleted, label missing", "No context", "Mapping marked invalid, call failed (no pointless "
         "retries); re-queued when the admin fixes the mapping"],
        ["Unexpected bug / AWS error", "No context", "Bounded retries, then DLQ + alarm"],
    ], [0.3, 0.27, 0.43]),

    p("10. Security and tenant isolation", H2),
    *bullets([
        "Every read and write is keyed by the workspaceId from the caller's verified Cognito identity (or from a row "
        "we wrote) - never from Monday or the request body. Settings routes require the JWT authorizer; mutating "
        "routes require company-admin or super-admin.",
        "Monday scopes are not board-granular, so the adapter writes only to the mapped board and ignores records "
        "from any other board.",
        "Tokens are stored only as KMS ciphertext, never logged, never returned to the browser; the accountId index "
        "projects keys and state only. OAuth state is single-use, 10-minute, bound to workspace and redirect URI; "
        "returnTo cannot leave the app.",
        "Logs carry workspace and call ids, error codes and masked numbers (***0198) - no names, summaries or tokens.",
        "IAM is per function: BFF may invoke the lookup and read connection status; post-call may read status and "
        "enqueue; only crm/crm-worker can use the KMS key and the Monday secret.",
    ]),

    p("11. Observability", H2),
    table([
        ["Signal", "Source"],
        ["ApiLatency, ApiCall (by operation and outcome)", "Symantic/CRM metrics (EMF logs)"],
        ["InboundLookupLatency (by outcome), Lookup, LookupLatency", "BFF and crm Lambda"],
        ["SyncSucceeded / SyncFailed / SyncRetried / DeadLettered / SyncDuration / QueueAge", "crm-worker"],
        ["RateLimited, TokenRefresh, TokenFailure, OAuth, Webhook, LeaseBusy, StaleLink", "crm and crm-worker"],
        ["Alarms: DLQ not empty; queue older than 1 h; worker errors; >=10 lookup timeouts / 15 min; "
         ">=5 mapping failures / h", "CloudWatch (optional SNS via crm_alarm_topic_arn)"],
    ], [0.62, 0.38]),

    p("12. Operations", H2),
    p("<b>One-time setup (per environment).</b> Register a Monday app in the Developer Center with the "
      "'New OAuth flow' enabled; redirect URI = terraform output monday_oauth_redirect_uri; scopes me:read, "
      "account:read, boards:read, boards:write, updates:write, users:read; lifecycle webhook URL = terraform output "
      "monday_lifecycle_webhook_url. Store the credentials:"),
    p("aws secretsmanager put-secret-value --secret-id symantic/dev/monday-oauth \\<br/>"
      "&nbsp;&nbsp;--secret-string '{\"clientId\":\"...\",\"clientSecret\":\"...\",\"signingSecret\":\"...\",\"appId\":\"...\"}'",
      CODE),
    *bullets([
        "<b>DLQ redrive</b> after fixing the cause: SQS console 'Start DLQ redrive' (or start-message-move-task). "
        "Replays are safe - sync is idempotent.",
        "<b>Admin-fixable failures</b> (reconnect, mapping) retry themselves when fixed; 'Retry failed calls' on the "
        "Integrations page re-queues the last 7 days.",
        "<b>Monday API version</b> is pinned (2026-07, variable monday_api_version). Move it forward deliberately when "
        "Monday announces its deprecation, and rerun the suites.",
        "<b>Existing agents</b> receive the prompt's CALLER RECORD section the next time they are saved (as with "
        "every prompt change); until then their calls still sync after the call, only without in-call context.",
    ]),
    p("<b>Known limitations.</b> Calls log as item updates, not Monday CRM 'Emails &amp; Activities' timeline entries "
      "(that API has no idempotency key and needs a per-account activity type). Changes made in Monday are read at "
      "call time, not pushed to Symantic. Numbers on +1 are classified US unless the area code is Canadian; other "
      "NANP countries may be rejected by Monday's phone validation (the call fails as invalid_value, visibly).", SMALL),

    KeepTogether([
        p("13. Verification", H2),
        p(VERIFICATION["status"], SMALL),
        table([["Suite", "Result", "Covers"], *VERIFICATION["rows"]], [0.3, 0.2, 0.5]),
    ]),
]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=17 * mm,
                        bottomMargin=17 * mm, title="Monday CRM integration", author="Symantic Agents")
doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f"wrote {OUT}")
