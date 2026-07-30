import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { registerSkillContextExplainFunction } from "../src/functions/skill-context-explain.js";
import {
  evaluateSkillAdvisoryPacking,
  packSkillAdvisories,
  renderSkillAdvisory,
} from "../src/functions/skill-context.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillAdvisory,
  SkillContextExplainResult,
  SkillContextPackingDecision,
} from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_CONTEXT",
  "AGENTMEMORY_SKILL_RECALL_LIMIT",
  "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE",
  "AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET",
];
const ORIGINAL: Record<string, string | undefined> = {};
const LEGACY_SECTION_OPENING = [
  '<skill-advisories source="agentmemory" mode="advisory">',
  "Advisory checklists only. Apply them only when relevant; do not execute automatically.",
].join("\n");
const LEGACY_SECTION_CLOSING = "</skill-advisories>";

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

function legacyEstimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function legacyRenderSection(rendered: string[]): string {
  return `${LEGACY_SECTION_OPENING}\n${rendered.join("\n\n")}\n${LEGACY_SECTION_CLOSING}`;
}

function legacyPack(advisories: readonly SkillAdvisory[], tokenBudget: number): {
  result: { content: string; tokens: number } | null;
  decisions: SkillContextPackingDecision[];
  selectedSkillIds: string[];
} {
  const selected: string[] = [];
  const selectedSkillIds: string[] = [];
  const decisions: SkillContextPackingDecision[] = [];
  for (const [index, current] of advisories.entries()) {
    const rendered = renderSkillAdvisory(current);
    const candidateSectionTokens = legacyEstimateTokens(legacyRenderSection([...selected, rendered]));
    const packed = candidateSectionTokens <= tokenBudget;
    if (packed) {
      selected.push(rendered);
      selectedSkillIds.push(current.skillId);
    }
    decisions.push({
      skillId: current.skillId,
      recallRank: index + 1,
      state: packed ? "packed" : "omitted_budget",
      reasonCodes: [packed ? "packed" : "exceeds_token_budget"],
      renderedAdvisoryTokens: legacyEstimateTokens(rendered),
      candidateSectionTokens,
      ...(packed ? { packedPosition: selected.length } : {}),
    });
  }
  if (selected.length === 0) return { result: null, decisions, selectedSkillIds };
  const content = legacyRenderSection(selected);
  return { result: { content, tokens: legacyEstimateTokens(content) }, decisions, selectedSkillIds };
}

function assertPackerParity(advisories: SkillAdvisory[], tokenBudget: number): ReturnType<typeof legacyPack> {
  const expected = legacyPack(advisories, tokenBudget);
  const evaluation = evaluateSkillAdvisoryPacking(advisories, tokenBudget);
  const ordinary = packSkillAdvisories(advisories, tokenBudget);
  expect(ordinary).toEqual(expected.result);
  expect({ content: evaluation.content, tokens: evaluation.tokens }).toEqual(expected.result === null
    ? { content: null, tokens: 0 }
    : expected.result);
  expect(evaluation.decisions).toEqual(expected.decisions);
  expect(evaluation.decisions.filter((item) => item.state === "packed").map((item) => item.skillId))
    .toEqual(expected.selectedSkillIds);
  return expected;
}

function assertPackingInvariants(result: SkillContextExplainResult): void {
  expect(result.packedCount + result.omittedCount).toBe(result.recallReturnedCount);
  expect(result.items).toHaveLength(result.recallReturnedCount);
  expect(result.items.map((item) => item.recallRank)).toEqual(result.items.map((_, index) => index + 1));
  const packed = result.items.filter((item) => item.state === "packed");
  expect(packed.map((item) => item.packedPosition)).toEqual(packed.map((_, index) => index + 1));
  for (const item of result.items.filter((item) => item.state === "omitted_budget")) {
    expect(item.packedPosition).toBeUndefined();
  }
}

