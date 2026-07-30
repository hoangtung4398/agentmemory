import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillAdvisory } from "../src/types.js";
import { registerSkillContextExplainFunction } from "../src/functions/skill-context-explain.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import {
  evaluateSkillAdvisoryPacking,
  packSkillAdvisories,
} from "../src/functions/skill-context.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_CONTEXT",
  "AGENTMEMORY_SKILL_RECALL_LIMIT",
  "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE",
  "AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggers: string[] = [];
  return {
    functions,
    triggers,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: async (input: { function_id: string; payload: unknown }) => {
      triggers.push(input.function_id);
      const handler = functions.get(input.function_id);
      if (!handler) throw new Error(`No function: ${input.function_id}`);
      return handler(input.payload);
    },
  };
}

function mockKV(rows: unknown[] = []) {
  const listScopes: string[] = [];
  const getScopes: string[] = [];
  const writes: string[] = [];
  let failure = false;
  return {
    listScopes,
    getScopes,
    writes,
    failList: () => { failure = true; },
    list: async <T>(scope: string): Promise<T[]> => {
      listScopes.push(scope);
      if (failure) throw new Error("storage unavailable");
      return rows as T[];
    },
    get: async <T>(scope: string): Promise<T | null> => {
      getScopes.push(scope);
      return null;
    },
    set: async () => { writes.push("set"); },
    update: async () => { writes.push("update"); },
    delete: async () => { writes.push("delete"); },
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Release validation",
    triggerCondition: "Before releasing changes",
    steps: ["Run focused tests"],
    expectedOutcome: "Validation is complete",
    antiPatterns: ["Skip tests"],
    project: "/repo/a",
    agentId: "agent_a",
    files: ["src/functions/observe.ts"],
    concepts: ["release"],
    confidence: 0.9,
    strength: 0.8,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    sourceProceduralMemoryIds: ["proc_release"],
    sourceCandidateIds: [],
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    status: "active",
    version: 1,
    ...overrides,
  };
}

function advisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  const stored = skill();
  return {
    source: "skill-advisory",
    skillId: stored.id,
    name: stored.name,
    triggerCondition: stored.triggerCondition,
    steps: [...stored.steps],
    expectedOutcome: stored.expectedOutcome,
    antiPatterns: [...stored.antiPatterns],
    project: stored.project,
    agentId: stored.agentId,
    files: [...stored.files],
    concepts: [...stored.concepts],
    confidence: stored.confidence,
    strength: stored.strength,
    score: 1,
    sourceProceduralMemoryIds: [...stored.sourceProceduralMemoryIds],
    ...overrides,
  };
}

