export function createDynamoToolsStore(client, commands, tableNames) {
  return {
    async getCalendarConnection(workspaceId) {
      return getItem(
        client,
        commands,
        tableNames.calendarConnections,
        { workspaceId },
      );
    },

    async markCalendarReauthRequired(workspaceId, reason) {
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.calendarConnections,
        Key: marshall({ workspaceId }),
        UpdateExpression:
          "SET connectionState = :state, bookingToolsEnabled = :disabled, " +
          "reauthReason = :reason, updatedAt = :updatedAt",
        ExpressionAttributeValues: marshall({
          ":state": "reauth_required",
          ":disabled": false,
          ":reason": reason,
          ":updatedAt": new Date().toISOString(),
        }),
        ReturnValues: "ALL_NEW",
      }));
      return unmarshall(result.Attributes);
    },

    async rotateCalendarToken({
      workspaceId,
      provider,
      expectedVersion,
      encryptedRefreshToken,
    }) {
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.calendarConnections,
        Key: marshall({ workspaceId }),
        UpdateExpression:
          "SET encryptedRefreshToken = :token, tokenVersion = :nextVersion",
        ConditionExpression:
          "provider = :provider AND tokenVersion = :expectedVersion",
        ExpressionAttributeValues: marshall({
          ":token": encryptedRefreshToken,
          ":nextVersion": expectedVersion + 1,
          ":provider": provider,
          ":expectedVersion": expectedVersion,
        }),
        ReturnValues: "ALL_NEW",
      }));
      return unmarshall(result.Attributes);
    },

    async getAppointment(workspaceId, appointmentId) {
      return getItem(client, commands, tableNames.appointments, {
        workspaceId,
        appointmentId,
      });
    },

    async listAppointments(workspaceId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.appointments,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({
          ":workspaceId": workspaceId,
        }),
        ConsistentRead: true,
      }));
      return (result.Items ?? []).map(unmarshall);
    },

    async putAppointment(record) {
      await putOnce(
        client,
        commands,
        tableNames.appointments,
        record,
        "appointmentId",
      );
      return record;
    },

    async updateAppointment(workspaceId, appointmentId, updates) {
      return updateItem(
        client,
        commands,
        tableNames.appointments,
        { workspaceId, appointmentId },
        updates,
      );
    },

    async getLead(workspaceId, leadId) {
      return getItem(client, commands, tableNames.leads, {
        workspaceId,
        leadId,
      });
    },

    async putLead(record) {
      await putOnce(client, commands, tableNames.leads, record, "leadId");
      return record;
    },

    async getMessage(workspaceId, messageId) {
      return getItem(client, commands, tableNames.messages, {
        workspaceId,
        messageId,
      });
    },

    async putMessage(record) {
      await putOnce(
        client,
        commands,
        tableNames.messages,
        record,
        "messageId",
      );
      return record;
    },

    async getBusinessProfile(workspaceId) {
      return getItem(
        client,
        commands,
        tableNames.businessProfiles,
        { workspaceId },
      );
    },

    async getAgent(workspaceId, agentId) {
      if (agentId) {
        return getItem(client, commands, tableNames.agents, {
          workspaceId,
          agentId,
        });
      }
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.agents,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({
          ":workspaceId": workspaceId,
        }),
        ConsistentRead: true,
      }));
      const agents = (result.Items ?? []).map(unmarshall);
      return agents.find(({ status }) => status === "active") ?? agents[0] ?? null;
    },
  };
}

async function getItem(client, commands, tableName, key) {
  requireTableName(tableName);
  const result = await client.send(new commands.GetItemCommand({
    TableName: tableName,
    Key: marshall(key),
    ConsistentRead: true,
  }));
  return result.Item ? unmarshall(result.Item) : null;
}

async function putOnce(client, commands, tableName, record, idField) {
  requireTableName(tableName);
  await client.send(new commands.PutItemCommand({
    TableName: tableName,
    Item: marshall(record),
    ConditionExpression: `attribute_not_exists(#id)`,
    ExpressionAttributeNames: { "#id": idField },
  }));
}

async function updateItem(client, commands, tableName, key, updates) {
  requireTableName(tableName);
  const entries = Object.entries(updates)
    .filter(([, value]) => value !== undefined);
  if (entries.length === 0) return getItem(client, commands, tableName, key);
  const names = Object.fromEntries(
    entries.map(([field], index) => [`#field${index}`, field]),
  );
  const values = Object.fromEntries(
    entries.map(([, value], index) => [`:value${index}`, value]),
  );
  const result = await client.send(new commands.UpdateItemCommand({
    TableName: tableName,
    Key: marshall(key),
    UpdateExpression: `SET ${entries.map(
      (_entry, index) => `#field${index} = :value${index}`,
    ).join(", ")}`,
    ConditionExpression: "attribute_exists(workspaceId)",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
    ReturnValues: "ALL_NEW",
  }));
  return unmarshall(result.Attributes);
}

function requireTableName(value) {
  if (!value) throw new Error("Tools DynamoDB table environment variable is required");
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
      Object.entries(value.M)
        .map(([key, item]) => [key, fromAttributeValue(item)]),
    );
  }
  return undefined;
}

function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item)
      .map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}
