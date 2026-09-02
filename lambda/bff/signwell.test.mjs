import assert from "node:assert/strict";
import test from "node:test";

import { createSignWellClient } from "./signwell.mjs";

test("SignWell document lookup uses the authenticated document endpoint", async () => {
  const calls = [];
  const client = createSignWellClient({
    apiKey: "test-key",
    baseUrl: "https://signwell.example.test/api/v1/",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "document/with space", status: "Completed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await client.getDocument("document/with space");

  assert.equal(result.status, "Completed");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://signwell.example.test/api/v1/documents/document%2Fwith%20space",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-Api-Key"], "test-key");
});

test("SignWell recipient updates, draft sends, and cancellation use their documented endpoints", async () => {
  const calls = [];
  const client = createSignWellClient({
    apiKey: "test-key",
    testMode: false,
    baseUrl: "https://signwell.example.test/api/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(init.method === "DELETE" ? null : JSON.stringify({ id: "doc-1" }), {
        status: init.method === "DELETE" ? 204 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.updateRecipients("doc-1", [{ id: "1", name: "New", email: "new@example.com" }]);
  await client.sendDocument("doc-1", { subject: "Please sign" });
  await client.deleteDocument("doc-1");

  assert.deepEqual(calls.map(({ url, init }) => [url, init.method]), [
    ["https://signwell.example.test/api/v1/documents/doc-1/recipients", "PATCH"],
    ["https://signwell.example.test/api/v1/documents/doc-1/send", "POST"],
    ["https://signwell.example.test/api/v1/documents/doc-1", "DELETE"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    recipients: [{ id: "1", name: "New", email: "new@example.com" }],
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), { test_mode: false, subject: "Please sign" });
});