function duplicateShape(result: SkillContextExplainResult) {
  return {
    success: result.success,
    reason: result.reason,
    items: result.items,
    packedCount: result.packedCount,
    omittedCount: result.omittedCount,
    packedTokens: result.packedTokens,
    sectionCreated: result.sectionCreated,
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

  function enableContext(tokenBudget = 1000): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_RECALL"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET"] = String(tokenBudget);
  }

  async function explain(input: unknown): Promise<SkillContextExplainResult> {
    return sdk.functions.get("mem::skill-context-explain")!(input) as Promise<SkillContextExplainResult>;
  }

  it("registers internally, preserves public counts, and gates before validation or storage", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index.indexOf("registerSkillRecallFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillRecallExplainFunction(sdk, kv)"));
    expect(index.indexOf("registerSkillRecallExplainFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillRecallDiagnosticsFunction(sdk, kv)"));
    expect(index.indexOf("registerSkillRecallDiagnosticsFunction(sdk, kv)")).toBeLessThan(index.indexOf("registerSkillContextExplainFunction(sdk, kv)"));
    expect(sdk.functions.has("mem::skill-context-explain")).toBe(true);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("context_explain"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");

    await expect(explain({ tokenBudget: 0 })).resolves.toMatchObject({
      success: true, enabled: false, applied: false, reason: "skill context explanation is disabled", items: [],
    });
    expect(kv.listScopes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("rejects every invalid input before storage and retains valid request boundaries", async () => {
    enableContext();
    const invalid = [
      null, [], "value", { files: "bad" }, { tokenBudget: "1" }, { tokenBudget: true },
      { tokenBudget: {} }, { tokenBudget: [] }, { tokenBudget: 0 }, { tokenBudget: -1 },
      { tokenBudget: 1.5 }, { tokenBudget: Number.NaN }, { tokenBudget: Infinity },
      { tokenBudget: -Infinity }, { tokenBudget: 1001 },
    ];
    for (const input of invalid) {
      await expect(explain(input)).resolves.toMatchObject({
        success: false, enabled: true, reason: "invalid skill context explanation input", items: [],
      });
    }
    kv = mockKV([skill()]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    for (const tokenBudget of [1, 1000]) {
      const result = await explain({ tokenBudget });
      expect(result).toMatchObject({ success: true, requestedTokenBudget: tokenBudget, effectiveTokenBudget: tokenBudget });
    }
    expect(kv.listScopes).toEqual([KV.skills, KV.skills]);
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
      success: false, reason: "failed to load skill context explanation", scannedCount: 0,
      requestedTokenBudget: 1, effectiveTokenBudget: 1, items: [],
    });
    expect(kv.listScopes).toEqual([KV.skills]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("matches the independent legacy packer across the full parity matrix", () => {
    const fitting = advisory({ skillId: "fit" });
    const second = advisory({ skillId: "second", name: "Second release validation", antiPatterns: [], sourceProceduralMemoryIds: [] });
    const huge = advisory({ skillId: "huge", steps: ["x".repeat(4_000)] });
    const xml = advisory({ skillId: "xml", name: '<xml & "advisory">', triggerCondition: "<trigger &>" });
    const oneTokens = legacyPack([fitting], 1000).decisions[0]!.candidateSectionTokens;
    const multipleTokens = legacyEstimateTokens(legacyRenderSection([renderSkillAdvisory(fitting), renderSkillAdvisory(second)]));
    const firstOmittedLaterFitsBudget = legacyPack([fitting], 1000).decisions[0]!.candidateSectionTokens;
    const scenarios: Array<{ name: string; advisories: SkillAdvisory[]; budget: number }> = [
      { name: "empty", advisories: [], budget: 1 },
      { name: "one fitting", advisories: [fitting], budget: oneTokens },
      { name: "multiple fitting", advisories: [fitting, second], budget: multipleTokens },
      { name: "none fitting", advisories: [fitting], budget: oneTokens - 1 },
      { name: "first omitted later fitting", advisories: [huge, fitting], budget: firstOmittedLaterFitsBudget },
      { name: "middle omitted later fitting", advisories: [fitting, huge, second], budget: multipleTokens },
      { name: "all omitted", advisories: [huge, advisory({ skillId: "also-huge", steps: ["y".repeat(4_000)] })], budget: oneTokens },
      { name: "exact boundary", advisories: [fitting], budget: oneTokens },
      { name: "one below boundary", advisories: [fitting], budget: oneTokens - 1 },
      { name: "xml sensitive", advisories: [xml], budget: legacyPack([xml], 1000).decisions[0]!.candidateSectionTokens },
      { name: "optional fields", advisories: [fitting, second], budget: multipleTokens },
    ];
    for (const scenario of scenarios) {
      const expected = assertPackerParity(scenario.advisories, scenario.budget);
      expect(expected.decisions.map((item) => item.recallRank)).toEqual(scenario.advisories.map((_, index) => index + 1));
      expect(expected.decisions.filter((item) => item.state === "packed").map((item) => item.packedPosition))
        .toEqual(expected.selectedSkillIds.map((_, index) => index + 1));
    }
  });

  it("derives section overhead from independent structural bytes for empty, one, and multiple packing", () => {
    const expectedOverhead = legacyEstimateTokens(legacyRenderSection([]));
    const fitting = advisory({ skillId: "fit" });
    const second = advisory({ skillId: "second", name: "Second release validation" });
    const budgets = [1, legacyPack([fitting], 1000).decisions[0]!.candidateSectionTokens,
      legacyEstimateTokens(legacyRenderSection([renderSkillAdvisory(fitting), renderSkillAdvisory(second)]))];
    const populations = [[], [fitting], [fitting, second]];
    for (const [index, population] of populations.entries()) {
      const evaluation = evaluateSkillAdvisoryPacking(population, budgets[index]!);
      expect(evaluation.sectionOverheadTokens).toBe(expectedOverhead);
    }
  });

  it("caps configured token budget and compares explanation results to the independent oracle", async () => {
    enableContext(320);
    const oversized = skill({ id: "oversized", name: "Release oversized", confidence: 0.99, steps: ["x".repeat(4_000)] });
    const fitting = skill({ id: "fitting", name: "Release fitting", confidence: 0.8 });
    kv = mockKV([oversized, fitting]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const advisories = [
      advisory({ skillId: "oversized", name: "Release oversized", confidence: 0.99, steps: ["x".repeat(4_000)] }),
      advisory({ skillId: "fitting", name: "Release fitting", confidence: 0.8 }),
    ];
    const expectedAtCap = legacyPack(advisories, 320);
    const capped = await explain({ project: "/repo/a", agentId: "agent_a", query: "release", tokenBudget: 1000 });
    expect(capped).toMatchObject({ configuredTokenBudget: 320, requestedTokenBudget: 1000, effectiveTokenBudget: 320 });
    expect(capped.items).toEqual(expectedAtCap.decisions);
    expect(capped.packedTokens).toBe(expectedAtCap.result?.tokens ?? 0);
    assertPackingInvariants(capped);

    const belowConfigured = await explain({ project: "/repo/a", agentId: "agent_a", query: "release", tokenBudget: 300 });
    const expectedBelow = legacyPack(advisories, 300);
    expect(belowConfigured).toMatchObject({ configuredTokenBudget: 320, requestedTokenBudget: 300, effectiveTokenBudget: 300 });
    expect(belowConfigured.items).toEqual(expectedBelow.decisions);
    expect(belowConfigured.packedTokens).toBe(expectedBelow.result?.tokens ?? 0);
    assertPackingInvariants(belowConfigured);
  });

  it("is deterministic across persisted row order with one list and no side effects", async () => {
    enableContext();
    const huge = skill({ id: "a-huge", name: "Release huge", confidence: 0.99, steps: ["x".repeat(4_000)] });
    const one = skill({ id: "b-one", name: "Release one", confidence: 0.9 });
    const two = skill({ id: "c-two", name: "Release two", confidence: 0.8, antiPatterns: [] });
    const privateRow = skill({ id: "private", name: "<private>private-marker</private>", confidence: 0.95 });
    const malformed = { id: "broken", name: "Release broken" };
    const rows = [huge, one, two, privateRow, malformed];
    const advisories = [
      advisory({ skillId: "a-huge", name: "Release huge", confidence: 0.99, steps: ["x".repeat(4_000)] }),
      advisory({ skillId: "b-one", name: "Release one", confidence: 0.9 }),
      advisory({ skillId: "c-two", name: "Release two", confidence: 0.8, antiPatterns: [] }),
    ];
    const budget = legacyEstimateTokens(legacyRenderSection([renderSkillAdvisory(advisories[1]!), renderSkillAdvisory(advisories[2]!)]));
    const expected = legacyPack(advisories, budget);
    const orders = [rows, [...rows].reverse(), [rows[2]!, rows[4]!, rows[0]!, rows[3]!, rows[1]!]];
    const results: SkillContextExplainResult[] = [];
    for (const orderedRows of orders) {
      kv = mockKV(orderedRows);
      registerSkillContextExplainFunction(sdk as never, kv as never);
      const result = await explain({ project: "/repo/a", agentId: "agent_a", query: "release", tokenBudget: budget });
      expect(kv.listScopes).toEqual([KV.skills]);
      expect(kv.getScopes).toEqual([]);
      expect(kv.writes).toEqual([]);
      expect(sdk.triggers).toEqual([]);
      expect(result.items).toEqual(expected.decisions);
      expect(result).toMatchObject({ recallReturnedCount: 3, privateProtectedCount: 1, malformedCount: 1 });
      assertPackingInvariants(result);
      results.push(result);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("fails closed deterministically for every duplicate shape without leaking rows", async () => {
    enableContext();
    const valid = skill({ id: "dup" });
    const privateValid = skill({ id: "dup", name: "<private>secret-marker</private>" });
    const malformedA = { id: "dup", name: "broken-a" };
    const malformedB = { id: "dup", triggerCondition: "broken-b" };
    const duplicatePopulations: Array<[unknown[], unknown[]]> = [
      [[valid, malformedA], [malformedA, valid]],
      [[valid, privateValid], [privateValid, valid]],
      [[malformedA, malformedB], [malformedB, malformedA]],
      [[skill({ id: " dup " }), skill({ id: "dup" })], [skill({ id: "dup" }), skill({ id: " dup " })]],
      [[skill({ id: "dup" }), skill({ id: "dup", name: "Other" })], [skill({ id: "dup", name: "Other" }), skill({ id: "dup" })]],
      [[privateValid, skill({ id: "dup", name: "<private>other-secret</private>" })], [skill({ id: "dup", name: "<private>other-secret</private>" }), privateValid]],
    ];
    for (const [forward, reverse] of duplicatePopulations) {
      const results: SkillContextExplainResult[] = [];
      for (const rows of [forward, reverse]) {
        kv = mockKV(rows);
        registerSkillContextExplainFunction(sdk as never, kv as never);
        const result = await explain({});
        expect(duplicateShape(result)).toEqual({
          success: false, reason: "duplicate skill id", items: [], packedCount: 0,
          omittedCount: 0, packedTokens: 0, sectionCreated: false,
        });
        expect(kv.listScopes).toEqual([KV.skills]);
        expect(kv.getScopes).toEqual([]);
        expect(kv.writes).toEqual([]);
        expect(sdk.triggers).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('"dup"');
        expect(JSON.stringify(result)).not.toContain('"private"');
        expect(JSON.stringify(result)).not.toContain("secret-marker");
        results.push(result);
      }
      expect(results[1]).toEqual(results[0]);
    }
  });

  it("returns fresh allocations and does not mutate persisted rows or inputs", async () => {
    enableContext();
    const successfulRows = [skill()];
    kv = mockKV(successfulRows);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release", tokenBudget: 1000 };
    const inputBefore = structuredClone(input);
    const rowsBefore = structuredClone(successfulRows);
    const first = await explain(input);
    first.items.push({ ...first.items[0]!, skillId: "mutated", reasonCodes: ["exceeds_token_budget"] });
    first.items[0]!.skillId = "mutated";
    first.items[0]!.reasonCodes[0] = "exceeds_token_budget";
    expect(successfulRows).toEqual(rowsBefore);
    expect(input).toEqual(inputBefore);
    const pristine = await explain(input);
    expect(pristine.items).toHaveLength(1);
    expect(pristine.items[0]).toMatchObject({ skillId: "skill_release", reasonCodes: ["packed"] });

    const direct = evaluateSkillAdvisoryPacking([advisory()], 1000);
    direct.decisions.push({ ...direct.decisions[0]!, skillId: "mutated", reasonCodes: ["packed"] });
    direct.decisions[0]!.skillId = "mutated";
    direct.decisions[0]!.reasonCodes[0] = "exceeds_token_budget";
    expect(evaluateSkillAdvisoryPacking([advisory()], 1000).decisions[0]).toMatchObject({ skillId: "skill_release", reasonCodes: ["packed"] });
    expect(packSkillAdvisories([advisory()], 1000)).toEqual(legacyPack([advisory()], 1000).result);

    for (const sample of [
      { rows: [skill({ id: "private", name: "<private>hidden</private>" })], request: {} },
      { rows: [skill({ id: "dup" }), { id: "dup", name: "broken" }], request: {} },
    ]) {
      const rowsBeforeInvocation = structuredClone(sample.rows);
      const requestBeforeInvocation = structuredClone(sample.request);
      kv = mockKV(sample.rows);
      registerSkillContextExplainFunction(sdk as never, kv as never);
      await explain(sample.request);
      expect(sample.rows).toEqual(rowsBeforeInvocation);
      expect(sample.request).toEqual(requestBeforeInvocation);
    }
  });

  it("suppresses private instructions and handles no recalled advisories without packing", async () => {
    enableContext();
    const markers = ["private-name", "private-trigger", "private-step", "private-outcome", "private-anti"];
    const privateRows = [
      skill({ id: "private-name", name: `<private>${markers[0]}</private>` }),
      skill({ id: "private-trigger", triggerCondition: `<private>${markers[1]}</private>` }),
      skill({ id: "private-step", steps: [`<private>${markers[2]}</private>`] }),
      skill({ id: "private-outcome", expectedOutcome: `<private>${markers[3]}</private>` }),
      skill({ id: "private-anti", antiPatterns: [`<private>${markers[4]}</private>`] }),
    ];
    kv = mockKV([skill({ concepts: ["other"], files: ["other.ts"] }), ...privateRows]);
    registerSkillContextExplainFunction(sdk as never, kv as never);
    const safe = await explain({ query: "release" });
    expect(safe).toMatchObject({ success: true, recallReturnedCount: 0, packedCount: 0, omittedCount: 0, packedTokens: 0, sectionCreated: false, items: [], privateProtectedCount: 5 });
    for (const marker of markers) expect(JSON.stringify(safe)).not.toContain(marker);
    assertPackingInvariants(safe);
  });
});
