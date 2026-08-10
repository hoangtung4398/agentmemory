import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));

vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftScopeRequest,
  evaluateSkillContextParityDriftScope,
  registerSkillContextParityDriftScopeDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-scope.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillContextParityStabilityDiagnosticsFunction } from "../src/functions/skill-context-parity-stability.js";
import { registerSkillContextParityDriftAttributionDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-attribution.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillContextParityAttributionSummary,
  SkillContextParityDriftAttributionDiagnosticsResult,
  SkillContextParityDriftScopeDiagnosticsResult,
} from "../src/types.js";

function enabledConfig(tokenBudget = 320) {
  return {
    enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3,
    recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget,
    promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2,
  };
}

function attribution(stages: string[] = [], counts: Record<string, number> = {}): SkillContextParityAttributionSummary {
  return {
    stages: stages as SkillContextParityAttributionSummary["stages"],
    stageCounts: {
      path_contract: 0, budget: 0, recall: 0, packing: 0, admission: 0,
      ...counts,
    },
  };
}

function attributionResult(
  state: "disabled" | "failed" | "stable_consistent" | "stable_mismatch" | "observed_drift" = "stable_consistent",
  overrides: Record<string, unknown> = {},
): SkillContextParityDriftAttributionDiagnosticsResult {
  const empty = attribution();
  const values = state === "disabled" ? {
    success: true, enabled: false, attributionAvailable: false,
    stabilityTriggerAttempted: false, stabilityTriggerSucceeded: false, stabilityResultParsed: false,
    parityOutcomeChanged: false, reasonCodes: ["context_disabled"],
  } : state === "failed" ? {
    success: false, attributionAvailable: false,
    stabilityTriggerAttempted: true, stabilityTriggerSucceeded: false, stabilityResultParsed: false,
    parityOutcomeChanged: false, reasonCodes: ["stability_trigger_failure"],
  } : state === "stable_mismatch" ? {
    parityOutcomeChanged: false, reasonCodes: ["stable_mismatch_attributed"],
    repeatableMismatchAttribution: attribution(["packing"], { packing: 1 }),
  } : state === "observed_drift" ? {
    parityOutcomeChanged: false, reasonCodes: ["observed_drift_attributed"],
    directDriftAttribution: attribution(["budget"], { budget: 1 }),
  } : { parityOutcomeChanged: false, reasonCodes: ["stable_consistency_attributed"] };
  return {
    success: true, enabled: true, applied: false, state, reasonCodes: ["stable_consistency_attributed"],
    sourceSamplingMode: "sequential_double_sample_non_atomic", attributionAvailable: true,
    stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: true,
    parityOutcomeChanged: false, repeatableMismatchAttribution: empty, directDriftAttribution: empty, runtimeDriftAttribution: empty,
    ...values, ...overrides,
  } as SkillContextParityDriftAttributionDiagnosticsResult;
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
    id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"], expectedOutcome: "Green", antiPatterns: ["Skip tests"],
    project: "/repo", agentId: "agent", files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0,
    sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, ...overrides };
}

