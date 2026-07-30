import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import {
  evaluateSkillContextAdmission,
  registerSkillContextAdmissionExplainFunction,
} from "../src/functions/skill-context-admission.js";
import { evaluateSkillAdvisoryPacking, packSkillAdvisories } from "../src/functions/skill-context.js";
import { evaluateSkillRecallPopulation } from "../src/functions/skill-recall-policy.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, Lesson, Session, SkillAdvisory, SkillContextAdmissionExplainResult } from "../src/types.js";

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

function advisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  const stored = skill();
  return {
    source: "skill-advisory", skillId: stored.id, name: stored.name, triggerCondition: stored.triggerCondition,
    steps: [...stored.steps], expectedOutcome: stored.expectedOutcome, antiPatterns: [...stored.antiPatterns],
    project: stored.project, agentId: stored.agentId, files: [...stored.files], concepts: [...stored.concepts],
    confidence: stored.confidence, strength: stored.strength, score: 1,
    sourceProceduralMemoryIds: [...stored.sourceProceduralMemoryIds], ...overrides,
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function contextKV(seed: { sessions?: Session[]; lessons?: Lesson[] } = {}) {
  const accesses: Array<{ operation: string; scope: string; key?: string }> = [];
  const values = new Map<string, Map<string, unknown>>();
  for (const session of seed.sessions ?? []) {
    if (!values.has(KV.sessions)) values.set(KV.sessions, new Map());
    values.get(KV.sessions)!.set(session.id, session);
  }
  for (const lesson of seed.lessons ?? []) {
    if (!values.has(KV.lessons)) values.set(KV.lessons, new Map());
    values.get(KV.lessons)!.set(lesson.id, lesson);
  }
  return {
    accesses,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      accesses.push({ operation: "get", scope, key });
      return (values.get(scope)?.get(key) as T) ?? null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      accesses.push({ operation: "list", scope });
      return Array.from(values.get(scope)?.values() ?? []) as T[];
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      accesses.push({ operation: "set", scope, key });
      if (!values.has(scope)) values.set(scope, new Map());
      values.get(scope)!.set(key, value);
      return value;
    },
    update: async () => null,
    delete: async () => null,
  };
}

function wireContext(
  kv: ReturnType<typeof contextKV>,
  recallResult: unknown,
  tokenBudget = 1000,
) {
  const functions = new Map<string, Function>();
  const triggerRequests: Array<{ function_id: string; payload: unknown }> = [];
  const sdk = {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: async (request: { function_id: string; payload: unknown }) => {
      triggerRequests.push(request);
      return recallResult;
    },
  };
  registerContextFunction(sdk as never, kv as never, tokenBudget);
  return { handler: functions.get("mem::context")!, triggerRequests };
}

function withLegacyKVAccesses(kv: ReturnType<typeof contextKV>) {
  return kv.accesses.filter((entry) => entry.scope === KV.accessLog);
}

