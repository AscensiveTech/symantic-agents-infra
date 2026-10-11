import assert from "node:assert/strict";
import test from "node:test";

import { awsRequest } from "./aws-request.mjs";

// AWS Signature Version 4 test suite, "get-vanilla".
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const NOW = new Date("2015-08-30T12:36:00Z");

function capture(response = { status: 200, body: "{}" }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(response.body, { status: response.status, headers: response.headers ?? {} });
  };
  return { calls, fetchImpl };
}

test("signs exactly like the AWS SigV4 test suite (get-vanilla)", async () => {
  const { calls, fetchImpl } = capture();
  await awsRequest({ service: "service", host: "example.amazonaws.com", method: "GET", path: "/", region: "us-east-1", credentials: CREDENTIALS, now: NOW, fetchImpl });
  assert.equal(calls[0].url, "https://example.amazonaws.com/");
  assert.equal(
    calls[0].init.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("JSON bodies, sorted query strings and session tokens are signed and sent", async () => {
  const { calls, fetchImpl } = capture({ status: 200, body: "{\"ResultItems\":[]}" });
  const result = await awsRequest({
    service: "geo-places",
    host: "places.geo.us-east-1.amazonaws.com",
    method: "GET",
    path: "/v2/place/AQAB-c_d",
    query: { language: "en", "intended-use": "Storage", empty: "" },
    region: "us-east-1",
    credentials: { ...CREDENTIALS, sessionToken: "token" },
    now: NOW,
    fetchImpl,
  });
  assert.deepEqual(result, { ResultItems: [] });
  assert.equal(calls[0].url, "https://places.geo.us-east-1.amazonaws.com/v2/place/AQAB-c_d?intended-use=Storage&language=en");
  assert.equal(calls[0].init.headers["x-amz-security-token"], "token");
  assert.match(calls[0].init.headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);

  const post = capture();
  await awsRequest({ service: "geo-places", host: "h", path: "/v2/geocode", body: { QueryText: "x" }, region: "us-east-1", credentials: CREDENTIALS, now: NOW, fetchImpl: post.fetchImpl });
  assert.equal(post.calls[0].init.body, "{\"QueryText\":\"x\"}");
  assert.equal(post.calls[0].init.headers["content-type"], "application/json");
  assert.match(post.calls[0].init.headers.authorization, /SignedHeaders=content-type;host;x-amz-date,/);
});

test("AWS errors keep their type, so callers can tell throttling from bad input", async () => {
  const throttled = capture({ status: 429, body: "{\"message\":\"Rate exceeded\"}", headers: { "x-amzn-errortype": "ThrottlingException:http://internal" } });
  await assert.rejects(
    () => awsRequest({ service: "geo-places", host: "h", path: "/v2/geocode", body: {}, region: "us-east-1", credentials: CREDENTIALS, fetchImpl: throttled.fetchImpl }),
    (error) => error.name === "ThrottlingException" && error.status === 429 && error.message === "Rate exceeded",
  );
  const missing = capture({ status: 404, body: "{\"__type\":\"com.amazon#ResourceNotFoundException\",\"Message\":\"not found\"}" });
  await assert.rejects(
    () => awsRequest({ service: "geo", host: "h", method: "GET", path: "/x", region: "us-east-1", credentials: CREDENTIALS, fetchImpl: missing.fetchImpl }),
    (error) => error.name === "ResourceNotFoundException",
  );
});

test("a slow service times out instead of hanging the call", async () => {
  // A real request keeps the event loop alive while it waits; so does this.
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    const pending = setTimeout(() => {}, 5000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(pending);
      reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    });
  });
  await assert.rejects(
    () => awsRequest({ service: "geo-places", host: "h", path: "/v2/geocode", body: {}, region: "us-east-1", credentials: CREDENTIALS, timeoutMs: 20, fetchImpl }),
    (error) => error.name === "TimeoutError",
  );
});

test("no credentials is a clear error, not a malformed request", async () => {
  await assert.rejects(
    () => awsRequest({ service: "geo-places", host: "h", path: "/", region: "us-east-1", credentials: {}, fetchImpl: async () => { throw new Error("not called"); } }),
    (error) => error.name === "CredentialsError",
  );
});
