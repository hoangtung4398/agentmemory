import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftShapeRequest,
  evaluateSkillContextParityDriftShape,
  registerSkillContextParityDriftShapeDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-shape.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillContextParityStabilityDiagnosticsFunction } from "../src/functions/skill-context-parity-stability.js";
import { registerSkillContextParityDriftAttributionDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-attribution.js";
import { registerSkillContextParityDriftScopeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-scope.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillContextParityDriftShapeDiagnosticsResult } from "../src/types.js";

const stages = ["path_contract", "budget", "recall", "packing", "admission"] as const;
const lanes = ["repeatable_mismatch", "direct_drift", "runtime_drift", "parity_outcome"] as const;

function enabledConfig(tokenBudget = 320) {
  return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 };
}

function scope(state: "disabled" | "failed" | "stable_consistent" | "stable_mismatch" | "observed_drift" = "stable_consistent", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    success: true, enabled: true, applied: false, state, reasonCodes: ["stable_consistency_scoped"], sourceSamplingMode: "sequential_double_sample_non_atomic", scopeAvailable: true,
    attributionTriggerAttempted: true, attributionTriggerSucceeded: true, attributionResultParsed: true,
    affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0, crossStage: false, crossPathDrift: false, parityOnly: false,
  };
  if (state === "disabled") Object.assign(base, { enabled: false, scopeAvailable: false, attributionTriggerAttempted: false, attributionTriggerSucceeded: false, attributionResultParsed: false, reasonCodes: ["context_disabled"] });
  if (state === "failed") Object.assign(base, { success: false, scopeAvailable: false, attributionTriggerAttempted: true, attributionTriggerSucceeded: false, attributionResultParsed: false, reasonCodes: ["attribution_trigger_failure"] });
  if (state === "stable_mismatch") Object.assign(base, { reasonCodes: ["stable_mismatch_scoped"], affectedStages: ["budget"], activeLanes: ["repeatable_mismatch"], stageCount: 1, laneCount: 1 });
  if (state === "observed_drift") Object.assign(base, { reasonCodes: ["observed_drift_scoped"], affectedStages: ["budget"], activeLanes: ["direct_drift"], stageCount: 1, laneCount: 1 });
  return { ...base, ...overrides };
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
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = [];
  return {
    lists, gets, writes,
    list: async <T>(name: string): Promise<T[]> => { lists.push(name); return rows as T[]; },
    get: async <T>(name: string): Promise<T | null> => { gets.push(name); return null; },
    set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); },
  };
}

