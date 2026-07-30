import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig, recordAccessBatch } = vi.hoisted(() => ({
  loadSkillConfig: vi.fn(),
  recordAccessBatch: vi.fn(),
}));

vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));
vi.mock("../src/functions/access-tracker.js", () => ({ recordAccessBatch }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { registerContextFunction } from "../src/functions/context.js";
import { evaluateSkillContextAdmission } from "../src/functions/skill-context-admission.js";
import { evaluateSkillAdvisoryPacking } from "../src/functions/skill-context.js";
import {
  buildSkillContextRecallRequest,
  registerSkillContextRuntimeExplainFunction,
} from "../src/functions/skill-context-runtime.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillAdvisory,
  SkillContextRuntimeExplainResult,
} from "../src/types.js";

function enabledConfig(tokenBudget = 320) {
  return {
    enabled: true,
    diagnosticsEnabled: true,
    diagnosticsLimit: 50,
    recallEnabled: true,
    recallLimit: 3,
    recallMinConfidence: 0.7,
    contextEnabled: true,
    contextTokenBudget: tokenBudget,
    promotionEnabled: false,
    promotionMinStrength: 0.7,
    promotionMinEvidence: 2,
  };
}

function advisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  return {
    source: "skill-advisory",
    skillId: "skill_release",
    name: "Release validation",
    triggerCondition: "Before release",
    steps: ["Run focused tests"],
    expectedOutcome: "Green",
    antiPatterns: ["Skip tests"],
    project: "/repo",
    agentId: "agent",
    files: [],
    concepts: [],
    confidence: 0.9,
    strength: 0.8,
    score: 1,
    sourceProceduralMemoryIds: ["proc"],
    ...overrides,
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Release validation",
    triggerCondition: "Before release",
    steps: ["Run focused tests"],
    expectedOutcome: "Green",
    antiPatterns: ["Skip tests"],
    project: "/repo",
    agentId: "agent",
    files: [],
    concepts: [],
    confidence: 0.9,
    strength: 0.8,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    sourceProceduralMemoryIds: ["proc"],
    sourceCandidateIds: [],
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    version: 1,
    ...overrides,
  };
}

function mockKV(seed: Array<[string, string, unknown]> = []) {
  const values = new Map<string, Map<string, unknown>>();
  const lists: string[] = [];
  const gets: string[] = [];
  const writes: string[] = [];
  for (const [scope, key, value] of seed) {
    if (!values.has(scope)) values.set(scope, new Map());
    values.get(scope)!.set(key, value);
  }
  return {
    lists,
    gets,
    writes,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      gets.push(`${scope}:${key}`);
      return (values.get(scope)?.get(key) as T) ?? null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      lists.push(scope);
      return Array.from(values.get(scope)?.values() ?? []) as T[];
    },
    set: async () => { writes.push("set"); },
    update: async () => { writes.push("update"); },
    delete: async () => { writes.push("delete"); },
  };
}

function mockSdk() {
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let implementation: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | null = null;
  return {
    functions,
    requests,
    setTrigger: (next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) => { implementation = next; },
    registerFunction: (id: string, handler: (data: unknown) => Promise<unknown>) => functions.set(id, handler),
    trigger: async (request: { function_id: string; payload: unknown }): Promise<unknown> => {
      requests.push(request);
      if (implementation) return implementation(request);
      const handler = functions.get(request.function_id);
      if (!handler) throw new Error("missing handler");
      return handler(request.payload);
    },
  };
}

