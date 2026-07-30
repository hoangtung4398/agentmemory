import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import {
  evaluateSkillContextAdmission,
  registerSkillContextAdmissionExplainFunction,
} from "../src/functions/skill-context-admission.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillAdvisory, SkillContextAdmissionExplainResult } from "../src/types.js";

const ENV = ["AGENTMEMORY_SKILLS", "AGENTMEMORY_SKILL_RECALL", "AGENTMEMORY_SKILL_CONTEXT", "AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET", "AGENTMEMORY_SKILL_RECALL_LIMIT", "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"];
const original: Record<string, string | undefined> = {};

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"],
    expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent",
    files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0,
    failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [],
    sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    status: "active", version: 1, ...overrides,
  };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = []; let fail = false;
  return {
    lists, gets, writes, failList: () => { fail = true; },
    list: async <T>(scope: string): Promise<T[]> => { lists.push(scope); if (fail) throw new Error("storage"); return rows as T[]; },
    get: async <T>(scope: string): Promise<T | null> => { gets.push(scope); return null; },
    set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>(); const triggers: string[] = [];
  return { functions, triggers, registerFunction: (id: string, handler: Function) => functions.set(id, handler), trigger: async (input: { function_id: string }) => { triggers.push(input.function_id); return null; } };
}

function oracle(input: Parameters<typeof evaluateSkillContextAdmission>[0]) {
  const separatorTokens = input.selectedBlockCount > 0 ? Math.ceil("\n\n".length / 3) : 0;
  const remainingOverallBudget = input.overallBudget - input.usedTokens - separatorTokens;
  const effectiveSkillTokenBudget = Math.max(0, Math.min(input.configuredSkillTokenBudget, remainingOverallBudget));
  const shouldAttemptRecall = input.enabled && effectiveSkillTokenBudget > 0;
  const packed = Number.isInteger(input.packedSectionTokens) && (input.packedSectionTokens ?? 0) > 0;
  const sectionAdmitted = shouldAttemptRecall && packed && input.usedTokens + separatorTokens + (input.packedSectionTokens ?? 0) <= input.overallBudget;
  return { separatorTokens, remainingOverallBudget, effectiveSkillTokenBudget, shouldAttemptRecall, sectionCreated: packed, sectionAdmitted,
    projectedUsedTokens: sectionAdmitted ? input.usedTokens + separatorTokens + (input.packedSectionTokens ?? 0) : input.usedTokens,
    projectedBlockCount: sectionAdmitted ? input.selectedBlockCount + 1 : input.selectedBlockCount };
}

function advisory(): SkillAdvisory {
  const stored = skill();
  return {
    source: "skill-advisory", skillId: stored.id, name: stored.name, triggerCondition: stored.triggerCondition,
    steps: [...stored.steps], expectedOutcome: stored.expectedOutcome, antiPatterns: [...stored.antiPatterns],
    project: stored.project, agentId: stored.agentId, files: [...stored.files], concepts: [...stored.concepts],
    confidence: stored.confidence, strength: stored.strength, score: 1,
    sourceProceduralMemoryIds: [...stored.sourceProceduralMemoryIds],
  };
}

