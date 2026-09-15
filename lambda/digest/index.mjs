import { describeSendFailure, getDefaultSender, normalizeEmail } from "./email.mjs";
import { renderDigest } from "./render.mjs";
import { isDigestDue, normalizeDigestSettings } from "./schedule.mjs";

const TEST_WINDOW_MS = 24 * 3_600_000;

function recipientsFor(adminEmails, settings) {
  const seen = new Set();
  for (const candidate of [...adminEmails, ...settings.extraRecipients]) {
    const email = normalizeEmail(candidate);
    if (email) seen.add(email);
  }
  return [...seen];
}

function appLinks(appUrl) {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  return {
    dashboardUrl: `${base}/call-history`,
    settingsUrl: `${base}/agents/maya-receptionist/call-summaries`,
  };
}

export function createDigestHandler({
  getStore = getDefaultStore,
  getSender = getDefaultSender,
  appUrl = process.env.APP_URL,
  now = () => new Date(),
  log = console,
} = {}) {
  const links = appLinks(appUrl);

  function composeFor(workspace, settings, calls, windowStart, windowEnd, isTest) {
    return renderDigest({
      workspaceName: workspace.name,
      calls,
      timezone: settings.timezone,
      windowStart,
      windowEnd,
      isTest,
      ...links,
    });
  }

  async function runWorkspace(store, workspace, current) {
    const settings = normalizeDigestSettings(workspace.callDigest);
    if (!settings.enabled) return "disabled";
    const cursor = workspace.callDigestCursor;
    if (!cursor) {
      // Summaries cover calls from the moment they were turned on, never the
      // whole back catalogue - start the window now.
      await store.initializeCursor(workspace.workspaceId, current.toISOString());
      return "initialized";
    }
    if (!isDigestDue(settings, cursor, current)) return "not_due";

    const windowEnd = current.toISOString();
    // Claim the window before sending, so two overlapping runs can never send
    // the same summary twice.
    if (!await store.claimWindow(workspace.workspaceId, cursor, windowEnd)) return "claimed_elsewhere";

    const calls = await store.listCallsAnalyzedBetween(workspace.workspaceId, cursor, windowEnd);
    if (!calls.length) {
      await store.recordRun(workspace.workspaceId, { at: windowEnd, status: "no_calls", callCount: 0 });
      return "no_calls";
    }
    const recipients = recipientsFor(await store.listAdminEmails(workspace.workspaceId), settings);
    if (!recipients.length) {
      await store.recordRun(workspace.workspaceId, {
        at: windowEnd,
        status: "no_recipients",
        callCount: calls.length,
      });
      return "no_recipients";
    }

    const message = composeFor(workspace, settings, calls, cursor, windowEnd, false);
    const send = await getSender();
    const failures = [];
    for (const to of recipients) {
      try {
        await send({ to, ...message });
      } catch (error) {
        failures.push({ to, error });
        log.error("Call summary email failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
    }
    if (failures.length === recipients.length) {
      // Nobody received it - hand the window back so the next tick retries.
      await store.releaseWindow(workspace.workspaceId, windowEnd, cursor);
      await store.recordRun(workspace.workspaceId, {
        at: windowEnd,
        status: "failed",
        callCount: calls.length,
        recipientCount: recipients.length,
        error: describeSendFailure(failures[0].error),
      });
      return "failed";
    }
    await store.recordRun(workspace.workspaceId, {
      at: windowEnd,
      status: "sent",
      callCount: calls.length,
      recipientCount: recipients.length - failures.length,
      ...(failures.length
        ? {
          failedCount: failures.length,
          error: describeSendFailure(failures[0].error),
        }
        : {}),
    });
    const sentTo = recipients.filter((to) => !failures.some((failure) => failure.to === to));
    await store.appendNotification(workspace.workspaceId, {
      id: `${workspace.workspaceId}-${windowEnd}`,
      sentAt: windowEnd,
      recipients: sentTo,
      content: message.subject,
      read: false,
    }, workspace.notifications ?? []);
    return "sent";
  }

  async function sendTest(store, { workspaceId, recipient }) {
    const to = normalizeEmail(recipient);
    if (typeof workspaceId !== "string" || !workspaceId || !to) {
      return { sent: false, error: "A workspace and a valid recipient are required." };
    }
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) return { sent: false, error: "Workspace not found." };
    const settings = normalizeDigestSettings(workspace.callDigest);
    const windowEnd = now();
    const windowStart = new Date(windowEnd.getTime() - TEST_WINDOW_MS);
    const calls = await store.listCallsAnalyzedBetween(
      workspaceId,
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );
    const message = composeFor(
      workspace,
      settings,
      calls,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      true,
    );
    try {
      await (await getSender())({ to, ...message });
      return { sent: true, to, callCount: calls.length };
    } catch (error) {
      log.error("Test call summary email failed", {
        workspaceId,
        name: error?.name,
        message: error?.message,
      });
      return { sent: false, to, error: describeSendFailure(error) };
    }
  }

  return async function handle(event) {
    const store = await getStore();
    if (event?.action === "send-test") return sendTest(store, event);

    const current = now();
    const results = {};
    for (const workspace of await store.listDigestWorkspaces()) {
      try {
        const outcome = await runWorkspace(store, workspace, current);
        results[outcome] = (results[outcome] ?? 0) + 1;
      } catch (error) {
        // One workspace's failure must not stop everyone else's summary.
        results.error = (results.error ?? 0) + 1;
        log.error("Call summary run failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
    }
    log.info("Call summary run complete", results);
    return results;
  };
}

// ---------------------------------------------------------------------------
// DynamoDB store
// ---------------------------------------------------------------------------

function toAttributeValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  if (typeof value === "object") {
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, toAttributeValue(item)]),
      ),
    };
  }
  throw new TypeError(`Unsupported DynamoDB value: ${typeof value}`);
}