describe("internal skill context packing explanation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillContextExplainFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableContext(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_RECALL"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET"] = "1000";
  }

  async function explain(input: unknown) {
    return sdk.functions.get("mem::skill-context-explain")!(input);
  }

  it("registers internally in the required order and gates before validation or storage", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index.indexOf("registerSkillRecallFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillRecallExplainFunction(sdk, kv)"));
    expect(index.indexOf("registerSkillRecallExplainFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillRecallDiagnosticsFunction(sdk, kv)"));
    expect(index.indexOf("registerSkillRecallDiagnosticsFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillContextExplainFunction(sdk, kv)"));
    expect(sdk.functions.has("mem::skill-context-explain")).toBe(true);
    expect(getAllTools().some((tool) => tool.name.includes("context_explain"))).toBe(false);

    await expect(explain({ tokenBudget: 0 })).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      reason: "skill context explanation is disabled",
      items: [],
    });
    expect(kv.listScopes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("rejects every invalid input before storage", async () => {
    enableContext();
    const invalid = [
      null, [], "value", { files: "bad" }, { tokenBudget: "1" }, { tokenBudget: true },
      { tokenBudget: {} }, { tokenBudget: [] }, { tokenBudget: 0 }, { tokenBudget: -1 },
      { tokenBudget: 1.5 }, { tokenBudget: Number.NaN }, { tokenBudget: Infinity },
      { tokenBudget: -Infinity }, { tokenBudget: 1001 },
    ];
    for (const input of invalid) {
      await expect(explain(input)).resolves.toMatchObject({
        success: false,
        enabled: true,
        reason: "invalid skill context explanation input",
        items: [],
      });
    }
    expect(kv.listScopes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("uses exactly one skills list and fails without partial decisions", async () => {
    enableContext();
    kv = mockKV([skill()]);
    kv.failList();
    registerSkillContextExplainFunction(sdk as never, kv as never);

    await expect(explain({ tokenBudget: 1 })).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill context explanation",
      scannedCount: 0,
      requestedTokenBudget: 1,
      effectiveTokenBudget: 1,
      items: [],
    });
    expect(kv.listScopes).toEqual([KV.skills]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("uses recall order and the shared packer decisions without exposing instructions", async () => {
    enableContext();
    const oversized = skill({ id: "oversized", steps: ["x".repeat(4_000)] });
    const fitting = skill({ id: "fitting", name: "Release fitting", confidence: 0.8 });
    const rows = [oversized, fitting];
    kv = mockKV(rows);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    registerSkillRecallFunction(sdk as never, kv as never);

    const input = { project: "/repo/a", agentId: "agent_a", query: "release" };
    const result = await explain({ ...input, tokenBudget: 1000 });
    const recall = await sdk.functions.get("mem::skill-recall")!(input);
    const packing = evaluateSkillAdvisoryPacking([
      advisory({ skillId: "oversized", steps: ["x".repeat(4_000)] }),
      advisory({ skillId: "fitting", name: "Release fitting", confidence: 0.8 }),
    ], 1000);
    expect(result).toMatchObject({
      success: true,
      effectiveTokenBudget: 1000,
      recallReturnedCount: 2,
      packedCount: 1,
      omittedCount: 1,
      sectionCreated: true,
      packedTokens: packing.tokens,
      sectionOverheadTokens: packing.sectionOverheadTokens,
    });
    expect(result.items).toEqual(packing.decisions);
    expect(result.items).toMatchObject([
      { skillId: "oversized", recallRank: 1, state: "omitted_budget", reasonCodes: ["exceeds_token_budget"] },
      { skillId: "fitting", recallRank: 2, state: "packed", reasonCodes: ["packed"], packedPosition: 1 },
    ]);
    expect(result).toMatchObject({
      scannedCount: recall.scannedCount,
      matchedCount: recall.matchedCount,
      recallReturnedCount: recall.returnedCount,
      recallTruncated: recall.truncated,
      privacySuppressedCount: recall.privacySuppressedCount,
    });
    expect(result.items.map((item: { skillId: string }) => item.skillId)).toEqual(
      recall.advisories.map((item: { skillId: string }) => item.skillId),
    );
    expect(JSON.stringify(result)).not.toContain("x".repeat(100));
    expect(JSON.stringify(result)).not.toContain("Release fitting");
    expect(kv.listScopes).toEqual([KV.skills, KV.skills]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("preserves packer bytes and exact token boundaries across budgets", async () => {
    enableContext();
    const rows = [skill()];
    kv = mockKV(rows);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const candidateTokens = evaluateSkillAdvisoryPacking([advisory()], 1000).decisions[0]!.candidateSectionTokens;

    const input = { project: "/repo/a", agentId: "agent_a" };
    const exact = await explain({ ...input, tokenBudget: candidateTokens });
    const over = await explain({ ...input, tokenBudget: candidateTokens - 1 });
    const packed = packSkillAdvisories([advisory()], candidateTokens);
    expect(exact).toMatchObject({ packedCount: 1, omittedCount: 0, packedTokens: packed?.tokens, sectionCreated: true });
    expect(exact.items[0]).toMatchObject({ state: "packed", candidateSectionTokens: candidateTokens });
    expect(over).toMatchObject({ packedCount: 0, omittedCount: 1, packedTokens: 0, sectionCreated: false });
    expect(over.items[0]).toMatchObject({ state: "omitted_budget", candidateSectionTokens: candidateTokens });

    for (const budget of [candidateTokens - 1, candidateTokens, 1000]) {
      const evaluation = evaluateSkillAdvisoryPacking([advisory({ name: "<xml & advisory>" })], budget);
      const ordinary = packSkillAdvisories([advisory({ name: "<xml & advisory>" })], budget);
      expect(evaluation.content).toBe(ordinary?.content ?? null);
      expect(evaluation.tokens).toBe(ordinary?.tokens ?? 0);
    }
  });

  it("caps requested budget, handles no recalled advisories, and returns fresh allocations", async () => {
    enableContext();
    kv = mockKV([skill()]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", tokenBudget: 1000 };
    const capped = await explain(input);
    capped.items[0]!.reasonCodes[0] = "exceeds_token_budget";
    capped.items[0]!.skillId = "mutated";
    const next = await explain(input);
    expect(next.items[0]).toMatchObject({ skillId: "skill_release", reasonCodes: ["packed"] });

    const evaluator = evaluateSkillAdvisoryPacking([advisory()], 1000);
    evaluator.decisions[0]!.reasonCodes[0] = "exceeds_token_budget";
    expect(evaluateSkillAdvisoryPacking([advisory()], 1000).decisions[0]!.reasonCodes).toEqual(["packed"]);
    expect(packSkillAdvisories([advisory()], 1000)?.content).toContain('id="skill_release"');

    kv = mockKV([skill({ concepts: ["other"], files: ["other.ts"] })]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    await expect(explain({ query: "release" })).resolves.toMatchObject({
      success: true,
      recallReturnedCount: 0,
      packedCount: 0,
      omittedCount: 0,
      packedTokens: 0,
      sectionCreated: false,
      items: [],
    });
  });

  it("suppresses all private instruction fields and fails closed on every duplicate shape", async () => {
    enableContext();
    const markers = ["private-name", "private-trigger", "private-step", "private-outcome", "private-anti"];
    const privateRows = [
      skill({ id: "private-name", name: `<private>${markers[0]}</private>` }),
      skill({ id: "private-trigger", triggerCondition: `<private>${markers[1]}</private>` }),
      skill({ id: "private-step", steps: [`<private>${markers[2]}</private>`] }),
      skill({ id: "private-outcome", expectedOutcome: `<private>${markers[3]}</private>` }),
      skill({ id: "private-anti", antiPatterns: [`<private>${markers[4]}</private>`] }),
    ];
    kv = mockKV([skill(), ...privateRows]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const safe = await explain({});
    expect(safe.privateProtectedCount).toBe(5);
    for (const privateRow of privateRows) {
      expect(safe.items.map((item: { skillId: string }) => item.skillId)).not.toContain(privateRow.id);
    }
    for (const marker of markers) expect(JSON.stringify(safe)).not.toContain(marker);

    const duplicatePopulations = [
      [skill({ id: "dup" }), skill({ id: " dup " })],
      [skill({ id: "dup" }), { id: "dup", name: "broken" }],
      [{ id: "dup" }, { id: "dup" }],
      [skill({ id: "dup" }), { ...privateRows[0], id: "dup" }],
      [{ ...privateRows[0], id: "dup" }, { ...privateRows[1], id: "dup" }],
    ];
    for (const rows of duplicatePopulations) {
      kv = mockKV(rows);
      registerSkillContextExplainFunction(sdk as never, kv as never);
      const result = await explain({});
      expect(result).toMatchObject({
        success: false,
        reason: "duplicate skill id",
        packedCount: 0,
        omittedCount: 0,
        packedTokens: 0,
        sectionCreated: false,
        items: [],
      });
      for (const marker of markers) expect(JSON.stringify(result)).not.toContain(marker);
      expect(kv.getScopes).toEqual([]);
      expect(kv.writes).toEqual([]);
    }
  });
});
