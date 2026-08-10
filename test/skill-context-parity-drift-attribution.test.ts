import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));

vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  attributeSkillContextParityCodes,
  buildSkillContextParityDriftAttributionRequest,
  registerSkillContextParityDriftAttributionDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-attribution.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillContextParityStabilityDiagnosticsFunction } from "../src/functions/skill-context-parity-stability.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillContextParityDriftAttributionDiagnosticsResult,
  SkillContextParityMismatchCode,
  SkillContextParityStabilityDiagnosticsResult,
  SkillContextParityStabilitySampleSummary,
} from "../src/types.js";

function enabledConfig(tokenBudget = 320) {
  return {
    enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3,
    recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget,
    promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2,
  };
}

function summary(overrides: Partial<SkillContextParityStabilitySampleSummary> = {}): SkillContextParityStabilitySampleSummary {
  return {
    success: true, enabled: true, state: "consistent", comparisonAvailable: true, consistent: true, mismatchCodes: [], ...overrides,
  };
}

function stabilityResult(
  state: "disabled" | "failed" | "stable_consistent" | "stable_mismatch" | "observed_drift" = "stable_consistent",
  overrides: Record<string, unknown> = {},
): SkillContextParityStabilityDiagnosticsResult {
  const consistent = summary();
  const mismatch = summary({ state: "mismatch", consistent: false, mismatchCodes: ["packed_tokens_mismatch"] });
  const values = state === "stable_mismatch" ? { first: mismatch, second: mismatch, stableAcrossSamples: true, repeatableMismatch: true, reasonCodes: ["stable_mismatch_observed"] } :
    state === "observed_drift" ? { first: consistent, second: consistent, stableAcrossSamples: false, repeatableMismatch: false, reasonCodes: ["sample_drift_observed"] } :
    state === "disabled" ? { success: true, enabled: false, firstTriggerAttempted: false, firstTriggerSucceeded: false, firstResultParsed: false, secondTriggerAttempted: false, secondTriggerSucceeded: false, secondResultParsed: false, first: null, second: null, stableAcrossSamples: false, repeatableMismatch: false, reasonCodes: ["context_disabled"] } :
    state === "failed" ? { success: false, firstTriggerAttempted: true, firstTriggerSucceeded: false, firstResultParsed: false, secondTriggerAttempted: true, secondTriggerSucceeded: true, secondResultParsed: true, first: null, second: consistent, stableAcrossSamples: false, repeatableMismatch: false, reasonCodes: ["first_trigger_failure"] } :
    { first: consistent, second: consistent, stableAcrossSamples: true, repeatableMismatch: false, reasonCodes: ["stable_consistency_observed"] };
  return {
    success: true, enabled: true, applied: false, state, reasonCodes: ["stable_consistency_observed"],
    samplingMode: "sequential_double_sample_non_atomic", sampleCount: 2,
    firstTriggerAttempted: true, firstTriggerSucceeded: true, firstResultParsed: true,
    secondTriggerAttempted: true, secondTriggerSucceeded: true, secondResultParsed: true,
    first: consistent, second: consistent, directDriftCodes: [], runtimeDriftCodes: [], stableAcrossSamples: true, repeatableMismatch: false,
    ...values, ...overrides,
  } as SkillContextParityStabilityDiagnosticsResult;
}

function mockSdk() {
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let implementation: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | null = null;
  return {
    functions, requests,
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

function mockKV(rows: unknown[] = []) {
  const lists: string[] = [];
  const gets: string[] = [];
  const writes: string[] = [];
  return {
    lists, gets, writes,
    list: async <T>(scope: string): Promise<T[]> => { lists.push(scope); return rows as T[]; },
    get: async <T>(scope: string): Promise<T | null> => { gets.push(scope); return null; },
    set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); },
  };
}

function skill(): AgentSkill {
  return {
    id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"],
    expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [],
    confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0,
    sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [],
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, ...overrides };
}

