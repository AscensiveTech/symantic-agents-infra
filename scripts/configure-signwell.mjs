#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const apiKey = process.env.SIGNWELL_API_KEY?.trim();
if (!apiKey) {
  console.error("Set SIGNWELL_API_KEY in your shell before running this command.");
  process.exit(1);
}

const profile = process.env.AWS_PROFILE || "ascensiveAdmin";
const region = process.env.AWS_REGION || "us-east-1";
const secretId = process.env.SIGNWELL_SECRET_ID || "symantic/dev/signwell";
const testMode = process.env.SIGNWELL_TEST_MODE !== "false";
const apiRoot = "https://www.signwell.com/api/v1";

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${name} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function callbackUrl() {
  if (process.env.SIGNWELL_WEBHOOK_URL?.trim()) {
    return process.env.SIGNWELL_WEBHOOK_URL.trim();
  }
  const apiUrl = command("terraform", ["output", "-raw", "bff_api_url"]);
  return `${apiUrl.replace(/\/+$/, "")}/webhooks/signwell`;
}

async function signWellRequest(path, init = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    throw new Error(
      typeof body?.message === "string"
        ? body.message
        : `SignWell returned ${response.status}`,
    );
  }
  return body;
}

function webhookList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.hooks)) return body.hooks;
  return [];
}

async function main() {
  const callback = callbackUrl();
  const existing = webhookList(await signWellRequest("/hooks"))
    .find((hook) => hook?.callback_url === callback);
  const webhook = existing ?? await signWellRequest("/hooks", {
    method: "POST",
    body: JSON.stringify({ callback_url: callback }),
  });
  const webhookId = webhook?.id;
  if (typeof webhookId !== "string" || !webhookId) {
    throw new Error("SignWell did not return a webhook ID.");
  }

  const cliInput = JSON.stringify({
    SecretId: secretId,
    SecretString: JSON.stringify({ apiKey, webhookId, testMode }),
  });
  command("aws", [
    "secretsmanager",
    "put-secret-value",
    "--profile",
    profile,
    "--region",
    region,
    "--cli-input-json",
    "file:///dev/stdin",
  ], { input: cliInput });

  console.log(`SignWell configured in ${testMode ? "test" : "live"} mode.`);
  console.log(`Webhook: ${callback}`);
  console.log(`AWS secret: ${secretId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