function skill(): AgentSkill {
  return { id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"], expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1 };
}

function validInput(overrides: Record<string, unknown> = {}) { return { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, ...overrides }; }

describe("skill context parity drift shape diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityDriftShapeDiagnosticsFunction(sdk as never);
  });

  async function diagnose(input: unknown): Promise<SkillContextParityDriftShapeDiagnosticsResult> {
    return sdk.functions.get("mem::skill-context-parity-drift-shape-diagnostics")!(input) as Promise<SkillContextParityDriftShapeDiagnosticsResult>;
  }

  async function invalidScope(raw: unknown) {
    loadSkillConfig.mockReturnValue(enabledConfig());
    sdk.setTrigger(async () => raw);
    await expect(diagnose(validInput())).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_scope_result"], scopeTriggerAttempted: true, scopeTriggerSucceeded: true, scopeResultParsed: false, laneShape: "none", stageSpan: "none" });
  }

  it("is internal, registered after Phase 5I, and preserves all public counts", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const names = ["registerSkillContextParityDiagnosticsFunction(sdk)", "registerSkillContextParityStabilityDiagnosticsFunction(sdk)", "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)", "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk)", "registerSkillContextParityDriftShapeDiagnosticsFunction(sdk)"];
    const positions = names.map((name) => index.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(index).toContain("REST API: 135 endpoints");
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => JSON.stringify(tool).includes("drift_shape"))).toBe(false);
    await expect(diagnose(Symbol("disabled-private"))).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"], shapeAvailable: false, scopeTriggerAttempted: false });
    expect(sdk.requests).toEqual([]);
  });

  it("rejects every structural, normalized, and numeric invalid enabled input without a trigger", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [undefined, null, "1", false, true, {}, [], NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -1];
    const invalid = [null, [], "value", 1, true, {}, Symbol("input"), { ...validInput(), project: undefined }, { ...validInput(), project: "   " }, ...[1, true, {}, []].map((project) => ({ ...validInput(), project })), ...[null, 1, false, {}, []].map((agentId) => ({ ...validInput(), agentId })), { ...validInput(), overallBudget: 0 }, ...invalidNumbers.map((overallBudget) => ({ ...validInput(), overallBudget })), ...invalidNumbers.map((usedTokens) => ({ ...validInput(), usedTokens })), ...invalidNumbers.map((selectedBlockCount) => ({ ...validInput(), selectedBlockCount }))];
    for (const value of invalid) {
      sdk.requests.length = 0;
      await expect(diagnose(value)).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"], scopeTriggerAttempted: false, laneShape: "none" });
      expect(sdk.requests).toEqual([]);
    }
    sdk.setTrigger(async () => scope());
    await expect(diagnose(validInput({ overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER }))).resolves.toMatchObject({ success: true, state: "stable_consistent" });
    await expect(diagnose(validInput({ overallBudget: 1, usedTokens: 2, selectedBlockCount: 0 }))).resolves.toMatchObject({ success: true, state: "stable_consistent" });
  });

  it("builds fresh exact scope requests and never forwards ignored input", () => {
    const source = { project: " /repo ", agentId: " agent ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 4, selectedBlockCount: 2, query: "private-query", files: ["secret"], concepts: ["secret"], limit: 1, sampleCount: 2, retryCount: 3, scopeMode: "all", shapeMode: "all", severity: "high", confidence: 0.9 };
    const before = structuredClone(source);
    const first = buildSkillContextParityDriftShapeRequest(source as never); const second = buildSkillContextParityDriftShapeRequest(source as never);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-scope-diagnostics", payload: { project: " /repo ", agentId: " agent ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 4, selectedBlockCount: 2 } });
    expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload);
    for (const key of ["query", "files", "concepts", "limit", "sampleCount", "retryCount", "scopeMode", "shapeMode", "severity", "confidence"]) expect(first.payload).not.toHaveProperty(key);
    expect(buildSkillContextParityDriftShapeRequest({ project: "/repo", agentId: "   ", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 })).toEqual({ function_id: "mem::skill-context-parity-drift-scope-diagnostics", payload: { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 } });
    for (const key of ["project", "agentId", "overallBudget", "usedTokens", "selectedBlockCount"] as const) (first.payload as Record<string, unknown>)[key] = "mutated";
    expect(buildSkillContextParityDriftShapeRequest(source as never).payload).toEqual(second.payload);
    expect(source).toEqual(before);
  });

  it("rejects missing, malformed, extra, and contradictory top-level Phase 5I contract fields", async () => {
    const base = scope();
    for (const field of ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "scopeAvailable", "attributionTriggerAttempted", "attributionTriggerSucceeded", "attributionResultParsed", "affectedStages", "activeLanes", "stageCount", "laneCount", "crossStage", "crossPathDrift", "parityOnly"]) {
      const raw = structuredClone(base); delete raw[field]; await invalidScope(raw);
    }
    const mutations: Array<[string, unknown]> = [["success", null], ["enabled", "true"], ["applied", true], ["state", "unknown"], ["reasonCodes", []], ["sourceSamplingMode", "wrong"], ["scopeAvailable", 1], ["attributionTriggerAttempted", null], ["attributionTriggerSucceeded", "yes"], ["attributionResultParsed", []], ["affectedStages", null], ["activeLanes", null], ["stageCount", "0"], ["laneCount", false], ["crossStage", null], ["crossPathDrift", "no"], ["parityOnly", 0]];
    for (const [field, value] of mutations) { const raw = structuredClone(base); raw[field] = value; await invalidScope(raw); }
    await invalidScope({ ...base, reason: 1 }); await invalidScope({ ...base, extra: "private" }); await invalidScope({ ...base, reasonCodes: ["stable_consistency_scoped", "other"] }); await invalidScope({ ...base, reasonCodes: ["unknown"] });
  });

  it("strictly validates canonical stages, lanes, counts, and derived booleans", async () => {
    for (const affectedStages of ["bad", ["unknown"], ["budget", "budget"], ["budget", "path_contract"]]) await invalidScope(scope("observed_drift", { affectedStages }));
    for (const activeLanes of ["bad", ["unknown"], ["direct_drift", "direct_drift"], ["runtime_drift", "direct_drift"]]) await invalidScope(scope("observed_drift", { activeLanes, laneCount: Array.isArray(activeLanes) ? activeLanes.length : 1 }));
    for (const affectedStages of [[], ...stages.map((stage) => [stage]), [...stages]]) {
      const raw = scope("observed_drift", { affectedStages, activeLanes: ["direct_drift"], stageCount: affectedStages.length, laneCount: 1, crossStage: affectedStages.length > 1 });
      loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ success: affectedStages.length > 0 });
    }
    const canonical = scope("observed_drift", { affectedStages: ["budget", "packing"], activeLanes: ["direct_drift", "runtime_drift", "parity_outcome"], stageCount: 2, laneCount: 3, crossStage: true, crossPathDrift: true });
    for (const field of ["stageCount", "laneCount"] as const) for (const value of [null, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, "1", false]) { const raw = structuredClone(canonical); raw[field] = value; await invalidScope(raw); }
    for (const raw of [{ ...canonical, stageCount: 1 }, { ...canonical, laneCount: 2 }, { ...canonical, crossStage: false }, { ...canonical, crossPathDrift: false }, { ...scope("observed_drift", { affectedStages: [], activeLanes: ["parity_outcome"], stageCount: 0, laneCount: 1, parityOnly: false }), parityOnly: false }, scope("observed_drift", { affectedStages: ["budget"], activeLanes: ["parity_outcome"], stageCount: 1, laneCount: 1, parityOnly: true }), scope("observed_drift", { affectedStages: [], activeLanes: ["direct_drift"], stageCount: 0, laneCount: 1 })]) await invalidScope(raw);
  });

  it("accepts only exact disabled and failed nested states and maps them to unavailable", async () => {
    const disabled = scope("disabled");
    loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => disabled);
    await expect(diagnose(validInput())).resolves.toMatchObject({ state: "failed", reasonCodes: ["scope_classification_unavailable"], scopeResultParsed: true });
    for (const field of ["success", "enabled", "scopeAvailable", "attributionTriggerAttempted", "attributionTriggerSucceeded", "attributionResultParsed", "affectedStages", "activeLanes", "stageCount", "laneCount", "crossStage", "crossPathDrift", "parityOnly", "reasonCodes"]) { const raw = structuredClone(disabled); raw[field] = field === "reasonCodes" ? ["wrong"] : field.includes("Stages") || field.includes("Lanes") ? ["budget"] : field.includes("Count") ? 1 : !raw[field]; await invalidScope(raw); }
    const failures = [["attribution_trigger_failure", true, false, false], ["invalid_attribution_result", true, true, false], ["attribution_classification_unavailable", true, true, true]] as const;
    for (const [reason, attempted, succeeded, parsed] of failures) {
      const raw = scope("failed", { reasonCodes: [reason], attributionTriggerAttempted: attempted, attributionTriggerSucceeded: succeeded, attributionResultParsed: parsed });
      loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => raw);
      await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["scope_classification_unavailable"], scopeResultParsed: true });
      for (const field of ["attributionTriggerAttempted", "attributionTriggerSucceeded", "attributionResultParsed"]) { const invalid = structuredClone(raw); invalid[field] = !invalid[field]; await invalidScope(invalid); }
    }
    await invalidScope(scope("failed", { reasonCodes: ["invalid_input"] }));
  });

  it("enforces every successful state invariant and maps every categorical shape", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const raw of [scope("stable_consistent", { activeLanes: ["direct_drift"], laneCount: 1, affectedStages: ["budget"], stageCount: 1 }), scope("stable_consistent", { reasonCodes: ["wrong"] }), scope("stable_mismatch", { activeLanes: ["parity_outcome"], affectedStages: [], stageCount: 0, laneCount: 1, parityOnly: true }), scope("stable_mismatch", { affectedStages: [] }), scope("observed_drift", { activeLanes: [], affectedStages: [], stageCount: 0, laneCount: 0 }), scope("observed_drift", { activeLanes: ["repeatable_mismatch"], affectedStages: ["budget"], stageCount: 1, laneCount: 1 })]) await invalidScope(raw);
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [scope(), "none", "none"],
      [scope("stable_mismatch", { affectedStages: ["budget", "packing"], stageCount: 2, crossStage: true }), "repeatable_mismatch", "cross_stage"],
      ...[[["direct_drift"], "direct_drift"], [["runtime_drift"], "runtime_drift"], [["direct_drift", "runtime_drift"], "cross_path_drift"], [["parity_outcome"], "parity_only"], [["direct_drift", "parity_outcome"], "parity_with_direct_drift"], [["runtime_drift", "parity_outcome"], "parity_with_runtime_drift"], [["direct_drift", "runtime_drift", "parity_outcome"], "parity_with_cross_path_drift"]].map(([activeLanes, laneShape]) => {
        const stageBearing = (activeLanes as string[]).some((lane) => lane !== "parity_outcome");
        return [scope("observed_drift", { activeLanes, laneCount: (activeLanes as string[]).length, affectedStages: stageBearing ? ["budget"] : [], stageCount: stageBearing ? 1 : 0, parityOnly: !stageBearing, crossPathDrift: (activeLanes as string[]).includes("direct_drift") && (activeLanes as string[]).includes("runtime_drift") }), laneShape as string, stageBearing ? "single_stage" : "none"] as [Record<string, unknown>, string, string];
      }),
    ];
    for (const [raw, laneShape, stageSpan] of cases) { sdk.setTrigger(async () => raw); await expect(diagnose(validInput())).resolves.toMatchObject({ success: true, enabled: true, shapeAvailable: true, scopeTriggerAttempted: true, scopeTriggerSucceeded: true, scopeResultParsed: true, laneShape, stageSpan }); }
  });

  it("evaluates all nine categorical lane shapes without mutating input", () => {
    const cases: Array<[string[], number, string, string]> = [[[], 0, "none", "none"], [["repeatable_mismatch"], 1, "repeatable_mismatch", "single_stage"], [["direct_drift"], 1, "direct_drift", "single_stage"], [["runtime_drift"], 2, "runtime_drift", "cross_stage"], [["direct_drift", "runtime_drift"], 2, "cross_path_drift", "cross_stage"], [["parity_outcome"], 0, "parity_only", "none"], [["direct_drift", "parity_outcome"], 1, "parity_with_direct_drift", "single_stage"], [["runtime_drift", "parity_outcome"], 1, "parity_with_runtime_drift", "single_stage"], [["direct_drift", "runtime_drift", "parity_outcome"], 2, "parity_with_cross_path_drift", "cross_stage"]];
    for (const [activeLanes, stageCount, laneShape, stageSpan] of cases) {
      const input = { activeLanes: activeLanes as never, stageCount }; const before = structuredClone(input);
      const output = evaluateSkillContextParityDriftShape(input);
      expect(output).toEqual({ laneShape, stageSpan, stageAttributionPresent: stageCount > 0, parityOutcomePresent: activeLanes.includes("parity_outcome") });
      Object.assign(output, { laneShape: "none", stageSpan: "none", stageAttributionPresent: false, parityOutcomePresent: false });
      expect(evaluateSkillContextParityDriftShape(input)).toEqual({ laneShape, stageSpan, stageAttributionPresent: stageCount > 0, parityOutcomePresent: activeLanes.includes("parity_outcome") });
      expect(input).toEqual(before);
    }
  });

  it("handles every trigger failure and malformed result without leaking private markers", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const thrown of [new Error("private-error"), "private-string", { marker: "private-object" }, null]) {
      sdk.setTrigger(async () => { throw thrown; });
      const output = await diagnose(validInput({ project: "private-project", agentId: "private-agent" }));
      expect(output).toMatchObject({ state: "failed", reasonCodes: ["scope_trigger_failure"], scopeTriggerAttempted: true, scopeTriggerSucceeded: false, scopeResultParsed: false });
      expect(JSON.stringify(output)).not.toContain("private");
    }
    for (const raw of [null, [], 1, "bad", { marker: "private-extra" }]) { sdk.setTrigger(async () => raw); const output = await diagnose(validInput()); expect(output.reasonCodes).toEqual(["invalid_scope_result"]); expect(JSON.stringify(output)).not.toContain("private"); }
  });

  it("never leaks nested stage names or private fields and returns defensive allocations", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = scope("observed_drift", { affectedStages: [...stages], activeLanes: ["direct_drift", "runtime_drift", "parity_outcome"], stageCount: 5, laneCount: 3, crossStage: true, crossPathDrift: true, reason: "private-reason" });
    const caller = validInput({ project: "private-project", agentId: "private-agent" }); const before = structuredClone({ raw, caller });
    sdk.setTrigger(async () => raw);
    const first = await diagnose(caller);
    for (const key of ["reasonCodes", "state", "sourceSamplingMode", "shapeAvailable", "scopeTriggerAttempted", "scopeTriggerSucceeded", "scopeResultParsed", "laneShape", "stageSpan", "stageAttributionPresent", "parityOutcomePresent"] as const) (first as Record<string, unknown>)[key] = key === "reasonCodes" ? ["mutated"] : "mutated";
    const second = await diagnose(caller); const serialized = JSON.stringify(second);
    expect(second).toMatchObject({ laneShape: "parity_with_cross_path_drift", stageSpan: "cross_stage" });
    for (const marker of ["path_contract", "budget", "recall", "packing", "admission", "affectedStages", "activeLanes", "stageCount", "laneCount", "crossStage", "crossPathDrift", "parityOnly", "payload", "private-project", "private-agent", "private-reason"]) expect(serialized).not.toContain(marker);
    expect({ raw, caller }).toEqual(before);
  });

  it("uses the real Phase 5D-5J chain with nine no-budget triggers and no KV reads", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never);
    await expect(integrated.functions.get("mem::skill-context-parity-drift-shape-diagnostics")!(validInput({ overallBudget: 10, usedTokens: 10 }))).resolves.toMatchObject({ success: true, state: "stable_consistent" });
    expect(integrated.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
    expect(kv.lists).toEqual([]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
  });

  it("uses the real Phase 5D-5J chain with eleven positive-budget triggers and four skill lists", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never);
    await expect(integrated.functions.get("mem::skill-context-parity-drift-shape-diagnostics")!(validInput())).resolves.toMatchObject({ success: true, state: "stable_consistent" });
    expect(integrated.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall"]);
    expect(kv.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
  });
});