describe("skill context parity drift attribution diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk as never);
  });

  async function diagnose(input: unknown): Promise<SkillContextParityDriftAttributionDiagnosticsResult> {
    return sdk.functions.get("mem::skill-context-parity-drift-attribution-diagnostics")!(input) as Promise<SkillContextParityDriftAttributionDiagnosticsResult>;
  }

  it("is internal, registers after Phase 5G, and preserves public counts", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const names = [
      "registerSkillContextParityDiagnosticsFunction(sdk)",
      "registerSkillContextParityStabilityDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)",
    ];
    const positions = names.map((name) => index.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("attribution"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(diagnose(Symbol("private"))).resolves.toMatchObject({
      success: true, enabled: false, applied: false, state: "disabled", reasonCodes: ["context_disabled"],
      attributionAvailable: false, stabilityTriggerAttempted: false,
    });
    expect(sdk.requests).toEqual([]);
  });

  it("builds one fresh normalized stability request without ignored inputs", () => {
    const input = { project: " /repo ", agentId: " agent ", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 };
    const before = structuredClone(input);
    const first = buildSkillContextParityDriftAttributionRequest(input);
    const second = buildSkillContextParityDriftAttributionRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-stability-diagnostics", payload: input });
    expect(first).not.toBe(second);
    expect(first.payload).not.toBe(second.payload);
    first.payload.project = "mutated";
    first.payload.agentId = "mutated";
    first.payload.overallBudget = 2;
    expect(input).toEqual(before);
    expect(buildSkillContextParityDriftAttributionRequest({ project: "/repo", agentId: "   ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: 0 }).payload).not.toHaveProperty("agentId");
  });

  it("gates before validation and rejects invalid input without a trigger", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [undefined, null, "1", true, {}, [], Number.NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1];
    const invalid = [null, [], "x", 1, true, Symbol("private"), {},
      { project: "", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", agentId: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      ...invalidNumbers.map((overallBudget) => ({ project: "/repo", overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ project: "/repo", overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount })),
    ];
    for (const input of invalid) {
      sdk.requests.length = 0;
      await expect(diagnose(input)).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"], stabilityTriggerAttempted: false });
      expect(sdk.requests).toEqual([]);
    }
  });

  it("maps repeatable mismatch and drift codes to canonical fixed stages", () => {
    expect(attributeSkillContextParityCodes(["packed_tokens_mismatch"])).toEqual({
      stages: ["packing"], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 1, admission: 0 },
    });
    const all: SkillContextParityMismatchCode[] = ["path_success_mismatch", "overall_budget_mismatch", "effective_recall_limit_mismatch", "packed_count_mismatch", "section_admitted_mismatch"];
    expect(attributeSkillContextParityCodes(all)).toEqual({
      stages: ["path_contract", "budget", "recall", "packing", "admission"],
      stageCounts: { path_contract: 1, budget: 1, recall: 1, packing: 1, admission: 1 },
    });
    const codes = ["packed_tokens_mismatch"] as SkillContextParityMismatchCode[];
    const before = structuredClone(codes);
    const result = attributeSkillContextParityCodes(codes);
    result.stages.push("budget");
    result.stageCounts.packing = 99;
    expect(codes).toEqual(before);
    expect(attributeSkillContextParityCodes(codes)).toEqual({ stages: ["packing"], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 1, admission: 0 } });
  });

  it("maps every canonical parity code to its only permitted stage", () => {
    const cases: Array<[SkillContextParityMismatchCode, string]> = [
      ["path_success_mismatch", "path_contract"], ["path_enabled_mismatch", "path_contract"], ["path_state_mismatch", "path_contract"],
      ["overall_budget_mismatch", "budget"], ["used_tokens_mismatch", "budget"], ["selected_block_count_mismatch", "budget"],
      ["configured_skill_budget_mismatch", "budget"], ["separator_tokens_mismatch", "budget"], ["remaining_budget_mismatch", "budget"], ["effective_skill_budget_mismatch", "budget"],
      ["effective_recall_limit_mismatch", "recall"], ["recall_attempt_mismatch", "recall"], ["recalled_advisory_count_mismatch", "recall"],
      ["packed_count_mismatch", "packing"], ["omitted_count_mismatch", "packing"], ["packed_tokens_mismatch", "packing"], ["section_created_mismatch", "packing"],
      ["section_admitted_mismatch", "admission"], ["projected_used_tokens_mismatch", "admission"], ["projected_block_count_mismatch", "admission"],
    ];
    for (const [code, stage] of cases) {
      const attributed = attributeSkillContextParityCodes([code]);
      expect(attributed.stages).toEqual([stage]);
      expect(Object.values(attributed.stageCounts).filter((count) => count !== 0)).toEqual([1]);
    }
  });

  it("attributes stable consistency, repeatable mismatch, and independent direct/runtime drift", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    sdk.setTrigger(async () => stabilityResult());
    await expect(diagnose(validInput())).resolves.toMatchObject({
      success: true, state: "stable_consistent", reasonCodes: ["stable_consistency_attributed"], attributionAvailable: true,
      parityOutcomeChanged: false, repeatableMismatchAttribution: { stages: [] }, directDriftAttribution: { stages: [] }, runtimeDriftAttribution: { stages: [] },
    });
    sdk.setTrigger(async () => stabilityResult("stable_mismatch", {
      first: summary({ state: "mismatch", consistent: false, mismatchCodes: ["packed_tokens_mismatch"] }),
      second: summary({ state: "mismatch", consistent: false, mismatchCodes: ["packed_tokens_mismatch"] }),
    }));
    await expect(diagnose(validInput())).resolves.toMatchObject({
      state: "stable_mismatch", repeatableMismatchAttribution: { stages: ["packing"] }, directDriftAttribution: { stages: [] }, runtimeDriftAttribution: { stages: [] },
    });
    sdk.setTrigger(async () => stabilityResult("observed_drift", { directDriftCodes: ["overall_budget_mismatch"], runtimeDriftCodes: ["effective_recall_limit_mismatch", "packed_count_mismatch"] }));
    await expect(diagnose(validInput())).resolves.toMatchObject({
      state: "observed_drift", directDriftAttribution: { stages: ["budget"] }, runtimeDriftAttribution: { stages: ["recall", "packing"] },
    });
  });

  it("reports parity-only outcome change without inventing a drift stage", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    sdk.setTrigger(async () => stabilityResult("observed_drift", {
      first: summary(), second: summary({ state: "mismatch", consistent: false, mismatchCodes: ["packed_tokens_mismatch"] }),
    }));
    await expect(diagnose(validInput())).resolves.toMatchObject({
      success: true, state: "observed_drift", parityOutcomeChanged: true,
      repeatableMismatchAttribution: { stages: [] }, directDriftAttribution: { stages: [] }, runtimeDriftAttribution: { stages: [] },
    });
  });

  it("fails closed on Phase 5G trigger errors, unavailable states, and malformed contracts", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const thrown of [new Error("private-error"), "private-string", { private: "object" }, null]) {
      sdk.setTrigger(async () => { throw thrown; });
      const result = await diagnose(validInput());
      expect(result).toMatchObject({ success: false, state: "failed", reasonCodes: ["stability_trigger_failure"], stabilityTriggerAttempted: true, stabilityTriggerSucceeded: false, stabilityResultParsed: false });
      expect(JSON.stringify(result)).not.toContain("private");
    }
    for (const raw of [null, [], "bad", 1, { ...stabilityResult(), sampleCount: 3 }, stabilityResult("disabled"), stabilityResult("failed")]) {
      sdk.setTrigger(async () => raw);
      const result = await diagnose(validInput());
      expect(result.reasonCodes).toEqual(raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { state?: string }).state !== "disabled" && (raw as { state?: string }).state !== "failed" ? ["invalid_stability_result"] : raw && typeof raw === "object" && !Array.isArray(raw) ? ["stability_classification_unavailable"] : ["invalid_stability_result"]);
      expect(result.reason).toBe("skill context parity drift attribution diagnostics could not attribute a stability result");
    }
  });

  it("rejects contradictory strict stability results and does not leak nested data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const malformed = [
      stabilityResult("stable_consistent", { reasonCodes: ["sample_drift_observed"] }),
      stabilityResult("stable_consistent", { first: summary({ mismatchCodes: ["packed_tokens_mismatch"] }) }),
      stabilityResult("stable_mismatch", { repeatableMismatch: false }),
      stabilityResult("observed_drift", { repeatableMismatch: true }),
      stabilityResult("observed_drift", { first: summary(), second: summary(), directDriftCodes: [], runtimeDriftCodes: [] }),
      stabilityResult("failed", { firstTriggerAttempted: false }),
      stabilityResult("failed", { firstTriggerSucceeded: true, firstResultParsed: false }),
      stabilityResult("failed", { firstTriggerSucceeded: true, firstResultParsed: true, first: summary() }),
    ];
    for (const raw of malformed) {
      sdk.setTrigger(async () => ({ ...raw, privateReason: "private", first: raw.first && { ...raw.first, privateId: "private" } }));
      const result = await diagnose(validInput({ project: "private-project", agentId: "private-agent" }));
      expect(result).toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_stability_result"] });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });

  it("allocates fresh result controls and preserves caller and source objects", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = stabilityResult("observed_drift", { directDriftCodes: ["overall_budget_mismatch"] });
    const caller = validInput({ project: "private-project", agentId: "private-agent" });
    const before = structuredClone({ raw, caller });
    sdk.setTrigger(async () => raw);
    const first = await diagnose(caller);
    first.reasonCodes.push("invalid_input");
    first.directDriftAttribution.stages.push("packing");
    first.directDriftAttribution.stageCounts.budget = 99;
    const second = await diagnose(caller);
    expect(second).toMatchObject({ state: "observed_drift", reasonCodes: ["observed_drift_attributed"], directDriftAttribution: { stages: ["budget"], stageCounts: { budget: 1 } } });
    expect({ raw, caller }).toEqual(before);
  });

  it("uses only the Phase 5G chain with seven no-budget triggers and nine positive-budget triggers", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const noBudgetKV = mockKV([skill()]);
    const noBudgetSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillRecallFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillContextRuntimeExplainFunction(noBudgetSdk as never);
    registerSkillContextParityDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityDriftAttributionDiagnosticsFunction(noBudgetSdk as never);
    const noBudget = await noBudgetSdk.functions.get("mem::skill-context-parity-drift-attribution-diagnostics")!(validInput({ overallBudget: 10, usedTokens: 10 }));
    expect(noBudget).toMatchObject({ success: true, state: "stable_consistent" });
    expect(noBudgetSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
    ]);
    expect(noBudgetKV.lists).toEqual([]);
    expect(noBudgetKV.gets).toEqual([]);
    expect(noBudgetKV.writes).toEqual([]);

    const positiveKV = mockKV([skill()]);
    const positiveSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(positiveSdk as never, positiveKV as never);
    registerSkillRecallFunction(positiveSdk as never, positiveKV as never);
    registerSkillContextRuntimeExplainFunction(positiveSdk as never);
    registerSkillContextParityDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityDriftAttributionDiagnosticsFunction(positiveSdk as never);
    const positive = await positiveSdk.functions.get("mem::skill-context-parity-drift-attribution-diagnostics")!(validInput());
    expect(positive).toMatchObject({ success: true, state: "stable_consistent" });
    expect(positiveSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
    ]);
    expect(positiveKV.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]);
    expect(positiveKV.gets).toEqual([]);
    expect(positiveKV.writes).toEqual([]);
  });
});