describe("skill context admission explanation", () => {
  let sdk: ReturnType<typeof mockSdk>; let kv: ReturnType<typeof mockKV>;
  beforeEach(() => { for (const key of ENV) { original[key] = process.env[key]; delete process.env[key]; } sdk = mockSdk(); kv = mockKV(); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never); });
  afterEach(() => { for (const key of ENV) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  function enable(budget = 320) { process.env.AGENTMEMORY_SKILLS = "true"; process.env.AGENTMEMORY_SKILL_RECALL = "true"; process.env.AGENTMEMORY_SKILL_CONTEXT = "true"; process.env.AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET = String(budget); }
  async function explain(input: unknown) { return sdk.functions.get("mem::skill-context-admission-explain")!(input) as Promise<SkillContextAdmissionExplainResult>; }

  it("has an independent arithmetic oracle for budgets, separator, cap, and defensive rejection", () => {
    const cases = [
      { enabled: false, overallBudget: 100, usedTokens: 10, selectedBlockCount: 0, configuredSkillTokenBudget: 320 },
      { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320 },
      { enabled: true, overallBudget: 500, usedTokens: 10, selectedBlockCount: 2, configuredSkillTokenBudget: 320, packedSectionTokens: 320 },
      { enabled: true, overallBudget: 100, usedTokens: 100, selectedBlockCount: 1, configuredSkillTokenBudget: 320 },
      { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 90 },
    ];
    for (const input of cases) expect(evaluateSkillContextAdmission(input)).toEqual(oracle(input));
  });

  it("registers internally, remains default-off, and exposes no public surface", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index.indexOf("registerSkillContextExplainFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillContextAdmissionExplainFunction(sdk, kv)"));
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("admission"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(explain(null)).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", reason: "skill context admission explanation is disabled" });
    expect(kv.lists).toEqual([]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(sdk.triggers).toEqual([]);
  });

  it("validates admission values before reads while allowing exhausted outer contexts", async () => {
    enable();
    for (const input of [null, [], "x", {}, { overallBudget: 1, usedTokens: 0 }, { overallBudget: 1, usedTokens: 0, selectedBlockCount: 0.5 }, { overallBudget: 1, usedTokens: -1, selectedBlockCount: 0 }, { overallBudget: Number.MAX_SAFE_INTEGER + 1, usedTokens: 0, selectedBlockCount: 0 }]) {
      await expect(explain(input)).resolves.toMatchObject({ success: false, state: "failed", reason: "invalid skill context admission explanation input" });
    }
    expect(kv.lists).toEqual([]);
    const exhausted = await explain({ overallBudget: 10, usedTokens: 11, selectedBlockCount: 1 });
    expect(exhausted).toMatchObject({ success: true, state: "skipped_no_budget", recallAttempted: false, sectionAdmitted: false, projectedUsedTokens: 11, projectedBlockCount: 1 });
    expect(kv.lists).toEqual([]);
  });

  it("uses exactly one skills list for positive budget and reports recall, packing, and admission aggregates", async () => {
    enable(320); kv = mockKV([skill()]); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const result = await explain({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 10, selectedBlockCount: 1 });
    expect(result).toMatchObject({ success: true, state: "admitted", recallAttempted: true, configuredSkillTokenBudget: 320, effectiveSkillTokenBudget: 320, recallReturnedCount: 1, packedCount: 1, omittedCount: 0, sectionCreated: true, sectionAdmitted: true });
    expect(result.packedCount + result.omittedCount).toBe(result.recallReturnedCount);
    expect(result.projectedBlockCount).toBe(2);
    expect(kv.lists).toEqual([KV.skills]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(sdk.triggers).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("skill_release");
  });

  it("fails closed for duplicates, suppresses private rows, and stays deterministic across physical order", async () => {
    enable();
    const publicRow = skill({ id: "public", name: "Release public" });
    const privateRow = skill({ id: "private", name: "<private>secret-marker</private>" });
    const rows = [publicRow, privateRow, { id: "broken", name: "bad" }];
    const results: SkillContextAdmissionExplainResult[] = [];
    for (const population of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[1]!]]) {
      kv = mockKV(population); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
      results.push(await explain({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }));
    }
    expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ privateProtectedCount: 1, recallReturnedCount: 1 });
    expect(JSON.stringify(results[0])).not.toContain("secret-marker");
    for (const population of [[skill({ id: "dup" }), { id: "dup", name: "bad" }], [{ id: "dup", name: "bad" }, skill({ id: "dup" })]]) {
      kv = mockKV(population); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
      await expect(explain({ overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 })).resolves.toMatchObject({ success: false, state: "failed", reason: "duplicate skill id", reasonCodes: ["duplicate_skill_id"], packedCount: 0, sectionAdmitted: false });
    }
  });

  it("rejects every invalid numeric and delegated recall shape before storage", async () => {
    enable();
    const invalidNumbers = [undefined, null, "1", true, {}, [], Number.NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
    const invalid: unknown[] = [
      ...invalidNumbers.map((overallBudget) => ({ overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ overallBudget: 1, usedTokens: 0, selectedBlockCount })),
      { overallBudget: 1, usedTokens: 0, selectedBlockCount: 0, query: "x".repeat(1001) },
      { overallBudget: 1, usedTokens: 0, selectedBlockCount: 0, files: "src/x.ts" },
      { overallBudget: 1, usedTokens: 0, selectedBlockCount: 0, concepts: ["ok", 1] },
      { overallBudget: 1, usedTokens: 0, selectedBlockCount: 0, limit: Number.NaN },
    ];
    for (const input of invalid) {
      await expect(explain(input)).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_input"] });
    }
    expect(kv.lists).toEqual([]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(sdk.triggers).toEqual([]);
  });

  it("keeps the read boundary and reports storage, empty-recall, and packing-empty outcomes", async () => {
    enable();
    kv.failList();
    const failed = await explain({ overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(failed).toMatchObject({ success: false, state: "failed", reasonCodes: ["storage_failure"], scannedCount: 0, packedCount: 0 });
    expect(kv.lists).toEqual([KV.skills]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(sdk.triggers).toEqual([]);

    kv = mockKV(); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const empty = await explain({ overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(empty).toMatchObject({ success: true, state: "recall_empty", reasonCodes: ["no_recalled_advisories"], recallAttempted: true, sectionCreated: false });

    kv = mockKV([skill({ steps: ["x".repeat(4000)] })]); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const packingEmpty = await explain({ project: "/repo", agentId: "agent", overallBudget: 64, usedTokens: 0, selectedBlockCount: 0 });
    expect(packingEmpty).toMatchObject({ success: true, state: "packing_empty", reasonCodes: ["no_advisory_fits"], recallReturnedCount: 1, packedCount: 0, omittedCount: 1, packedTokens: 0, sectionCreated: false });
    expect(kv.lists).toEqual([KV.skills]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(sdk.triggers).toEqual([]);
  });

  it("uses independent admission arithmetic for every outer-budget boundary", () => {
    const cases: Parameters<typeof evaluateSkillContextAdmission>[0][] = [
      { enabled: true, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 320, packedSectionTokens: 1 },
      { enabled: true, overallBudget: 2, usedTokens: 0, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 1 },
      { enabled: true, overallBudget: 3, usedTokens: 0, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 1 },
      { enabled: true, overallBudget: 100, usedTokens: 98, selectedBlockCount: 0, configuredSkillTokenBudget: 1, packedSectionTokens: 1 },
      { enabled: true, overallBudget: 100, usedTokens: 98, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 1 },
      { enabled: false, overallBudget: 100, usedTokens: 0, selectedBlockCount: 3, configuredSkillTokenBudget: 320, packedSectionTokens: 10 },
      { enabled: true, overallBudget: 1000, usedTokens: 0, selectedBlockCount: 3, configuredSkillTokenBudget: 50, packedSectionTokens: 51 },
      { enabled: true, overallBudget: 1000, usedTokens: 0, selectedBlockCount: 3, configuredSkillTokenBudget: 50, packedSectionTokens: 0 },
      { enabled: true, overallBudget: 1000, usedTokens: 0, selectedBlockCount: 3, configuredSkillTokenBudget: 50, packedSectionTokens: 1.5 },
    ];
    for (const input of cases) {
      const actual = evaluateSkillContextAdmission(input);
      expect(actual).toEqual(oracle(input));
      expect(actual).not.toBe(oracle(input));
    }
  });

  it("applies existing config caps and recall limits without leaking or retaining caller data", async () => {
    enable(99999); process.env.AGENTMEMORY_SKILL_RECALL_LIMIT = "99";
    const frozen = skill({ id: "frozen", files: ["src/a.ts"], concepts: ["release"] });
    const snapshot = JSON.stringify(frozen);
    kv = mockKV([frozen]); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const input = { project: " /repo ", agentId: " agent ", files: ["src/a.ts", " src/a.ts "], concepts: ["release", " release "], limit: 99, overallBudget: 700, usedTokens: 0, selectedBlockCount: 0 };
    const first = await explain(input);
    const second = await explain(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ configuredSkillTokenBudget: 1000, effectiveSkillTokenBudget: 700, effectiveRecallLimit: 10, recallReturnedCount: 1 });
    expect(JSON.stringify(frozen)).toBe(snapshot);
    first.reasonCodes.push("context_disabled");
    expect(second.reasonCodes).toEqual(["section_admitted"]);
    expect(JSON.stringify(first)).not.toContain("frozen");
  });

  it("suppresses private instruction payloads in every rendered field and fails closed for all duplicate forms", async () => {
    enable();
    const privateRows = [
      skill({ name: "<private>name-marker</private>" }),
      skill({ triggerCondition: "<private>trigger-marker</private>" }),
      skill({ steps: ["<private>step-marker</private>"] }),
      skill({ expectedOutcome: "<private>outcome-marker</private>" }),
      skill({ antiPatterns: ["<private>anti-marker</private>"] }),
    ];
    for (const row of privateRows) {
      kv = mockKV([row]); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
      const result = await explain({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result).toMatchObject({ privateProtectedCount: 1, privacySuppressedCount: 1, recallReturnedCount: 0, state: "recall_empty" });
      expect(JSON.stringify(result)).not.toContain("marker");
    }
    const valid = skill({ id: "dup" });
    const privateValid = skill({ id: "dup", name: "<private>secret-marker</private>" });
    const malformedA = { id: "dup", name: "broken-a" };
    const malformedB = { id: "dup", triggerCondition: "broken-b" };
    const populations: unknown[][] = [
      [valid, malformedA], [malformedA, valid], [valid, privateValid], [privateValid, valid],
      [malformedA, malformedB], [malformedB, malformedA], [skill({ id: " dup " }), skill({ id: "dup" })],
    ];
    for (const rows of populations) {
      kv = mockKV(rows); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
      const result = await explain({ overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result).toMatchObject({ success: false, state: "failed", reason: "duplicate skill id", duplicateSkillIdCount: 1, recallAttempted: true, packedCount: 0, omittedCount: 0 });
      expect(JSON.stringify(result)).not.toContain("secret-marker");
    }
  });

  it("shares admission with context without changing recall trigger or outer packing behavior", async () => {
    enable(320);
    const functions = new Map<string, Function>(); const triggers: string[] = [];
    const contextSdk = {
      registerFunction: (id: string, handler: Function) => functions.set(id, handler),
      trigger: async (input: { function_id: string }) => { triggers.push(input.function_id); return { success: true, enabled: true, advisories: [advisory()] }; },
    };
    const contextKV = {
      get: async () => null,
      list: async <T>(scope: string): Promise<T[]> => scope === KV.sessions ? [] : [],
      set: async () => null, update: async () => null, delete: async () => null,
    };
    registerContextFunction(contextSdk as never, contextKV as never, 1000);
    const context = functions.get("mem::context")!;
    const admitted = await context({ sessionId: "session", project: "/repo", budget: 1000 });
    expect(triggers).toEqual(["mem::skill-recall"]);
    expect(admitted.blocks).toBe(1); expect(admitted.context).toContain("<skill-advisories");
    triggers.length = 0;
    const noBudget = await context({ sessionId: "session", project: "/repo", budget: 10 });
    expect(triggers).toEqual([]); expect(noBudget).toEqual({ context: "", blocks: 0, tokens: 0 });
  });
});
