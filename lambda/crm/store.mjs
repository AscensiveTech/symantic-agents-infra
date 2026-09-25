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

export function linkKeyFor(provider, phoneE164) {
  return `${provider}#${phoneE164}`;
}

const TOKEN_FIELDS = [
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "refreshLockUntil",
];

export function createDynamoCrmStore(client, commands, tables, { now = Date.now } = {}) {
  const iso = () => new Date(Number(now())).toISOString();

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

    async listConnectionsByAccount(provider, accountId) {
      requireTable(connections);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: connections,
          IndexName: "accountId-index",
          KeyConditionExpression: "accountId = :accountId",
          FilterExpression: "#provider = :provider",
          ExpressionAttributeNames: { "#provider": "provider" },
          ExpressionAttributeValues: marshall({ ":accountId": String(accountId), ":provider": provider }),
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
        remove: ["refreshLockUntil", "pausedUntil", "pauseReason", "reauthReason", "disconnectedAt", "disconnectReason"],
      }).then(async (saved) => {
        // First connection: no mapping yet.
        if (!saved.mappingStatus) {
          return update(connections, { workspaceId, provider }, {
            set: { mappingStatus: saved.mapping ? "unchecked" : "unconfigured", createdAt: saved.createdAt ?? timestamp },
          });
        }
        return saved;
      });
    },

    acquireRefreshLock(workspaceId, provider, expectedVersion, untilMs) {
      return update(connections, { workspaceId, provider }, {
        set: { refreshLockUntil: untilMs },
        condition: "tokenVersion = :version AND connectionState = :connected AND " +
          "(attribute_not_exists(refreshLockUntil) OR refreshLockUntil < :now)",
        conditionValues: { ":version": expectedVersion, ":connected": "connected", ":now": Number(now()) },
        conditional: true,
      }).then(Boolean);
    },

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

    markReauthRequired(workspaceId, provider, reason) {
      return update(connections, { workspaceId, provider }, {
        set: { connectionState: "reauth_required", reauthReason: reason, updatedAt: iso() },
        remove: ["refreshLockUntil"],
        condition: "connectionState = :connected",
        conditionValues: { ":connected": "connected" },
        conditional: true,
      });
    },

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

    saveMapping(workspaceId, provider, mapping, { status, problems }) {
      return update(connections, { workspaceId, provider }, {
        set: { mapping, mappingStatus: status, mappingProblems: problems ?? [], mappingCheckedAt: iso(), updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    markMappingInvalid(workspaceId, provider, problems) {
      return update(connections, { workspaceId, provider }, {
        set: { mappingStatus: "invalid", mappingProblems: problems, mappingCheckedAt: iso(), updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

    pause(workspaceId, provider, untilMs, reason) {
      return update(connections, { workspaceId, provider }, {
        set: { pausedUntil: untilMs, pauseReason: reason, updatedAt: iso() },
        condition: "attribute_exists(workspaceId)",
        conditional: true,
      });
    },

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

    // ---- links ----
    getLink(workspaceId, linkKey) {
      return get(links, { workspaceId, linkKey });
    },

    acquireLinkLease(workspaceId, linkKey, owner, untilMs) {
      return update(links, { workspaceId, linkKey }, {
        set: { leaseOwner: owner, leaseExpiresAt: untilMs },
        condition: "attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :owner",
        conditionValues: { ":now": Number(now()), ":owner": owner },
        conditional: true,
      });
    },

    releaseLinkLease(workspaceId, linkKey, owner) {
      return update(links, { workspaceId, linkKey }, {
        remove: ["leaseOwner", "leaseExpiresAt"],
        condition: "leaseOwner = :owner",
        conditionValues: { ":owner": owner },
        conditional: true,
      });
    },

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

    updateCallSync(workspaceId, callId, fields) {
      return update(tables.calls, { workspaceId, callId }, {
        set: { ...fields, crmUpdatedAt: iso() },
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

    async listFailedCalls(workspaceId, sinceIso) {
      requireTable(tables.calls);
      const items = [];
      let startKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tables.calls,
          KeyConditionExpression: "workspaceId = :workspaceId",
          FilterExpression: "crmStatus = :failed AND analyzedAt >= :since",
          ProjectionExpression: "callId, crmStatus, crmLastErrorCode, analyzedAt",
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

    getMembership(userId) {
      return get(tables.memberships, { userId });
    },

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

function projectionOf(fields) {
  const names = Object.fromEntries(fields.map((field, i) => [`#p${i}`, field]));
  return {
    ProjectionExpression: Object.keys(names).join(", "),
    ExpressionAttributeNames: names,
  };
}

function requireTable(value) {
  if (!value) throw new Error("CRM DynamoDB table environment variable is required");
}

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

export function marshall(value) {
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
