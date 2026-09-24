// An in-memory Retell that enforces the versioning rules the real API does,
// so tests fail the way production would. The old per-test fakes accepted
// any request, which is how "Cannot update response engine after agent
// versions have been created" reached production unnoticed.
//
// Rules modelled (confirmed against the live API or its docs):
// - A published agent or LLM version is read-only.
// - Updates without ?version= target the latest version.
// - response_engine can't be sent once an agent has a published version.
// - create-agent-version copies a base version (and its LLM) into a new draft.
// - A phone number answers with the version its inbound agent_version names:
//   a number, "latest_published", or "latest"/absent for the newest version.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function retellError(status, message) {
  return new Response(JSON.stringify({ status: "error", message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ok(body, status = 200) {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createFakeRetell() {
  const agents = new Map(); // agent_id -> [versions]
  const llms = new Map(); // llm_id -> [versions]
  const phones = new Map(); // phone_number -> record
  const requests = [];
  let nextId = 1;

  const latest = (versions) => versions[versions.length - 1];
  const pick = (versions, version) =>
    version === null ? latest(versions) : versions.find((entry) => entry.version === version);

  function newLlm(body) {
    const llmId = `llm_${nextId++}`;
    llms.set(llmId, [{ ...clone(body), llm_id: llmId, version: 0, is_published: false }]);
    return llmId;
  }

  function newAgent(body) {
    const agentId = `agent_${nextId++}`;
    agents.set(agentId, [{
      ...clone(body),
      agent_id: agentId,
      version: 0,
      is_published: false,
      response_engine: { ...body.response_engine, version: 0 },
    }]);
    return agentId;
  }

  function resolveVersion(agentId, reference) {
    const versions = agents.get(agentId) ?? [];
    if (Number.isInteger(reference)) return versions.find((entry) => entry.version === reference);
    if (reference === "latest_published") {
      return [...versions].reverse().find((entry) => entry.is_published);
    }
    return latest(versions);
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, search: url.search, body: clone(body) });
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "v2") parts.shift();
    const [endpoint, rawId] = parts;
    const id = rawId ? decodeURIComponent(rawId) : undefined;
    const versionParam = url.searchParams.has("version") ? Number(url.searchParams.get("version")) : null;

    switch (`${method} ${endpoint}`) {
      case "POST create-retell-llm":
        return ok({ llm_id: newLlm(body) }, 201);
      case "POST create-agent":
        return ok({ agent_id: newAgent(body) }, 201);
      case "GET list-agents":
      case "POST list-agents":
        return ok([...agents.values()].map((versions) => clone(latest(versions))));
      case "GET get-agent": {
        const versions = agents.get(id);
        const found = versions && pick(versions, versionParam);
        return found ? ok(clone(found)) : retellError(404, "Agent not found");
      }
      case "GET get-retell-llm": {
        const versions = llms.get(id);
        const found = versions && pick(versions, versionParam);
        return found ? ok(clone(found)) : retellError(404, "LLM not found");
      }
      case "GET list-agent-versions": {
        const versions = agents.get(id);
        if (!versions) return retellError(404, "Agent not found");
        const items = [...versions].reverse().map(({ version, is_published, base_version, version_title }) =>
          ({ version, is_published, base_version, version_title }));
        return ok({ items, has_more: false });
      }
      case "POST create-agent-version": {
        const versions = agents.get(id);
        const base = versions?.find((entry) => entry.version === body?.base_version);
        if (!base) return retellError(404, "Base version not found");
        const baseLlmVersions = llms.get(base.response_engine.llm_id);
        const baseLlm = baseLlmVersions.find((entry) => entry.version === base.response_engine.version);
        const llmVersion = latest(baseLlmVersions).version + 1;
        baseLlmVersions.push({ ...clone(baseLlm), version: llmVersion, is_published: false });
        const draft = {
          ...clone(base),
          version: latest(versions).version + 1,
          base_version: base.version,
          is_published: false,
          version_title: null,
          response_engine: { ...base.response_engine, version: llmVersion },
        };
        versions.push(draft);
        return ok(clone(draft), 201);
      }
      case "PATCH update-agent": {
        const versions = agents.get(id);
        const target = versions && pick(versions, versionParam);
        if (!target) return retellError(404, "Agent not found");
        if (body?.response_engine && versions.some((entry) => entry.is_published)) {
          return retellError(400, "Cannot update response engine after agent versions have been created");
        }
        if (target.is_published) return retellError(400, "Cannot update a published agent version");
        Object.assign(target, clone(body));
        return ok(clone(target));
      }
      case "PATCH update-retell-llm": {
        const versions = llms.get(id);
        const target = versions && pick(versions, versionParam);
        if (!target) return retellError(404, "LLM not found");
        if (target.is_published) return retellError(400, "Cannot update a published LLM version");
        Object.assign(target, clone(body));
        return ok(clone(target));
      }
      case "POST publish-agent-version": {
        const versions = agents.get(id);
        const target = versions?.find((entry) => entry.version === body?.version);
        if (!target) return retellError(404, "Version not found");
        if (target.is_published) return retellError(400, "Version is already published");
        target.is_published = true;
        target.version_title = body.version_title ?? null;
        const llmVersion = llms.get(target.response_engine.llm_id)
          .find((entry) => entry.version === target.response_engine.version);
        if (llmVersion) llmVersion.is_published = true;
        return ok({ message: "Agent version published successfully" });
      }
      case "GET list-phone-numbers":
        return ok([...phones.values()].map(clone));
      case "POST import-phone-number": {
        phones.set(body.phone_number, clone(body));
        return ok({ phone_number: body.phone_number }, 201);
      }
      case "PATCH update-phone-number": {
        const record = phones.get(id);
        if (!record) return retellError(404, "Phone number not found");
        Object.assign(record, clone(body));
        return ok(clone(record));
      }
      default:
        return retellError(404, `Fake Retell has no route for ${method} ${url.pathname}`);
    }
  }

  return {
    fetchImpl,
    requests,

    // Set up an agent the way the Retell dashboard can leave one: any mix
    // of published versions and a trailing draft, each with its own LLM
    // version. Returns the agent and LLM ids.
    seedAgent({ versions: seeds }) {
      const llmId = `llm_${nextId++}`;
      const agentId = `agent_${nextId++}`;
      llms.set(llmId, seeds.map((seed, index) => ({
        ...clone(seed.llm), llm_id: llmId, version: index, is_published: seed.published,
      })));
      agents.set(agentId, seeds.map((seed, index) => ({
        ...clone(seed.agent),
        agent_id: agentId,
        version: index,
        is_published: seed.published,
        response_engine: { type: "retell-llm", llm_id: llmId, version: index },
      })));
      return { agentId, llmId };
    },

    seedPhone(phoneNumber, agentId, agentVersion) {
      const entry = { agent_id: agentId, weight: 1, ...(agentVersion === undefined ? {} : { agent_version: agentVersion }) };
      phones.set(phoneNumber, { phone_number: phoneNumber, inbound_agents: [entry], outbound_agents: [{ ...entry }] });
    },

    // Something done in the Retell dashboard, outside the app.
    dashboardEditDraft(agentId, { agent = {}, llm = {} }) {
      const draft = latest(agents.get(agentId));
      if (draft.is_published) throw new Error("dashboard edit needs a draft");
      Object.assign(draft, clone(agent));
      const llmVersion = llms.get(draft.response_engine.llm_id).find((entry) => entry.version === draft.response_engine.version);
      Object.assign(llmVersion, clone(llm));
    },
    dashboardPublishLatest(agentId) {
      const draft = latest(agents.get(agentId));
      draft.is_published = true;
      llms.get(draft.response_engine.llm_id).find((entry) => entry.version === draft.response_engine.version).is_published = true;
    },

    versions(agentId) {
      return clone(agents.get(agentId));
    },

    // What a caller dialling this number actually talks to.
    answering(phoneNumber) {
      const record = phones.get(phoneNumber);
      const entry = record?.inbound_agents?.[0];
      if (!entry) return null;
      const agent = resolveVersion(entry.agent_id, entry.agent_version);
      if (!agent) return null;
      const llm = llms.get(agent.response_engine.llm_id).find((version) => version.version === agent.response_engine.version);
      return { agent: clone(agent), llm: clone(llm), binding: entry.agent_version ?? "latest" };
    },
  };
}
