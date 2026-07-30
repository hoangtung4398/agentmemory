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
    const first = buildSkillContextRecallRequest(input);
    const second = buildSkillContextRecallRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-recall", payload: { project: " /repo ", agentId: " agent ", limit: 3 } });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.payload).not.toBe(first.payload);
    first.payload.project = "changed";
    expect(buildSkillContextRecallRequest(input).payload.project).toBe(" /repo ");
    expect(buildSkillContextRecallRequest({ project: "/repo", agentId: "   ", recallLimit: 10 }))
      .toEqual({ function_id: "mem::skill-recall", payload: { project: "/repo", limit: 10 } });
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
    for (const raw of [null, [], false, { success: false, enabled: true, advisories: [] }, { success: true, enabled: false, advisories: [] }, { success: true, enabled: true, advisories: [{}] }]) {
      sdk.setTrigger(async () => raw);
      await expect(explain({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }))
        .resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_recall_result"], recallTriggerSucceeded: true, recallResultParsed: false });
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
});
