import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeSkillRecallInput,
  registerSkillRecallFunction,
} from "../src/functions/skill-recall.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { AgentSkill } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_RECALL_LIMIT",
  "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggers: string[] = [];
  return {
    triggers,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => undefined,
    trigger: async (input: { function_id: string; payload: unknown }) => {
      triggers.push(input.function_id);
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listScopes: string[] = [];
  const writes: Array<{ operation: string; scope: string; key: string }> = [];
  return {
    listScopes,
    writes,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      writes.push({ operation: "set", scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    update: async <T>(scope: string, key: string): Promise<T> => {
      writes.push({ operation: "update", scope, key });
      return store.get(scope)?.get(key) as T;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      writes.push({ operation: "delete", scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listScopes.push(scope);
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
    snapshot: () => JSON.parse(JSON.stringify([...store.entries()])),
    resetTracking: () => {
      listScopes.length = 0;
      writes.length = 0;
    },
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Validate release changes",
    triggerCondition: "Before releasing AgentMemory changes",
    steps: ["Run focused tests", "Run the skills check"],
    expectedOutcome: "Release validation is complete.",
    antiPatterns: ["Skip focused validation"],
    project: "/repo/a",
    agentId: "agent_a",
    files: ["src/functions/observe.ts"],
    concepts: ["release", "validation"],
    confidence: 0.9,
    strength: 0.8,
    usageCount: 9,
    successCount: 8,
    failureCount: 1,
    sourceProceduralMemoryIds: ["proc_release"],
    sourceCandidateIds: ["candidate_private"],
    sourceObservationIds: ["obs_private"],
    sourceSessionIds: ["session_private"],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    status: "active",
    version: 1,
    ...overrides,
  };
}

function request(body?: unknown) {
  return { body, headers: {}, query_params: {} };
}

describe("AgentSkill advisory recall", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillRecallFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableRecall(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_RECALL"] = "true";
  }

  async function recall(input: Record<string, unknown> = {}) {
    return sdk.getFunction("mem::skill-recall")!(input);
  }

  it("is disabled by default without listing skills, and REST/MCP preserve the disabled gate", async () => {
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);
    await kv.set(KV.skills, "skill_release", skill());
    kv.resetTracking();

    await expect(recall()).resolves.toMatchObject({ success: false, error: "Agent skill recall not enabled" });
    await expect(sdk.getFunction("api::skill-recall")!(request())).resolves.toMatchObject({
      status_code: 503,
      body: { flag: "AGENTMEMORY_SKILL_RECALL" },
    });
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_recall",
      arguments: {},
    }));
    expect(mcp.body).toMatchObject({ isError: true });
    expect(kv.listScopes).not.toContain(KV.skills);
  });

  it("returns empty enabled results with no writes", async () => {
    enableRecall();
    const result = await recall();

    expect(result).toEqual({
      success: true,
      enabled: true,
      scannedCount: 0,
      matchedCount: 0,
      returnedCount: 0,
      truncated: false,
      privacySuppressedCount: 0,
      advisories: [],
    });
    expect(kv.writes).toEqual([]);
  });

  it("rejects malformed REST and MCP arrays before listing skills", async () => {
    enableRecall();
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);

    const rest = await sdk.getFunction("api::skill-recall")!(request({ files: {} }));
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_recall",
      arguments: { concepts: ["release", 1] },
    }));

    expect(rest).toMatchObject({ status_code: 400, body: { error: "files and concepts must be arrays of strings" } });
    expect(mcp).toMatchObject({ status_code: 400, body: { error: "files and concepts must be arrays of strings" } });
    expect(kv.listScopes).not.toContain(KV.skills);
    expect(sdk.triggers).not.toContain("mem::skill-recall");
  });

  it("enforces active, confidence, exact project and agent scope without leaking scoped skills", async () => {
    enableRecall();
    for (const entry of [
      skill(),
      skill({ id: "global", project: undefined, agentId: undefined, confidence: 0.7 }),
      skill({ id: "other-project", project: "/repo/b" }),
      skill({ id: "other-agent", agentId: "agent_b" }),
      skill({ id: "retired", status: "retired" }),
      skill({ id: "low-confidence", confidence: 0.69 }),
    ]) await kv.set(KV.skills, entry.id, entry);
    kv.resetTracking();

    const scoped = await recall({ project: "/repo/a", agentId: "agent_a" });
    expect(scoped.advisories.map((entry: { skillId: string }) => entry.skillId)).toEqual([
      "skill_release", "global",
    ]);
    const missingScope = await recall({ query: "release" });
    expect(missingScope.advisories.map((entry: { skillId: string }) => entry.skillId)).toEqual(["global"]);
    expect(kv.writes).toEqual([]);
  });

  it("matches concepts, files, and query tokens deterministically while requiring a contextual signal", async () => {
    enableRecall();
    await kv.set(KV.skills, "skill_release", skill());
    await kv.set(KV.skills, "skill_tie_b", skill({
      id: "skill_tie_b",
      project: undefined,
      agentId: undefined,
      concepts: ["release"],
      files: [],
      confidence: 0.8,
      strength: 0.7,
      updatedAt: "2026-07-15T01:00:00.000Z",
    }));
    await kv.set(KV.skills, "skill_tie_a", skill({
      id: "skill_tie_a",
      project: undefined,
      agentId: undefined,
      concepts: ["release"],
      files: [],
      confidence: 0.8,
      strength: 0.7,
      updatedAt: "2026-07-15T01:00:00.000Z",
    }));
    kv.resetTracking();

    const combined = await recall({
      project: "/repo/a",
      agentId: "agent_a",
      concepts: ["release"],
      files: ["src/functions/observe.ts"],
      query: "release validation",
    });
    expect(combined.advisories[0]).toMatchObject({ skillId: "skill_release", score: 21 });
    const tie = await recall({ concepts: ["release"] });
    expect(tie.advisories.map((entry: { skillId: string }) => entry.skillId)).toEqual([
      "skill_tie_a", "skill_tie_b",
    ]);
    await expect(recall({ query: "unrelated" })).resolves.toMatchObject({ matchedCount: 0 });
  });

  it("clamps configured and requested limits and reports truncation", async () => {
    enableRecall();
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "1";
    for (const id of ["a", "b", "c"]) {
      await kv.set(KV.skills, id, skill({ id, project: undefined, agentId: undefined }));
    }
    kv.resetTracking();

    await expect(recall({ query: "release" })).resolves.toMatchObject({
      matchedCount: 3,
      returnedCount: 1,
      truncated: true,
    });
    await expect(recall({ query: "release", limit: 99 })).resolves.toMatchObject({
      returnedCount: 3,
      truncated: false,
    });
    expect(normalizeSkillRecallInput({ files: {}, concepts: ["ok", 1] })).toMatchObject({ success: false });
  });

  it("suppresses every advisory with private text and leaves stored rows untouched", async () => {
    enableRecall();
    const rows = [
      skill({ id: "secret-name", name: "token=abcdefghijklmnopqrstuvwxyz1234567890" }),
      skill({ id: "secret-trigger", triggerCondition: "<private>internal</private> before release" }),
      skill({ id: "secret-step", steps: ["Bearer abcdefghijklmnopqrstuvwxyz123456"] }),
      skill({ id: "secret-outcome", expectedOutcome: "<private>unclosed" }),
      skill({ id: "safe-incomplete", antiPatterns: ["token=short"] }),
    ];
    for (const entry of rows) await kv.set(KV.skills, entry.id, entry);
    const before = kv.snapshot();
    kv.resetTracking();

    const result = await recall({ project: "/repo/a", agentId: "agent_a" });

    expect(result).toMatchObject({ privacySuppressedCount: 4, returnedCount: 1 });
    expect(result.advisories[0]).toMatchObject({ skillId: "safe-incomplete" });
    expect(kv.snapshot()).toEqual(before);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).not.toContain("mem::skill-promote");
  });

  it("has REST and MCP parity and exposes the additive non-core tool", async () => {
    enableRecall();
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);
    await kv.set(KV.skills, "skill_release", skill());
    kv.resetTracking();
    const input = { project: "/repo/a", agentId: "agent_a", query: "release", limit: 2 };

    const direct = await recall(input);
    const rest = await sdk.getFunction("api::skill-recall")!(request(input));
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_recall",
      arguments: input,
    }));
    const mcpResult = JSON.parse(mcp.body.content[0].text);

    expect(rest.body).toEqual(direct);
    expect(mcpResult).toEqual(direct);
    expect(getAllTools().some((tool) => tool.name === "memory_skill_recall")).toBe(true);
    expect(kv.writes).toEqual([]);
  });
});
