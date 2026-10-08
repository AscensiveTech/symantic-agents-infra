// Persistence for the CRM integration. Three tables of our own plus narrow
// access to existing ones:
//
//   crm-connections  (workspaceId, provider)  tokens (KMS ciphertext), mapping,
//                                              health; GSI accountId-index for
//                                              the uninstall webhook
//   crm-links        (workspaceId, linkKey)    phone -> CRM record id, per-phone
//                                              lease, last-applied watermark
//   calls            (workspaceId, callId)     crm* sync-state attributes
//   business-profiles, oauth-states, workspace-memberships: read/consume only
//
// Every read and write is keyed by workspaceId, which always comes from the
// caller's verified identity or from a row we wrote - never from a CRM.

// Key for the caller-to-CRM-row link: per connection (so per agent) and per
// phone number, so each agent's board keeps its own match for a caller.
export function linkKeyFor(provider, phoneE164) {
  return `${provider}#${phoneE164}`;
}

// Key for the caller link on one Monday board, shared by every agent that
// syncs to that board (e.g. an English and a Spanish agent on one account).
// Its lease makes two agents take turns on the same caller, so they can't
// both create a row for them; different callers never wait on each other.
// `provider` may be a connection key ("monday#agent-1") or "monday".
export function boardLinkKeyFor(provider, boardId, phoneE164) {
  return `${boardLinkPrefix(provider, boardId)}${phoneE164}`;
}

// Prefix of every caller link on one board, used to purge them on uninstall.
export function boardLinkPrefix(provider, boardId) {
  return `${String(provider).split("#")[0]}#board#${boardId}#`;
}

const TOKEN_FIELDS = [
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "refreshLockUntil",
];