describe("skill context parity drift scope diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityDriftScopeDiagnosticsFunction(sdk as never);
  });

  async function diagnose(input: unknown): Promise<SkillContextParityDriftScopeDiagnosticsResult> {
    return sdk.functions.get("mem::skill-context-parity-drift-scope-diagnostics")!(input) as Promise<SkillContextParityDriftScopeDiagnosticsResult>;
  }

  it("is internal, is registered after Phase 5H, and preserves public counts", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const names = [
      "registerSkillContextParityDiagnosticsFunction(sdk)",
      "registerSkillContextParityStabilityDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk)",
    ];
    const positions = names.map((name) => index.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("drift_scope"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(diagnose(Symbol("private"))).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", scopeAvailable: false, attributionTriggerAttempted: false });
    expect(sdk.requests).toEqual([]);
  });

  it("builds fresh exact attribution requests without mutating the caller", () => {
    const input = { project: " /repo ", agentId: " agent ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 4, selectedBlockCount: 2 };
    const before = structuredClone(input);
    const first = buildSkillContextParityDriftScopeRequest(input);
    const second = buildSkillContextParityDriftScopeRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-attribution-diagnostics", payload: input });
    expect(first).not.toBe(second);
    expect(first.payload).not.toBe(second.payload);
    first.payload.project = "mutated";
    expect(input).toEqual(before);
    expect(buildSkillContextParityDriftScopeRequest({ ...input, agentId: "   " }).payload).not.toHaveProperty("agentId");
    expect(buildSkillContextParityDriftScopeRequest({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 })).toEqual({
      function_id: "mem::skill-context-parity-drift-attribution-diagnostics",
      payload: { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
    });
    expect(buildSkillContextParityDriftScopeRequest({ project: "/repo", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER }).payload).toMatchObject({ overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER });
    const widened = { ...input, query: "ignored", files: ["secret"], concepts: ["secret"], limit: 1, sampleCount: 2, retryCount: 3, scopeMode: "all", severity: "high" };
    const widenedBefore = structuredClone(widened);
    const request = buildSkillContextParityDriftScopeRequest(widened as never);
    for (const key of ["query", "files", "concepts", "limit", "sampleCount", "retryCount", "scopeMode", "severity"]) expect(request.payload).not.toHaveProperty(key);
    for (const key of ["project", "agentId", "overallBudget", "usedTokens", "selectedBlockCount"] as const) (request.payload as Record<string, unknown>)[key] = "mutated";
    expect(buildSkillContextParityDriftScopeRequest(widened as never).payload).toEqual(input);
    expect(widened).toEqual(widenedBefore);
  });

  it("gates before validation and rejects every structural or numeric invalid input without a trigger", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [undefined, null, "1", false, true, {}, [], NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -1];
    const invalid = [null, [], "value", 1, true, {}, { ...validInput(), project: "   " }, ...[1, true, {}, []].map((project) => ({ ...validInput(), project })),
      { project: "/repo", overallBudget: 0, usedTokens: 0, selectedBlockCount: 0 },
      ...invalidNumbers.map((overallBudget) => ({ project: "/repo", overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ project: "/repo", overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount })),
      ...[null, 1, false, {}, []].map((agentId) => ({ ...validInput(), agentId })),
      Symbol("invalid"),
    ];
    for (const input of invalid) {
      sdk.requests.length = 0;
      await expect(diagnose(input)).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"], attributionTriggerAttempted: false });
      expect(sdk.requests).toEqual([]);
    }
    sdk.setTrigger(async () => attributionResult());
    await expect(diagnose(validInput({ usedTokens: 101 }))).resolves.toMatchObject({ success: true, state: "stable_consistent" });
  });

  it("strictly parses Phase 5H summaries, state invariants, and failure flags", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const malformed: unknown[] = [null, [], "bad", 1, attributionResult("stable_consistent", { applied: true }),
      attributionResult("stable_consistent", { sourceSamplingMode: "wrong" }), attributionResult("stable_consistent", { extra: true }),
      attributionResult("stable_consistent", { repeatableMismatchAttribution: { stages: [], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 0 } } }),
      attributionResult("stable_consistent", { repeatableMismatchAttribution: { stages: [], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 0, admission: 0, extra: 0 } } }),
      attributionResult("stable_consistent", { repeatableMismatchAttribution: { stages: ["packing", "budget"], stageCounts: { path_contract: 0, budget: 1, recall: 0, packing: 1, admission: 0 } } }),
      attributionResult("stable_consistent", { repeatableMismatchAttribution: { stages: ["unknown"], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { repeatableMismatchAttribution: { stages: ["budget", "budget"], stageCounts: { path_contract: 0, budget: 1, recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { directDriftAttribution: { stages: ["budget"], stageCounts: { path_contract: 0, budget: "1", recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { directDriftAttribution: { stages: [], stageCounts: { path_contract: 0, budget: -1, recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { directDriftAttribution: { stages: [], stageCounts: { path_contract: 0, budget: 1.5, recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { directDriftAttribution: { stages: [], stageCounts: { path_contract: 0, budget: Number.MAX_SAFE_INTEGER + 1, recall: 0, packing: 0, admission: 0 } } }),
      attributionResult("stable_consistent", { reasonCodes: ["stable_mismatch_attributed"] }),
      attributionResult("stable_mismatch", { repeatableMismatchAttribution: attribution() }),
      attributionResult("observed_drift", { directDriftAttribution: attribution(), runtimeDriftAttribution: attribution(), parityOutcomeChanged: false }),
      attributionResult("failed", { reasonCodes: ["invalid_input"] }),
      attributionResult("failed", { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: true }),
    ];
    for (const raw of malformed) {
      sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_attribution_result"], attributionResultParsed: false });
    }
    for (const raw of [attributionResult("disabled"), attributionResult("failed")]) {
      sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["attribution_classification_unavailable"], attributionResultParsed: true });
    }
  });

  it("rejects every contradictory Phase 5H top-level control and preserves valid unavailable classifications", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const contradictory: Record<string, unknown>[] = [
      { success: false }, { enabled: false }, { attributionAvailable: false }, { stabilityTriggerAttempted: false },
      { stabilityTriggerSucceeded: false }, { stabilityResultParsed: false }, { parityOutcomeChanged: true },
      { state: "unknown" }, { reasonCodes: [] }, { reasonCodes: ["stable_consistency_attributed", "observed_drift_attributed"] },
    ];
    for (const override of contradictory) {
      sdk.setTrigger(async () => attributionResult("stable_consistent", override));
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, reasonCodes: ["invalid_attribution_result"] });
    }
    const unavailable: Array<[string, Record<string, unknown>]> = [
      ["stability_trigger_failure", { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: false, stabilityResultParsed: false }],
      ["invalid_stability_result", { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: false }],
      ["stability_classification_unavailable", { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: true }],
    ];
    for (const [reasonCode, flags] of unavailable) {
      sdk.setTrigger(async () => attributionResult("failed", { reasonCodes: [reasonCode], ...flags }));
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["attribution_classification_unavailable"], attributionResultParsed: true });
    }
  });

  it("rejects missing and wrong-type forms for every required Phase 5H top-level field", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const fields = ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "attributionAvailable", "stabilityTriggerAttempted", "stabilityTriggerSucceeded", "stabilityResultParsed", "parityOutcomeChanged", "repeatableMismatchAttribution", "directDriftAttribution", "runtimeDriftAttribution"];
    for (const field of fields) {
      const missing = attributionResult() as unknown as Record<string, unknown>;
      delete missing[field];
      sdk.setTrigger(async () => missing);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_attribution_result"], attributionTriggerAttempted: true, attributionTriggerSucceeded: true, attributionResultParsed: false });
    }
    const wrongTypes: Record<string, unknown> = { success: null, enabled: "true", applied: 0, state: null, reasonCodes: "code", sourceSamplingMode: null, attributionAvailable: 1, stabilityTriggerAttempted: null, stabilityTriggerSucceeded: 1, stabilityResultParsed: "true", parityOutcomeChanged: null, repeatableMismatchAttribution: null, directDriftAttribution: [], runtimeDriftAttribution: "summary" };
    for (const [field, wrong] of Object.entries(wrongTypes)) {
      sdk.setTrigger(async () => attributionResult("stable_consistent", { [field]: wrong }));
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, reasonCodes: ["invalid_attribution_result"], attributionResultParsed: false });
    }
    for (const override of [{ reason: 1 }, { state: "unknown" }, { reasonCodes: ["unknown"] }, { reasonCodes: [] }, { reasonCodes: ["stable_consistency_attributed", "observed_drift_attributed"] }, { extra: true }]) {
      sdk.setTrigger(async () => attributionResult("stable_consistent", override));
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, reasonCodes: ["invalid_attribution_result"] });
    }
  });

  it("rejects count boundaries and stage/count disagreement in each nested attribution summary", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const keys = ["repeatableMismatchAttribution", "directDriftAttribution", "runtimeDriftAttribution"] as const;
    for (const key of keys) {
      for (const count of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", true, null]) {
        const raw = attributionResult("stable_consistent");
        (raw[key].stageCounts as Record<string, unknown>).budget = count;
        sdk.setTrigger(async () => raw);
        await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, reasonCodes: ["invalid_attribution_result"] });
      }
      const disagreement = attributionResult("stable_consistent");
      disagreement[key] = attribution(["budget"], { budget: 0 });
      sdk.setTrigger(async () => disagreement);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, reasonCodes: ["invalid_attribution_result"] });
    }
  });

  it("rejects every malformed form in each attribution summary and every nested state flag contradiction", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const keys = ["repeatableMismatchAttribution", "directDriftAttribution", "runtimeDriftAttribution"] as const;
    for (const key of keys) {
      const malformed: unknown[] = [null, [], "summary", { stageCounts: attribution().stageCounts }, { stages: [] }, { stages: [], stageCounts: attribution().stageCounts, extra: true }];
      for (const value of malformed) {
        sdk.setTrigger(async () => attributionResult("stable_consistent", { [key]: value }));
        await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
      }
    }
    for (const field of ["success", "enabled", "attributionAvailable", "stabilityTriggerAttempted", "stabilityTriggerSucceeded", "stabilityResultParsed", "parityOutcomeChanged"] as const) {
      const raw = attributionResult("disabled") as unknown as Record<string, unknown>;
      raw[field] = field === "success" ? false : field === "enabled" ? true : true;
      sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
    }
    for (const override of [
      { reasonCodes: ["wrong"] },
      { repeatableMismatchAttribution: attribution(["budget"], { budget: 1 }) },
      { directDriftAttribution: attribution(["budget"], { budget: 1 }) },
      { runtimeDriftAttribution: attribution(["budget"], { budget: 1 }) },
    ]) {
      sdk.setTrigger(async () => attributionResult("disabled", override));
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_attribution_result"], attributionResultParsed: false });
    }
    for (const code of ["stability_trigger_failure", "invalid_stability_result", "stability_classification_unavailable"]) {
      for (const field of ["stabilityTriggerAttempted", "stabilityTriggerSucceeded", "stabilityResultParsed"] as const) {
        const flags = code === "stability_trigger_failure" ? { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: false, stabilityResultParsed: false } :
          code === "invalid_stability_result" ? { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: false } :
            { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: true };
        const raw = attributionResult("failed", { reasonCodes: [code], ...flags }) as unknown as Record<string, unknown>;
        raw[field] = !(raw[field] as boolean);
        sdk.setTrigger(async () => raw);
        await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
      }
    }
    for (const override of [
      { parityOutcomeChanged: true }, { directDriftAttribution: attribution(["budget"], { budget: 1 }) }, { runtimeDriftAttribution: attribution(["budget"], { budget: 1 }) }, { reasonCodes: ["observed_drift_attributed"] },
    ]) {
      sdk.setTrigger(async () => attributionResult("stable_mismatch", override));
      await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
    }
    for (const override of [
      { repeatableMismatchAttribution: attribution(["budget"], { budget: 1 }) }, { reasonCodes: ["stable_consistency_attributed"] },
    ]) {
      sdk.setTrigger(async () => attributionResult("observed_drift", override));
      await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
    }
    sdk.setTrigger(async () => attributionResult("stable_consistent", { directDriftAttribution: attribution(["budget"], { budget: 1 }) }));
    await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_attribution_result"] });
  });

  it("evaluates every scope lane in canonical order without mutating inputs", () => {
    const input = {
      repeatableMismatchAttribution: attribution(["path_contract", "packing"], { path_contract: 1, packing: 1 }),
      directDriftAttribution: attribution(["budget"], { budget: 1 }),
      runtimeDriftAttribution: attribution(["recall", "admission"], { recall: 1, admission: 1 }),
      parityOutcomeChanged: true,
    };
    const before = structuredClone(input);
    const result = evaluateSkillContextParityDriftScope(input);
    expect(result).toEqual({ affectedStages: ["path_contract", "budget", "recall", "packing", "admission"], activeLanes: ["repeatable_mismatch", "direct_drift", "runtime_drift", "parity_outcome"], stageCount: 5, laneCount: 4, crossStage: true, crossPathDrift: true, parityOnly: false });
    result.affectedStages.push("budget");
    result.activeLanes.push("direct_drift");
    expect(input).toEqual(before);
    expect(evaluateSkillContextParityDriftScope({ repeatableMismatchAttribution: attribution(), directDriftAttribution: attribution(), runtimeDriftAttribution: attribution(), parityOutcomeChanged: true })).toEqual({ affectedStages: [], activeLanes: ["parity_outcome"], stageCount: 0, laneCount: 1, crossStage: false, crossPathDrift: false, parityOnly: true });
    const empty = { repeatableMismatchAttribution: attribution(), directDriftAttribution: attribution(), runtimeDriftAttribution: attribution(), parityOutcomeChanged: false };
    expect(evaluateSkillContextParityDriftScope(empty)).toEqual({ affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0, crossStage: false, crossPathDrift: false, parityOnly: false });
    expect(evaluateSkillContextParityDriftScope({ ...empty, repeatableMismatchAttribution: attribution(["admission"], { admission: 1 }) }).activeLanes).toEqual(["repeatable_mismatch"]);
    expect(evaluateSkillContextParityDriftScope({ ...empty, directDriftAttribution: attribution(["packing"], { packing: 1 }) }).activeLanes).toEqual(["direct_drift"]);
    expect(evaluateSkillContextParityDriftScope({ ...empty, runtimeDriftAttribution: attribution(["recall"], { recall: 1 }) }).activeLanes).toEqual(["runtime_drift"]);
  });

  it("maps successful Phase 5H classifications to bounded scope views", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const cases: Array<[SkillContextParityDriftAttributionDiagnosticsResult, Record<string, unknown>]> = [
      [attributionResult(), { state: "stable_consistent", affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0 }],
      [attributionResult("stable_mismatch"), { state: "stable_mismatch", affectedStages: ["packing"], activeLanes: ["repeatable_mismatch"] }],
      [attributionResult("stable_mismatch", { repeatableMismatchAttribution: attribution(["budget", "packing"], { budget: 1, packing: 1 }) }), { state: "stable_mismatch", affectedStages: ["budget", "packing"], activeLanes: ["repeatable_mismatch"], stageCount: 2, laneCount: 1, crossStage: true, crossPathDrift: false, parityOnly: false }],
      [attributionResult("observed_drift"), { state: "observed_drift", affectedStages: ["budget"], activeLanes: ["direct_drift"], crossPathDrift: false }],
      [attributionResult("observed_drift", { directDriftAttribution: attribution(), runtimeDriftAttribution: attribution(["recall"], { recall: 1 }) }), { activeLanes: ["runtime_drift"] }],
      [attributionResult("observed_drift", { directDriftAttribution: attribution(["budget"], { budget: 1 }), runtimeDriftAttribution: attribution(["packing"], { packing: 1 }) }), { activeLanes: ["direct_drift", "runtime_drift"], crossPathDrift: true, crossStage: true }],
      [attributionResult("observed_drift", { directDriftAttribution: attribution(), parityOutcomeChanged: true }), { affectedStages: [], activeLanes: ["parity_outcome"], parityOnly: true }],
      [attributionResult("observed_drift", { parityOutcomeChanged: true }), { activeLanes: ["direct_drift", "parity_outcome"], parityOnly: false }],
    ];
    for (const [raw, expected] of cases) {
      sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: true, enabled: true, scopeAvailable: true, attributionTriggerAttempted: true, attributionTriggerSucceeded: true, attributionResultParsed: true, ...expected });
    }
  });

  it("fails closed on trigger errors and does not leak nested private values", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const thrown of [new Error("private-error"), "private-string", { private: "object" }, null]) {
      sdk.setTrigger(async () => { throw thrown; });
      const result = await diagnose(validInput({ project: "private-project", agentId: "private-agent" }));
      expect(result).toMatchObject({ success: false, state: "failed", reasonCodes: ["attribution_trigger_failure"], attributionTriggerAttempted: true, attributionTriggerSucceeded: false, attributionResultParsed: false });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });

  it("returns defensive result allocations and never mutates source attribution results", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = attributionResult("observed_drift", { directDriftAttribution: attribution(["budget"], { budget: 1 }) });
    const caller = validInput({ project: "private-project", agentId: "private-agent" });
    const before = structuredClone({ raw, caller });
    sdk.setTrigger(async () => raw);
    const first = await diagnose(caller);
    first.reasonCodes.push("invalid_input"); first.state = "failed"; first.sourceSamplingMode = "sequential_double_sample_non_atomic";
    first.scopeAvailable = false; first.attributionTriggerAttempted = false; first.attributionTriggerSucceeded = false; first.attributionResultParsed = false;
    first.affectedStages.push("packing"); first.activeLanes.push("runtime_drift"); first.stageCount = 99; first.laneCount = 99; first.crossStage = false; first.crossPathDrift = false; first.parityOnly = true;
    const second = await diagnose(caller);
    expect(second).toMatchObject({ reasonCodes: ["observed_drift_scoped"], affectedStages: ["budget"], activeLanes: ["direct_drift"] });
    expect({ raw, caller }).toEqual(before);
    for (const scenario of [
      { config: { ...enabledConfig(), contextEnabled: false }, raw: attributionResult(), expected: ["context_disabled"] },
      { config: enabledConfig(), raw: null, expected: ["invalid_attribution_result"] },
      { config: enabledConfig(), raw: attributionResult("failed"), expected: ["attribution_classification_unavailable"] },
    ]) {
      loadSkillConfig.mockReturnValue(scenario.config);
      sdk.setTrigger(async () => scenario.raw);
      const output = await diagnose(validInput());
      output.reasonCodes.push("invalid_input"); output.affectedStages.push("budget"); output.activeLanes.push("direct_drift");
      const pristine = await diagnose(validInput());
      expect(pristine.reasonCodes).toEqual(scenario.expected);
    }
    const invalidCaller = { ...validInput(), project: "" };
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidFirst = await diagnose(invalidCaller);
    invalidFirst.reasonCodes.push("context_disabled"); invalidFirst.state = "disabled"; invalidFirst.sourceSamplingMode = "sequential_double_sample_non_atomic"; invalidFirst.scopeAvailable = true; invalidFirst.attributionTriggerAttempted = true; invalidFirst.attributionTriggerSucceeded = true; invalidFirst.attributionResultParsed = true; invalidFirst.affectedStages.push("budget"); invalidFirst.activeLanes.push("direct_drift"); invalidFirst.stageCount = 1; invalidFirst.laneCount = 1; invalidFirst.crossStage = true; invalidFirst.crossPathDrift = true; invalidFirst.parityOnly = true;
    const invalidSecond = await diagnose(invalidCaller);
    expect(invalidSecond).toMatchObject({ state: "failed", reasonCodes: ["invalid_input"], scopeAvailable: false, attributionTriggerAttempted: false, affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0 });
    const thrown = { privateMarker: "unchanged" };
    const thrownBefore = structuredClone(thrown);
    sdk.setTrigger(async () => { throw thrown; });
    const failedFirst = await diagnose(validInput());
    failedFirst.reasonCodes.push("context_disabled"); failedFirst.state = "disabled"; failedFirst.sourceSamplingMode = "sequential_double_sample_non_atomic"; failedFirst.scopeAvailable = true; failedFirst.attributionTriggerAttempted = false; failedFirst.attributionTriggerSucceeded = true; failedFirst.attributionResultParsed = true; failedFirst.affectedStages.push("budget"); failedFirst.activeLanes.push("direct_drift"); failedFirst.stageCount = 1; failedFirst.laneCount = 1; failedFirst.crossStage = true; failedFirst.crossPathDrift = true; failedFirst.parityOnly = true;
    const failedSecond = await diagnose(validInput());
    expect(failedSecond).toMatchObject({ state: "failed", reasonCodes: ["attribution_trigger_failure"], scopeAvailable: false, attributionTriggerAttempted: true, attributionTriggerSucceeded: false, attributionResultParsed: false, affectedStages: [], activeLanes: [] });
    expect(thrown).toEqual(thrownBefore);
  });

  it("does not return prohibited nested markers from valid or malformed Phase 5H results", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = attributionResult("observed_drift", {
      directDriftAttribution: attribution(["budget"], { budget: 1 }),
      reason: "secret-text", project: "private-project", agentId: "private-agent",
    });
    sdk.setTrigger(async () => raw);
    const output = JSON.stringify(await diagnose(validInput()));
    for (const marker of ["private-project", "private-agent", "secret-text", "repeatableMismatchAttribution", "stageCounts", "payload"]) {
      expect(output).not.toContain(marker);
    }
    const valid = attributionResult("observed_drift", { reason: "private-nested-reason" });
    sdk.setTrigger(async () => valid);
    const successful = JSON.stringify(await diagnose(validInput({ project: "private-project", agentId: "private-agent" })));
    for (const marker of ["private-project", "private-agent", "private-nested-reason", "repeatableMismatchAttribution", "directDriftAttribution", "runtimeDriftAttribution", "stageCounts", "payload"]) expect(successful).not.toContain(marker);
  });

  it("uses only the Phase 5H chain with eight no-budget triggers and ten positive-budget triggers", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const noBudgetRows = [skill()];
    const noBudgetBefore = structuredClone(noBudgetRows);
    const noBudgetKV = mockKV(noBudgetRows);
    const noBudgetSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillRecallFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillContextRuntimeExplainFunction(noBudgetSdk as never);
    registerSkillContextParityDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityDriftAttributionDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityDriftScopeDiagnosticsFunction(noBudgetSdk as never);
    const noBudget = await noBudgetSdk.functions.get("mem::skill-context-parity-drift-scope-diagnostics")!(validInput({ overallBudget: 10, usedTokens: 10 }));
    expect(noBudget).toMatchObject({ success: true, state: "stable_consistent" });
    expect(noBudgetSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
    ]);
    expect(noBudgetKV.lists).toEqual([]);
    expect(noBudgetKV.gets).toEqual([]);
    expect(noBudgetKV.writes).toEqual([]);
    expect(noBudgetRows).toEqual(noBudgetBefore);

    const positiveRows = [skill()];
    const positiveBefore = structuredClone(positiveRows);
    const positiveKV = mockKV(positiveRows);
    const positiveSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(positiveSdk as never, positiveKV as never);
    registerSkillRecallFunction(positiveSdk as never, positiveKV as never);
    registerSkillContextRuntimeExplainFunction(positiveSdk as never);
    registerSkillContextParityDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityDriftAttributionDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityDriftScopeDiagnosticsFunction(positiveSdk as never);
    const positive = await positiveSdk.functions.get("mem::skill-context-parity-drift-scope-diagnostics")!(validInput());
    expect(positive).toMatchObject({ success: true, state: "stable_consistent" });
    expect(positiveSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
    ]);
    expect(positiveKV.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]);
    expect(positiveKV.gets).toEqual([]);
    expect(positiveKV.writes).toEqual([]);
    expect(positiveRows).toEqual(positiveBefore);
  });
});
