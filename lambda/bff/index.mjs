import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  createRetellClient,
  createTelnyxClient,
  ProviderRequestError,
  resolveRetellVoiceId,
} from "./providers.mjs";
import { buildReceptionistConfig, resolveConfiguredVoiceId } from "./receptionist.mjs";
import { formatCurrentTime, isBusinessHours } from "./business-hours.mjs";
import {
  createSignWellClient,
  SignWellRequestError,
  verifySignWellEvent,
} from "./signwell.mjs";

const PROFILE_FIELDS = {
  businessType: "string",
  businessName: "string",
  address: "string",
  timezone: "string",
  phone: "string",
  description: "string",
  hours: "string",
  faqs: "faq[]",
  policies: "string",
  escalationContact: "string",
  ownerPhone: "string",
  fallbackPhone: "string",
  communicationStyle: "string",
};

const AGENT_STATUSES = new Set(["active", "draft", "preview", "planned"]);
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CALL_ID_PATTERN = /^call-[A-Za-z0-9_-]{1,123}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROPOSAL_ASSET_KEY_PATTERN = /^(templates|proposals|exports)\/[A-Za-z0-9_./-]+\.pdf$/;
const COMPANY_LOGO_KEY_PATTERN = /^company\/logo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_CONTENT_TYPE_PATTERN = /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const MAX_COMPANY_LOGO_BYTES = 10 * 1024 * 1024;
const MAX_DYNAMO_RECORD_BYTES = 350 * 1024;
const WORKSPACE_ROLES = new Set(["super-admin", "company-admin", "quotation-builder"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROPOSAL_SECTION_KINDS = [
  "cover",
  "agenda",
  "companyIntro",
  "parts",
  "summary",
  "scope",
  "agreement",
  "payment",
  "closing",
];
const PROPOSAL_SECTION_SET = new Set(PROPOSAL_SECTION_KINDS);
const COMPANY_TIERS = new Set(["basic", "repository", "signing"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function readBody(event) {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(PROFILE_FIELDS).every(([field, kind]) => {
    const candidate = value[field];
    if (kind === "string") return typeof candidate === "string";
    if (kind === "string[]") {
      return Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
    }
    return Array.isArray(candidate) && candidate.every((item) => (
      item &&
      typeof item === "object" &&
      typeof item.question === "string" &&
      typeof item.answer === "string"
    ));
  }) && ("businessHours" in value ? isBusinessHours(value.businessHours) : true);
}

function pickProfile(value) {
  return {
    ...Object.fromEntries(Object.keys(PROFILE_FIELDS).map((field) => [field, value[field]])),
    ...(isBusinessHours(value.businessHours) ? { businessHours: value.businessHours } : {}),
  };
}

function pickAgent(value, routeAgentId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agentId = routeAgentId ?? value.id ?? value.agentId;
  if (
    typeof agentId !== "string" ||
    !AGENT_ID_PATTERN.test(agentId) ||
    (value.id !== undefined && value.id !== agentId) ||
    (value.agentId !== undefined && value.agentId !== agentId) ||
    typeof value.name !== "string" ||
    typeof value.role !== "string" ||
    typeof value.description !== "string" ||
    !AGENT_STATUSES.has(value.status) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string") ||
    (value.configuration !== undefined && (
      !value.configuration ||
      typeof value.configuration !== "object" ||
      Array.isArray(value.configuration)
    ))
  ) {
    return null;
  }
  return {
    id: agentId,
    name: value.name,
    role: value.role,
    description: value.description,
    status: value.status,
    capabilities: value.capabilities,
    ...(value.configuration === undefined ? {} : { configuration: value.configuration }),
  };
}

function getAgentId(event, path) {
  const value = event?.pathParameters?.agentId ?? path.match(/^\/workspaces\/me\/agents\/([^/]+)$/)?.[1];
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return AGENT_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function getAgentAction(event, path) {
  const match = path.match(
    /^\/workspaces\/me\/agents\/([^/]+)\/(activate|start-test-call)$/,
  );
  if (!match) return null;
  try {
    const agentId = decodeURIComponent(
      event?.pathParameters?.agentId ?? match[1],
    );
    return AGENT_ID_PATTERN.test(agentId)
      ? { agentId, action: match[2] }
      : null;
  } catch {
    return null;
  }
}

function getCallId(event, path) {
  const value = event?.pathParameters?.callId ??
    path.match(/^\/workspaces\/me\/calls\/([^/]+)$/)?.[1];
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return CALL_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function getCallRecordingId(event, path) {
  const value = event?.pathParameters?.callId ??
    path.match(/^\/workspaces\/me\/calls\/([^/]+)\/recording$/)?.[1];
  if (!value || !path.endsWith("/recording")) return null;
  try {
    const decoded = decodeURIComponent(value);
    return CALL_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function getEntityId(event, path, collection, parameterName) {
  const pattern = new RegExp(`^/workspaces/me/${collection}/([^/]+)$`);
  const value = event?.pathParameters?.[parameterName] ?? path.match(pattern)?.[1];
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return ENTITY_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function pickEntity(value, idField, routeId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = routeId ?? value[idField];
  if (
    typeof id !== "string" ||
    !ENTITY_ID_PATTERN.test(id) ||
    (value[idField] !== undefined && value[idField] !== id)
  ) return null;
  const { workspaceId: _workspaceId, ...record } = value;
  const normalized = { ...record, [idField]: id };
  return Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_DYNAMO_RECORD_BYTES
    ? normalized
    : null;
}

function pickEntityArray(value, idField) {
  if (!Array.isArray(value)) return null;
  const records = value.map((item) => pickEntity(item, idField));
  return records.every(Boolean) ? records : null;
}

function validAssetKey(value) {
  return typeof value === "string" &&
    value.length <= 512 &&
    !value.includes("..") &&
    PROPOSAL_ASSET_KEY_PATTERN.test(value);
}

function claimGroups(value) {
  if (Array.isArray(value)) return value.filter((group) => typeof group === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((group) => typeof group === "string");
  } catch {
    // API Gateway can expose a comma-delimited claim instead of a JSON array.
  }
  return value.replace(/^\[|\]$/g, "").split(",")
    .map((group) => group.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

async function resolveActor(event, store) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
  const userId = claims.sub;
  if (typeof userId !== "string" || userId.length === 0) return null;

  // Unit-test stores written before shared workspaces intentionally omit membership methods.
  if (typeof store.getMembership !== "function") {
    return { userId, workspaceId: userId, roles: ["company-admin"] };
  }

  const membership = await store.getMembership(userId);
  if (!membership || membership.status === "disabled") return null;
  const roles = claimGroups(claims["cognito:groups"])
    .filter((group) => WORKSPACE_ROLES.has(group));
  if (!roles.includes(membership.role) && !roles.includes("super-admin")) return null;
  return { userId, workspaceId: membership.workspaceId, roles, membership };
}

function isWorkspaceAdmin(actor) {
  return actor.roles.includes("company-admin") || actor.roles.includes("super-admin");
}

function isProposalPath(path) {
  return typeof path === "string" && [
    "/workspaces/me/proposals",
    "/workspaces/me/proposal-templates",
    "/workspaces/me/parts",
    "/workspaces/me/proposal-assets",
  ].some((prefix) => path.startsWith(prefix));
}

export function createHandler({
  getStore = getDefaultStore,
  getUserDirectory = getDefaultUserDirectory,
  getAssetSigner = getDefaultAssetSigner,
  getRecordingSigner = getDefaultRecordingSigner,
  getProviders = getDefaultProviders,
  getRetellApiKey = getDefaultRetellApiKey,
  getSignWell = getDefaultSignWell,
  verifySignature = verifyRetellSignature,
  toolBaseUrl = process.env.PUBLIC_API_BASE_URL,
} = {}) {
  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path;
    try {
      if (path === "/retell/inbound-lookup" && method === "POST") {
        return await handleInboundLookup(event, {
          getStore,
          getProviders,
          getRetellApiKey,
          verifySignature,
          toolBaseUrl,
        });
      }

      if (path === "/webhooks/signwell" && method === "POST") {
        return await handleSignWellWebhook(event, { getStore, getSignWell });
      }

      const subject = event?.requestContext?.authorizer?.jwt?.claims?.sub;
      if (typeof subject !== "string" || subject.length === 0) {
        return json(401, { message: "Unauthorized" });
      }
      if (path === "/workspaces/me/profile" && method === "PUT" && !isProfile(readBody(event))) {
        return json(400, { message: "Invalid profile" });
      }

      const store = await getStore();
      const actor = await resolveActor(event, store);
      if (!actor) {
        return json(401, { message: "Unauthorized" });
      }
      const { workspaceId } = actor;

      const platformResponse = await handlePlatformCompanies(event, {
        method,
        path,
        actor,
        store,
        getUserDirectory,
        getAssetSigner,
      });
      if (platformResponse) return platformResponse;

      const usersResponse = await handleWorkspaceUsers(event, {
        method,
        path,
        actor,
        store,
        getUserDirectory,
      });
      if (usersResponse) return usersResponse;

      const companyResponse = await handleCompanyProfile(event, {
        method,
        path,
        actor,
        store,
        getAssetSigner,
      });
      if (companyResponse) return companyResponse;

      if (path === "/workspaces/me/proposal-settings" && method === "GET") {
        if (!isWorkspaceAdmin(actor)) {
          return json(403, { message: "Company administrator access is required" });
        }
        const workspace = await store.getWorkspace(workspaceId);
        return json(200, {
          allowedProposalSections: normalizeProposalSections(
            workspace?.allowedProposalSections,
            PROPOSAL_SECTION_KINDS,
          ),
          tier: normalizeCompanyTier(workspace?.tier),
        });
      }

      if (actor.roles.includes("quotation-builder") && !isWorkspaceAdmin(actor) && !isProposalPath(path)) {
        return json(403, { message: "Quotation builders can only access proposal features" });
      }

      const proposalResponse = await handleProposalApi(event, {
        method,
        path,
        workspaceId,
        getStore: async () => store,
        getAssetSigner,
        getSignWell,
      });
      if (proposalResponse) return proposalResponse;

      if (path === "/workspaces/me/profile" && method === "PUT") {
        const body = readBody(event);
        if (!isProfile(body)) return json(400, { message: "Invalid profile" });
        const profile = pickProfile(body);
        await store.ensureWorkspace(workspaceId);
        const saved = await store.putProfile(workspaceId, profile);
        return json(200, saved);
      }

      if (path === "/workspaces/me/profile" && method === "GET") {
        await store.ensureWorkspace(workspaceId);
        return json(200, await store.getProfile(workspaceId));
      }

      if (path === "/workspaces/me/agents" && method === "GET") {
        await store.ensureWorkspace(workspaceId);
        return json(200, await store.listAgents(workspaceId));
      }

      if (path === "/workspaces/me/agents" && method === "POST") {
        const candidate = pickAgent(readBody(event));
        const agent = candidate
          ? {
            ...candidate,
            status: candidate.status === "active" ? "draft" : candidate.status,
          }
          : null;
        if (!agent) return json(400, { message: "Invalid agent" });
        await store.ensureWorkspace(workspaceId);
        return json(201, await store.createAgent(workspaceId, agent.id, agent));
      }

      if (path === "/workspaces/me/calls" && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const calls = await store.listCalls(workspaceId);
        return json(200, calls.map(toPublicCallSummary));
      }

      const recordingCallId = getCallRecordingId(event, path);
      if (recordingCallId && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const call = await store.getCall(workspaceId, recordingCallId);
        if (!call?.recordingKey) {
          return json(404, { message: "Recording not available" });
        }
        const signer = await getRecordingSigner();
        return json(200, {
          url: await signer.createDownloadUrl(workspaceId, call.recordingKey),
        });
      }

      const callId = getCallId(event, path);
      if (callId && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const call = await store.getCall(workspaceId, callId);
        return call
          ? json(200, toPublicCall(call))
          : json(404, { message: "Call not found" });
      }

      const agentAction = getAgentAction(event, path);
      if (agentAction?.action === "activate" && method === "POST") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentAction.agentId);
        if (!agent) return json(404, { message: "Agent not found" });
        const profile = await store.getProfile(workspaceId);
        const calendar = agent?.configuration?.booking === true &&
            typeof store.getCalendarConnection === "function"
          ? await store.getCalendarConnection(workspaceId)
          : null;
        const launchIssue = launchReadinessIssue(agent, profile, calendar);
        if (launchIssue) return json(409, { message: launchIssue });
        const providers = await getProviders();
        const runtime = await syncReceptionistRuntime({
          workspaceId,
          agentId: agentAction.agentId,
          agent,
          profile,
          store,
          providers,
          toolBaseUrl,
          phoneStatus: "active",
        });
        const activatedAt = new Date().toISOString();
        let updatedAgent;
        try {
          updatedAgent = await store.updateAgentRuntime(
            workspaceId,
            agentAction.agentId,
            {
              status: "active",
              retellAgentId: runtime.retellAgentId,
              activatedAt,
              updatedAt: activatedAt,
            },
          );
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return json(404, { message: "Agent not found" });
          }
          throw error;
        }
        return json(200, {
          agent: toPublicAgent(updatedAgent),
          phoneNumber: toPublicPhoneNumber(runtime.phoneNumber),
        });
      }

      if (agentAction?.action === "start-test-call" && method === "POST") {
        const body = readBody(event);
        const toNumber = body?.toNumber;
        if (!isE164(toNumber)) {
          return json(400, {
            message: "toNumber must be an E.164 phone number",
          });
        }
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentAction.agentId);
        if (!agent) return json(404, { message: "Agent not found" });
        const profile = await store.getProfile(workspaceId);
        if (!profile) {
          return json(409, {
            message: "Complete the business profile before starting a test call",
          });
        }
        const providers = await getProviders();
        const runtime = await syncReceptionistRuntime({
          workspaceId,
          agentId: agentAction.agentId,
          agent,
          profile,
          store,
          providers,
          toolBaseUrl,
          phoneStatus: agent.status === "active" ? "active" : "draft",
        });
        const call = await providers.retell.startPhoneCall({
          fromNumber: runtime.phoneNumber.retellPhoneNumberId,
          toNumber,
          retellAgentId: runtime.retellAgentId,
          workspaceId,
          agentId: agentAction.agentId,
          currentTime: formatCurrentTime(profile.timezone),
          timezone: typeof profile.timezone === "string" ? profile.timezone : "UTC",
        });
        return json(202, {
          ...call,
          phoneNumber: toPublicPhoneNumber(runtime.phoneNumber),
        });
      }

      const agentId = getAgentId(event, path);
      if (agentId && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentId);
        return agent
          ? json(200, toPublicAgent(agent))
          : json(404, { message: "Agent not found" });
      }

      if (agentId && method === "PUT") {
        const agent = pickAgent(readBody(event), agentId);
        if (!agent) return json(400, { message: "Invalid agent" });
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        try {
          const existing = typeof store.getAgent === "function"
            ? await store.getAgent(workspaceId, agentId)
            : null;
          const invalidateTest = Boolean(
            existing &&
            !sameLaunchConfiguration(existing.configuration, agent.configuration),
          );
          const saved = {
            ...agent,
            status: invalidateTest
              ? "draft"
              : existing?.status === "active"
                ? "active"
                : agent.status === "active"
                  ? "draft"
                  : agent.status,
          };
          return json(
            200,
            await store.putAgent(
              workspaceId,
              agentId,
              saved,
              { invalidateTest },
            ),
          );
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return json(404, { message: "Agent not found" });
          }
          throw error;
        }
      }

      return json(404, { message: "Not found" });
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return json(409, { message: "Agent already exists" });
      }
      if (error instanceof ProviderRequestError) {
        console.error("BFF provider request failed", {
          provider: error.provider,
          providerStatus: error.providerStatus,
          message: error.message,
        });
        return json(502, { message: error.message });
      }
      if (error instanceof SignWellRequestError) {
        console.error("SignWell request failed", {
          providerStatus: error.status,
          message: error.message,
        });
        return json(502, { message: error.message });
      }
      console.error("BFF request failed", error);
      return json(500, { message: "Internal server error" });
    }
  };
}

async function handlePlatformCompanies(event, {
  method,
  path,
  actor,
  store,
  getUserDirectory,
  getAssetSigner,
}) {
  if (
    typeof path !== "string" ||
    (path !== "/platform/companies" && !path.startsWith("/platform/companies/"))
  ) return null;
  if (!actor.roles.includes("super-admin")) {
    return json(403, { message: "Super administrator access is required" });
  }

  if (path === "/platform/companies" && method === "GET") {
    const workspaces = await store.listWorkspaces();
    const summaries = await Promise.all(
      workspaces.map((workspace) => platformCompanySummary(store, workspace)),
    );
    summaries.sort((left, right) => left.name.localeCompare(right.name));
    return json(200, summaries);
  }

  if (path !== "/platform/companies") {
    const target = getPlatformCompanyTarget(event, path);
    if (!target) return json(404, { message: "Not found" });
    const workspace = await store.getWorkspace(target.workspaceId);
    if (!workspace) return json(404, { message: "Company workspace not found" });

    if (target.kind === "logo-upload" && method === "POST") {
      const logo = validCompanyLogoRequest(readBody(event));
      if (!logo) return json(400, { message: "Logo must be an image no larger than 10 MB" });
      const key = `company/logo-${randomUUID()}`;
      const signer = await getAssetSigner();
      return json(200, {
        ...(await signer.createImageUpload(target.workspaceId, key, logo.contentType, MAX_COMPANY_LOGO_BYTES)),
        key,
      });
    }

    if (target.kind === "logo-complete" && method === "POST") {
      const logo = validCompanyLogoCompletion(readBody(event));
      if (!logo) return json(400, { message: "Invalid company logo" });
      const updated = withCompanyLogo(workspace, logo, actor.userId);
      await store.putWorkspace(updated);
      return json(200, companyLogoResponse(updated));
    }

    if (target.kind === "company" && method === "PATCH") {
      const body = readBody(event);
      const hasName = body && Object.hasOwn(body, "name");
      const hasTier = body && Object.hasOwn(body, "tier");
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (
        (!hasName && !hasTier) ||
        (hasName && (name.length < 2 || name.length > 120)) ||
        (hasTier && !COMPANY_TIERS.has(body?.tier))
      ) {
        return json(400, { message: "Invalid company update" });
      }
      const updated = {
        ...workspace,
        ...(hasName ? { name } : {}),
        ...(hasTier ? { tier: body.tier } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: actor.userId,
      };
      await store.putWorkspace(updated);
      return json(200, await platformCompanySummary(store, updated));
    }

    if (target.kind === "users" && method === "GET") {
      return json(200, await store.listMemberships(target.workspaceId));
    }

    if (target.kind === "user" && method === "PATCH") {
      const body = readBody(event);
      const role = body?.role;
      if (!["company-admin", "quotation-builder"].includes(role)) {
        return json(400, { message: "Invalid workspace role" });
      }
      const membership = await store.getMembership(target.userId);
      if (!membership || membership.workspaceId !== target.workspaceId) {
        return json(404, { message: "Workspace user not found" });
      }
      const directory = await getUserDirectory();
      const directoryRoles = typeof directory.getRoles === "function"
        ? await directory.getRoles(membership.cognitoUsername ?? membership.email)
        : [];
      if (membership.role === "super-admin" || directoryRoles.includes("super-admin")) {
        return json(403, { message: "A super administrator role cannot be changed here" });
      }
      if (membership.role === "company-admin" && role !== "company-admin") {
        const members = await store.listMemberships(target.workspaceId);
        const activeAdmins = members.filter((member) => (
          member.role === "company-admin" && member.status !== "disabled"
        ));
        if (activeAdmins.length <= 1) {
          return json(409, { message: "Promote another company administrator first" });
        }
      }
      await directory.setRole(membership.cognitoUsername ?? membership.email, role);
      const updated = {
        ...membership,
        role,
        updatedAt: new Date().toISOString(),
        updatedBy: actor.userId,
      };
      await store.putMembership(updated);
      return json(200, updated);
    }

    return json(404, { message: "Not found" });
  }

  if (method !== "POST") return json(404, { message: "Not found" });

  const body = readBody(event);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const adminEmail = typeof body?.adminEmail === "string"
    ? body.adminEmail.trim().toLowerCase()
    : "";
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  const temporaryPassword = body?.temporaryPassword;
  const tier = body?.tier ?? "basic";
  const allowedSections = normalizeProposalSections(body?.allowedProposalSections);
  const defaultSections = normalizeProposalSections(body?.defaultTemplateSections);
  if (
    name.length < 2 ||
    name.length > 120 ||
    !EMAIL_PATTERN.test(adminEmail) ||
    adminEmail.length > 320 ||
    adminName.length > 120 ||
    typeof temporaryPassword !== "string" ||
    temporaryPassword.length < 12 ||
    !COMPANY_TIERS.has(tier) ||
    !allowedSections ||
    !defaultSections ||
    defaultSections.some((section) => !allowedSections.includes(section))
  ) {
    return json(400, { message: "Invalid company setup" });
  }

  const now = new Date().toISOString();
  const workspaceId = `workspace-${randomUUID()}`;
  const workspace = {
    workspaceId,
    name,
    tier,
    allowedProposalSections: allowedSections,
    createdAt: now,
    createdBy: actor.userId,
  };
  const template = defaultProposalTemplate(defaultSections, now);
  const directory = await getUserDirectory();
  let created;
  try {
    created = await directory.createUser({
      email: adminEmail,
      name: adminName,
      temporaryPassword,
    });
    await directory.setRole(created.username, "company-admin");
    const membership = {
      userId: created.userId,
      cognitoUsername: created.username,
      workspaceId,
      email: adminEmail,
      name: adminName,
      role: "company-admin",
      status: "active",
      createdAt: now,
      createdBy: actor.userId,
    };
    await store.createWorkspaceBundle({ workspace, membership, template });
    return json(201, {
      workspaceId,
      name,
      createdAt: now,
      allowedProposalSections: allowedSections,
      tier,
      userCount: 1,
      proposalCount: 0,
      templateCount: 1,
    });
  } catch (error) {
    if (created?.username) await directory.deleteUser(created.username).catch(() => {});
    if (error?.name === "UsernameExistsException") {
      return json(409, { message: "A user with that email already exists" });
    }
    if (error?.name === "ConditionalCheckFailedException" || error?.name === "TransactionCanceledException") {
      return json(409, { message: "That company could not be created because its records already exist" });
    }
    throw error;
  }
}

async function platformCompanySummary(store, workspace) {
  const [members, proposals, templates] = await Promise.all([
    store.listMemberships(workspace.workspaceId),
    store.listProposals(workspace.workspaceId),
    store.listProposalTemplates(workspace.workspaceId),
  ]);
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name || workspace.workspaceId,
    createdAt: workspace.createdAt ?? null,
    allowedProposalSections: normalizeProposalSections(
      workspace.allowedProposalSections,
      PROPOSAL_SECTION_KINDS,
    ),
    tier: normalizeCompanyTier(workspace.tier),
    userCount: members.filter((member) => member.status !== "disabled").length,
    proposalCount: proposals.length,
    templateCount: templates.length,
  };
}

function getPlatformCompanyTarget(event, path) {
  const patterns = [
    ["logo-upload", /^\/platform\/companies\/([^/]+)\/logo\/upload-url$/],
    ["logo-complete", /^\/platform\/companies\/([^/]+)\/logo\/complete$/],
    ["user", /^\/platform\/companies\/([^/]+)\/users\/([^/]+)$/],
    ["users", /^\/platform\/companies\/([^/]+)\/users$/],
    ["company", /^\/platform\/companies\/([^/]+)$/],
  ];
  for (const [kind, pattern] of patterns) {
    const match = path.match(pattern);
    if (!match) continue;
    try {
      const workspaceId = decodeURIComponent(
        event?.pathParameters?.workspaceId ?? match[1],
      );
      const userId = kind === "user"
        ? decodeURIComponent(event?.pathParameters?.userId ?? match[2])
        : null;
      if (
        !ENTITY_ID_PATTERN.test(workspaceId) ||
        (kind === "user" && !ENTITY_ID_PATTERN.test(userId))
      ) return null;
      return { kind, workspaceId, ...(userId ? { userId } : {}) };
    } catch {
      return null;
    }
  }
  return null;
}

function validCompanyLogoRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { contentType, bytes } = value;
  if (
    typeof contentType !== "string" ||
    !IMAGE_CONTENT_TYPE_PATTERN.test(contentType) ||
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_COMPANY_LOGO_BYTES
  ) return null;
  return { contentType, bytes };
}

function validCompanyLogoCompletion(value) {
  const logo = validCompanyLogoRequest(value);
  if (!logo || typeof value.key !== "string" || !COMPANY_LOGO_KEY_PATTERN.test(value.key)) {
    return null;
  }
  return { ...logo, key: value.key };
}

function withCompanyLogo(workspace, logo, userId) {
  const now = new Date().toISOString();
  return {
    ...workspace,
    companyLogo: { ...logo, updatedAt: now },
    updatedAt: now,
    updatedBy: userId,
  };
}

function companyLogoResponse(workspace, url = null) {
  const logo = workspace?.companyLogo;
  if (
    !logo ||
    !COMPANY_LOGO_KEY_PATTERN.test(logo.key ?? "") ||
    !validCompanyLogoRequest(logo)
  ) return { logo: null };
  return {
    logo: {
      key: logo.key,
      contentType: logo.contentType,
      bytes: logo.bytes,
      ...(url ? { url } : {}),
    },
  };
}

function normalizeProposalSections(value, fallback = null) {
  if (value === undefined && fallback) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((section) => typeof section === "string" && PROPOSAL_SECTION_SET.has(section))) {
    return null;
  }
  return PROPOSAL_SECTION_KINDS.filter((section) => value.includes(section));
}