function lesson(id = "lesson-1", content = "Legacy lesson"): Lesson {
  return {
    id, content, context: "", confidence: 0.9, createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z", reinforcements: 1, source: "manual",
    sourceIds: [], tags: [], decayRate: 0.05,
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
    const registrations = [
      "registerSkillRecallFunction(sdk, kv)",
      "registerSkillRecallExplainFunction(sdk, kv)",
      "registerSkillRecallDiagnosticsFunction(sdk, kv)",
      "registerSkillContextExplainFunction(sdk, kv)",
      "registerSkillContextAdmissionExplainFunction(sdk, kv)",
    ].map((text) => index.indexOf(text));
    expect(registrations.every((position) => position >= 0)).toBe(true);
    expect([...registrations].sort((a, b) => a - b)).toEqual(registrations);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name === "memory_skill_context_admission_explain")).toBe(false);
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

  it("covers the complete independently calculated admission matrix", () => {
    const cases: Array<[string, Parameters<typeof evaluateSkillContextAdmission>[0]]> = [
      ["disabled", { enabled: false, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50 }],
      ["zero selected blocks", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50 }],
      ["one selected block", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 1, configuredSkillTokenBudget: 50 }],
      ["multiple selected blocks", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 3, configuredSkillTokenBudget: 50 }],
      ["remaining budget positive", { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 50 }],
      ["remaining budget exactly zero", { enabled: true, overallBudget: 10, usedTokens: 9, selectedBlockCount: 1, configuredSkillTokenBudget: 50 }],
      ["remaining budget negative", { enabled: true, overallBudget: 10, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 50 }],
      ["configured skill-budget cap", { enabled: true, overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50 }],
      ["remaining outer budget below configured cap", { enabled: true, overallBudget: 100, usedTokens: 40, selectedBlockCount: 1, configuredSkillTokenBudget: 320 }],
      ["exact section fit", { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 89 }],
      ["one token over outer budget", { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 90 }],
      ["packedSectionTokens absent", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50 }],
      ["packedSectionTokens null", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50, packedSectionTokens: null }],
      ["packedSectionTokens zero", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50, packedSectionTokens: 0 }],
      ["packedSectionTokens fractional", { enabled: true, overallBudget: 100, usedTokens: 0, selectedBlockCount: 0, configuredSkillTokenBudget: 50, packedSectionTokens: 1.5 }],
      ["positive admitted section", { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 20 }],
    ];
    for (const [name, input] of cases) expect(evaluateSkillContextAdmission(input), name).toEqual(oracle(input));
  });

  it("matches recall and packing aggregates and preserves all admission invariants", async () => {
    enable(320);
    const huge = skill({ id: "public-huge", name: "Huge", steps: ["x".repeat(4_000)], confidence: 0.95 });
    const fitting = skill({ id: "public-fit", name: "Fits", steps: ["short"], confidence: 0.9 });
    const privateRow = skill({ id: "private-id", name: "<private>private-marker</private>" });
    const malformed = { id: "malformed-id", name: "bad" };
    const rows = [huge, fitting, privateRow, malformed];
    const input = { project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 10, selectedBlockCount: 1 };
    kv = mockKV(rows); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const result = await explain(input);
    const recall = evaluateSkillRecallPopulation(rows, { project: "/repo", agentId: "agent" }, 0.7, 3);
    const packing = evaluateSkillAdvisoryPacking(recall.advisories, 320);
    expect(result).toMatchObject({
      state: "admitted", scannedCount: recall.scannedCount, validCount: recall.validCount,
      malformedCount: recall.malformedCount, privacySuppressedCount: recall.privacySuppressedCount,
      privateProtectedCount: 1, matchedCount: recall.matchedCount, recallReturnedCount: recall.returnedCount,
      recallTruncated: recall.truncated, packedCount: packing.decisions.filter((item) => item.state === "packed").length,
      omittedCount: packing.decisions.filter((item) => item.state === "omitted_budget").length,
      packedTokens: packing.tokens, sectionCreated: packing.content !== null,
    });
    expect(result.packedCount + result.omittedCount).toBe(result.recallReturnedCount);
    expect(result.sectionCreated).toBe(result.packedCount > 0);
    expect(result.sectionAdmitted).toBe(true);
    expect(result.packedTokens).toBeGreaterThan(0);
    expect(result.projectedUsedTokens).toBeLessThanOrEqual(result.overallBudget);
    expect(result.projectedBlockCount).toBe(result.selectedBlockCountBeforeSkill + 1);
    expect(result.recallAttempted).toBe(result.enabled && result.effectiveSkillTokenBudget > 0);
    expect(JSON.stringify(result)).not.toContain("public-huge");
    expect(JSON.stringify(result)).not.toContain("private-marker");
  });

  it("completes every duplicate order with one stable, non-leaking failure result", async () => {
    enable();
    const validA = skill({ id: "public-skill-id", name: "Public A" });
    const validB = skill({ id: "public-skill-id", name: "Public B" });
    const privateA = skill({ id: "public-skill-id", name: "<private>private-a</private>" });
    const privateB = skill({ id: "public-skill-id", name: "<private>private-b</private>" });
    const malformedA = { id: "public-skill-id", name: "bad-a" };
    const malformedB = { id: "public-skill-id", triggerCondition: "bad-b" };
    const shapes: Array<[unknown[], unknown[]]> = [
      [[validA, validB], [validB, validA]],
      [[validA, malformedA], [malformedA, validA]],
      [[validA, privateA], [privateA, validA]],
      [[malformedA, malformedB], [malformedB, malformedA]],
      [[privateA, privateB], [privateB, privateA]],
      [[skill({ id: " public-skill-id " }), skill({ id: "public-skill-id" })], [skill({ id: "public-skill-id" }), skill({ id: " public-skill-id " })]],
    ];
    for (const [forward, reverse] of shapes) {
      const results: SkillContextAdmissionExplainResult[] = [];
      for (const rows of [forward, reverse]) {
        kv = mockKV(rows); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
        results.push(await explain({ overallBudget: 1000, usedTokens: 7, selectedBlockCount: 2 }));
      }
      expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        success: false, state: "failed", reason: "duplicate skill id", reasonCodes: ["duplicate_skill_id"],
        recallAttempted: true, packedCount: 0, omittedCount: 0, packedTokens: 0,
        sectionCreated: false, sectionAdmitted: false, projectedUsedTokens: 7, projectedBlockCount: 2,
      });
      expect(JSON.stringify(results[0])).not.toContain("public-skill-id");
      expect(JSON.stringify(results[0])).not.toContain("private-");
    }
  });

  it("returns fresh explanation and evaluator values without mutating caller inputs", async () => {
    enable();
    const rows = [skill({ id: "fresh-id" })];
    const request = { project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 3, selectedBlockCount: 1 };
    const beforeRows = JSON.parse(JSON.stringify(rows)); const beforeRequest = JSON.parse(JSON.stringify(request));
    kv = mockKV(rows); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
    const pristine = await explain(request);
    const changed = pristine as SkillContextAdmissionExplainResult & { state: string };
    changed.reasonCodes.push("context_disabled"); changed.state = "failed"; changed.separatorTokens = -1;
    changed.remainingOverallBudget = -1; changed.effectiveSkillTokenBudget = -1; changed.packedCount = -1;
    changed.sectionAdmitted = false; changed.projectedUsedTokens = -1; changed.projectedBlockCount = -1;
    const again = await explain(request);
    expect(again).toEqual(await explain(request));
    expect(again).not.toEqual(changed);
    expect(rows).toEqual(beforeRows); expect(request).toEqual(beforeRequest);

    const evaluatorInput = { enabled: true, overallBudget: 100, usedTokens: 10, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 20 };
    const evaluatorBefore = JSON.parse(JSON.stringify(evaluatorInput));
    const evaluation = evaluateSkillContextAdmission(evaluatorInput);
    for (const key of Object.keys(evaluation) as Array<keyof typeof evaluation>) (evaluation as Record<string, unknown>)[key] = typeof evaluation[key] === "boolean" ? false : -1;
    expect(evaluateSkillContextAdmission(evaluatorInput)).toEqual(oracle(evaluatorInput));
    expect(evaluatorInput).toEqual(evaluatorBefore);
  });

  it("preserves context bytes, payloads, separators, fitting behavior, and legacy access tracking", async () => {
    enable(320);
    const session: Session = { id: "current", project: "/repo", cwd: "/repo", startedAt: "2026-07-01T00:00:00.000Z", status: "active", observationCount: 0, agentId: "agent" };
    const ordinary = advisory();
    const recallResult = { success: true, enabled: true, advisories: [ordinary] };
    const recallBefore = JSON.parse(JSON.stringify(recallResult));
    const skillOnlyKV = contextKV({ sessions: [session] });
    const skillOnly = wireContext(skillOnlyKV, recallResult);
    const section = packSkillAdvisories([ordinary], 320)!;
    const header = '<agentmemory-context project="/repo">'; const footer = "</agentmemory-context>";
    const expectedSkillOnly = `${header}\n${section.content}\n${footer}`;
    const skillOnlyResult = await skillOnly.handler({ sessionId: "current", project: "/repo", budget: 1000 });
    expect(skillOnly.triggerRequests).toEqual([{ function_id: "mem::skill-recall", payload: { project: "/repo", agentId: "agent", limit: 3 } }]);
    expect(skillOnlyResult).toEqual({ context: expectedSkillOnly, blocks: 1, tokens: estimateTokens(header) + section.tokens + estimateTokens(footer) });
    expect(recallResult).toEqual(recallBefore);

    const missingSession = wireContext(contextKV(), recallResult);
    expect(await missingSession.handler({ sessionId: "missing", project: "/repo", budget: 1000 })).toEqual({ context: expectedSkillOnly, blocks: 1, tokens: estimateTokens(header) + section.tokens + estimateTokens(footer) });
    expect(missingSession.triggerRequests).toEqual([{ function_id: "mem::skill-recall", payload: { project: "/repo", limit: 3 } }]);

    const legacy = lesson("lesson-1", "Legacy lesson");
    const legacyContent = "## Lessons Learned\n- (0.90) Legacy lesson";
    const legacyKV = contextKV({ sessions: [session], lessons: [legacy] });
    const withLegacy = wireContext(legacyKV, recallResult);
    const withLegacyResult = await withLegacy.handler({ sessionId: "current", project: "/repo", budget: 1000 });
    const expectedLegacy = `${header}\n${legacyContent}\n\n${section.content}\n${footer}`;
    expect(withLegacy.triggerRequests).toEqual([{ function_id: "mem::skill-recall", payload: { project: "/repo", agentId: "agent", limit: 3 } }]);
    expect(withLegacyResult).toEqual({ context: expectedLegacy, blocks: 2, tokens: estimateTokens(header) + estimateTokens(footer) + estimateTokens(legacyContent) + 1 + section.tokens });
    expect(withLegacyResult.context.indexOf(legacyContent)).toBeLessThan(withLegacyResult.context.indexOf("<skill-advisories"));
    expect(withLegacyResult.context.match(/<skill-advisories/g)).toHaveLength(1);

    const huge = advisory({ skillId: "oversized", name: "Oversized", steps: ["x".repeat(4_000)] });
    const fitting = advisory({ skillId: "later-fit", name: "Later fit", steps: ["short"] });
    const fittingSection = packSkillAdvisories([huge, fitting], 320)!;
    const oversizedKV = contextKV({ sessions: [session] });
    const oversized = wireContext(oversizedKV, { success: true, enabled: true, advisories: [huge, fitting] });
    const oversizedResult = await oversized.handler({ sessionId: "current", project: "/repo", budget: 1000 });
    expect(oversized.triggerRequests).toHaveLength(1);
    expect(oversizedResult).toEqual({ context: `${header}\n${fittingSection.content}\n${footer}`, blocks: 1, tokens: estimateTokens(header) + fittingSection.tokens + estimateTokens(footer) });
    expect(oversizedResult.context).not.toContain("Oversized"); expect(oversizedResult.context).toContain("Later fit");

    const legacyOnlyKV = contextKV({ sessions: [session], lessons: [legacy] });
    const noBudget = wireContext(legacyOnlyKV, recallResult);
    const legacyTokens = estimateTokens(header) + estimateTokens(footer) + estimateTokens(legacyContent);
    const noBudgetResult = await noBudget.handler({ sessionId: "current", project: "/repo", budget: legacyTokens });
    expect(noBudget.triggerRequests).toEqual([]);
    expect(noBudgetResult).toEqual({ context: `${header}\n${legacyContent}\n${footer}`, blocks: 1, tokens: legacyTokens });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const enabledAccess = withLegacyKVAccesses(legacyKV);
    const noBudgetAccess = withLegacyKVAccesses(legacyOnlyKV);
    expect(enabledAccess).toEqual(noBudgetAccess);
    expect(enabledAccess).toEqual([{ operation: "get", scope: KV.accessLog, key: "lesson-1" }, { operation: "set", scope: KV.accessLog, key: "lesson-1" }]);
    expect(enabledAccess.some((item) => item.key === "skill_release")).toBe(false);
  });

  it("keeps rows and requests immutable across representative explanation outcomes", async () => {
    enable();
    const cases: Array<{ rows: unknown[]; input: Record<string, unknown> }> = [
      { rows: [skill({ id: "admitted" })], input: { project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } },
      { rows: [], input: { overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } },
      { rows: [skill({ steps: ["x".repeat(4000)] })], input: { project: "/repo", agentId: "agent", overallBudget: 64, usedTokens: 0, selectedBlockCount: 0 } },
      { rows: [skill({ name: "<private>private-only</private>" })], input: { project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } },
      { rows: [skill({ id: "duplicate" }), skill({ id: "duplicate", name: "other" })], input: { overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } },
      { rows: [skill()], input: { overallBudget: 10, usedTokens: 11, selectedBlockCount: 0 } },
    ];
    for (const scenario of cases) {
      const rowsBefore = JSON.parse(JSON.stringify(scenario.rows)); const inputBefore = JSON.parse(JSON.stringify(scenario.input));
      kv = mockKV(scenario.rows); registerSkillContextAdmissionExplainFunction(sdk as never, kv as never);
      await explain(scenario.input);
      expect(scenario.rows).toEqual(rowsBefore); expect(scenario.input).toEqual(inputBefore);
    }
  });

  it("uses isolated mocks to prove each explanation read and trigger boundary", async () => {
    async function invoke(rows: unknown[], input: unknown, enabled: boolean, fail = false) {
      for (const key of ENV) delete process.env[key];
      if (enabled) enable();
      const localSdk = mockSdk(); const localKv = mockKV(rows);
      if (fail) localKv.failList();
      registerSkillContextAdmissionExplainFunction(localSdk as never, localKv as never);
      const result = await localSdk.functions.get("mem::skill-context-admission-explain")!(input) as SkillContextAdmissionExplainResult;
      return { result, localSdk, localKv };
    }
    const disabled = await invoke([skill()], null, false);
    const invalid = await invoke([skill()], { overallBudget: 1, usedTokens: 0 }, true);
    const noBudget = await invoke([skill()], { overallBudget: 10, usedTokens: 11, selectedBlockCount: 0 }, true);
    const positive = await invoke([skill()], { project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }, true);
    const failed = await invoke([skill()], { overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }, true, true);
    for (const scenario of [disabled, invalid, noBudget]) {
      expect(scenario.localKv.lists).toEqual([]); expect(scenario.localKv.gets).toEqual([]);
      expect(scenario.localKv.writes).toEqual([]); expect(scenario.localSdk.triggers).toEqual([]);
    }
    expect(positive.localKv.lists).toEqual([KV.skills]); expect(positive.localKv.gets).toEqual([]);
    expect(positive.localKv.writes).toEqual([]); expect(positive.localSdk.triggers).toEqual([]);
    expect(failed.localKv.lists).toEqual([KV.skills]); expect(failed.localKv.gets).toEqual([]);
    expect(failed.localKv.writes).toEqual([]); expect(failed.localSdk.triggers).toEqual([]);
    expect(failed.result).toMatchObject({ success: false, state: "failed", reasonCodes: ["storage_failure"], scannedCount: 0, packedCount: 0, sectionAdmitted: false });
  });
});
