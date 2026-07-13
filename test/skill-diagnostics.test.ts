import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, ProceduralMemory } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS_LIMIT",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listScopes: string[] = [];
  const setCalls: Array<{ scope: string; key: string }> = [];
  return {
    listScopes,
    setCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      setCalls.push({ scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listScopes.push(scope);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(
  body?: unknown,
  query_params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return { body, headers, query_params };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_1",
    name: "Run focused validation before release",
    triggerCondition: "Before releasing AgentMemory changes",
    steps: ["Run focused tests", "Run the skills consistency check"],
    expectedOutcome: "Regression checks are complete.",
    antiPatterns: ["Skipping focused tests"],
    project: "/repo/a",
    agentId: "agent_a",
    files: ["src/functions/observe.ts"],
    concepts: ["release", "validation"],
    confidence: 0.9,
    strength: 0.8,
    usageCount: 4,
    successCount: 4,
    failureCount: 0,
    sourceProceduralMemoryIds: ["proc_1"],
    sourceCandidateIds: ["dq_1"],
    sourceObservationIds: ["obs_1"],
    sourceSessionIds: ["ses_1"],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
    status: "active",
    version: 1,
    ...overrides,
  };
}

async function seedSkills(kv: ReturnType<typeof mockKV>): Promise<void> {
  await kv.set(KV.skills, "skill_1", skill());
  await kv.set(KV.skills, "skill_2", skill({
    id: "skill_2",
    name: "Retired release validation",
    project: "/repo/a",
    agentId: "agent_b",
    files: ["src/functions/remember.ts"],
    concepts: ["release"],
    status: "retired",
    updatedAt: "2026-07-10T00:02:00.000Z",
    version: 2,
  }));
  await kv.set(KV.skills, "skill_3", skill({
    id: "skill_3",
    project: "/repo/b",
    agentId: "agent_a",
    files: ["src/functions/context.ts"],
    concepts: ["context"],
    status: "superseded",
    updatedAt: "2026-07-10T00:03:00.000Z",
    version: 3,
  }));
}

describe("AgentSkill read-only diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  it("adds a dedicated AgentSkill KV scope without changing ProceduralMemory", () => {
    expect(KV.skills).toBe("mem:skills");

    const procedure: ProceduralMemory = {
      id: "proc_1",
      name: "Existing procedural row",
      steps: ["Preserve the current storage shape"],
      triggerCondition: "Existing workflow",
      frequency: 1,
      sourceSessionIds: [],
      strength: 0.5,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };

    expect(procedure).not.toHaveProperty("antiPatterns");
    expect(procedure).not.toHaveProperty("sourceCandidateIds");
  });

  it("returns a clear disabled REST diagnostic without reading the skill scope", async () => {
    registerApiTriggers(sdk as never, kv as never);
    await seedSkills(kv);

    const result = await sdk.getFunction("api::skills")!(makeReq());

    expect(result).toMatchObject({
      status_code: 503,
      body: {
        error: "Agent skill diagnostics not enabled",
        flag: "AGENTMEMORY_SKILL_DIAGNOSTICS",
      },
    });
    expect(kv.listScopes).not.toContain(KV.skills);
  });

  it("does not read the REST scope when diagnostics are explicitly disabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "false";
    registerApiTriggers(sdk as never, kv as never);
    await seedSkills(kv);

    const result = await sdk.getFunction("api::skills")!(makeReq());

    expect(result).toMatchObject({
      status_code: 503,
      body: { flag: "AGENTMEMORY_SKILL_DIAGNOSTICS" },
    });
    expect(kv.listScopes).not.toContain(KV.skills);
  });

  it("returns empty read-only diagnostics when enabled and no rows exist", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    registerApiTriggers(sdk as never, kv as never);

    const result = await sdk.getFunction("api::skills")!(makeReq());

    expect(result).toMatchObject({
      status_code: 200,
      body: { success: true, count: 0, skills: [] },
    });
  });

  it("filters REST diagnostics and honors the requested limit without mutation", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    registerApiTriggers(sdk as never, kv as never);
    await seedSkills(kv);
    const before = JSON.parse(JSON.stringify(await kv.list<AgentSkill>(KV.skills)));

    const filtered = await sdk.getFunction("api::skills")!(makeReq(undefined, {
      status: "active",
      project: "/repo/a",
      agentId: "agent_a",
      concept: "validation",
      file: "src/functions/observe.ts",
      limit: "1",
    }));

    expect(filtered.body).toMatchObject({ success: true, count: 1 });
    expect(filtered.body.skills.map((entry: AgentSkill) => entry.id)).toEqual(["skill_1"]);
    const after = JSON.parse(JSON.stringify(await kv.list<AgentSkill>(KV.skills)));
    expect(after).toEqual(before);
    expect(kv.setCalls).toHaveLength(3);

    const limited = await sdk.getFunction("api::skills")!(makeReq(undefined, { limit: "1" }));
    expect(limited.body.skills.map((entry: AgentSkill) => entry.id)).toEqual(["skill_3"]);

    const clamped = await sdk.getFunction("api::skills")!(makeReq(undefined, { limit: "0" }));
    expect(clamped.body.skills.map((entry: AgentSkill) => entry.id)).toEqual(["skill_3"]);
  });

  it("respects REST auth before checking the skills flag", async () => {
    registerApiTriggers(sdk as never, kv as never, "secret");

    await expect(sdk.getFunction("api::skills")!(makeReq())).resolves.toMatchObject({
      status_code: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns compact filtered MCP diagnostics", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    registerMcpEndpoints(sdk as never, kv as never);
    await seedSkills(kv);
    const before = JSON.parse(JSON.stringify(await kv.list<AgentSkill>(KV.skills)));

    const result = await sdk.getFunction("mcp::tools::call")!(makeReq({
      name: "memory_skills",
      arguments: {
        status: "active",
        project: "/repo/a",
        agentId: "agent_a",
        concept: "validation",
        file: "src/functions/observe.ts",
        limit: 5,
      },
    }));
    const parsed = JSON.parse(result.body.content[0].text);

    expect(result.status_code).toBe(200);
    expect(parsed).toMatchObject({ success: true, count: 1 });
    expect(parsed.skills[0]).toMatchObject({
      id: "skill_1",
      sourceProceduralMemoryCount: 1,
      sourceCandidateCount: 1,
    });
    expect(parsed.skills[0].sourceProceduralMemoryIds).toBeUndefined();
    const after = JSON.parse(JSON.stringify(await kv.list<AgentSkill>(KV.skills)));
    expect(after).toEqual(before);
    expect(kv.setCalls).toHaveLength(3);
  });

  it("returns an empty MCP result when the enabled scope has no rows", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    registerMcpEndpoints(sdk as never, kv as never);

    const result = await sdk.getFunction("mcp::tools::call")!(makeReq({
      name: "memory_skills",
      arguments: {},
    }));
    const parsed = JSON.parse(result.body.content[0].text);

    expect(parsed).toMatchObject({ success: true, count: 0, skills: [] });
  });

  it("reports disabled MCP diagnostics without mutating state", async () => {
    registerMcpEndpoints(sdk as never, kv as never);
    await seedSkills(kv);

    const result = await sdk.getFunction("mcp::tools::call")!(makeReq({
      name: "memory_skills",
      arguments: {},
    }));
    const parsed = JSON.parse(result.body.content[0].text);

    expect(result.body.isError).toBe(true);
    expect(parsed).toMatchObject({
      success: false,
      flag: "AGENTMEMORY_SKILL_DIAGNOSTICS",
    });
    expect(kv.listScopes).not.toContain(KV.skills);
    await expect(kv.get<AgentSkill>(KV.skills, "skill_1")).resolves.toMatchObject({ id: "skill_1" });
  });

  it("does not read the MCP scope when diagnostics are explicitly disabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "false";
    registerMcpEndpoints(sdk as never, kv as never);
    await seedSkills(kv);

    const result = await sdk.getFunction("mcp::tools::call")!(makeReq({
      name: "memory_skills",
      arguments: {},
    }));
    const parsed = JSON.parse(result.body.content[0].text);

    expect(parsed).toMatchObject({
      success: false,
      flag: "AGENTMEMORY_SKILL_DIAGNOSTICS",
    });
    expect(kv.listScopes).not.toContain(KV.skills);
  });

  it("keeps existing MCP tools available alongside the additive diagnostics tool", () => {
    const names = getAllTools().map((tool) => tool.name);
    expect(names).toContain("memory_skills");
    expect(names).toContain("memory_decision_audit");
    expect(new Set(names).size).toBe(names.length);
  });
});
