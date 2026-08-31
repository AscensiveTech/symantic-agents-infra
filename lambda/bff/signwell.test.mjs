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
