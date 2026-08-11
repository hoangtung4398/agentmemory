import { beforeEach, describe, expect, it, vi } from "vitest";
const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));
import { buildSkillContextParityDriftShapeRequest, evaluateSkillContextParityDriftShape, registerSkillContextParityDriftShapeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-shape.js";
import type { SkillContextParityDriftScopeDiagnosticsResult } from "../src/types.js";

function config() { return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: 320, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 }; }
function scope(state: SkillContextParityDriftScopeDiagnosticsResult["state"] = "stable_consistent", overrides: Record<string, unknown> = {}): SkillContextParityDriftScopeDiagnosticsResult {
  const base = { success: true, enabled: true, applied: false, state, reasonCodes: ["stable_consistency_scoped"], sourceSamplingMode: "sequential_double_sample_non_atomic", scopeAvailable: true, attributionTriggerAttempted: true, attributionTriggerSucceeded: true, attributionResultParsed: true, affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0, crossStage: false, crossPathDrift: false, parityOnly: false };
  if (state === "stable_mismatch") Object.assign(base, { reasonCodes: ["stable_mismatch_scoped"], affectedStages: ["budget"], activeLanes: ["repeatable_mismatch"], stageCount: 1, laneCount: 1 });
  if (state === "observed_drift") Object.assign(base, { reasonCodes: ["observed_drift_scoped"], affectedStages: ["budget"], activeLanes: ["direct_drift"], stageCount: 1, laneCount: 1 });
  if (state === "disabled") Object.assign(base, { enabled: false, reasonCodes: ["context_disabled"], scopeAvailable: false, attributionTriggerAttempted: false, attributionTriggerSucceeded: false, attributionResultParsed: false });
  return { ...base, ...overrides } as SkillContextParityDriftScopeDiagnosticsResult;
}
function sdk() { const functions = new Map<string, (data: unknown) => Promise<unknown>>(); const requests: unknown[] = []; let trigger: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | undefined; return { functions, requests, set: (next: typeof trigger) => { trigger = next; }, registerFunction: (id: string, fn: (data: unknown) => Promise<unknown>) => functions.set(id, fn), trigger: async (request: { function_id: string; payload: unknown }) => { requests.push(request); if (trigger) return trigger(request); throw new Error("unset"); } }; }
describe("skill context parity drift shape diagnostics", () => {
  let mock: ReturnType<typeof sdk>;
  beforeEach(() => { loadSkillConfig.mockReset(); loadSkillConfig.mockReturnValue({ ...config(), contextEnabled: false }); mock = sdk(); registerSkillContextParityDriftShapeDiagnosticsFunction(mock as never); });
  const input = { project: "/repo", overallBudget: 10, usedTokens: 0, selectedBlockCount: 0 };
  const run = (value: unknown) => mock.functions.get("mem::skill-context-parity-drift-shape-diagnostics")!(value);
  it("gates before validation and builds fresh exact scope requests", async () => {
    await expect(run(Symbol("x"))).resolves.toMatchObject({ state: "disabled", shapeAvailable: false }); expect(mock.requests).toEqual([]);
    const source = { ...input, agentId: " agent " }; const a = buildSkillContextParityDriftShapeRequest(source); const b = buildSkillContextParityDriftShapeRequest(source); expect(a).toEqual({ function_id: "mem::skill-context-parity-drift-scope-diagnostics", payload: source }); expect(a).not.toBe(b); expect(a.payload).not.toBe(b.payload); a.payload.project = "mutated"; expect(source.project).toBe("/repo");
  });
  it("rejects invalid input without a trigger and allows used tokens above budget", async () => {
    loadSkillConfig.mockReturnValue(config());
    for (const value of [null, [], { ...input, project: "" }, { ...input, overallBudget: 0 }, { ...input, usedTokens: NaN }, { ...input, selectedBlockCount: -1 }]) { mock.requests.length = 0; await expect(run(value)).resolves.toMatchObject({ state: "failed", reasonCodes: ["invalid_input"], scopeTriggerAttempted: false }); expect(mock.requests).toEqual([]); }
    mock.set(async () => scope()); await expect(run({ ...input, usedTokens: 11 })).resolves.toMatchObject({ success: true, state: "stable_consistent", laneShape: "none", stageSpan: "none" });
  });
  it("classifies every categorical lane shape and preserves input", () => {
    const cases: Array<[string[], number, string, string]> = [[[], 0, "none", "none"], [["repeatable_mismatch"], 1, "repeatable_mismatch", "single_stage"], [["direct_drift"], 1, "direct_drift", "single_stage"], [["runtime_drift"], 2, "runtime_drift", "cross_stage"], [["direct_drift", "runtime_drift"], 2, "cross_path_drift", "cross_stage"], [["parity_outcome"], 0, "parity_only", "none"], [["direct_drift", "parity_outcome"], 1, "parity_with_direct_drift", "single_stage"], [["runtime_drift", "parity_outcome"], 1, "parity_with_runtime_drift", "single_stage"], [["direct_drift", "runtime_drift", "parity_outcome"], 2, "parity_with_cross_path_drift", "cross_stage"]];
    for (const [activeLanes, stageCount, laneShape, stageSpan] of cases) expect(evaluateSkillContextParityDriftShape({ activeLanes: activeLanes as never, stageCount })).toMatchObject({ laneShape, stageSpan, stageAttributionPresent: stageCount > 0, parityOutcomePresent: activeLanes.includes("parity_outcome") });
  });
  it("parses strict scope results and fails closed without leaking nested values", async () => {
    loadSkillConfig.mockReturnValue(config()); mock.set(async () => scope("observed_drift", { activeLanes: ["direct_drift", "runtime_drift", "parity_outcome"], affectedStages: ["budget", "packing"], stageCount: 2, laneCount: 3, crossStage: true, crossPathDrift: true }));
    await expect(run(input)).resolves.toMatchObject({ success: true, laneShape: "parity_with_cross_path_drift", stageSpan: "cross_stage", stageAttributionPresent: true, parityOutcomePresent: true });
    for (const raw of [null, [], scope("stable_consistent", { stageCount: 1 }), scope("stable_mismatch", { activeLanes: ["direct_drift"] }), scope("observed_drift", { affectedStages: ["budget"], activeLanes: ["parity_outcome"], stageCount: 1, laneCount: 1, parityOnly: true })]) { mock.set(async () => raw); await expect(run(input)).resolves.toMatchObject({ state: "failed", reasonCodes: ["invalid_scope_result"] }); }
    mock.set(async () => { throw { secret: "no-leak" }; }); const failed = await run(input); expect(JSON.stringify(failed)).not.toContain("no-leak");
  });
});