describe("skill context runtime handoff explanation", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    recordAccessBatch.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextRuntimeExplainFunction(sdk as never);
  });

  afterEach(() => vi.restoreAllMocks());

  async function explain(input: unknown): Promise<SkillContextRuntimeExplainResult> {
    return sdk.functions.get("mem::skill-context-runtime-explain")!(input) as Promise<SkillContextRuntimeExplainResult>;
  }

  it("builds fresh exact recall requests without forwarding caller-owned data", () => {
    const input = { project: " /repo ", agentId: " agent ", recallLimit: 3 };
    const beforeInput = structuredClone(input);
    const first = buildSkillContextRecallRequest(input);
    const second = buildSkillContextRecallRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-recall", payload: { project: " /repo ", agentId: " agent ", limit: 3 } });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.payload).not.toBe(first.payload);
    const mutableFirst = first as unknown as { function_id: string; payload: { project: string; agentId?: string; limit: number } };
    mutableFirst.function_id = "changed";
    mutableFirst.payload.project = "changed-project";
    mutableFirst.payload.agentId = "changed-agent";
    mutableFirst.payload.limit = 99;
    expect(input).toEqual(beforeInput);
    expect(buildSkillContextRecallRequest(input)).toEqual({
      function_id: "mem::skill-recall",
      payload: { project: " /repo ", agentId: " agent ", limit: 3 },
    });
    expect(buildSkillContextRecallRequest({ project: "/repo", agentId: "   ", recallLimit: 10 }))
      .toEqual({ function_id: "mem::skill-recall", payload: { project: "/repo", limit: 10 } });
    expect(buildSkillContextRecallRequest({ project: "/repo", recallLimit: 1 }))
      .toEqual({ function_id: "mem::skill-recall", payload: { project: "/repo", limit: 1 } });
  });

  it("registers internally, keeps public counts, and gates before validation or trigger work", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const order = [
      "registerSkillRecallFunction(sdk, kv)",
      "registerSkillRecallExplainFunction(sdk, kv)",
      "registerSkillRecallDiagnosticsFunction(sdk, kv)",
      "registerSkillContextExplainFunction(sdk, kv)",
      "registerSkillContextAdmissionExplainFunction(sdk, kv)",
      "registerSkillContextRuntimeExplainFunction(sdk)",
    ].map((text) => index.indexOf(text));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("runtime"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(explain(null)).resolves.toMatchObject({
      success: true, enabled: false, state: "disabled", reason: "skill context runtime explanation is disabled",
      recallAttempted: false,
    });
    expect(sdk.requests).toEqual([]);
  });

  it("rejects invalid input and skips exhausted budgets without triggering", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalid = [
      null, [], "x", {}, { project: "", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", agentId: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: 1.5, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: 1, usedTokens: -1, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const input of invalid) {
      await expect(explain(input)).resolves.toMatchObject({
        success: false, state: "failed", reasonCodes: ["invalid_input"], recallAttempted: false,
      });
    }
    const exhausted = await explain({ project: "/repo", overallBudget: 10, usedTokens: 11, selectedBlockCount: 1 });
    expect(exhausted).toMatchObject({
      success: true, state: "skipped_no_budget", recallAttempted: false, projectedUsedTokens: 11, projectedBlockCount: 1,
    });
    expect(sdk.requests).toEqual([]);
  });

  it("rejects the complete strict numeric input matrix before triggering", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [
      undefined, null, "1", true, false, {}, [], Number.NaN, Infinity, -Infinity, 1.5, -1,
      Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
    ];
    const invalid = [
      ...invalidNumbers.map((overallBudget) => ({ project: "/repo", overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ project: "/repo", overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount })),
      { project: "/repo", overallBudget: 0, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: -1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: 1, usedTokens: -1, selectedBlockCount: 0 },
      { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: -1 },
    ];
    for (const input of invalid) {
      await expect(explain(input)).resolves.toMatchObject({
        success: false, state: "failed", reasonCodes: ["invalid_input"], recallAttempted: false,
      });
      expect(sdk.requests).toEqual([]);
    }
  });

  it("uses exactly one normalized recall trigger and never exposes recall content", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const secret = "runtime-private-marker";
    sdk.setTrigger(async () => ({ success: true, enabled: true, advisories: [advisory({ name: secret })] }));
    const result = await explain({
      project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 2, selectedBlockCount: 1,
      query: "ignored", files: ["ignored"], concepts: ["ignored"], limit: 10,
    });
    expect(sdk.requests).toEqual([{
      function_id: "mem::skill-recall",
      payload: { project: "/repo", agentId: "agent", limit: 3 },
    }]);
    expect(result).toMatchObject({
      success: true, state: "admitted", recallAttempted: true, recallTriggerSucceeded: true,
      recallResultParsed: true, parsedAdvisoryCount: 1, packedCount: 1, omittedCount: 0,
      sectionCreated: true, sectionAdmitted: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("/repo");
    expect(JSON.stringify(result)).not.toContain("agent");
  });

  it("returns stable non-leaking failures for trigger and parser boundaries", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const failure of [new Error("secret error"), "secret string", { message: "secret object" }, null]) {
      sdk.setTrigger(async () => { throw failure; });
      const result = await explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result).toMatchObject({ success: false, state: "failed", reasonCodes: ["recall_trigger_failure"], recallAttempted: true, recallTriggerSucceeded: false, recallResultParsed: false });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    const marker = "malformed-runtime-private-marker";
    const invalidAdvisories: Array<[string, unknown]> = [
      ["null recall", null],
      ["array recall", []],
      ["false recall", false],
      ["disabled result", { success: false, enabled: true, advisories: [] }],
      ["disabled flag", { success: true, enabled: false, advisories: [] }],
      ["missing advisories", { success: true, enabled: true }],
      ["null advisories", { success: true, enabled: true, advisories: null }],
      ["object advisories", { success: true, enabled: true, advisories: {} }],
      ["string advisories", { success: true, enabled: true, advisories: "not-an-array" }],
      ["empty object advisory", { success: true, enabled: true, advisories: [{}] }],
      ["mixed advisory", { success: true, enabled: true, advisories: [advisory(), {}] }],
      ["confidence nan", { success: true, enabled: true, error: marker, advisories: [advisory({ confidence: Number.NaN })] }],
      ["confidence infinity", { success: true, enabled: true, advisories: [advisory({ confidence: Infinity })] }],
      ["confidence negative infinity", { success: true, enabled: true, advisories: [advisory({ confidence: -Infinity })] }],
      ["confidence below range", { success: true, enabled: true, advisories: [advisory({ confidence: -0.01 })] }],
      ["confidence above range", { success: true, enabled: true, advisories: [advisory({ confidence: 1.01 })] }],
      ["strength nan", { success: true, enabled: true, advisories: [advisory({ strength: Number.NaN })] }],
      ["strength infinity", { success: true, enabled: true, advisories: [advisory({ strength: Infinity })] }],
      ["strength negative infinity", { success: true, enabled: true, advisories: [advisory({ strength: -Infinity })] }],
      ["strength below range", { success: true, enabled: true, advisories: [advisory({ strength: -0.01 })] }],
      ["strength above range", { success: true, enabled: true, advisories: [advisory({ strength: 1.01 })] }],
      ["score nan", { success: true, enabled: true, advisories: [advisory({ score: Number.NaN })] }],
      ["score infinity", { success: true, enabled: true, advisories: [advisory({ score: Infinity })] }],
      ["score negative infinity", { success: true, enabled: true, advisories: [advisory({ score: -Infinity })] }],
      ["blank skill id", { success: true, enabled: true, advisories: [advisory({ skillId: "  " })] }],
      ["blank name", { success: true, enabled: true, advisories: [advisory({ name: "  " })] }],
      ["blank trigger", { success: true, enabled: true, advisories: [advisory({ triggerCondition: "  " })] }],
      ["empty steps", { success: true, enabled: true, advisories: [advisory({ steps: [] })] }],
      ["blank step", { success: true, enabled: true, advisories: [advisory({ steps: ["  "] })] }],
      ["blank expected outcome", { success: true, enabled: true, advisories: [advisory({ expectedOutcome: "  " })] }],
      ["anti patterns object", { success: true, enabled: true, advisories: [advisory({ antiPatterns: {} as never })] }],
      ["files object", { success: true, enabled: true, advisories: [advisory({ files: {} as never })] }],
      ["concepts object", { success: true, enabled: true, advisories: [advisory({ concepts: {} as never })] }],
      ["source procedural ids object", { success: true, enabled: true, advisories: [advisory({ sourceProceduralMemoryIds: {} as never })] }],
    ];
    for (const [label, raw] of invalidAdvisories) {
      sdk.setTrigger(async () => raw);
      const result = await explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result, label).toMatchObject({
        success: false,
        state: "failed",
        reason: "invalid skill recall result",
        reasonCodes: ["invalid_recall_result"],
        recallAttempted: true,
        recallTriggerSucceeded: true,
        recallResultParsed: false,
        parsedAdvisoryCount: 0,
        packedCount: 0,
        omittedCount: 0,
        packedTokens: 0,
        sectionCreated: false,
        sectionAdmitted: false,
        projectedUsedTokens: 0,
        projectedBlockCount: 0,
      });
      expect(JSON.stringify(result), label).not.toContain(marker);
    }
  });

  it("reuses shared packing and admission outcomes without mutating recall data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(320));
    const supplied = [advisory({ skillId: "too-large", steps: ["x".repeat(2000)] }), advisory({ skillId: "fits", steps: ["short"] })];
    const before = structuredClone(supplied);
    sdk.setTrigger(async () => ({ success: true, enabled: true, advisories: supplied }));
    const result = await explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    const packing = evaluateSkillAdvisoryPacking(supplied, 320);
    expect(result).toMatchObject({
      state: "admitted", parsedAdvisoryCount: 2,
      packedCount: packing.decisions.filter((item) => item.state === "packed").length,
      omittedCount: packing.decisions.filter((item) => item.state === "omitted_budget").length,
      packedTokens: packing.tokens,
    });
    expect(supplied).toEqual(before);
    result.reasonCodes.push("invalid_input");
    result.state = "failed";
    const repeated = await explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(repeated).toMatchObject({ state: "admitted", reasonCodes: ["section_admitted"] });
    const rejected = evaluateSkillContextAdmission({ enabled: true, overallBudget: 100, usedTokens: 99, selectedBlockCount: 1, configuredSkillTokenBudget: 320, packedSectionTokens: 1 });
    expect(rejected.sectionAdmitted).toBe(false);
  });

  it("matches shared packing at fitting, omitted, ordering, and exact boundaries", async () => {
    const cases = [
      { label: "one fitting", advisories: [advisory()], budget: 1000 },
      { label: "multiple fitting", advisories: [advisory({ skillId: "one" }), advisory({ skillId: "two" })], budget: 1000 },
      { label: "all omitted", advisories: [advisory({ steps: ["x".repeat(4000)] })], budget: 320 },
      { label: "first oversized later fitting", advisories: [advisory({ skillId: "large" , steps: ["x".repeat(4000)] }), advisory({ skillId: "fits" })], budget: 320 },
      { label: "middle oversized later fitting", advisories: [advisory({ skillId: "first" }), advisory({ skillId: "large", steps: ["x".repeat(4000)] }), advisory({ skillId: "last" })], budget: 1000 },
    ];
    const exactAdvisories = [advisory({ skillId: "exact" })];
    cases.push({
      label: "exact boundary",
      advisories: exactAdvisories,
      budget: evaluateSkillAdvisoryPacking(exactAdvisories, 10_000).tokens,
    });
    cases.push({
      label: "one token below exact boundary",
      advisories: exactAdvisories,
      budget: evaluateSkillAdvisoryPacking(exactAdvisories, 10_000).tokens - 1,
    });
    for (const current of cases) {
      loadSkillConfig.mockReturnValue(enabledConfig(current.budget));
      sdk.setTrigger(async () => ({ success: true, enabled: true, advisories: current.advisories }));
      const result = await explain({ project: "/repo", overallBudget: 10_000, usedTokens: 0, selectedBlockCount: 0 });
      const packing = evaluateSkillAdvisoryPacking(current.advisories, current.budget);
      const admission = evaluateSkillContextAdmission({
        enabled: true,
        overallBudget: 10_000,
        usedTokens: 0,
        selectedBlockCount: 0,
        configuredSkillTokenBudget: current.budget,
        ...(packing.content ? { packedSectionTokens: packing.tokens } : {}),
      });
      expect({
        parsedAdvisoryCount: result.parsedAdvisoryCount,
        packedCount: result.packedCount,
        omittedCount: result.omittedCount,
        packedTokens: result.packedTokens,
        sectionCreated: result.sectionCreated,
        sectionAdmitted: result.sectionAdmitted,
        projectedUsedTokens: result.projectedUsedTokens,
        projectedBlockCount: result.projectedBlockCount,
      }, current.label)
        .toEqual({
          parsedAdvisoryCount: current.advisories.length,
          packedCount: packing.decisions.filter((item) => item.state === "packed").length,
          omittedCount: packing.decisions.filter((item) => item.state === "omitted_budget").length,
          packedTokens: packing.tokens,
          sectionCreated: packing.content !== null,
          sectionAdmitted: packing.content !== null && admission.sectionAdmitted,
          projectedUsedTokens: packing.content ? admission.projectedUsedTokens : 0,
          projectedBlockCount: packing.content ? admission.projectedBlockCount : 0,
        });
    }
  });

  it("reports empty and packing-empty results with aggregate invariants", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(64));
    sdk.setTrigger(async () => ({ success: true, enabled: true, advisories: [] }));
    await expect(explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }))
      .resolves.toMatchObject({ state: "recall_empty", parsedAdvisoryCount: 0, packedCount: 0, sectionCreated: false });
    sdk.setTrigger(async () => ({ success: true, enabled: true, advisories: [advisory({ steps: ["x".repeat(4000)] })] }));
    const result = await explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(result).toMatchObject({ state: "packing_empty", parsedAdvisoryCount: 1, packedCount: 0, omittedCount: 1, packedTokens: 0, sectionCreated: false, sectionAdmitted: false });
    expect(result.projectedUsedTokens).toBe(result.usedTokensBeforeSkill);
    expect(result.projectedBlockCount).toBe(result.selectedBlockCountBeforeSkill);
  });

  it("integrates the actual recall chain with one skills list and no runtime-owned KV access", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const kv = mockKV([[KV.skills, "skill_release", skill()]]);
    const chain = mockSdk();
    registerSkillRecallFunction(chain as never, kv as never);
    registerSkillContextRuntimeExplainFunction(chain as never);
    const handler = chain.functions.get("mem::skill-context-runtime-explain")!;
    const result = await handler({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }) as SkillContextRuntimeExplainResult;
    expect(result).toMatchObject({ state: "admitted", recallAttempted: true, recallResultParsed: true });
    expect(chain.requests.map((item) => item.function_id)).toEqual(["mem::skill-recall"]);
    expect(kv.lists).toEqual([KV.skills]);
    expect(kv.gets).toEqual([]);
    expect(kv.writes).toEqual([]);

    const noBudgetKV = mockKV([[KV.skills, "skill_release", skill()]]);
    const noBudgetChain = mockSdk();
    registerSkillRecallFunction(noBudgetChain as never, noBudgetKV as never);
    registerSkillContextRuntimeExplainFunction(noBudgetChain as never);
    const noBudget = await noBudgetChain.functions.get("mem::skill-context-runtime-explain")!({
      project: "/repo", overallBudget: 10, usedTokens: 10, selectedBlockCount: 0,
    }) as SkillContextRuntimeExplainResult;
    expect(noBudget).toMatchObject({ state: "skipped_no_budget", recallAttempted: false });
    expect(noBudgetChain.requests).toEqual([]);
    expect(noBudgetKV.lists).toEqual([]);
    expect(noBudgetKV.gets).toEqual([]);
    expect(noBudgetKV.writes).toEqual([]);
  });

  it("keeps mem::context recall requests identical to the shared builder", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const kv = mockKV([[KV.sessions, "session", { id: "session", project: "/repo", startedAt: "2026-07-01T00:00:00.000Z", agentId: "agent" }]]);
    const contextSdk = mockSdk();
    contextSdk.setTrigger(async () => ({ success: true, enabled: true, advisories: [] }));
    registerContextFunction(contextSdk as never, kv as never, 1000);
    const context = contextSdk.functions.get("mem::context")!;
    await context({ sessionId: "session", project: "/repo" });
    await context({ sessionId: "missing", project: "/repo" });
    expect(contextSdk.requests).toEqual([
      buildSkillContextRecallRequest({ project: "/repo", agentId: "agent", recallLimit: 3 }),
      buildSkillContextRecallRequest({ project: "/repo", recallLimit: 3 }),
    ]);
    expect(recordAccessBatch).not.toHaveBeenCalled();
  });

  it("keeps caller and recall values private, immutable, and independently allocated", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const markers = {
      project: "project-private-marker",
      agent: "agent-private-marker",
      skillId: "skill-private-marker",
      name: "name-private-marker",
      trigger: "trigger-private-marker",
      step: "step-private-marker",
      outcome: "outcome-private-marker",
      antiPattern: "anti-private-marker",
      file: "file-private-marker",
      concept: "concept-private-marker",
      sourceProceduralMemoryId: "source-procedural-private-marker",
      error: "error-private-marker",
    };
    const input = {
      project: markers.project,
      agentId: markers.agent,
      overallBudget: 1000,
      usedTokens: 0,
      selectedBlockCount: 0,
    };
    const raw = {
      success: true,
      enabled: true,
      error: markers.error,
      advisories: [advisory({
        skillId: markers.skillId,
        name: markers.name,
        triggerCondition: markers.trigger,
        steps: [markers.step],
        expectedOutcome: markers.outcome,
        antiPatterns: [markers.antiPattern],
        files: [markers.file],
        concepts: [markers.concept],
        sourceProceduralMemoryIds: [markers.sourceProceduralMemoryId],
      })],
    };
    const beforeInput = structuredClone(input);
    const beforeRaw = structuredClone(raw);
    sdk.setTrigger(async () => raw);
    const result = await explain(input);
    expect(input).toEqual(beforeInput);
    expect(raw).toEqual(beforeRaw);
    for (const marker of Object.values(markers)) expect(JSON.stringify(result)).not.toContain(marker);
    for (const key of [
      "project", "agentId", "request", "payload", "advisories", "skillId", "name", "triggerCondition",
      "steps", "expectedOutcome", "antiPatterns", "files", "concepts", "confidence", "strength", "score",
      "sourceProceduralMemoryIds", "error",
    ]) expect(result).not.toHaveProperty(key);
    const mutable = result as unknown as Record<string, unknown>;
    mutable.reasonCodes = ["invalid_input"];
    mutable.state = "failed";
    mutable.overallBudget = -1;
    mutable.usedTokensBeforeSkill = -1;
    mutable.selectedBlockCountBeforeSkill = -1;
    mutable.configuredSkillTokenBudget = -1;
    mutable.separatorTokens = -1;
    mutable.remainingOverallBudget = -1;
    mutable.effectiveSkillTokenBudget = -1;
    mutable.effectiveRecallLimit = -1;
    mutable.recallAttempted = false;
    mutable.recallTriggerSucceeded = false;
    mutable.recallResultParsed = false;
    mutable.parsedAdvisoryCount = -1;
    mutable.packedCount = -1;
    mutable.omittedCount = -1;
    mutable.packedTokens = -1;
    mutable.sectionCreated = false;
    mutable.sectionAdmitted = false;
    mutable.projectedUsedTokens = -1;
    mutable.projectedBlockCount = -1;
    const pristine = await explain(input);
    expect(pristine).toMatchObject({
      state: "admitted",
      reasonCodes: ["section_admitted"],
      overallBudget: 1000,
      recallAttempted: true,
      recallTriggerSucceeded: true,
      recallResultParsed: true,
      packedCount: 1,
      sectionAdmitted: true,
    });
    sdk.setTrigger(async () => { throw new Error(markers.error); });
    const failure = await explain(input);
    expect(JSON.stringify(failure)).not.toContain(markers.error);
  });

  it("does not mutate independent fixtures for every runtime outcome", async () => {
    const input = () => ({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    const nestedAdvisory = (overrides: Partial<SkillAdvisory> = {}) => advisory({
      steps: ["nested step"],
      antiPatterns: ["nested anti-pattern"],
      files: ["nested-file.ts"],
      concepts: ["nested concept"],
      sourceProceduralMemoryIds: ["nested-procedural-id"],
      ...overrides,
    });
    const cases: Array<{
      label: string;
      config: ReturnType<typeof enabledConfig>;
      expectedState: SkillContextRuntimeExplainResult["state"];
      raw?: () => unknown;
      thrown?: () => unknown;
    }> = [
      {
        label: "admitted",
        config: enabledConfig(1000),
        expectedState: "admitted",
        raw: () => ({ success: true, enabled: true, advisories: [nestedAdvisory()] }),
      },
      {
        label: "recall empty",
        config: enabledConfig(1000),
        expectedState: "recall_empty",
        raw: () => ({ success: true, enabled: true, advisories: [] }),
      },
      {
        label: "packing empty",
        config: enabledConfig(64),
        expectedState: "packing_empty",
        raw: () => ({ success: true, enabled: true, advisories: [nestedAdvisory({ steps: ["x".repeat(4000)] })] }),
      },
      {
        label: "invalid recall result",
        config: enabledConfig(1000),
        expectedState: "failed",
        raw: () => ({ success: true, enabled: true, advisories: [nestedAdvisory({ confidence: Number.NaN })] }),
      },
      {
        label: "trigger failure",
        config: enabledConfig(1000),
        expectedState: "failed",
        thrown: () => ({ message: "nested thrown marker", nested: { reason: "unchanged" } }),
      },
    ];
    for (const current of cases) {
      loadSkillConfig.mockReturnValue(current.config);
      const currentInput = input();
      const beforeInput = structuredClone(currentInput);
      if (current.raw) {
        const raw = current.raw();
        const beforeRaw = structuredClone(raw);
        sdk.setTrigger(async () => raw);
        const result = await explain(currentInput);
        expect(result.state, current.label).toBe(current.expectedState);
        expect(currentInput, current.label).toEqual(beforeInput);
        expect(raw, current.label).toEqual(beforeRaw);
        continue;
      }
      const thrown = current.thrown!();
      const beforeThrown = structuredClone(thrown);
      sdk.setTrigger(async () => { throw thrown; });
      const result = await explain(currentInput);
      expect(result.state, current.label).toBe(current.expectedState);
      expect(currentInput, current.label).toEqual(beforeInput);
      expect(thrown, current.label).toEqual(beforeThrown);
    }

    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const noBudgetInput = { ...input(), overallBudget: 10, usedTokens: 10 };
    const beforeNoBudgetInput = structuredClone(noBudgetInput);
    const requestCount = sdk.requests.length;
    const noBudget = await explain(noBudgetInput);
    expect(noBudget.state).toBe("skipped_no_budget");
    expect(noBudgetInput).toEqual(beforeNoBudgetInput);
    expect(sdk.requests).toHaveLength(requestCount);
  });
});
