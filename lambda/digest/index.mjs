import { describeSendFailure, getDefaultSender, normalizeEmail } from "./email.mjs";
import { renderDigest, renderNegativeSentimentAlert, renderBookingAlert, renderUsageThresholdAlert } from "./render.mjs";
import { isDigestDue, normalizeDigestSettings, normalizeNegativeSentimentSettings, normalizeUsageThresholdSettings } from "./schedule.mjs";
// Reused rather than duplicated - see lambda_digest.tf for how the whole
// bff module set is packaged alongside this Lambda's own files so this
// import resolves at runtime, same pattern as lambda/kb-refresh/index.mjs.
import { buildUsage, resolveAccountPlan } from "../bff/receptionist-billing.mjs";

const TEST_WINDOW_MS = 24 * 3_600_000;

function senderAddress() {
  return process.env.EMAIL_FROM ?? "";
}

function recipientsFor(settings) {
  const seen = new Set();
  for (const candidate of settings.recipients) {
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
    if (!calls.length && settings.skipIfEmpty) {
      await store.recordRun(workspace.workspaceId, { at: windowEnd, status: "no_calls", callCount: 0 });
      return "no_calls";
    }
    const recipients = recipientsFor(settings);
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
      sender: senderAddress(),
      recipients: sentTo,
      content: message.text ?? message.subject,
      read: false,
    }, workspace.notifications ?? []);
    return "sent";
  }

  // Independent of the call-digest schedule above - runs every tick
  // (the Lambda's own 5-minute EventBridge schedule), for any workspace with
  // this feature enabled and recipients configured, regardless of whether
  // call-digest summaries are even turned on. One email per pending call,
  // rather than batching several calls into one message, since each needs
  // its own summary/transcript/Call History link.
  async function runNegativeSentimentAlerts(store, workspace) {
    const settings = normalizeNegativeSentimentSettings(workspace.negativeSentimentAlert);
    if (!settings.enabled) return "disabled";
    const recipients = recipientsFor(settings);
    if (!recipients.length) return "no_recipients";
    const pending = await store.listPendingNegativeSentimentCalls(workspace.workspaceId);
    if (!pending.length) return "no_calls";

    const send = await getSender();
    let sentCount = 0;
    // Tracked locally and threaded through each appendNotification call
    // below - two alerts sent in the same tick must not each overwrite the
    // other by both prepending onto the same stale pre-loop snapshot.
    let notifications = workspace.notifications ?? [];
    for (const call of pending) {
      const message = renderNegativeSentimentAlert({
        workspaceName: workspace.name,
        call,
        recipients,
        timezone: normalizeDigestSettings(workspace.callDigest).timezone,
        dashboardUrl: links.dashboardUrl,
      });
      let anySent = false;
      for (const to of recipients) {
        try {
          await send({ to, ...message });
          anySent = true;
        } catch (error) {
          log.error("Negative sentiment alert email failed", {
            workspaceId: workspace.workspaceId,
            callId: call.callId,
            name: error?.name,
            message: error?.message,
          });
        }
      }
      // Marked once anyone got it - a fully-failed send (e.g. every address
      // rejected) is left pending so the next tick retries it, same
      // "hand the window back on total failure" idea as the digest above.
      if (anySent) {
        await store.markNegativeSentimentAlerted(workspace.workspaceId, call.callId);
        sentCount += 1;
        const entry = {
          id: `${workspace.workspaceId}-negative-sentiment-${call.callId}`,
          sentAt: now().toISOString(),
          sender: senderAddress(),
          recipients,
          content: message.text ?? message.subject,
          read: false,
        };
        await store.appendNotification(workspace.workspaceId, entry, notifications);
        notifications = [entry, ...notifications];
      }
    }
    return sentCount > 0 ? "sent" : "failed";
  }

  // Same independent-of-digest-schedule pattern as runNegativeSentimentAlerts
  // above, reusing the existing call-digest recipient list rather than its
  // own dedicated settings/recipients - per the product decision, anyone who
  // wants the periodic call digest also gets booking confirmations.
  async function runBookingAlerts(store, workspace) {
    const settings = normalizeDigestSettings(workspace.callDigest);
    const recipients = recipientsFor(settings);
    if (!recipients.length) return "no_recipients";
    const pending = await store.listPendingBookingAlerts(workspace.workspaceId);
    if (!pending.length) return "no_calls";

    const send = await getSender();
    let sentCount = 0;
    let notifications = workspace.notifications ?? [];
    for (const call of pending) {
      const message = renderBookingAlert({
        workspaceName: workspace.name,
        call,
        recipients,
        timezone: settings.timezone,
      });
      let anySent = false;
      for (const to of recipients) {
        try {
          await send({ to, ...message });
          anySent = true;
        } catch (error) {
          log.error("Booking alert email failed", {
            workspaceId: workspace.workspaceId,
            callId: call.callId,
            name: error?.name,
            message: error?.message,
          });
        }
      }
      if (anySent) {
        await store.markBookingAlerted(workspace.workspaceId, call.callId);
        sentCount += 1;
        const entry = {
          id: `${workspace.workspaceId}-booking-${call.callId}`,
          sentAt: now().toISOString(),
          sender: senderAddress(),
          recipients,
          content: message.text ?? message.subject,
          read: false,
        };
        await store.appendNotification(workspace.workspaceId, entry, notifications);
        notifications = [entry, ...notifications];
      }
    }
    return sentCount > 0 ? "sent" : "failed";
  }

  // Deletes notifications older than 12 months from sentAt - real deletion,
  // not just a display cap (see appendNotification's own comment above).
  // Runs every tick against whatever `notifications` listDigestWorkspaces
  // already projected, so it's a cheap in-memory filter, no extra read.
  async function runNotificationRetention(store, workspace) {
    const all = Array.isArray(workspace.notifications) ? workspace.notifications : [];
    if (!all.length) return "empty";
    const cutoff = new Date(now());
    cutoff.setMonth(cutoff.getMonth() - 12);
    const kept = all.filter((entry) => {
      const sentAt = entry?.sentAt ? new Date(entry.sentAt) : null;
      return !sentAt || Number.isNaN(sentAt.getTime()) || sentAt >= cutoff;
    });
    if (kept.length === all.length) return "nothing_expired";
    await store.pruneOldNotifications(workspace.workspaceId, kept);
    return "pruned";
  }

  function usageComputationInputs(usage) {
    const allowance = usage.minuteAllowance;
    return {
      usagePercent: allowance ? usage.billingCycle.minutes / allowance : 0,
      minutesUsed: usage.billingCycle.minutes,
      minuteAllowance: allowance,
      overageMinutes: usage.billingCycle.overageMinutes,
      overageCharge: usage.billingCycle.overageCharge,
      overagePerMinute: usage.overagePerMinute ?? 0.5,
      cycleStartsOn: usage.billingCycle.startsOn,
      cycleEndsOn: usage.billingCycle.endsOn,
    };
  }

  // Independent of the other alert types above, same per-tick scan - but
  // the actual usage computation (fetching every call + every agent for the
  // workspace, same as the Billing & Usage page) only runs once per
  // workspace per calendar day, not every 5-minute tick, since it's a much
  // heavier read than the other alert checks. 90%/100% don't need
  // minute-level detection to satisfy "send once when crossed", and the
  // post-100% repeat is explicitly already a once-daily email.
  async function runUsageThresholdAlerts(store, workspace) {
    const settings = normalizeUsageThresholdSettings(workspace.usageThresholdAlert);
    if (!settings.enabled) return "disabled";
    const recipients = recipientsFor(settings);
    if (!recipients.length) return "no_recipients";

    const timezone = normalizeDigestSettings(workspace.callDigest).timezone;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now());
    if (settings.lastCheckedOn === today) return "already_checked_today";

    const [fullWorkspace, agents, calls] = await Promise.all([
      store.getWorkspace(workspace.workspaceId),
      store.listAgentsForUsage(workspace.workspaceId),
      store.listCallsForUsage(workspace.workspaceId),
    ]);
    const plan = resolveAccountPlan(agents, fullWorkspace);
    const usage = buildUsage(calls, { now: now(), timezone, plan });

    let tracking = settings;
    if (tracking.period !== usage.billingCycle.period) {
      tracking = { ...settings, period: usage.billingCycle.period, sentAt90: false, sentAt100: false, lastDailySentOn: null };
    }

    if (usage.minuteAllowance == null) {
      await store.saveUsageThresholdTracking(workspace.workspaceId, { ...tracking, lastCheckedOn: today });
      return "no_cap";
    }

    const inputs = usageComputationInputs(usage);
    let trigger = null;
    if (inputs.usagePercent >= 1) {
      trigger = !tracking.sentAt100 ? "100" : (tracking.lastDailySentOn !== today ? "daily" : null);
    } else if (inputs.usagePercent >= 0.9 && !tracking.sentAt90) {
      trigger = "90";
    }

    if (!trigger) {
      await store.saveUsageThresholdTracking(workspace.workspaceId, { ...tracking, lastCheckedOn: today });
      return "no_trigger";
    }

    const message = renderUsageThresholdAlert({
      workspaceName: workspace.name,
      trigger,
      ...inputs,
      recipients,
      timezone,
    });
    const send = await getSender();
    let anySent = false;
    for (const to of recipients) {
      try {
        await send({ to, ...message });
        anySent = true;
      } catch (error) {
        log.error("Usage threshold alert email failed", {
          workspaceId: workspace.workspaceId,
          trigger,
          name: error?.name,
          message: error?.message,
        });
      }
    }

    const nextTracking = {
      ...tracking,
      lastCheckedOn: today,
      sentAt90: trigger === "90" ? true : tracking.sentAt90,
      sentAt100: trigger === "100" ? true : tracking.sentAt100,
      lastDailySentOn: trigger === "100" || trigger === "daily" ? today : tracking.lastDailySentOn,
    };
    await store.saveUsageThresholdTracking(workspace.workspaceId, nextTracking);

    if (anySent) {
      const entry = {
        id: `${workspace.workspaceId}-usage-${trigger}-${today}`,
        sentAt: now().toISOString(),
        sender: senderAddress(),
        recipients,
        content: message.text ?? message.subject,
        read: false,
      };
      await store.appendNotification(workspace.workspaceId, entry, workspace.notifications ?? []);
      return "sent";
    }
    return "failed";
  }

  async function sendUsageThresholdTest(store, { workspaceId, recipient }) {
    const to = normalizeEmail(recipient);
    if (typeof workspaceId !== "string" || !workspaceId || !to) {
      return { sent: false, error: "A workspace and a valid recipient are required." };
    }
    const [workspace, agents, calls] = await Promise.all([
      store.getWorkspace(workspaceId),
      store.listAgentsForUsage(workspaceId),
      store.listCallsForUsage(workspaceId),
    ]);
    if (!workspace) return { sent: false, error: "Workspace not found." };
    const timezone = normalizeDigestSettings(workspace.callDigest).timezone;
    const plan = resolveAccountPlan(agents, workspace);
    const usage = buildUsage(calls, { now: now(), timezone, plan });
    const inputs = usageComputationInputs(usage);
    const trigger = inputs.usagePercent >= 1 ? "100" : "90";
    const message = renderUsageThresholdAlert({
      workspaceName: workspace.name,
      trigger,
      ...inputs,
      recipients: [to],
      timezone,
    });
    try {
      await (await getSender())({ to, ...message });
      await store.appendNotification(workspaceId, {
        id: `${workspaceId}-usage-test-${now().getTime()}`,
        sentAt: now().toISOString(),
        sender: senderAddress(),
        recipients: [to],
        content: message.text ?? message.subject,
        test: true,
        read: false,
      }, workspace.notifications ?? []);
      return { sent: true, to };
    } catch (error) {
      log.error("Test usage threshold alert email failed", {
        workspaceId,
        name: error?.name,
        message: error?.message,
      });
      return { sent: false, to, error: describeSendFailure(error) };
    }
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
      await store.appendNotification(workspaceId, {
        id: `${workspaceId}-test-${windowEnd.getTime()}`,
        sentAt: windowEnd.toISOString(),
        sender: senderAddress(),
        recipients: [to],
        content: message.text ?? message.subject,
        test: true,
        read: false,
      }, workspace.notifications ?? []);
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

  // Uses the workspace's most recent negative-sentiment call as the sample
  // when one exists, so a test looks like a real alert - falls back to a
  // synthetic placeholder call so a test can still be sent even when the
  // workspace has never actually had one.
  async function sendNegativeSentimentTest(store, { workspaceId, recipient }) {
    const to = normalizeEmail(recipient);
    if (typeof workspaceId !== "string" || !workspaceId || !to) {
      return { sent: false, error: "A workspace and a valid recipient are required." };
    }
    const workspace = await store.getWorkspace(workspaceId);
    if (!workspace) return { sent: false, error: "Workspace not found." };
    const windowEnd = now();
    const windowStart = new Date(0);
    const calls = await store.listCallsAnalyzedBetween(workspaceId, windowStart.toISOString(), windowEnd.toISOString());
    const negativeCalls = calls
      .filter((call) => String(call.userSentiment ?? "").toLowerCase() === "negative")
      .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    const sampleCall = negativeCalls[0] ?? {
      callId: "sample-call",
      callerName: "Jordan Miles",
      callerNumber: "+15555550123",
      startedAt: windowEnd.toISOString(),
      callSummary: "This is a sample - no negative-sentiment call has happened yet. A caller was upset about a billing error and asked to speak with a manager.",
      transcript: [
        { speaker: "Agent", text: "Thanks for calling - how can I help?" },
        { speaker: "Caller", text: "I've been charged twice and nobody has fixed it yet." },
      ],
    };
    const message = renderNegativeSentimentAlert({
      workspaceName: workspace.name,
      call: sampleCall,
      recipients: [to],
      timezone: normalizeDigestSettings(workspace.callDigest).timezone,
      dashboardUrl: links.dashboardUrl,
    });
    try {
      await (await getSender())({ to, ...message });
      await store.appendNotification(workspaceId, {
        id: `${workspaceId}-negative-sentiment-test-${windowEnd.getTime()}`,
        sentAt: windowEnd.toISOString(),
        sender: senderAddress(),
        recipients: [to],
        content: message.text ?? message.subject,
        test: true,
        read: false,
      }, workspace.notifications ?? []);
      return { sent: true, to, sample: !negativeCalls.length };
    } catch (error) {
      log.error("Test negative sentiment alert email failed", {
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
    if (event?.action === "send-negative-sentiment-test") return sendNegativeSentimentTest(store, event);
    if (event?.action === "send-usage-threshold-test") return sendUsageThresholdTest(store, event);

    const current = now();
    const results = {};
    const alertResults = {};
    const bookingResults = {};
    const usageResults = {};
    const pruneResults = {};
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
      // Independent of the digest outcome above - a workspace with
      // call-digest off can still have this on, and vice versa.
      try {
        const outcome = await runNegativeSentimentAlerts(store, workspace);
        alertResults[outcome] = (alertResults[outcome] ?? 0) + 1;
      } catch (error) {
        alertResults.error = (alertResults.error ?? 0) + 1;
        log.error("Negative sentiment alert run failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
      // Independent of both the digest and the negative-sentiment alert
      // above - a workspace can have any combination of the three on or off.
      try {
        const outcome = await runBookingAlerts(store, workspace);
        bookingResults[outcome] = (bookingResults[outcome] ?? 0) + 1;
      } catch (error) {
        bookingResults.error = (bookingResults.error ?? 0) + 1;
        log.error("Booking alert run failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
      // Independent of everything above - can be on regardless of any other
      // alert's state, and defaults to on for every workspace.
      try {
        const outcome = await runUsageThresholdAlerts(store, workspace);
        usageResults[outcome] = (usageResults[outcome] ?? 0) + 1;
      } catch (error) {
        usageResults.error = (usageResults.error ?? 0) + 1;
        log.error("Usage threshold alert run failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
      // Real 12-month deletion, not a display cap - see
      // runNotificationRetention's own comment above.
      try {
        const outcome = await runNotificationRetention(store, workspace);
        pruneResults[outcome] = (pruneResults[outcome] ?? 0) + 1;
      } catch (error) {
        pruneResults.error = (pruneResults.error ?? 0) + 1;
        log.error("Notification retention run failed", {
          workspaceId: workspace.workspaceId,
          name: error?.name,
          message: error?.message,
        });
      }
    }
    log.info("Call summary run complete", results);
    log.info("Negative sentiment alert run complete", alertResults);
    log.info("Booking alert run complete", bookingResults);
    log.info("Usage threshold alert run complete", usageResults);
    log.info("Notification retention run complete", pruneResults);
    return {
      ...results,
      negativeSentimentAlerts: alertResults,
      bookingAlerts: bookingResults,
      usageThresholdAlerts: usageResults,
      notificationRetention: pruneResults,
    };
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
    // A workspace qualifies if EITHER call-digest summaries or negative-
    // sentiment alerts are on - the two are independent features that just
    // happen to share this same per-tick scan and Lambda.
    listDigestWorkspaces() {
      return queryAll(client, (startKey) => new commands.ScanCommand({
        TableName: tableNames.workspaces,
        // usageThresholdAlert defaults to enabled when absent (a workspace
        // that has never touched this setting is still "on" by default per
        // the product decision), so it needs its own not-explicitly-false
        // clause rather than an enabled=true check like the other two.
        FilterExpression: "#digest.#enabled = :true OR #alert.#enabled = :true OR #usage.#enabled <> :false OR attribute_not_exists(#usage)",
        ProjectionExpression: "workspaceId, #name, #digest, callDigestCursor, notifications, #alert, #usage",
        ExpressionAttributeNames: {
          "#digest": "callDigest",
          "#alert": "negativeSentimentAlert",
          "#usage": "usageThresholdAlert",
          "#enabled": "enabled",
          "#name": "name",
        },
        ExpressionAttributeValues: marshall({ ":true": true, ":false": false }),
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

    // Set to NULL (not omitted) by the postcall Lambda the moment a call's
    // sentiment comes back negative - a plain equality filter against the
    // NULL type finds every call still awaiting its alert. Never touched
    // again here once set to a real timestamp by markNegativeSentimentAlerted.
    listPendingNegativeSentimentCalls(workspaceId) {
      return queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.calls,
        KeyConditionExpression: "workspaceId = :workspaceId",
        FilterExpression: "negativeSentimentAlertedAt = :null",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId, ":null": null }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
    },

    markNegativeSentimentAlerted(workspaceId, callId) {
      return client.send(new commands.UpdateItemCommand({
        TableName: tableNames.calls,
        Key: marshall({ workspaceId, callId }),
        UpdateExpression: "SET negativeSentimentAlertedAt = :now",
        ExpressionAttributeValues: marshall({ ":now": new Date().toISOString() }),
      }));
    },

    // Same pattern as listPendingNegativeSentimentCalls/
    // markNegativeSentimentAlerted above, keyed on bookingAlertedAt instead.
    listPendingBookingAlerts(workspaceId) {
      return queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.calls,
        KeyConditionExpression: "workspaceId = :workspaceId",
        FilterExpression: "bookingAlertedAt = :null",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId, ":null": null }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
    },

    markBookingAlerted(workspaceId, callId) {
      return client.send(new commands.UpdateItemCommand({
        TableName: tableNames.calls,
        Key: marshall({ workspaceId, callId }),
        UpdateExpression: "SET bookingAlertedAt = :now",
        ExpressionAttributeValues: marshall({ ":now": new Date().toISOString() }),
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

    // Fuller agent projection than listAgents above - only used by the
    // usage-threshold alert's once-a-day check (see runUsageThresholdAlerts),
    // which needs each agent's status + configuration.receptionistPlan to
    // call resolveAccountPlan the same way the Billing & Usage page does.
    async listAgentsForUsage(workspaceId) {
      const agents = await queryAll(client, (startKey) => new commands.QueryCommand({
        TableName: tableNames.agents,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ProjectionExpression: "agentId, #status, configuration",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      return agents.filter((agent) => typeof agent.agentId === "string");
    },

    // Mirrors listCallsForUsage in lambda/bff/index.mjs - same table, same
    // lean projection, same 20k cap - kept as a separate copy here rather
    // than a shared export since the two Lambdas' store factories aren't
    // otherwise unified.
    async listCallsForUsage(workspaceId) {
      const items = [];
      let exclusiveStartKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tableNames.calls,
          KeyConditionExpression: "workspaceId = :workspaceId",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
          ConsistentRead: false,
          ProjectionExpression: "callId, agentId, startedAt, createdAt, durationMs, outcome, demoSeed",
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        items.push(...(result.Items ?? []).map((item) => unmarshall(item)));
        exclusiveStartKey = result.LastEvaluatedKey;
        if (items.length >= 20_000) break;
      } while (exclusiveStartKey);
      return items;
    },

    async saveUsageThresholdTracking(workspaceId, settings) {
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET usageThresholdAlert = :alert",
        ExpressionAttributeValues: marshall({ ":alert": settings }),
      }));
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

    // Sent notifications, newest first - kept as a single list on the
    // workspace item so the settings page can show a history without a
    // dedicated table. No count cap here - retention is time-based (12
    // months, see pruneOldNotifications below), not a fixed item count, so
    // a busy workspace doesn't lose real history just from volume.
    // `current` is passed in by the caller (already held from the same scan
    // that drove this run) to avoid an extra read.
    appendNotification(workspaceId, entry, current) {
      const notifications = [entry, ...(Array.isArray(current) ? current : [])];
      return client.send(new commands.UpdateItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET notifications = :list",
        ExpressionAttributeValues: marshall({ ":list": notifications }),
      }));
    },

    // Removes notifications older than 12 months from `sentAt`. Called once
    // per workspace per tick, alongside the other independent-of-digest
    // per-tick jobs.
    pruneOldNotifications(workspaceId, notifications) {
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
