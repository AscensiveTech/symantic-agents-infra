import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MARSHALLED_CALL_ITEM_BYTES,
  createDynamoPostcallStore,
  createHandler,
  marshalledCallItemBytes,
} from "./index.mjs";

test("invalid signature returns 401 without persisting the call", async () => {
  let storeLoads = 0;
  const handler = createHandler({
    verifySignature: () => false,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => {
      storeLoads += 1;
      return {};
    },
  });

  const response = await handler({
    requestContext: {
      http: {
        method: "POST",
        path: "/retell/webhooks/call-ended",
      },
    },
    rawPath: "/retell/webhooks/call-ended",
    headers: { "x-retell-signature": "invalid" },
    body: JSON.stringify({
      event: "call_ended",
      call: { call_id: "retell-call-123" },
    }),
  });

  assert.equal(response.statusCode, 401);
  assert.equal(storeLoads, 0);
});

test("valid call_ended persists a normalized call and marks a test agent tested", async () => {
  let persistedCall;
  let testedAgent;
  const store = {
    async upsertCall(record) {
      persistedCall = structuredClone(record);
    },
    async markAgentTested(workspaceId, agentId, testedAt) {
      testedAgent = { workspaceId, agentId, testedAt };
    },
  };
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => store,
    now: () => new Date("2026-08-16T14:00:00.000Z"),
  });
  const call = {
    call_id: "retell-call-123",
    call_status: "ended",
    direction: "outbound",
    from_number: "+17035550177",
    to_number: "+17035550100",
    start_timestamp: 1_800_000_000_000,
    end_timestamp: 1_800_000_123_000,
    recording_url: "https://retell.example/recording.wav",
    disconnection_reason: "user_hangup",
    metadata: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
      kind: "test",
    },
    transcript: "Agent: Hello\nUser: I need your hours.",
    transcript_object: [
      { role: "agent", content: "Hello", words: [{ start: 0.25, end: 0.5 }] },
      { role: "user", content: "I need your hours.", words: [{ start: 1.5, end: 2.5 }] },
    ],
    transcript_with_tool_calls: [],
  };

  const response = await handler(callEndedEvent(call));

  assert.equal(response.statusCode, 204);
  assert.match(persistedCall.callId, /^call-[a-f0-9]{24}$/);
  assert.notEqual(persistedCall.callId, call.call_id);
  assert.equal(persistedCall.retellCallId, call.call_id);
  assert.equal(persistedCall.workspaceId, "workspace-123");
  assert.equal(persistedCall.agentId, "agent-123");
  assert.equal(persistedCall.recordingKey, undefined); // recording is captured on call_analyzed
  assert.equal(persistedCall.callSummary, undefined); // summary arrives on call_analyzed
  assert.equal(persistedCall.outcome, "answered");
  assert.equal(persistedCall.durationMs, 123_000);
  assert.deepEqual(persistedCall.transcript, [
    { speaker: "Agent", text: "Hello", startMs: 250, endMs: 500 },
    { speaker: "Caller", text: "I need your hours.", startMs: 1_500, endMs: 2_500 },
  ]);
  assert.deepEqual(testedAgent, {
    workspaceId: "workspace-123",
    agentId: "agent-123",
    testedAt: "2026-08-16T14:00:00.000Z",
  });
});