function marshall(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toAttributeValue(item)]),
  );
}

function fromAttributeValue(value) {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.L) return value.L.map(fromAttributeValue);
  if (value.M) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, item]) => [key, fromAttributeValue(item)]),
    );
  }
  return undefined;
}

function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}

async function queryAll(client, command) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await client.send(command(exclusiveStartKey));
    items.push(...(result.Items ?? []).map(unmarshall));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export function createDynamoDigestStore(client, commands, tableNames) {
  async function conditionalUpdate(input) {
    try {
      await client.send(new commands.UpdateItemCommand(input));
      return true;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  return {
    listDigestWorkspaces() {
      return queryAll(client, (startKey) => new commands.ScanCommand({
        TableName: tableNames.workspaces,
        FilterExpression: "#digest.#enabled = :true",
        ProjectionExpression: "workspaceId, #name, #digest, callDigestCursor, notifications",
        ExpressionAttributeNames: { "#digest": "callDigest", "#enabled": "enabled", "#name": "name" },
        ExpressionAttributeValues: marshall({ ":true": true }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
    },

    async getWorkspace(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    // Calls enter a summary once Retell's analysis (summary + transcript) has
    // landed - not when they start - so a call still in progress at one run is
    // picked up by the next instead of being skipped. Sample calls never count.
    listCallsAnalyzedBetween(workspaceId, startIso, endIso) {
      return queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.calls,
        KeyConditionExpression: "workspaceId = :workspaceId",
        FilterExpression:
          "analyzedAt > :start AND analyzedAt <= :end AND " +
          "(attribute_not_exists(demoSeed) OR demoSeed <> :true)",
        ExpressionAttributeValues: marshall({
          ":workspaceId": workspaceId,
          ":start": startIso,
          ":end": endIso,
          ":true": true,
        }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
    },

    async listAgents(workspaceId) {
      const agents = await queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.agents,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ProjectionExpression: "agentId, #name",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      return agents.filter((agent) => typeof agent.agentId === "string");
    },

    async listAdminEmails(workspaceId) {
      const members = await queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.workspaceMemberships,
        IndexName: "workspaceId-index",
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      return members
        .filter((member) => member.role === "company-admin" && member.status !== "disabled")
        .map((member) => member.email)
        .filter((email) => typeof email === "string");
    },

    initializeCursor(workspaceId, cursor) {
      return conditionalUpdate({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET callDigestCursor = if_not_exists(callDigestCursor, :cursor)",
        ExpressionAttributeValues: marshall({ ":cursor": cursor }),
      });
    },

    claimWindow(workspaceId, expectedCursor, nextCursor) {
      return conditionalUpdate({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET callDigestCursor = :next",
        ConditionExpression: "callDigestCursor = :expected",
        ExpressionAttributeValues: marshall({ ":next": nextCursor, ":expected": expectedCursor }),
      });
    },

    releaseWindow(workspaceId, claimedCursor, previousCursor) {
      return conditionalUpdate({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET callDigestCursor = :previous",
        ConditionExpression: "callDigestCursor = :claimed",
        ExpressionAttributeValues: marshall({ ":previous": previousCursor, ":claimed": claimedCursor }),
      });
    },

    recordRun(workspaceId, run) {
      return conditionalUpdate({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET callDigestLastRun = :run",
        ExpressionAttributeValues: marshall({ ":run": run }),
      });
    },

    // The last 100 sent notifications, newest first - kept as a single list
    // on the workspace item so the settings page can show a history without
    // a dedicated table. `current` is passed in by the caller (already held
    // from the same scan that drove this run) to avoid an extra read.
    appendNotification(workspaceId, entry, current) {
      const notifications = [entry, ...(Array.isArray(current) ? current : [])].slice(0, 100);
      return client.send(new commands.UpdateItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET notifications = :list",
        ExpressionAttributeValues: marshall({ ":list": notifications }),
      }));
    },
  };
}

let defaultStorePromise;

function getDefaultStore() {
  defaultStorePromise ??= import("@aws-sdk/client-dynamodb").then((dynamodb) => {
    for (const name of ["WORKSPACES_TABLE", "CALLS_TABLE", "AGENTS_TABLE", "WORKSPACE_MEMBERSHIPS_TABLE"]) {
      if (!process.env[name]) throw new Error(`${name} is required`);
    }
    return createDynamoDigestStore(new dynamodb.DynamoDBClient({}), dynamodb, {
      workspaces: process.env.WORKSPACES_TABLE,
      calls: process.env.CALLS_TABLE,
      agents: process.env.AGENTS_TABLE,
      workspaceMemberships: process.env.WORKSPACE_MEMBERSHIPS_TABLE,
    });
  });
  return defaultStorePromise;
}

export const handler = createDigestHandler();
