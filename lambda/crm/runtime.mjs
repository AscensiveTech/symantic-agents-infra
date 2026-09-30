import { createCrmApi } from "./api.mjs";
import { createTokenKeeper } from "./keeper.mjs";
import { createCrmLookup } from "./lookup.mjs";
import { createMetrics } from "./metrics.mjs";
import { createMondayCrmAdapter } from "./monday/adapter.mjs";
import { createMondayGraphqlClient } from "./monday/graphql.mjs";
import { createMondayOAuthClient } from "./monday/oauth.mjs";
import { createMondaySessionFactory } from "./monday/session.mjs";
import { createProviderRegistry } from "./provider.mjs";
import { createReauthReminders } from "./reminders.mjs";
import { createRequeuer } from "./requeue.mjs";
import { createDynamoCrmStore } from "./store.mjs";
import { createCrmSync } from "./sync.mjs";

const SECRET_TTL_MS = 5 * 60 * 1000;

/**
 * Composes the CRM services from environment configuration. Everything is
 * created once per container and reused across invocations.
 */
export function composeRuntime({
  store,
  getAppSecret,
  tokenCrypto,
  enqueue,
  changeVisibility,
  sendEmail,
  fetchImpl = globalThis.fetch,
  apiVersion,
  appUrl,
  apiBaseUrl,
  metrics = createMetrics(),
  now = Date.now,
  sleep,
  log = console,
}) {
  const graphql = createMondayGraphqlClient({ fetchImpl, apiVersion, metrics, now });
  const adapter = createMondayCrmAdapter({ graphql });
  const providers = createProviderRegistry([adapter]);
  const oauthClient = createMondayOAuthClient({ fetchImpl, getAppSecret, now });
  const sessions = createMondaySessionFactory({
    connectionStore: store,
    tokenCrypto,
    oauthClient,
    now,
    sleep,
    metrics,
  });
  const crmSync = createCrmSync({ store, providers, sessions, appUrl, metrics, now, log });
  return {
    store,
    adapter,
    providers,
    sessions,
    metrics,
    changeVisibility,
    sync: crmSync,
    syncFollowUp: crmSync.syncFollowUp,
    lookup: createCrmLookup({ store, providers, sessions, metrics, now, log }),
    refreshTokens: createTokenKeeper({
      store,
      sessions,
      requeueFailed: createRequeuer({ store, enqueue, metrics, now }),
      remindReauth: createReauthReminders({ store, sendEmail, appUrl, now, log }),
      metrics,
      now,
      log,
    }),
    api: createCrmApi({
      store,
      adapter,
      oauthClient,
      sessions,
      tokenCrypto,
      getAppSecret,
      enqueue,
      metrics,
      appUrl,
      apiBaseUrl,
      now,
      log,
    }),
  };
}

let runtimePromise;

export function getRuntime() {
  runtimePromise ??= createAwsRuntime().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function createAwsRuntime() {
  const [dynamodb, kms, secrets, sqs, sesv2] = await Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-kms"),
    import("@aws-sdk/client-secrets-manager"),
    import("@aws-sdk/client-sqs"),
    import("@aws-sdk/client-sesv2"),
  ]);
  const env = process.env;
  const store = createDynamoCrmStore(new dynamodb.DynamoDBClient({}), dynamodb, {
    connections: env.CRM_CONNECTIONS_TABLE,
    links: env.CRM_LINKS_TABLE,
    calls: env.CALLS_TABLE,
    businessProfiles: env.BUSINESS_PROFILES_TABLE,
    contacts: env.CONTACTS_TABLE,
    agents: env.AGENTS_TABLE,
    workspaces: env.WORKSPACES_TABLE,
    memberships: env.WORKSPACE_MEMBERSHIPS_TABLE,
    oauthStates: env.OAUTH_STATES_TABLE,
  });

  const kmsClient = new kms.KMSClient({});
  const tokenCrypto = {
    async encrypt({ plaintext, workspaceId, provider, purpose }) {
      if (!env.CRM_TOKENS_KMS_KEY_ID) throw new Error("CRM_TOKENS_KMS_KEY_ID is required");
      const result = await kmsClient.send(new kms.EncryptCommand({
        KeyId: env.CRM_TOKENS_KMS_KEY_ID,
        Plaintext: new TextEncoder().encode(plaintext),
        EncryptionContext: { workspaceId, provider, purpose },
      }));
      return Buffer.from(result.CiphertextBlob).toString("base64");
    },
    async decrypt({ ciphertext, workspaceId, provider, purpose }) {
      const result = await kmsClient.send(new kms.DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, "base64"),
        EncryptionContext: { workspaceId, provider, purpose },
      }));
      return new TextDecoder().decode(result.Plaintext);
    },
  };

  const secretsClient = new secrets.SecretsManagerClient({});
  let cachedSecret;
  const getAppSecret = async () => {
    if (cachedSecret && cachedSecret.expiresAt > Date.now()) return cachedSecret.value;
    if (!env.MONDAY_OAUTH_SECRET_ARN) throw new Error("MONDAY_OAUTH_SECRET_ARN is required");
    let result;
    try {
      result = await secretsClient.send(
        new secrets.GetSecretValueCommand({ SecretId: env.MONDAY_OAUTH_SECRET_ARN }),
      );
    } catch (error) {
      // Terraform creates the secret empty; until the Monday app is registered
      // and its credentials stored, it has no value. That is "not configured"
      // (a clear 503 in the UI), not an internal error.
      if (error?.name !== "ResourceNotFoundException") throw error;
      cachedSecret = { value: {}, expiresAt: Date.now() + 60_000 };
      return cachedSecret.value;
    }
    let value = {};
    try {
      value = JSON.parse(result.SecretString ?? "{}");
    } catch {
      value = {};
    }
    cachedSecret = { value, expiresAt: Date.now() + SECRET_TTL_MS };
    return value;
  };

  const sesClient = new sesv2.SESv2Client({});
  const sendEmail = env.EMAIL_FROM
    ? async ({ to, subject, html, text }) => {
      await sesClient.send(new sesv2.SendEmailCommand({
        FromEmailAddress: env.EMAIL_FROM,
        Destination: { ToAddresses: [to] },
        ...(env.EMAIL_CONFIGURATION_SET ? { ConfigurationSetName: env.EMAIL_CONFIGURATION_SET } : {}),
        Content: {
          Simple: {
            Subject: { Data: String(subject).replace(/\s+/g, " ").slice(0, 250), Charset: "UTF-8" },
            Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
          },
        },
      }));
    }
    : undefined;

  const sqsClient = new sqs.SQSClient({});
  const queueUrl = env.CRM_SYNC_QUEUE_URL;
  return composeRuntime({
    store,
    getAppSecret,
    tokenCrypto,
    enqueue: async (message) => {
      if (!queueUrl) throw new Error("CRM_SYNC_QUEUE_URL is required");
      await sqsClient.send(new sqs.SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ v: 1, ...message }),
      }));
    },
    sendEmail,
    changeVisibility: async (receiptHandle, seconds) => {
      await sqsClient.send(new sqs.ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }));
    },
    apiVersion: env.MONDAY_API_VERSION || undefined,
    appUrl: env.APP_URL,
    apiBaseUrl: env.PUBLIC_API_BASE_URL,
  });
}