test("call_analyzed persists the summary + sentiment and copies the recording to S3", async () => {
  let persistedCall;
  let testedAgent;
  const recordings = [];
  const store = {
    async upsertCall(record) {
      persistedCall = structuredClone(record);
    },
    async markAgentTested(workspaceId, agentId, testedAt) {
      testedAgent = { workspaceId, agentId, testedAt };
    },
  };
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => store,
    getRecordingStore: async () => ({
      async putRecording(key, body, contentType) {
        recordings.push({ key, bytes: body.length, contentType });
      },
    }),
    fetchImpl: async (url) => {
      assert.equal(url, "https://retell.example/final-recording.wav");
      return {
        ok: true,
        headers: { get: () => "audio/wav" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      };
    },
    now: () => new Date("2026-08-16T14:05:00.000Z"),
  });
  const call = {
    call_id: "retell-call-123",
    direction: "inbound",
    from_number: "+17035550100",
    to_number: "+17035550177",
    start_timestamp: 1_800_000_000_000,
    end_timestamp: 1_800_000_123_000,
    recording_url: "https://retell.example/final-recording.wav",
    metadata: { workspaceId: "workspace-123", agentId: "agent-123" },
    transcript_object: [
      { role: "user", content: "Are you open Saturday?", words: [{ start: 1, end: 2 }] },
    ],
    transcript_with_tool_calls: [],
    call_analysis: {
      call_summary: "Caller asked about Saturday hours; agent confirmed 9-1.",
      user_sentiment: "Positive",
      call_successful: true,
      in_voicemail: false,
    },
  };

  const response = await handler(callAnalyzedEvent(call));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.callSummary, call.call_analysis.call_summary);
  assert.equal(persistedCall.userSentiment, "Positive");
  assert.equal(persistedCall.callSuccessful, true);
  assert.equal(persistedCall.recordingKey, `calls/${persistedCall.callId}.wav`);
  assert.deepEqual(recordings, [{
    key: `workspaces/workspace-123/calls/${persistedCall.callId}.wav`,
    bytes: 4,
    contentType: "audio/wav",
  }]);
  assert.equal(testedAgent, undefined); // markAgentTested is call_ended's job
});

test("call_analyzed still succeeds when the recording download fails", async () => {
  let persistedCall;
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => ({ async upsertCall(record) { persistedCall = record; } }),
    getRecordingStore: async () => ({ async putRecording() { throw new Error("nope"); } }),
    fetchImpl: async () => ({ ok: false }),
    now: () => new Date("2026-08-16T14:05:00.000Z"),
  });
  const response = await handler(callAnalyzedEvent({
    call_id: "retell-call-123",
    recording_url: "https://retell.example/gone.wav",
    metadata: { workspaceId: "workspace-123", agentId: "agent-123" },
    transcript_with_tool_calls: [],
    call_analysis: { call_summary: "Short call." },
  }));
  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.callSummary, "Short call.");
  assert.equal(persistedCall.recordingKey, undefined);
});

test("failed test call_ended persists the call without marking the agent tested", async () => {
  let persistedCall;
  let testedAgent;
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => ({
      async upsertCall(record) {
        persistedCall = structuredClone(record);
      },
      async markAgentTested(workspaceId, agentId, testedAt) {
        testedAgent = { workspaceId, agentId, testedAt };
      },
    }),
    now: () => new Date("2026-08-16T14:00:00.000Z"),
  });

  const response = await handler(callEndedEvent({
    call_id: "retell-call-failed",
    call_status: "error",
    disconnection_reason: "error",
    metadata: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
      kind: "test",
    },
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.outcome, "failed");
  assert.equal(testedAgent, undefined);
});

test("abandoned test call_ended persists the call without marking the agent tested", async () => {
  let persistedCall;
  let testedAgent;
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => ({
      async upsertCall(record) {
        persistedCall = structuredClone(record);
      },
      async markAgentTested(workspaceId, agentId, testedAt) {
        testedAgent = { workspaceId, agentId, testedAt };
      },
    }),
    now: () => new Date("2026-08-16T14:00:00.000Z"),
  });

  const response = await handler(callEndedEvent({
    call_id: "retell-call-abandoned",
    call_status: "ended",
    disconnection_reason: "no_answer",
    metadata: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
      kind: "test",
    },
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.outcome, "abandoned");
  assert.equal(testedAgent, undefined);
});

test("call_ended resolves workspace from the Retell agent FK when metadata is absent", async () => {
  let persistedCall;
  const store = {
    async findAgentByRetellAgentId(retellAgentId) {
      assert.equal(retellAgentId, "retell-agent-123");
      return {
        workspaceId: "workspace-123",
        agentId: "agent-123",
      };
    },
    async upsertCall(record) {
      persistedCall = structuredClone(record);
    },
  };
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => store,
  });

  const response = await handler(callEndedEvent({
    call_id: "retell-call-123",
    agent_id: "retell-agent-123",
    call_status: "ended",
    transcript_with_tool_calls: [],
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.workspaceId, "workspace-123");
  assert.equal(persistedCall.agentId, "agent-123");
});

