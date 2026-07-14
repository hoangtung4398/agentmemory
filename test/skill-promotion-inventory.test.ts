import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillPromotionInventoryFunction } from "../src/functions/skill-promotion-inventory.js";
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
  const writes: Array<{ operation: "set" | "update" | "delete"; scope: string; key: string }> = [];
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

function skill(proceduralMemoryId: string, overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: `skill_${proceduralMemoryId}`,
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
    ...overrides,
  };
}

function request(
  body?: unknown,
  query_params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return { body, query_params, headers };
}

describe("skill promotion inventory diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillPromotionInventoryFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableSkills(promotion = false): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    if (promotion) process.env["AGENTMEMORY_SKILL_PROMOTION"] = "true";
  }

  async function inventory(input: Record<string, unknown> = {}) {
    return sdk.getFunction("mem::skill-promotion-inventory")!(input);
  }

  it("reports policy eligibility even while runtime promotion is disabled", async () => {
    enableSkills(false);
    const valid = procedure({ id: "valid", createdAt: "2026-07-14T00:00:00.000Z" });
    const missingOutcome = procedure({
      id: "missing_outcome",
      expectedOutcome: undefined,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const secret = procedure({
      id: "secret",
      name: "token=secret-value",
      expectedOutcome: "Store <private>token=secret-value</private> safely.",
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    const promoted = procedure({ id: "promoted", createdAt: "2026-07-11T00:00:00.000Z" });
    for (const item of [valid, missingOutcome, secret, promoted]) {
      await kv.set(KV.procedural, item.id, item);
    }
    await kv.set(KV.skills, "skill_promoted", skill(promoted.id, { id: "skill_promoted" }));
    kv.resetTracking();

    const result = await inventory({ scanLimit: 10, limit: 10 });

    expect(result).toMatchObject({
      success: true,
      scannedCount: 4,
      matchedCount: 4,
      returnedCount: 4,
      promotionEnabled: false,
      summary: {
        policyEligibleCount: 2,
        currentlyPromotableCount: 0,
        alreadyPromotedCount: 1,
        blockedCount: 2,
        reasonCounts: {
          promotion_disabled: 4,
          missing_expected_outcome: 1,
          secret_heavy: 1,
          already_promoted: 1,
        },
      },
    });
    expect(result.items.map((item: { proceduralMemoryId: string }) => item.proceduralMemoryId))
      .toEqual(["valid", "missing_outcome", "secret", "promoted"]);
    expect(result.items.find((item: { proceduralMemoryId: string }) => item.proceduralMemoryId === "valid"))
      .toMatchObject({ policyEligible: true, currentlyPromotable: false, reasonCodes: ["promotion_disabled"] });
    expect(result.items.find((item: { proceduralMemoryId: string }) => item.proceduralMemoryId === "promoted"))
      .toMatchObject({
        policyEligible: true,
        alreadyPromoted: true,
        promotionStateResolved: true,
        existingSkillId: "skill_promoted",
      });
    const secretItem = result.items.find((item: { proceduralMemoryId: string }) => item.proceduralMemoryId === "secret");
    expect(secretItem).toMatchObject({ reasonCodes: expect.arrayContaining(["secret_heavy"]) });
    expect(secretItem.name).toBeUndefined();
    expect(kv.listScopes).toEqual([KV.procedural, KV.skills]);
    expect(kv.writes).toEqual([]);
  });

  it("omits names for incomplete procedures with secret-bearing workflow content", async () => {
    enableSkills(true);
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "true";
    const secretName = procedure({
      id: "secret_name",
      name: "token=abcdefghijklmnopqrstuvwxyz",
      expectedOutcome: undefined,
      createdAt: "2026-07-14T03:00:00.000Z",
    });
    const secretStep = procedure({
      id: "secret_step",
      expectedOutcome: undefined,
      steps: ["Bearer abcdefghijklmnopqrstuvwxyz", "Run the release validation"],
      createdAt: "2026-07-14T02:00:00.000Z",
    });
    const cleanIncomplete = procedure({
      id: "clean_incomplete",
      expectedOutcome: undefined,
      createdAt: "2026-07-14T01:00:00.000Z",
    });
    for (const source of [secretName, secretStep, cleanIncomplete]) {
      await kv.set(KV.procedural, source.id, source);
    }
    registerApiTriggers(sdk as never, kv as never);
    kv.resetTracking();

    const result = await inventory({ scanLimit: 10, limit: 10 });
    const rest = await sdk.getFunction("api::skill-promotion-inventory")!(request(undefined, {
      scanLimit: "10",
      limit: "10",
    }));
    const items = result.items as Array<Record<string, unknown>>;
    const restItems = rest.body.items as Array<Record<string, unknown>>;

    for (const sourceId of ["secret_name", "secret_step"]) {
      const item = items.find((entry) => entry.proceduralMemoryId === sourceId)!;
      expect(item).toMatchObject({
        policyEligible: false,
        reasonCodes: expect.arrayContaining(["missing_expected_outcome", "secret_heavy"]),
      });
      expect(item).not.toHaveProperty("name");
      expect(item).not.toHaveProperty("triggerCondition");
      expect(item).not.toHaveProperty("steps");
      expect(item).not.toHaveProperty("expectedOutcome");
      expect(restItems.find((entry) => entry.proceduralMemoryId === sourceId)).not.toHaveProperty("name");
    }
    expect(items.find((entry) => entry.proceduralMemoryId === "clean_incomplete")).toMatchObject({
      policyEligible: false,
      name: "Validate a release",
      reasonCodes: expect.arrayContaining(["missing_expected_outcome"]),
    });
    expect(kv.writes).toEqual([]);
  });

  it("uses active source-lineage skills only and applies filters with bounded stable output", async () => {
    enableSkills(true);
    const newest = procedure({ id: "newest", createdAt: "2026-07-14T00:00:00.000Z" });
    const promoted = procedure({ id: "promoted", createdAt: "2026-07-13T00:00:00.000Z" });
    const oldest = procedure({ id: "oldest", createdAt: "2026-07-12T00:00:00.000Z" });
    for (const item of [oldest, promoted, newest]) await kv.set(KV.procedural, item.id, item);
    await kv.set(KV.skills, "skill_promoted", skill(promoted.id, { id: "skill_promoted" }));
    await kv.set(KV.skills, "skill_retired", skill(newest.id, {
      id: "skill_retired",
      status: "retired",
    }));
    kv.resetTracking();

    const all = await inventory({ limit: 10 });
    expect(all.items.map((item: { proceduralMemoryId: string }) => item.proceduralMemoryId))
      .toEqual(["newest", "promoted", "oldest"]);
    expect(all.summary).toMatchObject({
      policyEligibleCount: 3,
      currentlyPromotableCount: 2,
      alreadyPromotedCount: 1,
      blockedCount: 0,
    });
    expect(all.items.find((item: { proceduralMemoryId: string }) => item.proceduralMemoryId === "newest"))
      .toMatchObject({
        alreadyPromoted: false,
        promotionStateResolved: true,
        currentlyPromotable: true,
        currentlyPromotableResolved: true,
      });

    const filtered = await inventory({
      policyEligible: true,
      currentlyPromotable: true,
      alreadyPromoted: false,
      limit: 1,
    });
    expect(filtered).toMatchObject({ matchedCount: 2, returnedCount: 1, truncated: true });
    expect(filtered.items[0]).toMatchObject({ proceduralMemoryId: "newest", currentlyPromotable: true });

    const clamped = await inventory({ scanLimit: 0, limit: 500 });
    expect(clamped).toMatchObject({ scannedCount: 1, returnedCount: 1, truncated: true });
    expect(kv.listScopes).toEqual([KV.procedural, KV.skills, KV.procedural, KV.skills, KV.procedural, KV.skills]);
    expect(kv.writes).toEqual([]);
  });

  it("resolves active lineage for procedures that no longer pass policy", async () => {
    enableSkills(true);
    const missingOutcome = procedure({
      id: "missing_outcome",
      expectedOutcome: undefined,
    });
    const insufficientStrength = procedure({
      id: "insufficient_strength",
      strength: 0.1,
    });
    await kv.set(KV.procedural, missingOutcome.id, missingOutcome);
    await kv.set(KV.procedural, insufficientStrength.id, insufficientStrength);
    await kv.set(KV.skills, "skill_missing_outcome", skill(missingOutcome.id, {
      id: "skill_missing_outcome",
    }));
    await kv.set(KV.skills, "skill_insufficient_strength", skill(insufficientStrength.id, {
      id: "skill_insufficient_strength",
    }));
    await kv.set(KV.skills, "skill_retired", skill(missingOutcome.id, {
      id: "skill_retired",
      status: "retired",
    }));
    kv.resetTracking();

    const result = await inventory();
    const alreadyPromoted = await inventory({ alreadyPromoted: true });

    expect(result).toMatchObject({
      success: true,
      promotionStateComplete: true,
      unresolvedPromotionStateCount: 0,
      summary: { policyEligibleCount: 0, alreadyPromotedCount: 2, blockedCount: 2 },
    });
    expect(result.items.find((item: { proceduralMemoryId: string }) =>
      item.proceduralMemoryId === missingOutcome.id,
    )).toMatchObject({
      policyEligible: false,
      alreadyPromoted: true,
      promotionStateResolved: true,
      currentlyPromotableResolved: true,
      existingSkillId: "skill_missing_outcome",
      currentlyPromotable: false,
      reasonCodes: expect.arrayContaining(["missing_expected_outcome", "already_promoted"]),
    });
    expect(result.items.find((item: { proceduralMemoryId: string }) =>
      item.proceduralMemoryId === insufficientStrength.id,
    )).toMatchObject({
      policyEligible: false,
      alreadyPromoted: true,
      promotionStateResolved: true,
      currentlyPromotableResolved: true,
      existingSkillId: "skill_insufficient_strength",
      currentlyPromotable: false,
      reasonCodes: expect.arrayContaining(["insufficient_strength", "already_promoted"]),
    });
    expect(alreadyPromoted.items.map((item: { proceduralMemoryId: string }) => item.proceduralMemoryId))
      .toEqual(["insufficient_strength", "missing_outcome"]);
    expect(kv.listScopes).toEqual([KV.procedural, KV.skills, KV.procedural, KV.skills]);
    expect(kv.writes).toEqual([]);
  });

  it("does not resolve skills for an empty procedural scan", async () => {
    enableSkills(true);
    await kv.set(KV.skills, "skill_unrelated", skill("other", { id: "skill_unrelated" }));
    kv.resetTracking();

    const result = await inventory();

    expect(result).toMatchObject({
      success: true,
      scannedCount: 0,
      promotionStateComplete: true,
      skillScannedCount: 0,
      skillScanTruncated: false,
      summary: { policyEligibleCount: 0, blockedCount: 0 },
    });
    expect(kv.listScopes).toEqual([KV.procedural]);
    expect(kv.writes).toEqual([]);
  });

  it("reports separate scan, result, and skill lineage truncation semantics", async () => {
    enableSkills(true);
    const sameTimestamp = "2026-07-14T00:00:00.000Z";
    for (const id of ["zeta", "beta", "alpha"]) {
      await kv.set(KV.procedural, id, procedure({ id, createdAt: sameTimestamp }));
    }
    kv.resetTracking();

    const exactScan = await inventory({ scanLimit: 3, limit: 3 });
    const scanLimited = await inventory({ scanLimit: 2, limit: 2 });
    const resultLimited = await inventory({ scanLimit: 3, limit: 1 });

    expect(exactScan).toMatchObject({
      scanTruncated: false,
      resultTruncated: false,
      skillScanTruncated: false,
      truncated: false,
      promotionStateComplete: true,
    });
    expect(exactScan.items.map((item: { proceduralMemoryId: string }) => item.proceduralMemoryId))
      .toEqual(["alpha", "beta", "zeta"]);
    expect(scanLimited).toMatchObject({
      scannedCount: 2,
      scanTruncated: true,
      resultTruncated: false,
      skillScanTruncated: false,
      truncated: true,
    });
    expect(resultLimited).toMatchObject({
      matchedCount: 3,
      returnedCount: 1,
      scanTruncated: false,
      resultTruncated: true,
      skillScanTruncated: false,
      truncated: true,
    });
    expect(kv.listScopes).toEqual([
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
    ]);
    expect(kv.writes).toEqual([]);
  });

  it("is conservative when the hard skill lineage scan limit is reached", async () => {
    enableSkills(true);
    await kv.set(KV.procedural, "valid", procedure({ id: "valid" }));
    for (let index = 0; index <= 5000; index += 1) {
      await kv.set(KV.skills, `skill_${index}`, skill(`other_${index}`, {
        id: `skill_${index}`,
        createdAt: `2026-07-13T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      }));
    }
    kv.resetTracking();

    const result = await inventory({ limit: 10 });
    const conclusivelyNotPromoted = await inventory({ alreadyPromoted: false });
    const conclusivelyNotPromotable = await inventory({ currentlyPromotable: false });
    const unresolved = await inventory({ promotionStateResolved: false });

    expect(result).toMatchObject({
      success: true,
      skillScannedCount: 5000,
      promotionStateComplete: false,
      unresolvedPromotionStateCount: 1,
      skillScanTruncated: true,
      truncated: true,
      summary: {
        policyEligibleCount: 1,
        currentlyPromotableCount: 0,
        alreadyPromotedCount: 0,
        blockedCount: 0,
      },
    });
    expect(result.items[0]).toMatchObject({
      proceduralMemoryId: "valid",
      policyEligible: true,
      alreadyPromoted: false,
      promotionStateResolved: false,
      currentlyPromotable: false,
      currentlyPromotableResolved: false,
    });
    expect(conclusivelyNotPromoted).toMatchObject({ matchedCount: 0, returnedCount: 0 });
    expect(conclusivelyNotPromotable).toMatchObject({ matchedCount: 0, returnedCount: 0 });
    expect(unresolved).toMatchObject({ matchedCount: 1, returnedCount: 1 });
    expect(unresolved.items[0]).toMatchObject({
      proceduralMemoryId: "valid",
      promotionStateResolved: false,
    });
    expect(kv.listScopes).toEqual([
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
    ]);
    expect(kv.writes).toEqual([]);
  });

  it("is strictly read-only for internal, REST, and MCP inventory calls", async () => {
    enableSkills(true);
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "true";
    const source = procedure();
    await kv.set(KV.procedural, source.id, source);
    await kv.set(KV.skills, "skill_unrelated", skill("other", { id: "skill_unrelated" }));
    await kv.set(KV.decisionCandidates, "candidate_1", { id: "candidate_1", status: "pending" });
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);
    const before = kv.snapshot();
    kv.resetTracking();

    await expect(inventory()).resolves.toMatchObject({
      success: true,
      summary: { currentlyPromotableCount: 1 },
    });
    await expect(sdk.getFunction("api::skill-promotion-inventory")!(request(undefined, {
      policyEligible: "true",
      currentlyPromotable: "true",
      promotionStateResolved: "true",
    }))).resolves.toMatchObject({ status_code: 200, body: { matchedCount: 1 } });
    const mcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_promotion_inventory",
      arguments: { reasonCode: "promotion_disabled", promotionStateResolved: true },
    }));

    expect(JSON.parse(mcp.body.content[0].text)).toMatchObject({ success: true, matchedCount: 0 });
    expect(kv.snapshot()).toEqual(before);
    expect(kv.writes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.listScopes).toEqual([
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
      KV.procedural, KV.skills,
    ]);
  });

  it("guards diagnostics and validates REST/MCP input before scope reads", async () => {
    await kv.set(KV.procedural, "valid", procedure({ id: "valid" }));
    registerApiTriggers(sdk as never, kv as never, "secret");
    registerMcpEndpoints(sdk as never, kv as never);
    kv.resetTracking();

    const disabledMcp = await sdk.getFunction("mcp::tools::call")!(request({
      name: "memory_skill_promotion_inventory",
      arguments: {},
    }));
    const unauthorized = await sdk.getFunction("api::skill-promotion-inventory")!(request());
    process.env["AGENTMEMORY_SKILLS"] = "true";
    const invalidRest = await sdk.getFunction("api::skill-promotion-inventory")!(request(
      undefined,
      { policyEligible: "maybe" },
      { authorization: "Bearer secret" },
    ));
    const invalidResolution = await sdk.getFunction("api::skill-promotion-inventory")!(request(
      undefined,
      { promotionStateResolved: "maybe" },
      { authorization: "Bearer secret" },
    ));

    expect(JSON.parse(disabledMcp.body.content[0].text)).toMatchObject({
      success: false,
      flag: "AGENTMEMORY_SKILL_DIAGNOSTICS",
    });
    expect(unauthorized).toMatchObject({ status_code: 401, body: { error: "unauthorized" } });
    expect(invalidRest).toMatchObject({ status_code: 400, body: { error: "policyEligible must be true or false" } });
    expect(invalidResolution).toMatchObject({
      status_code: 400,
      body: { error: "promotionStateResolved must be true or false" },
    });
    expect(kv.getScopes).toEqual([]);
    expect(kv.listScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });
});