// DynamoDB persistence for the CRM integration: connections (one per agent),
// caller links, per-call sync fields, OAuth states and the lookups the
// reminders need. Conditional writes keep concurrent workers from overwriting
// each other.
export function createDynamoCrmStore(client, commands, tables, { now = Date.now } = {}) {
  // Current time as ISO text, from the injectable clock.
  const iso = () => new Date(Number(now())).toISOString();

  // Strongly consistent single-item read (optionally only some fields); null
  // when missing.
  async function get(table, key, projection) {
    requireTable(table);
    const result = await client.send(new commands.GetItemCommand({
      TableName: table,
      Key: marshall(key),
      ConsistentRead: true,
      ...(projection ? projectionOf(projection) : {}),
    }));
    return result.Item ? unmarshall(result.Item) : null;
  }

  // Builds and sends one UpdateItem. Returns the new item, or null when the
  // condition failed and `conditional` is true.
  async function update(table, key, {
    set = {},
    remove = [],
    condition,
    conditionValues = {},
    conditionNames = {},
    conditional = false,
  }) {
    requireTable(table);
    const names = { ...conditionNames };
    const values = { ...conditionValues };
    const setParts = [];
    let index = 0;
    // null means "remove this attribute" - DynamoDB rejects an update that
    // both sets and removes the same path.
    const removals = [...new Set([
      ...remove,
      ...Object.entries(set).filter(([, value]) => value === null).map(([field]) => field),
    ])];
    for (const [field, value] of Object.entries(set)) {
      if (value === undefined || value === null) continue;
      const name = `#s${index}`;
      const placeholder = `:s${index}`;
      names[name] = field;
      if (value && typeof value === "object" && value.$increment !== undefined) {
        values[placeholder] = value.$increment;
        values[":zero"] = 0;
        setParts.push(`${name} = if_not_exists(${name}, :zero) + ${placeholder}`);
      } else {
        values[placeholder] = value;
        setParts.push(`${name} = ${placeholder}`);
      }
      index += 1;
    }
    const removeParts = removals.map((field, i) => {
      names[`#r${i}`] = field;
      return `#r${i}`;
    });
    const expression = [
      setParts.length ? `SET ${setParts.join(", ")}` : "",
      removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "",
    ].filter(Boolean).join(" ");
    try {
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: table,
        Key: marshall(key),
        UpdateExpression: expression,
        ...(condition ? { ConditionExpression: condition } : {}),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: marshall(values) } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return result.Attributes ? unmarshall(result.Attributes) : null;
    } catch (error) {
      if (conditional && error?.name === "ConditionalCheckFailedException") return null;
      throw error;
    }
  }

  const connections = tables.connections;
  const links = tables.links;

  return {
    // ---- connections ----
    getConnection(workspaceId, provider) {
      return get(connections, { workspaceId, provider });
    },

    // Every connection for one Monday account, via the account index. The
    // uninstall webhook uses it to disconnect them all.
    // Name sync: the webhooks registered on the mapped board (null removes).
    saveNameWebhooks(workspaceId, provider, record) {
      return update(connections, { workspaceId, provider }, {
        set: { nameWebhooks: record, updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Every keeper pass stamps this, so a long gap (we were offline and may
    // have missed webhook deliveries) can be noticed.
    markNameKeeperSeen(workspaceId, provider) {
      return update(connections, { workspaceId, provider }, {
        set: { nameKeeperSeenAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // When the daily name-sync webhook check last ran for this connection.
    markNameChecked(workspaceId, provider) {
      return update(connections, { workspaceId, provider }, {
        set: { nameCheckedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // A workspace contact (name, company, nameUpdatedAt...), or null.
    async getContactRecord(workspaceId, phoneNumber) {
      if (!tables.contacts || !phoneNumber) return null;
      return get(tables.contacts, { workspaceId, phoneNumber });
    },

    // Renames a contact from the CRM, only if this change is newer than the
    // last rename (from anywhere). Other contact fields are kept. Returns the
    // contact, or null when a newer name is already there.
    renameContactFromCrm(workspaceId, phoneNumber, name, { at, source }) {
      requireTable(tables.contacts);
      return update(tables.contacts, { workspaceId, phoneNumber }, {
        set: { name, nameUpdatedAt: at, nameSource: source, updatedByName: "Monday.com", updatedAt: iso() },
        condition: "attribute_not_exists(nameUpdatedAt) OR nameUpdatedAt < :at",
        conditionValues: { ":at": at },
        conditional: true,
      });
    },

    // Every call from a number, as {callId}.
    async listCallsForPhone(workspaceId, phoneNumber) {
      requireTable(tables.calls);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.calls,
          KeyConditionExpression: "workspaceId = :w",
          FilterExpression: "callerNumber = :p",
          ProjectionExpression: "callId",
          ExpressionAttributeValues: marshall({ ":w": workspaceId, ":p": phoneNumber }),
          ExclusiveStartKey: startKey,
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    async countCallsForPhone(workspaceId, phoneNumber) {
      return (await this.listCallsForPhone(workspaceId, phoneNumber)).length;
    },

    // Sets the caller name on every call from a number, as a manual name
    // (so automatic naming on a later call never overwrites it).
    async renameCallsForPhone(workspaceId, phoneNumber, name) {
      const calls = await this.listCallsForPhone(workspaceId, phoneNumber);
      for (const call of calls) {
        await update(tables.calls, { workspaceId, callId: call.callId }, {
          set: { callerName: name, callerNameSource: "manual" },
          condition: "attribute_exists(workspaceId)",
          conditional: true,
        });
      }
      return calls.length;
    },

    // Every connection (one per agent) in a workspace, used to find all of its
    // calls boards so none is ever offered for mapping.
    async listWorkspaceConnections(workspaceId) {
      requireTable(connections);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: connections,
          KeyConditionExpression: "workspaceId = :w",
          ExpressionAttributeValues: marshall({ ":w": workspaceId }),
          ExclusiveStartKey: startKey,
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    async listConnectionsByAccount(provider, accountId) {
      requireTable(connections);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: connections,
          IndexName: "accountId-index",
          KeyConditionExpression: "accountId = :accountId",
          // Rows are keyed "<provider>#<agentId>": every agent on the account.
          FilterExpression: "begins_with(#provider, :provider)",
          ExpressionAttributeNames: { "#provider": "provider" },
          ExpressionAttributeValues: marshall({ ":accountId": String(accountId), ":provider": `${provider}#` }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    // For the token keeper: every connected connection (a small table - one
    // row per workspace and provider).
    async listConnected() {
      requireTable(connections);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.ScanCommand({
          TableName: connections,
          FilterExpression: "connectionState IN (:connected, :reauth)",
          ProjectionExpression: "workspaceId, #provider, connectionState",
          ExpressionAttributeNames: { "#provider": "provider" },
          ExpressionAttributeValues: marshall({ ":connected": "connected", ":reauth": "reauth_required" }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    // A fresh (re)authorization. Keeps the saved mapping so reconnecting
    // doesn't make the admin configure fields again.
    saveAuthorization(workspaceId, provider, record) {
      const timestamp = iso();
      return update(connections, { workspaceId, provider }, {
        set: {
          ...record,
          connectionState: "connected",
          tokenVersion: { $increment: 1 },
          mappingStatus: undefined,
          createdAt: undefined,
          updatedAt: timestamp,
        },
        remove: ["refreshLockUntil", "pausedUntil", "pauseReason", "reauthReason", "disconnectedAt", "disconnectReason", "reauthReminderStage", "disconnectNoticeAt"],
      }).then(async (saved) => {
        // First connection: no mapping yet.
        if (!saved.mappingStatus) {
          return update(connections, { workspaceId, provider }, {
            // A brand-new connection logs to its calls board only; syncing
            // to one of the customer's own boards is opt-in.
            set: {
              mappingStatus: saved.mapping ? "unchecked" : "unconfigured",
              boardSyncEnabled: Boolean(saved.mapping),
              createdAt: saved.createdAt ?? timestamp,
            },
          });
        }
        return saved;
      });
    },

    // Claims the right to refresh this connection's tokens. Only succeeds on
    // the expected token version with no live lock, so two workers never
    // refresh (and burn) the same rotating refresh token.
    acquireRefreshLock(workspaceId, provider, expectedVersion, untilMs) {
      return update(connections, { workspaceId, provider }, {
        set: { refreshLockUntil: untilMs },
        condition: "tokenVersion = :version AND connectionState = :connected AND " +
          "(attribute_not_exists(refreshLockUntil) OR refreshLockUntil < :now)",
        conditionValues: { ":version": expectedVersion, ":connected": "connected", ":now": Number(now()) },
        conditional: true,
      }).then(Boolean);
    },

    // Drops the refresh lock after a refresh attempt, whatever the outcome.
    releaseRefreshLock(workspaceId, provider) {
      return update(connections, { workspaceId, provider }, {
        remove: ["refreshLockUntil"],
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    saveRefreshedTokens({
      workspaceId,
      provider,
      expectedVersion,
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    }) {
      return update(connections, { workspaceId, provider }, {
        set: {
          encryptedAccessToken,
          encryptedRefreshToken,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          tokenVersion: { $increment: 1 },
          updatedAt: iso(),
        },
        remove: ["refreshLockUntil"],
        condition: "tokenVersion = :version AND connectionState = :connected",
        conditionValues: { ":version": expectedVersion, ":connected": "connected" },
        conditional: true,
      });
    },

    // The grant stopped working (expired or revoked): the card asks the admin
    // to reconnect. Only moves a connected record.
    markReauthRequired(workspaceId, provider, reason) {
      return update(connections, { workspaceId, provider }, {
        set: { connectionState: "reauth_required", reauthReason: reason, updatedAt: iso() },
        remove: ["refreshLockUntil"],
        condition: "connectionState = :connected",
        conditionValues: { ":connected": "connected" },
        conditional: true,
      });
    },

    // Marks the connection disconnected and clears its tokens. The mapping
    // and calls board record are kept for a later reconnect.
    disconnect(workspaceId, provider, reason) {
      const timestamp = iso();
      return update(connections, { workspaceId, provider }, {
        set: {
          connectionState: "disconnected",
          disconnectedAt: timestamp,
          disconnectReason: reason,
          updatedAt: timestamp,
        },
        remove: [...TOKEN_FIELDS, "pausedUntil", "pauseReason"],
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // An app uninstall is different from a user choosing Disconnect. Monday's
    // lifecycle policy requires app-derived data to be removed, so purge the
    // connection, phone-to-item links and CRM-only fields on retained calls.
    // The connection row is deleted last: a retried webhook can finish a
    // partial purge, while a completed duplicate delivery is harmless.
    // `boardIds`: the boards this connection mapped, whose shared caller links
    // go too (they came from the same Monday account).
    async purgeProviderData(workspaceId, provider, { boardIds = [] } = {}) {
      requireTable(links);
      const prefixes = [`${provider}#`, ...boardIds.map((boardId) => boardLinkPrefix(provider, boardId))];
      requireTable(tables.calls);
      let removedLinks = 0;
      let scrubbedCalls = 0;

      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: links,
          KeyConditionExpression: "workspaceId = :workspaceId",
          ProjectionExpression: "workspaceId, linkKey",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        const rows = (result.Items ?? []).map(unmarshall)
          .filter((row) => prefixes.some((prefix) => String(row.linkKey ?? "").startsWith(prefix)));
        await Promise.all(rows.map((row) => client.send(new commands.DeleteItemCommand({
          TableName: links,
          Key: marshall({ workspaceId, linkKey: row.linkKey }),
        }))));
        removedLinks += rows.length;
        startKey = result.LastEvaluatedKey;
      } while (startKey);

      startKey = undefined;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.calls,
          KeyConditionExpression: "workspaceId = :workspaceId",
          ProjectionExpression: "workspaceId, callId, crmProvider",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        const rows = (result.Items ?? []).map(unmarshall)
          .filter((row) => row.crmProvider === provider);
        await Promise.all(rows.map((row) => update(tables.calls, { workspaceId, callId: row.callId }, {
          remove: [
            "crmProvider", "crmStatus", "crmItemId", "crmItemUrl", "crmActivityId", "crmCallsItemId",
            "crmCreated", "crmQueuedAt", "crmUpdatedAt", "crmLastErrorCode", "crmLastErrorAt",
          ],
          condition: "attribute_exists(workspaceId)",
          conditional: true,
        })));
        scrubbedCalls += rows.length;
        startKey = result.LastEvaluatedKey;
      } while (startKey);

      await client.send(new commands.DeleteItemCommand({
        TableName: connections,
        Key: marshall({ workspaceId, provider }),
      }));
      return { removedLinks, scrubbedCalls };
    },

    // Saves the board mapping with its validation result and any per-field
    // problems.
    saveMapping(workspaceId, provider, mapping, { status, problems }) {
      return update(connections, { workspaceId, provider }, {
        // A valid mapping re-arms the "board sync needs attention" email.
        set: {
          mapping, mappingStatus: status, mappingProblems: problems ?? [], mappingCheckedAt: iso(), updatedAt: iso(),
          ...(status === "valid" ? { mappingInvalidNoticeAt: null } : {}),
        },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Flags the mapping invalid (e.g. a mapped column was deleted in Monday)
    // so syncing to that board stops until it's fixed.
    markMappingInvalid(workspaceId, provider, problems) {
      return update(connections, { workspaceId, provider }, {
        set: { mappingStatus: "invalid", mappingProblems: problems, mappingCheckedAt: iso(), updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Stops syncing until a time (rate limit, daily limit, inactive account).
    // Calls are retried afterwards.
    pause(workspaceId, provider, untilMs, reason) {
      return update(connections, { workspaceId, provider }, {
        set: { pausedUntil: untilMs, pauseReason: reason, updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Last sync outcome shown on the card: time of the last success, or the
    // last error code.
    recordSyncResult(workspaceId, provider, { status, errorCode }) {
      const timestamp = iso();
      return update(connections, { workspaceId, provider }, {
        set: status === "synced"
          ? { lastSyncAt: timestamp, lastSyncStatus: status }
          : { lastErrorAt: timestamp, lastErrorCode: errorCode, lastSyncStatus: status },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Compare-and-set so two keeper runs never send the same reminder twice.
    async markReauthReminder(workspaceId, provider, stage, previousStage) {
      const saved = await update(connections, { workspaceId, provider }, {
        set: { reauthReminderStage: stage },
        condition: previousStage
          ? "reauthReminderStage = :previous"
          : "attribute_exists(workspaceId) AND attribute_not_exists(reauthReminderStage)",
        conditionValues: previousStage ? { ":previous": previousStage } : {},
        conditional: true,
      });
      return Boolean(saved);
    },

    // Also clears the "board deleted" email flags: a new or restored board
    // starts a fresh notice cycle.
    saveCallsBoard(workspaceId, provider, callsBoard) {
      return update(connections, { workspaceId, provider }, {
        set: { callsBoard },
        remove: ["callsBoardClaimAt", ...(callsBoard?.status === "deleted" ? [] : ["callsBoardDeletedNoticeAt", "callsBoardDeletedReminderAt"])],
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Only one worker/request may create an agent's calls board at a time.
    // A claim older than staleMs (a crashed attempt) can be taken over.
    async claimCallsBoard(workspaceId, provider, staleMs) {
      const nowMs = Number(now());
      const saved = await update(connections, { workspaceId, provider }, {
        set: { callsBoardClaimAt: nowMs },
        condition: "attribute_exists(workspaceId) AND (attribute_not_exists(callsBoardClaimAt) OR callsBoardClaimAt < :stale)",
        conditionValues: { ":stale": nowMs - staleMs },
        conditional: true,
      });
      return Boolean(saved);
    },

    // Stop Logging / Turn Back On for the auto-created calls board.
    setCallsBoardEnabled(workspaceId, provider, enabled) {
      return update(connections, { workspaceId, provider }, {
        set: { callsBoardEnabled: Boolean(enabled), updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Once-only flags for the "calls board deleted" email and its reminder.
    async markCallsBoardNotice(workspaceId, provider, field) {
      const saved = await update(connections, { workspaceId, provider }, {
        set: { [field]: iso() },
        condition: `attribute_exists(workspaceId) AND attribute_not_exists(${field})`,
        conditional: true,
      });
      return Boolean(saved);
    },

    // The "Also sync calls to one of my boards" switch.
    setBoardSyncEnabled(workspaceId, provider, enabled) {
      return update(connections, { workspaceId, provider }, {
        set: { boardSyncEnabled: Boolean(enabled), updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Ends a pause early (e.g. the account is active again) and resets the
    // inactive notice so a future outage emails again.
    clearPause(workspaceId, provider) {
      return update(connections, { workspaceId, provider }, {
        remove: ["pausedUntil", "pauseReason", "accountInactiveNotifiedAt"],
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Once per inactive spell (cleared with the pause).
    async markAccountInactiveNotified(workspaceId, provider) {
      const saved = await update(connections, { workspaceId, provider }, {
        set: { accountInactiveNotifiedAt: iso() },
        condition: "attribute_exists(workspaceId) AND attribute_not_exists(accountInactiveNotifiedAt)",
        conditional: true,
      });
      return Boolean(saved);
    },

    // Remembers when the keeper last replayed failed calls, so replays are
    // spaced out.
    markAutoRequeued(workspaceId, provider) {
      return update(connections, { workspaceId, provider }, {
        set: { autoRequeuedAt: Number(now()) },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // ---- links ----
    getLink(workspaceId, linkKey) {
      return get(links, { workspaceId, linkKey });
    },

    // Short lease on one caller's link so two calls from the same number
    // don't both create a new lead at once.
    acquireLinkLease(workspaceId, linkKey, owner, untilMs) {
      return update(links, { workspaceId, linkKey }, {
        set: { leaseOwner: owner, leaseExpiresAt: untilMs },
        condition: "attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :owner",
        conditionValues: { ":now": Number(now()), ":owner": owner },
        conditional: true,
      });
    },

    // Releases the caller lease, only if we still hold it.
    releaseLinkLease(workspaceId, linkKey, owner) {
      return update(links, { workspaceId, linkKey }, {
        remove: ["leaseOwner", "leaseExpiresAt"],
        condition: "leaseOwner = :owner",
        conditionValues: { ":owner": owner },
        conditional: true,
      });
    },

    // Saves which CRM row a caller maps to, plus the newest call applied to
    // it.
    saveLink(workspaceId, linkKey, fields) {
      return update(links, { workspaceId, linkKey }, {
        set: { ...fields, updatedAt: iso() },
      });
    },

    // Monotonic: an older call (a retry, or a delayed message) can never
    // overwrite the fields a newer call already wrote.
    advanceWatermark(workspaceId, linkKey, endedAt, extra = {}) {
      return update(links, { workspaceId, linkKey }, {
        set: { lastAppliedEndedAt: endedAt, ...extra, updatedAt: iso() },
        condition: "attribute_not_exists(lastAppliedEndedAt) OR lastAppliedEndedAt < :endedAt",
        conditionValues: { ":endedAt": endedAt },
        conditional: true,
      });
    },

    // ---- calls ----
    getCall(workspaceId, callId) {
      return get(tables.calls, { workspaceId, callId });
    },

    // Writes sync fields (status, item ids, errors) onto the call row.
    updateCallSync(workspaceId, callId, fields) {
      return update(tables.calls, { workspaceId, callId }, {
        set: { ...fields, crmUpdatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // A Follow-Up cell edited on the generated Monday calls board. The
    // caller first compares timestamps and cell text, so this narrow write
    // does not echo a Symantic-originated edit back into Symantic.
    updateCallFollowUpFromCrm(workspaceId, callId, followUp) {
      return update(tables.calls, { workspaceId, callId }, {
        set: { followUp },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    // Re-arm a call for sync unless it already synced. Returns false when it
    // had (so the caller doesn't enqueue it).
    async markCallQueued(workspaceId, callId, provider) {
      const saved = await update(tables.calls, { workspaceId, callId }, {
        set: { crmStatus: "pending", crmProvider: provider, crmQueuedAt: iso(), crmUpdatedAt: iso() },
        condition: "attribute_exists(workspaceId) AND (attribute_not_exists(crmStatus) OR crmStatus <> :synced)",
        conditionValues: { ":synced": "synced" },
        conditional: true,
      });
      return Boolean(saved);
    },

    // One agent's calls (optionally analyzed since a time), with just the
    // fields the calls-board rebuild and reconnect catch-up need.
    async listAgentCalls(workspaceId, agentId, { since } = {}) {
      requireTable(tables.calls);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.calls,
          KeyConditionExpression: "workspaceId = :workspaceId",
          FilterExpression: since ? "agentId = :agentId AND analyzedAt >= :since" : "agentId = :agentId",
          ProjectionExpression: "callId, agentId, callerNumber, outcome, demoSeed, analyzedAt, crmStatus, crmCallsItemId, crmCallsBoardId",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId, ":agentId": agentId, ...(since ? { ":since": since } : {}) }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    // This workspace's failed syncs since a time, for the keeper's outage
    // replay.
    async listFailedCalls(workspaceId, sinceIso) {
      requireTable(tables.calls);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.calls,
          KeyConditionExpression: "workspaceId = :workspaceId",
          FilterExpression: "crmStatus = :failed AND analyzedAt >= :since",
          ProjectionExpression: "callId, agentId, crmProvider, crmStatus, crmLastErrorCode, analyzedAt",
          ExpressionAttributeValues: marshall({
            ":workspaceId": workspaceId,
            ":failed": "failed",
            ":since": sinceIso,
          }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items;
    },

    // ---- read-only neighbours ----
    async getProfileTimezone(workspaceId) {
      const profile = await get(tables.businessProfiles, { workspaceId }, ["timezone"]);
      return typeof profile?.timezone === "string" ? profile.timezone : null;
    },

    // The workspace's "Monday Reconnect Reminders" alert setting.
    async getCrmReminderSettings(workspaceId) {
      if (!tables.workspaces) return null;
      const workspace = await get(tables.workspaces, { workspaceId }, ["crmReminderAlert"]);
      return workspace?.crmReminderAlert ?? null;
    },

    // Company saved for this number on the Contacts page, used for the
    // Company column.
    async getContactCompany(workspaceId, phoneNumber) {
      if (!tables.contacts || !phoneNumber) return null;
      const contact = await get(tables.contacts, { workspaceId, phoneNumber }, ["companyName"]);
      return typeof contact?.companyName === "string" && contact.companyName.trim() ? contact.companyName.trim() : null;
    },

    // Active company admins, the fallback reminder recipients when the
    // connecting admin has left.
    async listWorkspaceAdmins(workspaceId) {
      requireTable(tables.memberships);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.memberships,
          IndexName: "workspaceId-index",
          KeyConditionExpression: "workspaceId = :workspaceId",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }));
        items.push(...(result.Items ?? []).map(unmarshall));
        startKey = result.LastEvaluatedKey;
      } while (startKey);
      return items
        .filter((member) => member.status === "active" && (member.role === "company-admin" || (member.roles ?? []).includes?.("company-admin")))
        .map((member) => ({ userId: member.userId, email: member.email ?? null, name: member.name ?? null }));
    },

    // The agent a CRM connection belongs to; used to check an agentId from a
    // request is really in the caller's workspace.
    getAgent(workspaceId, agentId) {
      return get(tables.agents, { workspaceId, agentId }, ["agentId", "workspaceId", "name", "status"]);
    },

    // A user's workspace membership (workspace, role, status, email).
    getMembership(userId) {
      return get(tables.memberships, { userId });
    },

    // Saves a one-time OAuth state for the Monday consent round trip; never
    // overwrites an existing one.
    async putOAuthState(record) {
      requireTable(tables.oauthStates);
      await client.send(new commands.PutItemCommand({
        TableName: tables.oauthStates,
        Item: marshall(record),
        ConditionExpression: "attribute_not_exists(#state)",
        ExpressionAttributeNames: { "#state": "state" },
      }));
      return record;
    },

    // Reads and deletes the OAuth state in one step, so a callback URL can
    // only be used once.
    async consumeOAuthState(state) {
      requireTable(tables.oauthStates);
      const result = await client.send(new commands.DeleteItemCommand({
        TableName: tables.oauthStates,
        Key: marshall({ state }),
        ReturnValues: "ALL_OLD",
      }));
      return result.Attributes ? unmarshall(result.Attributes) : null;
    },
  };
}

// ProjectionExpression with #names, so reserved words like "state" are safe
// to read.
function projectionOf(fields) {
  const names = Object.fromEntries(fields.map((field, i) => [`#p${i}`, field]));
  return {
    ProjectionExpression: Object.keys(names).join(", "),
    ExpressionAttributeNames: names,
  };
}

// Fails loudly when a table env var is missing, instead of a confusing SDK
// error.
function requireTable(value) {
  if (!value) throw new Error("CRM DynamoDB table environment variable is required");
}

// Plain JS value to DynamoDB's typed form (small local marshaller, so the SDK
// util isn't bundled).
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

// A plain object as a DynamoDB item; undefined fields are left out.
export function marshall(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toAttributeValue(item)]),
  );
}

// DynamoDB's typed form back to a plain JS value.
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

// A DynamoDB item as a plain object.
function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}
