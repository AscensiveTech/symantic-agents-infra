// Signed AWS REST calls without the AWS SDK. Amazon Location's Places v2
// client isn't guaranteed to be in the Lambda runtime's bundled SDK, and
// this Lambda ships without node_modules - so the few calls it makes are
// signed here (Signature Version 4) with node:crypto and sent with fetch.
// Kept identical to lambda/bff/aws-request.mjs (separately packaged Lambda).

import { createHash, createHmac } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5000;

export class AwsRequestError extends Error {
  constructor(message, { name, status } = {}) {
    super(message);
    this.name = name || "AwsRequestError";
    this.status = status;
  }
}

// -> parsed JSON body. Throws AwsRequestError named after the AWS error type
// (ThrottlingException, ValidationException, ...).
export async function awsRequest({
  service,
  host,
  method = "POST",
  path,
  query = {},
  body,
  region = process.env.AWS_REGION,
  credentials = envCredentials(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = new Date(),
}) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new AwsRequestError("AWS credentials are not available", { name: "CredentialsError" });
  }
  const payload = body === undefined ? "" : JSON.stringify(body);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const encodedPath = path.split("/").map(encodeRfc3986).join("/");
  const canonicalQuery = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(String(value))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const headers = {
    host,
    "x-amz-date": amzDate,
    ...(payload ? { "content-type": "application/json" } : {}),
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  // Non-S3 services sign the path URI-encoded twice.
  const canonicalPath = encodedPath.split("/").map(encodeRfc3986).join("/");
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, sha256(payload)].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = ["aws4_request"].reduce(
    (key, part) => hmac(key, part),
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), service),
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  let response;
  try {
    response = await fetchImpl(`https://${host}${encodedPath}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
      method,
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(payload ? { body: payload } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new AwsRequestError(timedOut ? `${service} timed out` : `${service} request failed: ${error?.message}`, {
      name: timedOut ? "TimeoutError" : "NetworkError",
    });
  }
  const text = await response.text();
  const parsed = text ? safeJson(text) : null;
  if (!response.ok) {
    const type = response.headers.get("x-amzn-errortype")?.split(":")[0] || parsed?.__type?.split("#").pop() || `Http${response.status}`;
    throw new AwsRequestError(parsed?.message ?? parsed?.Message ?? `${service} returned ${response.status}`, { name: type, status: response.status });
  }
  return parsed;
}

function envCredentials() {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
