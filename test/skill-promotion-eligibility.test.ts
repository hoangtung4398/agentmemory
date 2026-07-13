import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillPromotionEligibilityFunction } from "../src/functions/skill-promotion-eligibility.js";
import { registerSkillPromotionFunction } from "../src/functions/skill-promotion.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { AgentSkill, ProceduralMemory } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_PROMOTION",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_STRENGTH",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_EVIDENCE",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => undefined,
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const getScopes: string[] = [];
  const listScopes: string[] = [];
  const writes: Array<{ operation: "set" | "delete"; scope: string; key: string }> = [];
  return {
    getScopes,
    listScopes,
    writes,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      getScopes.push(scope);
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      writes.push({ operation: "set", scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      writes.push({ operation: "delete", scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listScopes.push(scope);
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
    snapshot: () => JSON.parse(JSON.stringify(
      [...store.entries()].map(([scope, entries]) => [
        scope,
        [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ]).sort(([a], [b]) => a.localeCompare(b)),
    )),
    resetTracking: () => {
      getScopes.length = 0;
      listScopes.length = 0;
      writes.length = 0;
    },
  };
}

function procedure(overrides: Partial<ProceduralMemory> = {}): ProceduralMemory {
  return {
    id: "proc_release_validation",
    name: "Validate a release",
    triggerCondition: "Before releasing a change",
    steps: ["Run focused tests", "Run the skills consistency check"],
    expectedOutcome: "Release checks are complete.",
    frequency: 2,
    sourceSessionIds: ["session_1", "session_2"],
    sourceObservationIds: ["obs_1"],
    tags: ["release"],
    concepts: ["release", "validation"],
    strength: 0.8,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function existingSkill(proceduralMemoryId: string): AgentSkill {
  return {
    id: "skill_existing",
    name: "Existing release validation",
    triggerCondition: "Before releasing a change",
    steps: ["Run focused tests", "Run the skills consistency check"],
    expectedOutcome: "Release checks are complete.",
    antiPatterns: [],
    files: [],
    concepts: [],
    confidence: 0.8,
    strength: 0.8,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    sourceProceduralMemoryIds: [proceduralMemoryId],
    sourceCandidateIds: [],
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    status: "active",
    version: 1,
  };
}

function request(
  body?: unknown,
  query_params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return { body, query_params, headers };
}

describe("skill promotion eligibility diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillPromotionFunction(sdk as never, kv as never);
    registerSkillPromotionEligibilityFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enablePromotion(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_PROMOTION"] = "true";
  }

  async function evaluate(proceduralMemoryId = "proc_release_validation") {
    return sdk.getFunction("mem::skill-promotion-eligibility")!({ proceduralMemoryId });
  }

  async function promote(proceduralMemoryId = "proc_release_validation") {
    return sdk.getFunction("mem::skill-promote")!({ proceduralMemoryId });
  }

  it("uses the same policy as direct promotion for valid and rejected procedures", async () => {
    enablePromotion();
    const cases: Array<{
      source: ProceduralMemory;
      code: string;
      directReason: string;
    }> = [
      {
        source: procedure({ id: "missing_outcome", expectedOutcome: undefined }),
        code: "missing_expected_outcome",
        directReason: "procedural memory is missing required skill details",
      },
      {
        source: procedure({ id: "missing_name", name: "  " }),
        code: "missing_name",
        directReason: "procedural memory is missing required skill details",
      },
      {
        source: procedure({ id: "missing_trigger", triggerCondition: "  " }),
        code: "missing_trigger_condition",
        directReason: "procedural memory is missing required skill details",
      },
      {
        source: procedure({ id: "weak", strength: 0.6 }),
        code: "insufficient_strength",
        directReason: "procedural memory strength is below the promotion threshold",
      },
      {
        source: procedure({ id: "under_evidenced", sourceSessionIds: ["session_1"] }),
        code: "insufficient_evidence",
        directReason: "procedural memory has insufficient independent evidence",
      },
      {
        source: procedure({ id: "one_step", steps: ["Run focused tests"] }),
        code: "insufficient_steps",
        directReason: "procedural memory requires at least two meaningful steps",
      },
      {
        source: procedure({
          id: "secret_heavy",
          expectedOutcome: "Store <private>token=secret-value</private> safely.",
        }),
        code: "secret_heavy",
        directReason: "procedural memory contains secret-heavy content",
      },
    ];

    await kv.set(KV.procedural, "proc_release_validation", procedure());
    for (const testCase of cases) await kv.set(KV.procedural, testCase.source.id, testCase.source);

    await expect(evaluate()).resolves.toMatchObject({ eligible: true, reasonCodes: [] });
    await expect(promote()).resolves.toMatchObject({ promoted: true });
    for (const testCase of cases) {
      await expect(evaluate(testCase.source.id)).resolves.toMatchObject({
        eligible: false,
        reasonCodes: expect.arrayContaining([testCase.code]),
      });
      await expect(promote(testCase.source.id)).resolves.toMatchObject({
        promoted: false,
        reason: testCase.directReason,
      });
    }
  });

  it("reports an existing active skill without creating or changing any row", async () => {
    enablePromotion();
    const source = procedure();
    await kv.set(KV.procedural, source.id, source);
    await kv.set(KV.skills, "skill_existing", existingSkill(source.id));
    const before = kv.snapshot();
    kv.resetTracking();

    const result = await evaluate(source.id);

    expect(result).toMatchObject({
      success: true,
      found: true,
      eligible: false,
      existingSkillId: "skill_existing",
      reasonCodes: ["already_promoted"],
    });
    expect(kv.snapshot()).toEqual(before);
    expect(kv.writes).toEqual([]);
    expect(kv.getScopes).toEqual([KV.procedural]);
    expect(kv.listScopes).toEqual([KV.skills]);
  });

  it("is strictly read-only for internal, REST, and MCP eligibility calls", async () => {
    enablePromotion();
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "true";
    const source = procedure();
    await kv.set(KV.procedural, source.id, source);
    await kv.set(KV.decisionCandidates, "candidate_1", { id: "candidate_1", status: "pending" });
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);
    const before = kv.snapshot();
    kv.resetTracking();

    await expect(evaluate(source.id)).resolves.toMatchObject({ eligible: true });
    await expect(sdk.getFunction("api::skill-promotion-eligibility")!(request(undefined, {
      proceduralMemoryId: source.id,
    }))).resolves.toMatchObject({ status_code: 200, body: { eligible: true } });
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_promotion_eligibility",
      arguments: { proceduralMemoryId: source.id },
    }));

    expect(JSON.parse(mcp.body.content[0].text)).toMatchObject({ eligible: true });
    expect(kv.snapshot()).toEqual(before);
    expect(kv.writes).toEqual([]);
    expect(kv.getScopes).toEqual([KV.procedural, KV.procedural, KV.procedural]);
    expect(kv.listScopes).toEqual([KV.skills, KV.skills, KV.skills]);
  });

  it("separates a disabled promotion feature from malformed procedural memory", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    await kv.set(KV.procedural, "proc_release_validation", procedure());
    kv.resetTracking();

    const result = await evaluate();

    expect(result).toMatchObject({
      success: true,
      found: true,
      eligible: false,
      reasonCodes: ["promotion_disabled"],
    });
    expect(kv.getScopes).toEqual([KV.procedural]);
    expect(kv.listScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("returns safe validation and not-found results without any writes", async () => {
    enablePromotion();
    kv.resetTracking();

    await expect(evaluate("missing")).resolves.toMatchObject({
      success: false,
      found: false,
      proceduralMemoryId: "missing",
      eligible: false,
      reasons: ["procedural memory not found"],
    });
    await expect(sdk.getFunction("mem::skill-promotion-eligibility")!({})).resolves.toMatchObject({
      success: false,
      found: false,
      reasons: ["proceduralMemoryId is required"],
    });
    expect(kv.writes).toEqual([]);
  });

  it("guards REST and MCP diagnostics before reading procedural memory when skills are disabled", async () => {
    await kv.set(KV.procedural, "proc_release_validation", procedure());
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);
    kv.resetTracking();

    const rest = await sdk.getFunction("api::skill-promotion-eligibility")!(request(undefined, {
      proceduralMemoryId: "proc_release_validation",
    }));
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_promotion_eligibility",
      arguments: { proceduralMemoryId: "proc_release_validation" },
    }));

    expect(rest).toMatchObject({ status_code: 503, body: { flag: "AGENTMEMORY_SKILL_DIAGNOSTICS" } });
    expect(JSON.parse(mcp.body.content[0].text)).toMatchObject({
      success: false,
      flag: "AGENTMEMORY_SKILL_DIAGNOSTICS",
    });
    expect(kv.getScopes).toEqual([]);
    expect(kv.listScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("validates REST and MCP requests before triggering eligibility", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    registerApiTriggers(sdk as never, kv as never, "secret");
    registerMcpEndpoints(sdk as never, kv as never);
    kv.resetTracking();

    const unauthorized = await sdk.getFunction("api::skill-promotion-eligibility")!(request());
    const missingRestId = await sdk.getFunction("api::skill-promotion-eligibility")!(request(
      undefined,
      {},
      { authorization: "Bearer secret" },
    ));
    const missingMcpId = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_promotion_eligibility",
      arguments: {},
    }));

    expect(unauthorized).toMatchObject({ status_code: 401, body: { error: "unauthorized" } });
    expect(missingRestId).toMatchObject({
      status_code: 400,
      body: { error: "proceduralMemoryId is required" },
    });
    expect(missingMcpId).toMatchObject({ status_code: 400, body: { error: "proceduralMemoryId is required" } });
    expect(kv.getScopes).toEqual([]);
    expect(kv.listScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });
});