function normalizeCompanyTier(value) {
  return COMPANY_TIERS.has(value) ? value : "basic";
}

function defaultProposalTemplate(sections, now) {
  return {
    id: `tpl-${randomUUID()}`,
    name: "Default",
    isDefault: true,
    items: sections.map((kind, order) => ({
      id: `itm-${randomUUID()}`,
      order,
      kind,
      fileKey: null,
      label: null,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

async function handleWorkspaceUsers(event, {
  method,
  path,
  actor,
  store,
  getUserDirectory,
}) {
  if (typeof path !== "string" || !path.startsWith("/workspaces/me/users")) return null;
  if (!isWorkspaceAdmin(actor)) return json(403, { message: "Company administrator access is required" });

  if (path === "/workspaces/me/users" && method === "GET") {
    return json(200, await store.listMemberships(actor.workspaceId));
  }

  if (path === "/workspaces/me/users" && method === "POST") {
    const body = readBody(event);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const role = body?.role === "company-admin" ? "company-admin" : "quotation-builder";
    const temporaryPassword = body?.temporaryPassword;
    if (
      !EMAIL_PATTERN.test(email) ||
      email.length > 320 ||
      name.length > 120 ||
      typeof temporaryPassword !== "string" ||
      temporaryPassword.length < 12
    ) {
      return json(400, { message: "Invalid workspace user" });
    }

    const directory = await getUserDirectory();
    let created;
    try {
      created = await directory.createUser({ email, name, temporaryPassword });
      await directory.setRole(created.username, role);
      const membership = {
        userId: created.userId,
        cognitoUsername: created.username,
        workspaceId: actor.workspaceId,
        email,
        name,
        role,
        status: "active",
        createdAt: new Date().toISOString(),
        createdBy: actor.userId,
      };
      await store.putMembership(membership);
      return json(201, membership);
    } catch (error) {
      if (created?.username) await directory.deleteUser(created.username).catch(() => {});
      if (error?.name === "UsernameExistsException") {
        return json(409, { message: "A user with that email already exists" });
      }
      throw error;
    }
  }

  const userId = getEntityId(event, path, "users", "userId");
  if (!userId) return json(404, { message: "Not found" });
  const target = await store.getMembership(userId);
  if (!target || target.workspaceId !== actor.workspaceId) {
    return json(404, { message: "Workspace user not found" });
  }

  if (method === "PATCH") {
    const body = readBody(event);
    const role = body?.role;
    if (
      !["company-admin", "quotation-builder"].includes(role)
    ) {
      return json(400, { message: "Invalid workspace role" });
    }
    const directory = await getUserDirectory();
    if (!actor.roles.includes("super-admin") && (
      target.role === "super-admin" ||
      (typeof directory.getRoles === "function" &&
        (await directory.getRoles(target.cognitoUsername ?? target.email)).includes("super-admin"))
    )) {
      return json(403, { message: "A company administrator cannot change a super administrator" });
    }
    if (target.role === "company-admin" && role !== "company-admin") {
      const members = await store.listMemberships(actor.workspaceId);
      if (members.filter((member) => member.role === "company-admin" && member.status !== "disabled").length <= 1) {
        return json(409, { message: "Promote another company administrator first" });
      }
    }
    await directory.setRole(target.cognitoUsername ?? target.email, role);
    const updated = { ...target, role, updatedAt: new Date().toISOString() };
    await store.putMembership(updated);
    return json(200, updated);
  }

  if (method === "DELETE") {
    if (userId === actor.userId) return json(409, { message: "You cannot remove your own account" });
    const directory = await getUserDirectory();
    if (!actor.roles.includes("super-admin") && (
      target.role === "super-admin" ||
      (typeof directory.getRoles === "function" &&
        (await directory.getRoles(target.cognitoUsername ?? target.email)).includes("super-admin"))
    )) {
      return json(403, { message: "A company administrator cannot remove a super administrator" });
    }
    if (target.role === "company-admin") {
      const members = await store.listMemberships(actor.workspaceId);
      if (members.filter((member) => member.role === "company-admin" && member.status !== "disabled").length <= 1) {
        return json(409, { message: "Promote another company administrator first" });
      }
    }
    await directory.deleteUser(target.cognitoUsername ?? target.email);
    await store.deleteMembership(userId);
    return json(200, { ok: true });
  }

  return json(404, { message: "Not found" });
}

async function handleCompanyProfile(event, { method, path, actor, store, getAssetSigner }) {
  if (typeof path !== "string" || !path.startsWith("/workspaces/me/company")) return null;
  if (!isWorkspaceAdmin(actor)) {
    return json(403, { message: "Company administrator access is required" });
  }
  const workspace = await store.getWorkspace(actor.workspaceId);
  if (!workspace) return json(404, { message: "Company workspace not found" });

  if (path === "/workspaces/me/company/logo/upload-url" && method === "POST") {
    const logo = validCompanyLogoRequest(readBody(event));
    if (!logo) return json(400, { message: "Logo must be an image no larger than 10 MB" });
    const key = `company/logo-${randomUUID()}`;
    const signer = await getAssetSigner();
    return json(200, {
      ...(await signer.createImageUpload(actor.workspaceId, key, logo.contentType, MAX_COMPANY_LOGO_BYTES)),
      key,
    });
  }
  if (path === "/workspaces/me/company/logo/complete" && method === "POST") {
    const logo = validCompanyLogoCompletion(readBody(event));
    if (!logo) return json(400, { message: "Invalid company logo" });
    const updated = withCompanyLogo(workspace, logo, actor.userId);
    await store.putWorkspace(updated);
    return json(200, companyLogoResponse(updated));
  }
  if (path === "/workspaces/me/company/logo" && method === "DELETE") {
    const { companyLogo: _companyLogo, ...withoutLogo } = workspace;
    await store.putWorkspace({
      ...withoutLogo,
      updatedAt: new Date().toISOString(),
      updatedBy: actor.userId,
    });
    return json(200, { logo: null });
  }
  if (path !== "/workspaces/me/company") return json(404, { message: "Not found" });

  if (method === "GET") {
    let logoUrl = null;
    if (companyLogoResponse(workspace).logo) {
      const signer = await getAssetSigner();
      logoUrl = await signer.createDownloadUrl(actor.workspaceId, workspace.companyLogo.key);
    }
    return json(200, {
      name: workspace.name || "",
      ...companyLogoResponse(workspace, logoUrl),
    });
  }
  if (method === "PATCH") {
    const body = readBody(event);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 120) {
      return json(400, { message: "Invalid company name" });
    }
    await store.putWorkspace({
      ...workspace,
      name,
      updatedAt: new Date().toISOString(),
      updatedBy: actor.userId,
    });
    return json(200, { name });
  }
  return json(404, { message: "Not found" });
}

async function handleSignWellWebhook(event, { getStore, getSignWell }) {
  const payload = readBody(event);
  const signWell = await getSignWell();
  if (!verifySignWellEvent(payload, signWell.webhookId)) {
    return json(401, { message: "Invalid SignWell webhook signature" });
  }

  const document = payload?.data?.object;
  const { workspaceId, proposalId } = signWellDocumentMetadata(document);
  if (
    typeof document?.id !== "string" || !document.id ||
    typeof workspaceId !== "string" || !ENTITY_ID_PATTERN.test(workspaceId) ||
    typeof proposalId !== "string" || !ENTITY_ID_PATTERN.test(proposalId)
  ) {
    return json(200, { ok: true, ignored: true });
  }

  const store = await getStore();
  const proposal = await store.getProposal(workspaceId, proposalId);
  const current = proposal?.signatureRequest;
  if (!current || current.provider !== "signwell" || current.documentId !== document.id) {
    return json(200, { ok: true, ignored: true });
  }

  const eventType = payload.event.type;
  const eventStatus = eventType.startsWith("document_")
    ? normalizeSignWellStatus(eventType.slice("document_".length), current.status)
    : normalizeSignWellStatus(document.status, current.status);
  // Webhooks can be retried or arrive slightly out of order. A late viewed or
  // signed event must never reopen a completed/declined/expired document.
  const statusFromEvent = TERMINAL_SIGNATURE_STATUSES.has(current.status) &&
    !TERMINAL_SIGNATURE_STATUSES.has(eventStatus)
    ? current.status
    : eventStatus;
  const relatedSigner = payload.event.related_signer;
  const relatedEmail = typeof relatedSigner?.email === "string"
    ? relatedSigner.email.trim().toLowerCase()
    : null;
  const eventTimeNumber = Number(payload.event.time);
  const eventAt = Number.isFinite(eventTimeNumber)
    ? new Date(eventTimeNumber * 1000).toISOString()
    : new Date().toISOString();
  const recipientEventStatus = eventType === "document_signed"
    ? "signed"
    : eventType === "document_viewed"
      ? "viewed"
      : eventType === "document_declined"
        ? "declined"
        : null;
  const recipients = Array.isArray(current.recipients)
    ? current.recipients.map((recipient) => {
      const documentRecipient = Array.isArray(document.recipients)
        ? document.recipients.find((item) => item?.id === recipient.id)
        : null;
      const related = relatedEmail && recipient.email?.toLowerCase() === relatedEmail;
      const completed = statusFromEvent === "completed";
      return {
        ...recipient,
        ...(typeof documentRecipient?.name === "string" ? { name: documentRecipient.name } : {}),
        ...(typeof documentRecipient?.email === "string" ? { email: documentRecipient.email.toLowerCase() } : {}),
        ...(related && recipientEventStatus ? { status: recipientEventStatus } : {}),
        ...(related && eventType === "document_signed" ? { signedAt: eventAt } : {}),
        ...(related && eventType === "document_viewed" ? { viewedAt: eventAt } : {}),
        ...(related && eventType === "document_declined" ? { declinedAt: eventAt } : {}),
        ...(completed ? { status: "signed", signedAt: recipient.signedAt ?? eventAt } : {}),
      };
    })
    : [];
  const updated = {
    ...current,
    status: statusFromEvent,
    recipients,
    lastEvent: eventType,
    lastEventAt: eventAt,
    updatedAt: new Date().toISOString(),
    ...(statusFromEvent === "completed" ? { completedAt: eventAt } : {}),
  };
  await store.updateProposalSignature(workspaceId, proposalId, updated);
  return json(200, { ok: true });
}

const TERMINAL_SIGNATURE_STATUSES = new Set([
  "completed",
  "expired",
  "canceled",
  "declined",
  "bounced",
  "error",
]);

function normalizeSignWellStatus(value, fallback = "sent") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "pending") return "in_progress";
  if (normalized === "complete") return "completed";
  return SIGNATURE_STATUSES.has(normalized) ? normalized : fallback;
}

function signWellDocumentMetadata(document) {
  const metadata = document?.metadata;
  return {
    workspaceId: metadata?.workspaceId ?? metadata?.workspace_id,
    proposalId: metadata?.proposalId ?? metadata?.proposal_id,
  };
}

const SIGNATURE_STATUSES = new Set([
  "created",
  "sent",
  "viewed",
  "in_progress",
  "signed",
  "completed",
  "expired",
  "canceled",
  "declined",
  "bounced",
  "error",
]);

function isActiveSignatureRequest(request) {
  return request?.provider === "signwell" &&
    typeof request.documentId === "string" &&
    !TERMINAL_SIGNATURE_STATUSES.has(request.status);
}

const SIGNWELL_SYNC_INTERVAL_MS = 30_000;

async function reconcileSignWellSignature({
  proposal,
  workspaceId,
  store,
  client,
  force = false,
}) {
  const current = proposal?.signatureRequest;
  if (!isActiveSignatureRequest(current) || typeof client?.getDocument !== "function") {
    return proposal;
  }
  const lastSync = Date.parse(current.lastProviderSyncAt ?? "");
  if (!force && Number.isFinite(lastSync) && Date.now() - lastSync < SIGNWELL_SYNC_INTERVAL_MS) {
    return proposal;
  }

  try {
    const document = await client.getDocument(current.documentId);
    const metadata = signWellDocumentMetadata(document);
    if (
      document?.id !== current.documentId ||
      metadata.workspaceId !== workspaceId ||
      metadata.proposalId !== proposal.id
    ) {
      console.warn("SignWell reconciliation ignored mismatched document metadata", {
        workspaceId,
        proposalId: proposal.id,
        documentId: current.documentId,
      });
      return proposal;
    }

    const now = new Date().toISOString();
    const status = normalizeSignWellStatus(document.status, current.status);
    const documentRecipients = Array.isArray(document.recipients) ? document.recipients : [];
    const recipients = Array.isArray(current.recipients)
      ? current.recipients.map((recipient) => {
        const providerRecipient = documentRecipients.find((item) => item?.id === recipient.id);
        const providerStatus = normalizeSignWellRecipientStatus(providerRecipient?.status, recipient.status);
        return {
          ...recipient,
          ...(typeof providerRecipient?.name === "string" ? { name: providerRecipient.name } : {}),
          ...(typeof providerRecipient?.email === "string"
            ? { email: providerRecipient.email.trim().toLowerCase() }
            : {}),
          status: status === "completed" ? "signed" : providerStatus,
          ...(status === "completed" || providerStatus === "signed"
            ? { signedAt: recipient.signedAt ?? document.updated_at ?? now }
            : {}),
        };
      })
      : [];
    const eventAt = typeof document.updated_at === "string" ? document.updated_at : now;
    const updated = {
      ...current,
      status,
      recipients,
      lastProviderSyncAt: now,
      lastEvent: status === "completed" ? "document_completed" : current.lastEvent,
      lastEventAt: status === "completed" ? eventAt : current.lastEventAt,
      updatedAt: now,
      ...(status === "completed" ? { completedAt: eventAt } : {}),
    };
    await store.updateProposalSignature(workspaceId, proposal.id, updated);
    return { ...proposal, signatureRequest: updated };
  } catch (error) {
    console.warn("SignWell reconciliation failed", {
      workspaceId,
      proposalId: proposal.id,
      documentId: current.documentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return proposal;
  }
}

function normalizeSignWellRecipientStatus(value, fallback = "pending") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "signed") return "signed";
  if (normalized === "sent") return "sent";
  if (normalized === "created") return "pending";
  if (["pending", "in_progress", "viewed", "declined", "bounced", "expired", "canceled"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function proposalPdfFilename(name) {
  const stem = typeof name === "string"
    ? name.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  return `${stem || "proposal"}.pdf`;
}

function validSignatureRequest(value, proposalId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.assetKey !== `exports/${proposalId}.pdf`) return null;
  if (!Array.isArray(value.recipients) || value.recipients.length < 1 || value.recipients.length > 10) return null;
  const seenEmails = new Set();
  const recipients = [];
  for (const item of value.recipients) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const email = typeof item?.email === "string" ? item.email.trim().toLowerCase() : "";
    if (!name || name.length > 255 || !EMAIL_PATTERN.test(email) || seenEmails.has(email)) return null;
    seenEmails.add(email);
    recipients.push({ name, email });
  }
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  if (!subject || subject.length > 255 || !message || message.length > 4000) return null;
  return {
    assetKey: value.assetKey,
    recipients,
    subject,
    message,
    applySigningOrder: value.applySigningOrder === true,
  };
}

function proposalSignerNames(proposal) {
  if (Array.isArray(proposal?.signerNames)) {
    return proposal.signerNames
      .filter((name) => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 10);
  }
  return [...new Set([proposal?.presentedBy, proposal?.clientName]
    .filter((name) => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean))]
    .slice(0, 10);
}

function hasAgreementSigningFields(proposal, recipients) {
  const agreementIncluded = Array.isArray(proposal?.documentItems) &&
    proposal.documentItems.some((item) => item?.kind === "agreement" && item.hidden !== true);
  if (!agreementIncluded) return false;
  const names = proposalSignerNames(proposal);
  return names.length === recipients.length && names.every(
    (name, index) => name.toLocaleLowerCase() === recipients[index]?.name.toLocaleLowerCase(),
  );
}

async function handleProposalApi(event, {
  method,
  path,
  workspaceId,
  getStore,
  getAssetSigner,
  getSignWell,
}) {
  if (typeof path !== "string" || ![
    "/workspaces/me/proposals",
    "/workspaces/me/proposal-templates",
    "/workspaces/me/parts",
    "/workspaces/me/proposal-assets",
  ].some((prefix) => path.startsWith(prefix))) return null;

  const store = await getStore();
  await store.ensureWorkspace(workspaceId);

  if (path === "/workspaces/me/proposals") {
    if (method === "GET") return json(200, await store.listProposals(workspaceId));
    if (method === "POST") {
      const proposal = pickEntity(readBody(event), "id");
      if (!proposal) return json(400, { message: "Invalid proposal" });
      try {
        return json(201, await store.createProposal(workspaceId, proposal));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(409, { message: "Proposal already exists" });
        throw error;
      }
    }
  }

  const duplicateMatch = path.match(/^\/workspaces\/me\/proposals\/([^/]+)\/duplicate$/);
  if (duplicateMatch && method === "POST") {
    const proposalId = decodeEntityId(event?.pathParameters?.proposalId ?? duplicateMatch[1]);
    if (!proposalId) return json(400, { message: "Invalid proposal ID" });
    const source = await store.getProposal(workspaceId, proposalId);
    if (!source) return json(404, { message: "Proposal not found" });
    const now = new Date().toISOString();
    const copy = {
      ...structuredClone(source),
      id: `prp-${randomUUID()}`,
      name: `${source.name || "Proposal"} copy`,
      status: "draft",
      lastExportedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    delete copy.signatureRequest;
    return json(201, await store.createProposal(workspaceId, copy));
  }

  const signatureMatch = path.match(
    /^\/workspaces\/me\/proposals\/([^/]+)\/signature-requests(?:\/(remind|completed-pdf))?$/,
  );
  if (signatureMatch) {
    const proposalId = decodeEntityId(
      event?.pathParameters?.proposalId ?? signatureMatch[1],
    );
    if (!proposalId) return json(400, { message: "Invalid proposal ID" });
    const proposal = await store.getProposal(workspaceId, proposalId);
    if (!proposal) return json(404, { message: "Proposal not found" });
    const action = signatureMatch[2] ?? "create";
    const signWell = await getSignWell();

    if (action === "create" && method === "POST") {
      const input = validSignatureRequest(readBody(event), proposalId);
      if (!input) {
        return json(400, {
          message: "Provide 1 to 10 unique signer names and email addresses for the generated proposal PDF",
        });
      }
      if (isActiveSignatureRequest(proposal.signatureRequest)) {
        return json(409, { message: "This proposal already has an active signature request" });
      }
      const agreementHasSigningFields = hasAgreementSigningFields(
        proposal,
        input.recipients,
      );
      if (proposal.documentItems?.some((item) => item?.kind === "agreement" && !item.hidden) && !agreementHasSigningFields) {
        return json(409, {
          message: "The generated PDF signer names do not match these recipients. Save the signer names and regenerate the PDF first.",
        });
      }
      const signer = await getAssetSigner();
      const fileUrl = await signer.createDownloadUrl(workspaceId, input.assetKey);
      const embeddedTestMode = signWell.client.testMode === true;
      const created = await signWell.client.createDocument({
        name: proposal.name || "Proposal",
        subject: input.subject,
        message: input.message,
        draft: false,
        reminders: true,
        apply_signing_order: input.applySigningOrder,
        allow_decline: true,
        allow_reassign: true,
        ...(embeddedTestMode ? { embedded_signing: true } : {}),
        text_tags: agreementHasSigningFields,
        with_signature_page: !agreementHasSigningFields,
        files: [{
          name: proposalPdfFilename(proposal.name),
          file_url: fileUrl,
        }],
        recipients: input.recipients.map((recipient, index) => ({
          id: String(index + 1),
          name: recipient.name,
          email: recipient.email,
          delivery_method: "email",
          // Embedded recipients default to email delivery being disabled in
          // SignWell. Test mode uses embedding only to expose a safe signing
          // URL, so opt back into the same notification email as live mode.
          ...(embeddedTestMode ? { send_email: true } : {}),
        })),
        metadata: {
          workspaceId,
          proposalId,
          source: "rapidproposal",
        },
      });
      if (typeof created?.id !== "string" || !created.id) {
        throw new SignWellRequestError("SignWell did not return a document ID");
      }
      const now = new Date().toISOString();
      const createdStatus = normalizeSignWellStatus(created.status, "sent");
      const createdRecipients = Array.isArray(created.recipients) ? created.recipients : [];
      const testSigningUrl = embeddedTestMode && Array.isArray(created.recipients)
        ? created.recipients.find((recipient) =>
          typeof recipient?.embedded_signing_url === "string" && recipient.embedded_signing_url
        )?.embedded_signing_url
        : null;
      const signatureRequest = {
        provider: "signwell",
        documentId: created.id,
        status: createdStatus === "created" ? "sent" : createdStatus,
        testMode: created.test_mode === true || signWell.client.testMode === true,
        ...(testSigningUrl ? { testSigningUrl } : {}),
        subject: input.subject,
        message: input.message,
        applySigningOrder: input.applySigningOrder,
        recipients: input.recipients.map((recipient, index) => {
          const id = String(index + 1);
          const providerRecipient = createdRecipients.find((item) =>
            item?.id === id || item?.email?.trim().toLowerCase() === recipient.email
          );
          const fallbackStatus = embeddedTestMode || (input.applySigningOrder && index > 0)
            ? "pending"
            : "sent";
          return {
            id,
            name: recipient.name,
            email: recipient.email,
            status: normalizeSignWellRecipientStatus(providerRecipient?.status, fallbackStatus),
          };
        }),
        sentAt: now,
        updatedAt: now,
      };
      await store.updateProposalSignature(workspaceId, proposalId, signatureRequest);
      return json(201, signatureRequest);
    }

    let current = proposal.signatureRequest;
    if (!current || current.provider !== "signwell" || typeof current.documentId !== "string") {
      return json(404, { message: "This proposal has no SignWell signature request" });
    }
    if (action === "remind" && method === "POST") {
      if (!isActiveSignatureRequest(current)) {
        return json(409, { message: "Only active signature requests can be reminded" });
      }
      await signWell.client.sendReminder(current.documentId);
      const updated = {
        ...current,
        lastReminderAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.updateProposalSignature(workspaceId, proposalId, updated);
      return json(200, updated);
    }
    if (action === "completed-pdf" && method === "POST") {
      if (current.status !== "completed") {
        const reconciled = await reconcileSignWellSignature({
          proposal,
          workspaceId,
          store,
          client: signWell.client,
          force: true,
        });
        current = reconciled.signatureRequest;
      }
      if (current.status !== "completed") {
        return json(409, { message: "The signed PDF is available after every signer completes the document" });
      }
      return json(200, {
        url: await signWell.client.getCompletedPdfUrl(current.documentId),
      });
    }
    return json(404, { message: "Not found" });
  }

  const proposalId = getEntityId(event, path, "proposals", "proposalId");
  if (proposalId) {
    if (method === "GET") {
      let proposal = await store.getProposal(workspaceId, proposalId);
      if (proposal && isActiveSignatureRequest(proposal.signatureRequest)) {
        const signWell = await getSignWell();
        proposal = await reconcileSignWellSignature({
          proposal,
          workspaceId,
          store,
          client: signWell.client,
        });
      }
      return proposal ? json(200, proposal) : json(404, { message: "Proposal not found" });
    }
    if (method === "PATCH") {
      const proposal = pickEntity(readBody(event), "id", proposalId);
      if (!proposal) return json(400, { message: "Invalid proposal" });
      try {
        const current = await store.getProposal(workspaceId, proposalId);
        if (!current) return json(404, { message: "Proposal not found" });
        // Signature state is server-managed by SignWell webhooks. Preserve it
        // when an editor saves an older browser copy of the proposal.
        const updated = { ...proposal };
        if (current.signatureRequest) updated.signatureRequest = current.signatureRequest;
        else delete updated.signatureRequest;
        return json(200, await store.putProposal(workspaceId, updated));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(404, { message: "Proposal not found" });
        throw error;
      }
    }
    if (method === "DELETE") {
      await store.deleteProposal(workspaceId, proposalId);
      return json(200, { ok: true });
    }
  }

  if (path === "/workspaces/me/proposal-templates") {
    if (method === "GET") return json(200, await store.listProposalTemplates(workspaceId));
    if (method === "POST") {
      const template = pickEntity(readBody(event), "id");
      if (!template) return json(400, { message: "Invalid proposal template" });
      try {
        return json(201, await store.createProposalTemplate(workspaceId, template));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(409, { message: "Proposal template already exists" });
        throw error;
      }
    }
  }

  const templateId = getEntityId(event, path, "proposal-templates", "templateId");
  if (templateId) {
    if (method === "GET") {
      const template = await store.getProposalTemplate(workspaceId, templateId);
      return template ? json(200, template) : json(404, { message: "Proposal template not found" });
    }
    if (method === "PATCH") {
      const template = pickEntity(readBody(event), "id", templateId);
      if (!template) return json(400, { message: "Invalid proposal template" });
      try {
        return json(200, await store.putProposalTemplate(workspaceId, template));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(404, { message: "Proposal template not found" });
        throw error;
      }
    }
    if (method === "DELETE") {
      await store.deleteProposalTemplate(workspaceId, templateId);
      return json(200, { ok: true });
    }
  }

  if (path === "/workspaces/me/parts") {
    if (method === "GET") return json(200, await store.listParts(workspaceId));
    if (method === "POST") {
      const part = pickEntity(readBody(event), "id");
      if (!part) return json(400, { message: "Invalid part" });
      try {
        return json(201, await store.createPart(workspaceId, part));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(409, { message: "Part already exists" });
        throw error;
      }
    }
  }

  if (path === "/workspaces/me/parts/bulk" && method === "POST") {
    const parts = pickEntityArray(readBody(event)?.parts, "id");
    if (!parts) return json(400, { message: "Invalid parts" });
    return json(200, await store.putParts(workspaceId, parts));
  }

  const partId = getEntityId(event, path, "parts", "partId");
  if (partId) {
    if (method === "PATCH") {
      const part = pickEntity(readBody(event), "id", partId);
      if (!part) return json(400, { message: "Invalid part" });
      try {
        return json(200, await store.putPart(workspaceId, part));
      } catch (error) {
        if (isConditionalCheckFailed(error)) return json(404, { message: "Part not found" });
        throw error;
      }
    }
    if (method === "DELETE") {
      await store.deletePart(workspaceId, partId);
      return json(200, { ok: true });
    }
  }

  if (
    (path === "/workspaces/me/proposal-assets/upload-url" ||
      path === "/workspaces/me/proposal-assets/download-url") &&
    method === "POST"
  ) {
    const body = readBody(event);
    if (!validAssetKey(body?.key)) return json(400, { message: "Invalid proposal asset key" });
    const signer = await getAssetSigner();
    if (path.endsWith("/upload-url")) {
      if (body.contentType !== undefined && body.contentType !== "application/pdf") {
        return json(400, { message: "Only PDF proposal assets are supported" });
      }
      return json(200, {
        url: await signer.createUploadUrl(workspaceId, body.key, "application/pdf"),
        key: body.key,
      });
    }
    return json(200, { url: await signer.createDownloadUrl(workspaceId, body.key) });
  }

  return json(404, { message: "Not found" });
}

function decodeEntityId(value) {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return ENTITY_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

async function handleInboundLookup(event, {
  getStore,
  getProviders,
  getRetellApiKey,
  verifySignature,
  toolBaseUrl,
}) {
  const rawBody = readRawBody(event);
  const signature = readHeader(event?.headers, "x-retell-signature");
  if (rawBody === null || !signature) {
    return json(401, { message: "Unauthorized" });
  }
  const apiKey = await getRetellApiKey();
  if (!await verifySignature(rawBody, apiKey, signature)) {
    return json(401, { message: "Unauthorized" });
  }
  let input;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }
  if (
    input?.event !== "call_inbound" ||
    !input.call_inbound ||
    typeof input.call_inbound !== "object" ||
    Array.isArray(input.call_inbound)
  ) {
    return json(400, { message: "A call_inbound payload is required" });
  }
  const did = input.call_inbound.to_number;
  if (!isE164(did)) {
    return json(400, { message: "An E.164 destination DID is required" });
  }

  const store = await getStore();
  const phoneNumber = await store.getPhoneNumberByDid(did);
  if (!phoneNumber) return json(404, { message: "Phone number not found" });
  const [agent, profile] = await Promise.all([
    store.getAgent(phoneNumber.workspaceId, phoneNumber.agentId),
    store.getProfile(phoneNumber.workspaceId),
  ]);
  if (!agent || !profile) {
    return json(404, { message: "Receptionist configuration not found" });
  }
  if (agent.status !== "active" || !agent.retellAgentId) {
    return json(200, { call_inbound: { reject: true } });
  }
  return json(200, {
    call_inbound: {
      override_agent_id: agent.retellAgentId,
      dynamic_variables: {
        workspaceId: phoneNumber.workspaceId,
        agentId: phoneNumber.agentId,
        currentTime: formatCurrentTime(profile.timezone),
        timezone: typeof profile.timezone === "string" ? profile.timezone : "UTC",
      },
      metadata: {
        workspaceId: phoneNumber.workspaceId,
        agentId: phoneNumber.agentId,
      },
    },
  });
}

async function syncReceptionistRuntime({
  workspaceId,
  agentId,
  agent,
  profile,
  store,
  providers,
  toolBaseUrl,
  phoneStatus,
}) {
  let phoneNumber = await store.getPhoneNumberForAgent(workspaceId, agentId);
  if (!phoneNumber) {
    const provisioned = await providers.telnyx.ensureNumber({
      workspaceId,
      agentId,
      preferredPhone: agent?.configuration?.phone ?? profile.phone,
    });
    phoneNumber = {
      workspaceId,
      phoneNumberId: `phone-${agentId}`,
      agentId,
      ...provisioned,
      status: phoneStatus,
      createdAt: new Date().toISOString(),
    };
  }
  const voiceId = resolveConfiguredVoiceId(
    agent?.configuration,
    providers.resolveVoiceId,
  );
  const config = buildReceptionistConfig({
    workspaceId,
    agent,
    profile,
    toolBaseUrl,
    voiceId,
  });
  const synced = await providers.retell.upsertAgent({
    retellAgentId: agent.retellAgentId,
    symanticAgentId: agentId,
    agentName: agent?.configuration?.name ?? agent.name,
    greeting: agent?.configuration?.greeting ?? "",
    config,
  });
  try {
    await store.updateAgentRuntime(
      workspaceId,
      agentId,
      { retellAgentId: synced.retellAgentId },
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) throw error;
    console.error("Failed to persist retellAgentId after Retell upsert", error);
  }
  if (!phoneNumber.retellPhoneNumberId) {
    const imported = await providers.retell.importPhoneNumber({
      phoneNumber: phoneNumber.telnyxPhoneNumber,
      retellAgentId: synced.retellAgentId,
      nickname: `Symantic ${workspaceId} ${agentId}`,
      inboundWebhookUrl:
        `${String(toolBaseUrl).replace(/\/+$/, "")}/retell/inbound-lookup`,
    });
    phoneNumber = { ...phoneNumber, ...imported };
  }
  phoneNumber = {
    ...phoneNumber,
    status: phoneStatus,
    updatedAt: new Date().toISOString(),
  };
  await store.putPhoneNumber(phoneNumber);
  return {
    phoneNumber,
    retellAgentId: synced.retellAgentId,
  };
}

function launchReadinessIssue(agent, profile, calendar) {
  const requiredProfileFields = [
    "businessName",
    "businessType",
    "timezone",
    "hours",
    "ownerPhone",
    "fallbackPhone",
    "phone",
  ];
  if (
    !profile ||
    requiredProfileFields.some(
      (field) => typeof profile[field] !== "string" || !profile[field].trim(),
    )
  ) {
    return "Complete the business profile before activation";
  }
  if (
    !agent?.configuration ||
    !agent.configuration.template ||
    agent.configuration.businessConfirmed !== true ||
    !agent.configuration.name?.trim() ||
    !agent.configuration.guidance?.trim() ||
    !agent.configuration.escalation?.trim()
  ) {
    return "Complete the agent details and behavior before activation";
  }
  const phoneValues = [
    profile.phone,
    profile.ownerPhone,
    profile.fallbackPhone,
    agent?.configuration?.phone,
    ...(typeof profile.escalationContact === "string" &&
        profile.escalationContact.trim()
      ? [profile.escalationContact]
      : []),
    ...(Array.isArray(agent?.configuration?.emergencyRules)
      ? agent.configuration.emergencyRules.map(({ transferTarget }) =>
        transferTarget
      )
      : []),
  ];
  if (phoneValues.some((value) => !isValidPhone(value))) {
    return "Configure valid business, owner, fallback, and transfer phone numbers before activation";
  }
  if (
    agent?.configuration?.booking === true &&
    (
      calendar?.connectionState !== "connected" ||
      typeof calendar?.selectedCalendarId !== "string" ||
      !calendar.selectedCalendarId
    )
  ) {
    return "Connect and select a booking calendar before activation";
  }
  if (
    agent?.tested !== true ||
    typeof agent?.testedAt !== "string" ||
    Number.isNaN(Date.parse(agent.testedAt))
  ) {
    return "Run a successful current-config test before activation";
  }
  if (
    agent.configuration?.booking === true &&
    agent.configuration?.calendarSelectionId !== calendar.selectedCalendarId
  ) {
    return "Run a successful current-config test after selecting the booking calendar";
  }
  const testedAt = Date.parse(agent.testedAt);
  if (
    isTimestampAfter(profile?.updatedAt, testedAt) ||
    isTimestampAfter(calendar?.updatedAt, testedAt)
  ) {
    return "Run a successful current-config test after profile or calendar changes";
  }
  return null;
}

function sameLaunchConfiguration(left, right) {
  return JSON.stringify(canonicalLaunchConfiguration(left)) ===
    JSON.stringify(canonicalLaunchConfiguration(right));
}

function canonicalLaunchConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const {
    tested: _tested,
    testRunCount: _testRunCount,
    platformDid: _platformDid,
    completedSteps: _completedSteps,
    ...configuration
  } = value;
  return configuration;
}

function isValidPhone(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return true;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length === 10 ||
    (digits.length === 11 && digits.startsWith("1"));
}

function isTimestampAfter(value, timestamp) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed > timestamp;
}

export function verifyRetellSignature(
  rawBody,
  apiKey,
  signature,
  { now = Date.now, timeoutMs = 5 * 60_000 } = {},
) {
  if (
    typeof rawBody !== "string" ||
    typeof apiKey !== "string" ||
    !apiKey ||
    typeof signature !== "string"
  ) {
    return false;
  }
  const match = signature.match(/^v=(\d+),d=([a-f0-9]{64})$/i);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Number(now()) - timestamp) > timeoutMs
  ) {
    return false;
  }
  const expected = createHmac("sha256", apiKey)
    .update(rawBody + match[1])
    .digest();
  const provided = Buffer.from(match[2], "hex");
  return provided.length === expected.length &&
    timingSafeEqual(provided, expected);
}

function readRawBody(event) {
  if (typeof event?.body !== "string") return null;
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function isE164(value) {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

function isConditionalCheckFailed(error) {
  return error?.name === "ConditionalCheckFailedException";
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

function toAgentRecord(item) {
  if (!item) return null;
  const { workspaceId: _workspaceId, agentId, ...agent } = item;
  return { id: agentId, ...agent };
}

function toPublicAgent(item) {
  if (!item) return null;
  const {
    workspaceId: _workspaceId,
    agentId,
    retellAgentId: _retellAgentId,
    retellLlmId: _retellLlmId,
    telnyxNumberId: _telnyxNumberId,
    telnyxPhoneNumber: _telnyxPhoneNumber,
    ...agent
  } = item;
  return { id: agentId, ...agent };
}

function toPublicPhoneNumber(item) {
  return {
    id: item.phoneNumberId,
    agentId: item.agentId,
    phoneNumber: item.telnyxPhoneNumber,
    status: item.status,
  };
}

function toPublicCall(item) {
  const {
    workspaceId: _workspaceId,
    retellCallId: _retellCallId,
    recordingKey,
    recordingUrl: _recordingUrl,
    ...call
  } = item;
  return { ...call, hasRecording: Boolean(recordingKey) };
}

function toPublicCallSummary(item) {
  const {
    transcript: _transcript,
    toolLog: _toolLog,
    ...summary
  } = toPublicCall(item);
  return summary;
}

function toPublicEntity(item, keyField) {
  const { workspaceId: _workspaceId, [keyField]: id, ...value } = item;
  return { id, ...value };
}

export function createDynamoStore(client, commands, tableNames) {
  async function listRecords(tableName, keyField, workspaceId) {
    const result = await client.send(new commands.QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "workspaceId = :workspaceId",
      ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
      ConsistentRead: true,
    }));
    return (result.Items ?? []).map((item) => toPublicEntity(unmarshall(item), keyField));
  }

  async function getRecord(tableName, keyField, workspaceId, id) {
    const result = await client.send(new commands.GetItemCommand({
      TableName: tableName,
      Key: marshall({ workspaceId, [keyField]: id }),
      ConsistentRead: true,
    }));
    return result.Item ? toPublicEntity(unmarshall(result.Item), keyField) : null;
  }

  async function putRecord(tableName, keyField, workspaceId, record, conditionExpression) {
    const { id, workspaceId: _workspaceId, ...value } = record;
    await client.send(new commands.PutItemCommand({
      TableName: tableName,
      Item: marshall({ workspaceId, [keyField]: id, ...value }),
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
    }));
    return record;
  }

  async function deleteRecord(tableName, keyField, workspaceId, id) {
    await client.send(new commands.DeleteItemCommand({
      TableName: tableName,
      Key: marshall({ workspaceId, [keyField]: id }),
    }));
  }

  return {
    async getWorkspace(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async listWorkspaces() {
      const workspaces = [];
      let exclusiveStartKey;
      do {
        const result = await client.send(new commands.ScanCommand({
          TableName: tableNames.workspaces,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        workspaces.push(...(result.Items ?? []).map((item) => unmarshall(item)));
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return workspaces;
    },

    async putWorkspace(workspace) {
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.workspaces,
        Item: marshall(workspace),
      }));
      return workspace;
    },

    async createWorkspaceBundle({ workspace, membership, template }) {
      const { id: templateId, ...templateValue } = template;
      await client.send(new commands.TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableNames.workspaces,
              Item: marshall(workspace),
              ConditionExpression: "attribute_not_exists(workspaceId)",
            },
          },
          {
            Put: {
              TableName: tableNames.workspaceMemberships,
              Item: marshall(membership),
              ConditionExpression: "attribute_not_exists(userId)",
            },
          },
          {
            Put: {
              TableName: tableNames.proposalTemplates,
              Item: marshall({
                workspaceId: workspace.workspaceId,
                templateId,
                ...templateValue,
              }),
              ConditionExpression: "attribute_not_exists(templateId)",
            },
          },
        ],
      }));
      return { workspace, membership, template };
    },

    async getMembership(userId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.workspaceMemberships,
        Key: marshall({ userId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async listMemberships(workspaceId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.workspaceMemberships,
        IndexName: "workspaceId-index",
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
      }));
      return (result.Items ?? [])
        .map((item) => unmarshall(item))
        .sort((left, right) => String(left.email).localeCompare(String(right.email)));
    },

    async putMembership(membership) {
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.workspaceMemberships,
        Item: marshall(membership, { removeUndefinedValues: true }),
      }));
      return membership;
    },

    async deleteMembership(userId) {
      await client.send(new commands.DeleteItemCommand({
        TableName: tableNames.workspaceMemberships,
        Key: marshall({ userId }),
      }));
    },

    async ensureWorkspace(workspaceId) {
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET createdAt = if_not_exists(createdAt, :createdAt)",
        ExpressionAttributeValues: marshall({ ":createdAt": new Date().toISOString() }),
      }));
    },

    async getProfile(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.businessProfiles,
        Key: marshall({ workspaceId }),
        ConsistentRead: true,
      }));
      if (!result.Item) return null;
      const { workspaceId: _workspaceId, ...profile } = unmarshall(result.Item);
      return profile;
    },

    async putProfile(workspaceId, profile) {
      const updatedAt = new Date().toISOString();
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.businessProfiles,
        Item: marshall({ workspaceId, ...profile, updatedAt }),
      }));
      return profile;
    },

    async listCalls(workspaceId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.calls,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ConsistentRead: true,
      }));
      return (result.Items ?? [])
        .map((item) => unmarshall(item))
        .sort((left, right) => callTimestamp(right) - callTimestamp(left));
    },

    async getCall(workspaceId, callId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.calls,
        Key: marshall({ workspaceId, callId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async listAgents(workspaceId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.agents,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ConsistentRead: true,
      }));
      return (result.Items ?? []).map((item) => toPublicAgent(unmarshall(item)));
    },

    async getAgent(workspaceId, agentId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        ConsistentRead: true,
      }));
      return result.Item ? toAgentRecord(unmarshall(result.Item)) : null;
    },

    async createAgent(workspaceId, agentId, agent) {
      const { id: _id, ...record } = agent;
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.agents,
        Item: marshall({ workspaceId, agentId, ...record }),
        ConditionExpression: "attribute_not_exists(agentId)",
      }));
      return agent;
    },

    async putAgent(
      workspaceId,
      agentId,
      agent,
      { invalidateTest = false } = {},
    ) {
      const { id: _id, ...record } = agent;
      if (invalidateTest) {
        record.tested = false;
        record.updatedAt = new Date().toISOString();
      }
      const entries = Object.entries(record)
        .filter(([, value]) => value !== undefined);
      const names = Object.fromEntries(
        entries.map(([field], index) => [`#field${index}`, field]),
      );
      const values = Object.fromEntries(
        entries.map(([, value], index) => [`:value${index}`, value]),
      );
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        UpdateExpression: `SET ${
          entries.map(
            (_entry, index) => `#field${index} = :value${index}`,
          ).join(", ")
        }${invalidateTest ? " REMOVE #testedAt, #testCallId" : ""}`,
        ConditionExpression: "attribute_exists(agentId)",
        ExpressionAttributeNames: invalidateTest
          ? {
            ...names,
            "#testedAt": "testedAt",
            "#testCallId": "testCallId",
          }
          : names,
        ExpressionAttributeValues: marshall(values),
      }));
      return {
        ...agent,
        ...(invalidateTest ? { tested: false } : {}),
      };
    },

    async updateAgentRuntime(workspaceId, agentId, updates) {
      const entries = Object.entries(updates)
        .filter(([, value]) => value !== undefined);
      const names = Object.fromEntries(
        entries.map(([field], index) => [`#field${index}`, field]),
      );
      const values = Object.fromEntries(
        entries.map(([, value], index) => [`:value${index}`, value]),
      );
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        UpdateExpression: `SET ${
          entries.map(
            (_entry, index) => `#field${index} = :value${index}`,
          ).join(", ")
        }`,
        ConditionExpression: "attribute_exists(agentId)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
        ReturnValues: "ALL_NEW",
      }));
      return toAgentRecord(unmarshall(result.Attributes));
    },

    async getPhoneNumberForAgent(workspaceId, agentId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.phoneNumbers,
        Key: marshall({
          workspaceId,
          phoneNumberId: `phone-${agentId}`,
        }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async getCalendarConnection(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.calendarConnections,
        Key: marshall({ workspaceId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async listProposals(workspaceId) {
      const records = await listRecords(tableNames.proposals, "proposalId", workspaceId);
      return records.sort((left, right) => Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? ""));
    },

    getProposal(workspaceId, proposalId) {
      return getRecord(tableNames.proposals, "proposalId", workspaceId, proposalId);
    },

    createProposal(workspaceId, proposal) {
      return putRecord(
        tableNames.proposals,
        "proposalId",
        workspaceId,
        proposal,
        "attribute_not_exists(proposalId)",
      );
    },

    putProposal(workspaceId, proposal) {
      return putRecord(
        tableNames.proposals,
        "proposalId",
        workspaceId,
        proposal,
        "attribute_exists(proposalId)",
      );
    },

    async updateProposalSignature(workspaceId, proposalId, signatureRequest) {
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.proposals,
        Key: marshall({ workspaceId, proposalId }),
        UpdateExpression: "SET #signatureRequest = :signatureRequest",
        ConditionExpression: "attribute_exists(proposalId)",
        ExpressionAttributeNames: { "#signatureRequest": "signatureRequest" },
        ExpressionAttributeValues: marshall({ ":signatureRequest": signatureRequest }),
      }));
      return signatureRequest;
    },

    deleteProposal(workspaceId, proposalId) {
      return deleteRecord(tableNames.proposals, "proposalId", workspaceId, proposalId);
    },

    async listProposalTemplates(workspaceId) {
      const records = await listRecords(
        tableNames.proposalTemplates,
        "templateId",
        workspaceId,
      );
      return records.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
    },

    getProposalTemplate(workspaceId, templateId) {
      return getRecord(
        tableNames.proposalTemplates,
        "templateId",
        workspaceId,
        templateId,
      );
    },

    createProposalTemplate(workspaceId, template) {
      return putRecord(
        tableNames.proposalTemplates,
        "templateId",
        workspaceId,
        template,
        "attribute_not_exists(templateId)",
      );
    },

    putProposalTemplate(workspaceId, template) {
      return putRecord(
        tableNames.proposalTemplates,
        "templateId",
        workspaceId,
        template,
        "attribute_exists(templateId)",
      );
    },

    deleteProposalTemplate(workspaceId, templateId) {
      return deleteRecord(
        tableNames.proposalTemplates,
        "templateId",
        workspaceId,
        templateId,
      );
    },

    listParts(workspaceId) {
      return listRecords(tableNames.proposalParts, "partId", workspaceId);
    },

    createPart(workspaceId, part) {
      return putRecord(
        tableNames.proposalParts,
        "partId",
        workspaceId,
        part,
        "attribute_not_exists(partId)",
      );
    },

    putPart(workspaceId, part) {
      return putRecord(
        tableNames.proposalParts,
        "partId",
        workspaceId,
        part,
        "attribute_exists(partId)",
      );
    },

    async putParts(workspaceId, parts) {
      for (const part of parts) {
        await putRecord(tableNames.proposalParts, "partId", workspaceId, part);
      }
      return parts;
    },

    deletePart(workspaceId, partId) {
      return deleteRecord(tableNames.proposalParts, "partId", workspaceId, partId);
    },

    async putPhoneNumber(record) {
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.phoneNumbers,
        Item: marshall(record),
      }));
      return record;
    },

    async getPhoneNumberByDid(telnyxPhoneNumber) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.phoneNumbers,
        IndexName: "telnyxPhoneNumber-index",
        KeyConditionExpression: "telnyxPhoneNumber = :phoneNumber",
        ExpressionAttributeValues: marshall({
          ":phoneNumber": telnyxPhoneNumber,
        }),
        Limit: 1,
      }));
      return result.Items?.[0] ? unmarshall(result.Items[0]) : null;
    },
  };
}

let storePromise;

async function getDefaultStore() {
  storePromise ??= import("@aws-sdk/client-dynamodb").then((commands) => {
    const tableNames = {
      workspaces: process.env.WORKSPACES_TABLE,
      businessProfiles: process.env.BUSINESS_PROFILES_TABLE,
      agents: process.env.AGENTS_TABLE,
      phoneNumbers: process.env.PHONE_NUMBERS_TABLE,
      calendarConnections: process.env.CALENDAR_CONNECTIONS_TABLE,
      calls: process.env.CALLS_TABLE,
      proposals: process.env.PROPOSALS_TABLE,
      proposalParts: process.env.PROPOSAL_PARTS_TABLE,
      proposalTemplates: process.env.PROPOSAL_TEMPLATES_TABLE,
      workspaceMemberships: process.env.WORKSPACE_MEMBERSHIPS_TABLE,
    };
    if (Object.values(tableNames).some((value) => !value)) {
      throw new Error("BFF DynamoDB table environment variables are required");
    }
    return createDynamoStore(new commands.DynamoDBClient({}), commands, tableNames);
  });
  return storePromise;
}

let userDirectoryPromise;

async function getDefaultUserDirectory() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) throw new Error("COGNITO_USER_POOL_ID is required");
  userDirectoryPromise ??= import("@aws-sdk/client-cognito-identity-provider")
    .then((commands) => createCognitoDirectory(
      new commands.CognitoIdentityProviderClient({}),
      commands,
      userPoolId,
    ));
  return userDirectoryPromise;
}

export function createCognitoDirectory(client, commands, userPoolId) {
  const managedGroups = ["super-admin", "company-admin", "quotation-builder"];

  async function findUserByEmail(email) {
    let paginationToken;
    do {
      const result = await client.send(new commands.ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: 60,
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      }));
      const existing = (result.Users ?? []).find((user) =>
        user.Attributes?.some((attribute) =>
          attribute.Name === "email" && attribute.Value?.toLowerCase() === email.toLowerCase()
        )
      );
      if (existing) return existing;
      paginationToken = result.PaginationToken;
    } while (paginationToken);
    return null;
  }

  return {
    async createUser({ email, name, temporaryPassword }) {
      if (await findUserByEmail(email)) {
        const error = new Error("A user with that email already exists");
        error.name = "UsernameExistsException";
        throw error;
      }
      const attributes = [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
        ...(name ? [{ Name: "name", Value: name }] : []),
      ];
      const result = await client.send(new commands.AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        TemporaryPassword: temporaryPassword,
        MessageAction: "SUPPRESS",
        UserAttributes: attributes,
      }));
      const userId = result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
      const username = result.User?.Username;
      if (!userId || !username) throw new Error("Cognito did not return the created user identity");
      return { userId, username };
    },

    async setRole(username, role) {
      const current = await client.send(new commands.AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }));
      for (const group of current.Groups ?? []) {
        if (managedGroups.includes(group.GroupName) && group.GroupName !== role) {
          await client.send(new commands.AdminRemoveUserFromGroupCommand({
            UserPoolId: userPoolId,
            Username: username,
            GroupName: group.GroupName,
          }));
        }
      }
      await client.send(new commands.AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: role,
      }));
    },

    async getRoles(username) {
      const current = await client.send(new commands.AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }));
      return (current.Groups ?? [])
        .map((group) => group.GroupName)
        .filter((group) => typeof group === "string" && managedGroups.includes(group));
    },

    async deleteUser(username) {
      await client.send(new commands.AdminDeleteUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }));
    },
  };
}

let assetSignerPromise;

async function getDefaultAssetSigner() {
  const bucket = process.env.PROPOSAL_ASSETS_BUCKET;
  if (!bucket) throw new Error("PROPOSAL_ASSETS_BUCKET is required");
  assetSignerPromise ??= Promise.resolve(createS3AssetSigner({
    bucket,
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  }));
  return assetSignerPromise;
}

let recordingSignerPromise;
async function getDefaultRecordingSigner() {
  const bucket = process.env.CALL_ARTIFACTS_BUCKET;
  if (!bucket) throw new Error("CALL_ARTIFACTS_BUCKET is required");
  recordingSignerPromise ??= Promise.resolve(createS3AssetSigner({
    bucket,
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  }));
  return recordingSignerPromise;
}

export function createS3AssetSigner({ bucket, region, credentials, now = () => new Date() }) {
  if (!bucket || !region || !credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("S3 presigning requires a bucket, region, and AWS credentials");
  }
  const objectKey = (workspaceId, key) => `workspaces/${workspaceId}/${key}`;
  return {
    createUploadUrl(workspaceId, key, contentType) {
      return createPresignedS3Url({
        method: "PUT",
        bucket,
        region,
        key: objectKey(workspaceId, key),
        credentials,
        contentType,
        now: now(),
      });
    },
    createDownloadUrl(workspaceId, key) {
      return createPresignedS3Url({
        method: "GET",
        bucket,
        region,
        key: objectKey(workspaceId, key),
        credentials,
        now: now(),
      });
    },
    createImageUpload(workspaceId, key, contentType, maxBytes) {
      return createPresignedS3Post({
        bucket,
        region,
        key: objectKey(workspaceId, key),
        credentials,
        contentType,
        maxBytes,
        now: now(),
      });
    },
  };
}

function createPresignedS3Post({
  bucket,
  region,
  key,
  credentials,
  contentType,
  maxBytes,
  now,
  expiresIn = 900,
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const credential = `${credentials.accessKeyId}/${scope}`;
  const expiration = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const fields = {
    key,
    "Content-Type": contentType,
    success_action_status: "204",
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-credential": credential,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const conditions = [
    { bucket },
    { key },
    { "Content-Type": contentType },
    ["content-length-range", 1, maxBytes],
    { success_action_status: "204" },
    { "x-amz-algorithm": fields["x-amz-algorithm"] },
    { "x-amz-credential": credential },
    { "x-amz-date": amzDate },
    ...(credentials.sessionToken
      ? [{ "x-amz-security-token": credentials.sessionToken }]
      : []),
  ];
  const policy = Buffer.from(JSON.stringify({ expiration, conditions })).toString("base64");
  const dateKey = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  return {
    url: `https://${bucket}.s3.${region}.amazonaws.com`,
    fields: {
      ...fields,
      policy,
      "x-amz-signature": createHmac("sha256", signingKey).update(policy).digest("hex"),
    },
  };
}

