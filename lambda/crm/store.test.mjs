import assert from "node:assert/strict";
import { test } from "node:test";

import { createDynamoCrmStore, marshall } from "./store.mjs";

class QueryCommand { constructor(input) { this.input = input; } }
class DeleteItemCommand { constructor(input) { this.input = input; } }
class UpdateItemCommand { constructor(input) { this.input = input; } }

test("Dynamo store purge deletes provider links/connection and scrubs only provider call metadata", async () => {
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command);
      if (command instanceof QueryCommand && command.input.TableName === "links") {
        return {
          Items: [
            marshall({ workspaceId: "ws-a", linkKey: "monday#+12025550198" }),
            marshall({ workspaceId: "ws-a", linkKey: "other#+12025550199" }),
          ],
        };
      }
      if (command instanceof QueryCommand && command.input.TableName === "calls") {
        return {
          Items: [
            marshall({ workspaceId: "ws-a", callId: "call-monday", crmProvider: "monday" }),
            marshall({ workspaceId: "ws-a", callId: "call-other", crmProvider: "other" }),
          ],
        };
      }
      if (command instanceof UpdateItemCommand) return {};
      if (command instanceof DeleteItemCommand) return {};
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
  const store = createDynamoCrmStore(client, {
    QueryCommand,
    DeleteItemCommand,
    UpdateItemCommand,
  }, {
    connections: "connections",
    links: "links",
    calls: "calls",
  });

  const result = await store.purgeProviderData("ws-a", "monday");

  assert.deepEqual(result, { removedLinks: 1, scrubbedCalls: 1 });
  const deletes = sent.filter((command) => command instanceof DeleteItemCommand);
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].input.TableName, "links");
  assert.deepEqual(deletes[0].input.Key, marshall({ workspaceId: "ws-a", linkKey: "monday#+12025550198" }));
  assert.equal(deletes[1].input.TableName, "connections", "connection is deleted after related data");
  const updates = sent.filter((command) => command instanceof UpdateItemCommand);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.TableName, "calls");
  assert.deepEqual(updates[0].input.Key, marshall({ workspaceId: "ws-a", callId: "call-monday" }));
  assert.match(updates[0].input.UpdateExpression, /REMOVE/);
});