test("oversized transcript content is truncated instead of failing call ingest", async () => {
  let persistedCall;
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => ({
      async upsertCall(record) {
        persistedCall = structuredClone(record);
      },
    }),
  });
  const transcriptObject = Array.from({ length: 500 }, (_, index) => ({
    role: index % 2 ? "user" : "agent",
    content: `${index}:${"x".repeat(2_000)}`,
  }));

  const response = await handler(callEndedEvent({
    call_id: "retell-call-large",
    call_status: "ended",
    metadata: { workspaceId: "workspace-123", agentId: "agent-123" },
    transcript_object: transcriptObject,
    transcript_with_tool_calls: [],
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.transcriptTruncated, true);
  assert.match(persistedCall.transcriptNote, /truncated/i);
  assert.ok(
    marshalledCallItemBytes(persistedCall) <= MAX_MARSHALLED_CALL_ITEM_BYTES,
  );
  assert.ok(persistedCall.transcript.length < transcriptObject.length);
});

test("successful booking tool output sets booked and backfills its appointment", async () => {
  let persistedCall;
  let appointment;
  const store = {
    async upsertCall(record) {
      persistedCall = structuredClone(record);
    },
    async upsertAppointment(record) {
      appointment = structuredClone(record);
    },
  };
  const handler = createHandler({
    verifySignature: () => true,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => store,
    now: () => new Date("2026-08-16T14:00:00.000Z"),
  });
  const toolArguments = {
    workspaceId: "workspace-123",
    agentId: "agent-123",
    callId: "retell-call-123",
    idempotencyKey: "retell-call-123-calendar_create_booking",
    service: "Emergency exam",
    startTime: "2026-08-17T14:00:00-04:00",
    customer: {
      name: "Jordan Miles",
      phone: "+17035550123",
      email: "jordan@example.com",
    },
  };
  const call = {
    call_id: "retell-call-123",
    call_status: "ended",
    metadata: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
    },
    transcript_with_tool_calls: [
      {
        role: "tool_call_invocation",
        tool_call_id: "tool-1",
        name: "calendar_create_booking",
        arguments: JSON.stringify(toolArguments),
      },
      {
        role: "tool_call_result",
        tool_call_id: "tool-1",
        content: JSON.stringify({
          ok: true,
          appointmentId: "apt-existing-id",
          status: "confirmed",
          startTimeUtc: "2026-08-17T18:00:00.000Z",
          endTimeUtc: "2026-08-17T18:30:00.000Z",
          timezone: "America/New_York",
        }),
        successful: true,
      },
    ],
  };

  const response = await handler(callEndedEvent(call));

  assert.equal(response.statusCode, 204);
  assert.equal(persistedCall.outcome, "booked");
  assert.equal(persistedCall.callerName, "Jordan Miles");
  assert.equal(persistedCall.intent, "Emergency exam");
  assert.equal(appointment.appointmentId, "apt-existing-id");
  assert.equal(appointment.workspaceId, "workspace-123");
  assert.equal(appointment.callId, persistedCall.callId);
  assert.equal(appointment.retellCallId, "retell-call-123");
  assert.equal(appointment.agentId, "agent-123");
  assert.equal(appointment.service, "Emergency exam");
  assert.equal(appointment.startTimeUtc, "2026-08-17T18:00:00.000Z");
  assert.equal(appointment.customer.name, "Jordan Miles");
});

