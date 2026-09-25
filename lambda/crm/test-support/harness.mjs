// Wires the real CRM modules (API, sessions, adapter, sync, lookup, worker)
// to the fakes, so flow tests run the same code paths as production with
// only the network, DynamoDB, KMS and SQS replaced.

import { createHash } from "node:crypto";

import { createRecordingMetrics } from "../metrics.mjs";
import { composeRuntime } from "../runtime.mjs";
import { createWorker } from "../worker.mjs";
import {
  createClock,
  createFakeMonday,
  createFakeQueue,
  createFakeTokenCrypto,
  createMemoryCrmStore,
  TEST_APP_SECRET,
} from "./fakes.mjs";

export const APP_URL = "https://agents.example.test";
export const API_BASE = "https://api.example.test";

export function createHarness({ secret = TEST_APP_SECRET } = {}) {
  const clock = createClock();
  const monday = createFakeMonday({ now: clock });
  const board = monday.addBoard();
  const store = createMemoryCrmStore({
    now: clock,
    profiles: { "ws-a": { timezone: "America/New_York" }, "ws-b": { timezone: "Europe/London" } },
    memberships: {
      "sub-admin-a": { workspaceId: "ws-a", status: "active" },
      "sub-member-a": { workspaceId: "ws-a", status: "active" },
      "sub-admin-b": { workspaceId: "ws-b", status: "active" },
      "sub-disabled": { workspaceId: "ws-a", status: "disabled" },
    },
  });
  const tokenCrypto = createFakeTokenCrypto();
  const queue = createFakeQueue({ now: clock });
  const metrics = createRecordingMetrics();
  const logs = [];
  const log = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const runtime = composeRuntime({
    store,
    getAppSecret: async () => secret,
    tokenCrypto,
    enqueue: async (message) => queue.send({ v: 1, ...message }),
    changeVisibility: queue.changeVisibility,
    fetchImpl: monday.fetchImpl,
    appUrl: APP_URL,
    apiBaseUrl: API_BASE,
    metrics,
    now: clock,
    sleep: async (ms) => clock.advance(ms),
    log,
  });
  const worker = createWorker({
    sync: runtime.sync,
    changeVisibility: queue.changeVisibility,
    metrics,
    now: clock,
    log,
    random: () => 0,
  });

  function httpEvent(method, path, { sub, groups = ["company-admin"], body, query, headers } = {}) {
    return {
      rawPath: path,
      requestContext: {
        http: { method, path },
        ...(sub ? { authorizer: { jwt: { claims: { sub, username: sub, name: `User ${sub}`, "cognito:groups": groups } } } } : {}),
      },
      queryStringParameters: query,
      headers: headers ?? {},
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  const api = (method, path, options) => runtime.api(httpEvent(method, path, options));

  /** Full OAuth round trip through the real API: start -> consent -> callback. */
  async function connect({ sub = "sub-admin-a", returnTo = "/integrations" } = {}) {
    const start = await api("POST", "/crm/monday/start", { sub, body: { returnTo } });
    if (start.statusCode !== 200) return { start };
    const url = new URL(JSON.parse(start.body).authorizeUrl);
    const code = monday.issueCode({
      redirectUri: url.searchParams.get("redirect_uri"),
      challenge: url.searchParams.get("code_challenge"),
    });
    const callback = await api("GET", "/crm/oauth/monday/callback", {
      query: { code, state: url.searchParams.get("state") },
    });
    return { start, url, callback };
  }

  async function configureMapping({ sub = "sub-admin-a", overrides = {} } = {}) {
    const boards = JSON.parse((await api("GET", "/crm/monday/boards", { sub })).body);
    const target = boards.boards.find((b) => b.id === board.id);
    const mapping = {
      ...target.suggestion,
      labels: { newLead: "New Lead", followUp: "Follow up" },
      defaultOwnerId: "72",
      ...overrides,
    };
    return api("PUT", "/crm/mapping", { sub, body: { mapping } });
  }

  async function connectAndMap(options = {}) {
    await connect(options);
    const saved = await configureMapping(options);
    if (saved.statusCode !== 200) throw new Error(`mapping failed: ${saved.body}`);
    monday.reset();
    return saved;
  }

  /** A call row as the post-call Lambda would have written it. */
  function seedCall(overrides = {}) {
    const callId = overrides.callId ?? `call-${createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 12)}`;
    const call = {
      workspaceId: "ws-a",
      callId,
      retellCallId: `retell-${callId}`,
      callerNumber: "+12025550198",
      callerName: "Jane Doe",
      startedAt: new Date(clock() - 180_000).toISOString(),
      endedAt: new Date(clock() - 60_000).toISOString(),
      analyzedAt: new Date(clock()).toISOString(),
      durationMs: 120_000,
      outcome: "answered",
      intent: "Teeth whitening prices",
      callSummary: "Caller asked about whitening prices and hours.",
      toolLog: [],
      crmStatus: "pending",
      crmProvider: "monday",
      ...overrides,
    };
    store.seedCall(call);
    return call;
  }

  function enqueueCall(call) {
    queue.send({ v: 1, workspaceId: call.workspaceId, callId: call.callId, provider: "monday" });
  }

  /** Deliver queued messages until the queue is idle (advancing the clock past backoffs). */
  async function drain({ maxRounds = 50, advanceMs = 16 * 60 * 1000 } = {}) {
    for (let round = 0; round < maxRounds; round += 1) {
      const event = queue.receive(5);
      if (!event.Records.length) {
        if (!queue.messages.length) return;
        clock.advance(advanceMs);
        continue;
      }
      const result = await worker(event);
      queue.settle(event, result);
    }
  }

  return {
    clock,
    monday,
    board,
    store,
    tokenCrypto,
    queue,
    metrics,
    logs,
    runtime,
    worker,
    api,
    httpEvent,
    connect,
    configureMapping,
    connectAndMap,
    seedCall,
    enqueueCall,
    drain,
  };
}

export function toolLogFor(actions) {
  const log = [];
  actions.forEach(({ name, args = {}, output = { ok: true }, successful = true }, index) => {
    log.push({ role: "tool_call_invocation", tool_call_id: `t${index}`, name, arguments: JSON.stringify(args) });
    log.push({ role: "tool_call_result", tool_call_id: `t${index}`, successful, content: JSON.stringify(output) });
  });
  return log;
}
