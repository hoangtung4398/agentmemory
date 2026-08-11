import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftSignatureRequest,
  evaluateSkillContextParityDriftSignature,
  registerSkillContextParityDriftSignatureDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-signature.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillContextParityStabilityDiagnosticsFunction } from "../src/functions/skill-context-parity-stability.js";
import { registerSkillContextParityDriftAttributionDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-attribution.js";
import { registerSkillContextParityDriftScopeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-scope.js";
import { registerSkillContextParityDriftShapeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-shape.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";

type Shape = Record<string, unknown>;
const validInput = { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 };

const signatures = [
  ["stable_consistent", "none", "none", false, false, "v1:stable_consistent:none:none"],
  ["stable_mismatch", "repeatable_mismatch", "single_stage", true, false, "v1:stable_mismatch:repeatable_mismatch:single_stage"],
  ["stable_mismatch", "repeatable_mismatch", "cross_stage", true, false, "v1:stable_mismatch:repeatable_mismatch:cross_stage"],
  ["observed_drift", "direct_drift", "single_stage", true, false, "v1:observed_drift:direct_drift:single_stage"],
  ["observed_drift", "direct_drift", "cross_stage", true, false, "v1:observed_drift:direct_drift:cross_stage"],
  ["observed_drift", "runtime_drift", "single_stage", true, false, "v1:observed_drift:runtime_drift:single_stage"],
  ["observed_drift", "runtime_drift", "cross_stage", true, false, "v1:observed_drift:runtime_drift:cross_stage"],
  ["observed_drift", "cross_path_drift", "single_stage", true, false, "v1:observed_drift:cross_path_drift:single_stage"],
  ["observed_drift", "cross_path_drift", "cross_stage", true, false, "v1:observed_drift:cross_path_drift:cross_stage"],
  ["observed_drift", "parity_only", "none", false, true, "v1:observed_drift:parity_only:none"],
  ["observed_drift", "parity_with_direct_drift", "single_stage", true, true, "v1:observed_drift:parity_with_direct_drift:single_stage"],
  ["observed_drift", "parity_with_direct_drift", "cross_stage", true, true, "v1:observed_drift:parity_with_direct_drift:cross_stage"],
  ["observed_drift", "parity_with_runtime_drift", "single_stage", true, true, "v1:observed_drift:parity_with_runtime_drift:single_stage"],
  ["observed_drift", "parity_with_runtime_drift", "cross_stage", true, true, "v1:observed_drift:parity_with_runtime_drift:cross_stage"],
  ["observed_drift", "parity_with_cross_path_drift", "single_stage", true, true, "v1:observed_drift:parity_with_cross_path_drift:single_stage"],
  ["observed_drift", "parity_with_cross_path_drift", "cross_stage", true, true, "v1:observed_drift:parity_with_cross_path_drift:cross_stage"],
] as const;

function enabledConfig(tokenBudget = 320) {
  return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 };
}

function shape(state = "stable_consistent", overrides: Record<string, unknown> = {}): Shape {
  const result: Shape = {
    success: true, enabled: true, applied: false, state, reasonCodes: ["stable_consistency_shaped"],
    sourceSamplingMode: "sequential_double_sample_non_atomic", shapeAvailable: true,
    scopeTriggerAttempted: true, scopeTriggerSucceeded: true, scopeResultParsed: true,
    laneShape: "none", stageSpan: "none", stageAttributionPresent: false, parityOutcomePresent: false,
  };
  if (state === "disabled") Object.assign(result, { enabled: false, shapeAvailable: false, scopeTriggerAttempted: false, scopeTriggerSucceeded: false, scopeResultParsed: false, reasonCodes: ["context_disabled"] });
  if (state === "failed") Object.assign(result, { success: false, shapeAvailable: false, scopeTriggerAttempted: true, scopeTriggerSucceeded: false, scopeResultParsed: false, reasonCodes: ["scope_trigger_failure"] });
  if (state === "stable_mismatch") Object.assign(result, { reasonCodes: ["stable_mismatch_shaped"], laneShape: "repeatable_mismatch", stageSpan: "single_stage", stageAttributionPresent: true });
  if (state === "observed_drift") Object.assign(result, { reasonCodes: ["observed_drift_shaped"], laneShape: "direct_drift", stageSpan: "single_stage", stageAttributionPresent: true });
  return { ...result, ...overrides };
}

function shapeFor(signature: typeof signatures[number]): Shape {
  const [state, laneShape, stageSpan, stageAttributionPresent, parityOutcomePresent] = signature;
  return shape(state, { laneShape, stageSpan, stageAttributionPresent, parityOutcomePresent });
}

function mockSdk() {
  const functions = new Map<string, (input: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let implementation: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | undefined;
  return {
    functions, requests,
    setTrigger: (next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) => { implementation = next; },
    registerFunction: (id: string, fn: (input: unknown) => Promise<unknown>) => functions.set(id, fn),
    trigger: async (request: { function_id: string; payload: unknown }) => {
      requests.push(request);
      if (implementation) return implementation(request);
      const fn = functions.get(request.function_id);
      if (!fn) throw new Error("missing handler");
      return fn(request.payload);
    },
  };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = [];
  return {
    lists, gets, writes,
    list: async <T>(key: string): Promise<T[]> => { lists.push(key); return rows as T[]; },
    get: async <T>(key: string): Promise<T | null> => { gets.push(key); return null; },
    set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); },
  };
}

function skill() {
  return { id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"], expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1 };
}

describe("skill context parity drift signature diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  const handler = () => sdk.functions.get("mem::skill-context-parity-drift-signature-diagnostics")!;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk as never);
  });

  it("is internal, follows the Phase 5J registration tail, and preserves public counts", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const registrations = [
      "registerSkillContextParityDiagnosticsFunction(sdk)",
      "registerSkillContextParityStabilityDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftShapeDiagnosticsFunction(sdk)",
      "registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk)",
    ];
    expect(registrations.map((entry) => index.indexOf(entry))).toEqual([...registrations.map((entry) => index.indexOf(entry))].sort((a, b) => a - b));
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => JSON.stringify(tool).includes("drift-signature"))).toBe(false);
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain("15 native skills");
    expect(index).toContain("REST API: 135 endpoints");
  });

  it("gates before validation and rejects the complete caller and numeric matrix without triggering", async () => {
    const disabled = await handler()(Symbol("private"));
    expect(disabled).toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"], signature: null });
    expect(sdk.requests).toEqual([]);
    loadSkillConfig.mockReturnValue(enabledConfig());
    const structural = [null, [], "text", 1, true, Symbol("x"), {}];
    const invalidProjects = [{}, { ...validInput, project: undefined }, { ...validInput, project: "   " }, { ...validInput, project: 1 }, { ...validInput, project: false }, { ...validInput, project: {} }, { ...validInput, project: [] }];
    const invalidNumbers = [undefined, null, "1", false, true, {}, [], NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -1];
    for (const value of [...structural, ...invalidProjects]) await expect(handler()(value)).resolves.toMatchObject({ state: "failed", reasonCodes: ["invalid_input"], shapeTriggerAttempted: false, signature: null });
    for (const field of ["overallBudget", "usedTokens", "selectedBlockCount"] as const) for (const value of invalidNumbers) await expect(handler()({ ...validInput, [field]: value })).resolves.toMatchObject({ reasonCodes: ["invalid_input"] });
    for (const agentId of [null, 1, false, {}, []]) await expect(handler()({ ...validInput, agentId })).resolves.toMatchObject({ reasonCodes: ["invalid_input"] });
    await expect(handler()({ ...validInput, overallBudget: 0 })).resolves.toMatchObject({ reasonCodes: ["invalid_input"] });
    sdk.setTrigger(async () => shape());
    await expect(handler()({ ...validInput, usedTokens: 2000, selectedBlockCount: 0 })).resolves.toMatchObject({ success: true });
    await expect(handler()({ ...validInput, overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: Number.MAX_SAFE_INTEGER })).resolves.toMatchObject({ success: true });
    expect(sdk.requests).toHaveLength(2);
  });

  it("builds exact fresh requests, strips ignored fields, preserves strings, and never mutates caller input", () => {
    const source = { ...validInput, project: " /repo ", agentId: " agent ", query: "private", files: ["x"], concepts: ["y"], limit: 1, sampleCount: 2, retryCount: 3, scopeMode: "x", shapeMode: "x", signatureMode: "x", severity: 1, confidence: 1, history: ["x"], baseline: "x" };
    const before = structuredClone(source); const first = buildSkillContextParityDriftSignatureRequest(source); const second = buildSkillContextParityDriftSignatureRequest(source);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-shape-diagnostics", payload: { project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } });
    expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload);
    for (const key of Object.keys(first.payload)) (first.payload as Record<string, unknown>)[key] = "mutated";
    expect(buildSkillContextParityDriftSignatureRequest(source).payload).toEqual(second.payload);
    expect(buildSkillContextParityDriftSignatureRequest({ ...validInput, agentId: "   " }).payload).not.toHaveProperty("agentId");
    expect(source).toEqual(before);
  });

  it("strictly rejects every malformed top-level Phase 5J contract and maps valid unavailable states", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const required = ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "shapeAvailable", "scopeTriggerAttempted", "scopeTriggerSucceeded", "scopeResultParsed", "laneShape", "stageSpan", "stageAttributionPresent", "parityOutcomePresent"];
    for (const field of required) {
      const raw = shape(); delete raw[field]; sdk.setTrigger(async () => raw);
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_shape_result"], shapeResultParsed: false });
    }
    for (const raw of [null, [], 1, "bad", { ...shape(), extra: true }, { ...shape(), reason: 1 }, { ...shape(), applied: true }, { ...shape(), sourceSamplingMode: "wrong" }, { ...shape(), state: "unknown" }, { ...shape(), laneShape: "unknown" }, { ...shape(), stageSpan: "wrong" }, { ...shape(), reasonCodes: [] }, { ...shape(), reasonCodes: ["stable_consistency_shaped", "other"] }]) {
      sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_shape_result"], shapeResultParsed: false });
    }
    for (const raw of [shape("disabled"), shape("failed"), shape("failed", { reasonCodes: ["invalid_scope_result"], scopeTriggerSucceeded: true }), shape("failed", { reasonCodes: ["scope_classification_unavailable"], scopeTriggerSucceeded: true, scopeResultParsed: true })]) {
      sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["shape_classification_unavailable"], shapeResultParsed: true, signature: null });
    }
  });

  it("enforces failed flags and success state-specific reason and tuple invariants", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const failedCases = [["scope_trigger_failure", [true, false, false]], ["invalid_scope_result", [true, true, false]], ["scope_classification_unavailable", [true, true, true]]] as const;
    for (const [reason, flags] of failedCases) {
      const raw = shape("failed", { reasonCodes: [reason], scopeTriggerAttempted: flags[0], scopeTriggerSucceeded: flags[1], scopeResultParsed: flags[2] }); sdk.setTrigger(async () => raw);
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["shape_classification_unavailable"] });
      for (const key of ["scopeTriggerAttempted", "scopeTriggerSucceeded", "scopeResultParsed"] as const) {
        const contradiction = { ...raw, [key]: !raw[key] }; sdk.setTrigger(async () => contradiction);
        await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_shape_result"] });
      }
    }
    const contradictions = [
      { ...shape(), reasonCodes: ["observed_drift_shaped"] }, { ...shape(), shapeAvailable: false }, { ...shape(), scopeTriggerSucceeded: false }, { ...shape(), laneShape: "direct_drift" },
      { ...shape("stable_mismatch"), reasonCodes: ["stable_consistency_shaped"] }, { ...shape("stable_mismatch"), stageSpan: "none" }, { ...shape("stable_mismatch"), stageAttributionPresent: false }, { ...shape("stable_mismatch"), parityOutcomePresent: true },
      { ...shape("observed_drift"), reasonCodes: ["stable_mismatch_shaped"] }, { ...shape("observed_drift"), laneShape: "parity_only", stageSpan: "single_stage", stageAttributionPresent: true, parityOutcomePresent: true },
    ];
    for (const raw of contradictions) { sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_shape_result"] }); }
  });

  it("maps all sixteen canonical tuples through the pure evaluator and real handler without mutation", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    expect(signatures).toHaveLength(16);
    for (const candidate of signatures) {
      const [state, laneShape, stageSpan, stageAttributionPresent, parityOutcomePresent, signature] = candidate;
      const evaluatorInput = { state, laneShape, stageSpan, stageAttributionPresent, parityOutcomePresent }; const before = structuredClone(evaluatorInput);
      expect(evaluateSkillContextParityDriftSignature(evaluatorInput as never)).toBe(signature);
      expect(evaluatorInput).toEqual(before);
      sdk.setTrigger(async () => shapeFor(candidate));
      await expect(handler()(validInput)).resolves.toMatchObject({ success: true, enabled: true, state, shapeTriggerAttempted: true, shapeTriggerSucceeded: true, shapeResultParsed: true, signatureAvailable: true, signature, reasonCodes: [state === "stable_consistent" ? "stable_consistency_signed" : state === "stable_mismatch" ? "stable_mismatch_signed" : "observed_drift_signed"] });
    }
    expect(() => evaluateSkillContextParityDriftSignature({ state: "observed_drift", laneShape: "direct_drift", stageSpan: "none", stageAttributionPresent: true, parityOutcomePresent: false } as never)).toThrow();
  });

  it("contains trigger failures, private markers, and defensive returned values without leaking or mutating inputs", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const thrown of [new Error("private-error"), "private-string", { marker: "private-object" }, null]) {
      sdk.setTrigger(async () => { throw thrown; });
      const output = await handler()({ ...validInput, project: "private-project", agentId: "private-agent" });
      expect(output).toMatchObject({ reasonCodes: ["shape_trigger_failure"], shapeTriggerAttempted: true, shapeTriggerSucceeded: false, shapeResultParsed: false, signature: null });
      expect(JSON.stringify(output)).not.toContain("private");
    }
    const raw = shape("observed_drift", { reason: "private-reason", affectedStages: ["private-stage"], activeLanes: ["private-lane"] }); const source = { ...validInput, project: "private-project" }; const before = structuredClone({ raw, source });
    sdk.setTrigger(async () => raw); const first = await handler()(source);
    for (const key of ["reasonCodes", "state", "sourceSamplingMode", "signatureAvailable", "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature"] as const) (first as Record<string, unknown>)[key] = "mutated";
    const second = await handler()(source); const serialized = JSON.stringify(second);
    for (const marker of ["private", "laneShape", "stageSpan", "stageAttributionPresent", "parityOutcomePresent", "affectedStages", "activeLanes", "payload"]) expect(serialized).not.toContain(marker);
    expect({ raw, source }).toEqual(before);
  });

  it("runs the real Phase 5D-5K no-budget chain with ten triggers and zero KV reads", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never);
    await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-diagnostics")!({ ...validInput, overallBudget: 10, usedTokens: 10 })).resolves.toMatchObject({ success: true, signature: "v1:stable_consistent:none:none" });
    expect(integrated.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-parity-drift-shape-diagnostics", "mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
    expect(kv.lists).toEqual([]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
  });

  it("runs the real Phase 5D-5K positive-budget chain with twelve triggers and four skill lists", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never);
    await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-diagnostics")!(validInput)).resolves.toMatchObject({ success: true });
    expect(integrated.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-parity-drift-shape-diagnostics", "mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall"]);
    expect(kv.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
  });
});