test("successful lead and message tool outputs backfill missing records", async () => {
  const cases = [
    {
      name: "lead_capture",
      outcome: "lead",
      args: {
        name: "Jordan Miles",
        phone: "+17035550123",
        email: "jordan@example.com",
        interest: "Emergency exam",
      },
      output: { ok: true, leadId: "lead-existing-id", status: "captured" },
      method: "upsertLead",
      idField: "leadId",
      id: "lead-existing-id",
    },
    {
      name: "message_take",
      outcome: "message",
      args: {
        name: "Alicia Chen",
        phone: "+15715550129",
        message: "Please call me about insurance.",
        urgency: "normal",
      },
      output: { ok: true, messageId: "msg-existing-id", status: "received" },
      method: "upsertMessage",
      idField: "messageId",
      id: "msg-existing-id",
    },
  ];

  for (const sample of cases) {
    let persistedCall;
    let backfilled;
    const store = {
      async upsertCall(record) {
        persistedCall = structuredClone(record);
      },
      async [sample.method](record) {
        backfilled = structuredClone(record);
      },
    };
    const handler = createHandler({
      verifySignature: () => true,
      getRetellApiKey: async () => "retell-key",
      getStore: async () => store,
      now: () => new Date("2026-08-16T14:00:00.000Z"),
    });
    const argumentsWithContext = {
      workspaceId: "workspace-123",
      agentId: "agent-123",
      callId: "retell-call-123",
      idempotencyKey: `retell-call-123-${sample.name}`,
      ...sample.args,
    };
    const call = {
      call_id: "retell-call-123",
      call_status: "ended",
      metadata: {
        workspaceId: "workspace-123",
        agentId: "agent-123",
      },
      transcript_with_tool_calls: [
        {
          role: "tool_call_invocation",
          tool_call_id: "tool-1",
          name: sample.name,
          arguments: JSON.stringify(argumentsWithContext),
        },
        {
          role: "tool_call_result",
          tool_call_id: "tool-1",
          content: JSON.stringify(sample.output),
          successful: true,
        },
      ],
    };

    const response = await handler(callEndedEvent(call));

    assert.equal(response.statusCode, 204);
    assert.equal(persistedCall.outcome, sample.outcome);
    assert.equal(backfilled[sample.idField], sample.id);
    assert.equal(backfilled.workspaceId, "workspace-123");
    assert.equal(backfilled.callId, persistedCall.callId);
    assert.equal(backfilled.retellCallId, "retell-call-123");
    assert.equal(backfilled.name, sample.args.name);
  }
});

test("Dynamo store synchronously writes calls, conditional backfills, and testedAt", async () => {
  class PutItemCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command);
      if (command.input.TableName === "leads-table") {
        const error = new Error("already exists");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      return {};
    },
  };
  const store = createDynamoPostcallStore(
    client,
    { PutItemCommand, UpdateItemCommand },
    {
      calls: "calls-table",
      appointments: "appointments-table",
      leads: "leads-table",
      messages: "messages-table",
      agents: "agents-table",
    },
  );

  await store.upsertCall({
    workspaceId: "workspace-123",
    callId: "call-123",
    retellCallId: "retell-call-123",
    createdAt: "2026-08-16T14:00:00.000Z",
  });
  await store.upsertAppointment({
    workspaceId: "workspace-123",
    appointmentId: "apt-123",
  });
  await store.upsertLead({
    workspaceId: "workspace-123",
    leadId: "lead-123",
  });
  await store.upsertMessage({
    workspaceId: "workspace-123",
    messageId: "msg-123",
  });
  await store.markAgentTested(
    "workspace-123",
    "agent-123",
    "2026-08-16T14:00:00.000Z",
  );

  assert.equal(sent[0].input.TableName, "calls-table");
  assert.equal(sent[0].input.ConditionExpression, undefined);
  assert.ok(sent[0] instanceof UpdateItemCommand);
  assert.match(sent[0].input.UpdateExpression, /#createdAt = if_not_exists\(#createdAt, :createdAt\)/);
  assert.match(sent[0].input.UpdateExpression, /#k0 = :v0/);
  for (const command of sent.slice(1, 4)) {
    assert.match(command.input.ConditionExpression, /attribute_not_exists/);
  }
  assert.equal(sent[4].input.TableName, "agents-table");
  assert.equal(sent[4].input.ConditionExpression, "attribute_exists(agentId)");
  assert.match(sent[4].input.UpdateExpression, /tested = :tested/);
  assert.match(sent[4].input.UpdateExpression, /testedAt = :testedAt/);
});

function callEndedEvent(call) {
  return webhookEvent("call_ended", call);
}

function callAnalyzedEvent(call) {
  return webhookEvent("call_analyzed", call);
}

function webhookEvent(eventName, call) {
  return {
    requestContext: {
      http: {
        method: "POST",
        path: "/retell/webhooks/call-ended",
      },
    },
    rawPath: "/retell/webhooks/call-ended",
    headers: { "x-retell-signature": "valid" },
    body: JSON.stringify({ event: eventName, call }),
  };
}