function createPresignedS3Url({
  method,
  bucket,
  region,
  key,
  credentials,
  contentType,
  now,
  expiresIn = 900,
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const signedHeaders = contentType ? "content-type;host" : "host";
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
    ...(credentials.sessionToken ? { "X-Amz-Security-Token": credentials.sessionToken } : {}),
  };
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [awsPercentEncode(name), awsPercentEncode(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalUri = `/${key.split("/").map(awsPercentEncode).join("/")}`;
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\n`
    : `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function awsPercentEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function callTimestamp(call) {
  const value = Date.parse(call?.startedAt ?? call?.createdAt ?? "");
  return Number.isNaN(value) ? 0 : value;
}

const secretPromises = new Map();

async function getProviderSecret(secretArn, provider) {
  if (!secretArn) throw new Error(`${provider} secret ARN is required`);
  if (!secretPromises.has(secretArn)) {
    secretPromises.set(
      secretArn,
      import("@aws-sdk/client-secrets-manager").then(async (commands) => {
        const client = new commands.SecretsManagerClient({});
        const result = await client.send(new commands.GetSecretValueCommand({
          SecretId: secretArn,
        }));
        if (!result.SecretString) {
          throw new Error(`${provider} secret string is empty`);
        }
        try {
          return JSON.parse(result.SecretString);
        } catch {
          throw new Error(`${provider} secret must contain JSON`);
        }
      }),
    );
  }
  return secretPromises.get(secretArn);
}

function readApiKey(secret, provider) {
  const apiKey = secret?.apiKey ??
    secret?.api_key ??
    secret?.[`${provider.toLowerCase()}ApiKey`];
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error(`${provider} secret must contain apiKey`);
  }
  return apiKey;
}

async function getDefaultRetellApiKey() {
  const secret = await getProviderSecret(
    process.env.RETELL_SECRET_ARN,
    "Retell",
  );
  return readApiKey(secret, "Retell");
}

async function getDefaultSignWell() {
  // Read this small configuration for every SignWell operation so key rotations
  // and the test/live safety switch take effect immediately in warm Lambdas.
  // SignWell operations are infrequent compared with ordinary API traffic.
  const secret = await getProviderSecret(
    process.env.SIGNWELL_SECRET_ARN,
    "SignWell",
  );
  const webhookId = secret?.webhookId ?? secret?.webhook_id;
  if (typeof webhookId !== "string" || !webhookId) {
    throw new Error("SignWell secret must contain webhookId");
  }
  return {
    webhookId,
    client: createSignWellClient({
      apiKey: readApiKey(secret, "SignWell"),
      testMode: secret.testMode !== false,
    }),
  };
}

let providersPromise;
async function getDefaultProviders() {
  providersPromise ??= Promise.all([
    getProviderSecret(process.env.RETELL_SECRET_ARN, "Retell"),
    getProviderSecret(process.env.TELNYX_SECRET_ARN, "Telnyx"),
  ]).then(([retellSecret, telnyxSecret]) => ({
    retell: createRetellClient({
      apiKey: readApiKey(retellSecret, "Retell"),
      terminationUri: telnyxSecret.terminationUri ??
        telnyxSecret.termination_uri ??
        telnyxSecret.telnyxTerminationUri,
      sipTrunkAuthUsername: telnyxSecret.sipTrunkAuthUsername ??
        telnyxSecret.sip_trunk_auth_username ??
        telnyxSecret.username,
      sipTrunkAuthPassword: telnyxSecret.sipTrunkAuthPassword ??
        telnyxSecret.sip_trunk_auth_password ??
        telnyxSecret.password,
      transport: telnyxSecret.transport ?? "TCP",
    }),
    telnyx: createTelnyxClient({
      apiKey: readApiKey(telnyxSecret, "Telnyx"),
      connectionId: telnyxSecret.connectionId ??
        telnyxSecret.connection_id ??
        telnyxSecret.telnyxConnectionId,
    }),
    resolveVoiceId: (requestedVoice) =>
      resolveRetellVoiceId(requestedVoice, {
        defaultVoiceId: retellSecret.defaultVoiceId ??
          retellSecret.default_voice_id,
        voiceIds: retellSecret.voiceIds ?? retellSecret.voice_ids,
      }),
  }));
  return providersPromise;
}

export const handler = createHandler();
