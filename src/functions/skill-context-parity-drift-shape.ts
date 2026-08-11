import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityAttributionStage,
  SkillContextParityDriftScopeDiagnosticsResult, SkillContextParityDriftScopeLane,
  SkillContextParityDriftShapeDiagnosticsInput, SkillContextParityDriftShapeDiagnosticsReasonCode,
  SkillContextParityDriftShapeDiagnosticsResult, SkillContextParityDriftLaneShape,
  SkillContextParityDriftShapeEvaluation, SkillContextParityDriftStageSpan, SkillRecallInput,
} from "../types.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextParityDriftShapeRequestInput = { project: string; agentId?: string; overallBudget: number; usedTokens: number; selectedBlockCount: number };
type NormalizedInput = { recall: SkillRecallInput; overallBudget: number; usedTokens: number; selectedBlockCount: number };
type ParsedScope = { state: SkillContextParityDriftScopeDiagnosticsResult["state"]; activeLanes: SkillContextParityDriftScopeLane[]; stageCount: number };
const stages: SkillContextParityAttributionStage[] = ["path_contract", "budget", "recall", "packing", "admission"];
const lanes: SkillContextParityDriftScopeLane[] = ["repeatable_mismatch", "direct_drift", "runtime_drift", "parity_outcome"];
const states = new Set(["disabled", "failed", "stable_consistent", "stable_mismatch", "observed_drift"]);

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function exact(value: unknown, expected: string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]); }
function canonical(value: unknown, values: string[]): value is string[] {
  return Array.isArray(value) && value.every((item, index) => typeof item === "string" && values.includes(item) && (index === 0 || values.indexOf(value[index - 1] as string) < values.indexOf(item)));
}
function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftShapeDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (!recall.success || !recall.input.project || typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 || typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 || typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0) return null;
  return { recall: recall.input, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount };
}
export function buildSkillContextParityDriftShapeRequest(input: SkillContextParityDriftShapeRequestInput): { function_id: "mem::skill-context-parity-drift-scope-diagnostics"; payload: SkillContextParityDriftShapeRequestInput } {
  return { function_id: "mem::skill-context-parity-drift-scope-diagnostics", payload: { project: input.project, ...(input.agentId?.trim() ? { agentId: input.agentId } : {}), overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount } };
}
function parseScope(value: unknown): ParsedScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const required = ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "scopeAvailable", "attributionTriggerAttempted", "attributionTriggerSucceeded", "attributionResultParsed", "affectedStages", "activeLanes", "stageCount", "laneCount", "crossStage", "crossPathDrift", "parityOnly"];
  if (!exactKeys(result, required, ["reason"]) || (Object.hasOwn(result, "reason") && typeof result.reason !== "string") || result.applied !== false || result.sourceSamplingMode !== "sequential_double_sample_non_atomic" || !states.has(result.state as string) || typeof result.success !== "boolean" || typeof result.enabled !== "boolean" || typeof result.scopeAvailable !== "boolean" || typeof result.attributionTriggerAttempted !== "boolean" || typeof result.attributionTriggerSucceeded !== "boolean" || typeof result.attributionResultParsed !== "boolean" || typeof result.stageCount !== "number" || !Number.isSafeInteger(result.stageCount) || result.stageCount < 0 || typeof result.laneCount !== "number" || !Number.isSafeInteger(result.laneCount) || result.laneCount < 0 || typeof result.crossStage !== "boolean" || typeof result.crossPathDrift !== "boolean" || typeof result.parityOnly !== "boolean" || !canonical(result.affectedStages, stages) || !canonical(result.activeLanes, lanes)) return null;
  const affectedStages = result.affectedStages as SkillContextParityAttributionStage[];
  const activeLanes = result.activeLanes as SkillContextParityDriftScopeLane[];
  const flags = [result.attributionTriggerAttempted, result.attributionTriggerSucceeded, result.attributionResultParsed];
  const bearing = activeLanes.some((lane) => lane !== "parity_outcome");
  if (result.stageCount !== affectedStages.length || result.laneCount !== activeLanes.length || result.crossStage !== (result.stageCount > 1) || result.crossPathDrift !== (activeLanes.includes("direct_drift") && activeLanes.includes("runtime_drift")) || result.parityOnly !== (exact(activeLanes, ["parity_outcome"]) && affectedStages.length === 0) || (affectedStages.length > 0) !== bearing) return null;
  const state = result.state as ParsedScope["state"];
  if (state === "disabled") {
    if (!result.success || result.enabled || result.scopeAvailable || flags.some(Boolean) || affectedStages.length || activeLanes.length || !exact(result.reasonCodes, ["context_disabled"])) return null;
  } else if (state === "failed") {
    const code = Array.isArray(result.reasonCodes) && result.reasonCodes.length === 1 ? result.reasonCodes[0] : undefined;
    if (result.success || !result.enabled || result.scopeAvailable || affectedStages.length || activeLanes.length || result.stageCount || result.laneCount || result.crossStage || result.crossPathDrift || result.parityOnly || !["attribution_trigger_failure", "invalid_attribution_result", "attribution_classification_unavailable"].includes(code as string)) return null;
    if (code === "attribution_trigger_failure" && !(result.attributionTriggerAttempted && !result.attributionTriggerSucceeded && !result.attributionResultParsed)) return null;
    if (code === "invalid_attribution_result" && !(result.attributionTriggerAttempted && result.attributionTriggerSucceeded && !result.attributionResultParsed)) return null;
    if (code === "attribution_classification_unavailable" && !(result.attributionTriggerAttempted && result.attributionTriggerSucceeded && result.attributionResultParsed)) return null;
  } else if (!result.success || !result.enabled || !result.scopeAvailable || flags.some((flag) => !flag)) return null;
  if (state === "stable_consistent" && (!exact(result.reasonCodes, ["stable_consistency_scoped"]) || affectedStages.length || activeLanes.length)) return null;
  if (state === "stable_mismatch" && (!exact(result.reasonCodes, ["stable_mismatch_scoped"]) || !exact(activeLanes, ["repeatable_mismatch"]) || !affectedStages.length || result.crossPathDrift || result.parityOnly)) return null;
  if (state === "observed_drift" && (!exact(result.reasonCodes, ["observed_drift_scoped"]) || activeLanes.includes("repeatable_mismatch") || !activeLanes.length)) return null;
  return { state, activeLanes: [...activeLanes], stageCount: result.stageCount };
}
export function evaluateSkillContextParityDriftShape(input: { activeLanes: SkillContextParityDriftScopeLane[]; stageCount: number }): SkillContextParityDriftShapeEvaluation {
  const active = new Set(input.activeLanes); const parity = active.has("parity_outcome"); const direct = active.has("direct_drift"); const runtime = active.has("runtime_drift");
  const laneShape: SkillContextParityDriftLaneShape = active.size === 0 ? "none" : active.has("repeatable_mismatch") ? "repeatable_mismatch" : parity && direct && runtime ? "parity_with_cross_path_drift" : parity && direct ? "parity_with_direct_drift" : parity && runtime ? "parity_with_runtime_drift" : parity ? "parity_only" : direct && runtime ? "cross_path_drift" : direct ? "direct_drift" : "runtime_drift";
  const stageSpan: SkillContextParityDriftStageSpan = input.stageCount === 0 ? "none" : input.stageCount === 1 ? "single_stage" : "cross_stage";
  return { laneShape, stageSpan, stageAttributionPresent: input.stageCount > 0, parityOutcomePresent: parity };
}
function result(success: boolean, enabled: boolean, state: SkillContextParityDriftShapeDiagnosticsResult["state"], reasonCodes: SkillContextParityDriftShapeDiagnosticsReasonCode[], values: Partial<SkillContextParityDriftShapeDiagnosticsResult> = {}): SkillContextParityDriftShapeDiagnosticsResult {
  return { success, enabled, applied: false, state, reasonCodes: [...reasonCodes], sourceSamplingMode: "sequential_double_sample_non_atomic", shapeAvailable: false, scopeTriggerAttempted: false, scopeTriggerSucceeded: false, scopeResultParsed: false, laneShape: "none", stageSpan: "none", stageAttributionPresent: false, parityOutcomePresent: false, ...values };
}
export function registerSkillContextParityDriftShapeDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-shape-diagnostics", async (data: unknown): Promise<SkillContextParityDriftShapeDiagnosticsResult> => {
    if (!loadSkillConfig().contextEnabled) return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift shape diagnostics is disabled" });
    const input = normalizeInput(data); if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift shape diagnostics input" });
    let raw: unknown; try { raw = await sdk.trigger(buildSkillContextParityDriftShapeRequest({ project: input.recall.project!, ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}), overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount })); } catch { return result(false, true, "failed", ["scope_trigger_failure"], { reason: "skill context parity drift shape diagnostics could not classify a scope result", scopeTriggerAttempted: true }); }
    const scope = parseScope(raw); const flags = { scopeTriggerAttempted: true, scopeTriggerSucceeded: true, scopeResultParsed: scope !== null };
    if (!scope) return result(false, true, "failed", ["invalid_scope_result"], { reason: "skill context parity drift shape diagnostics could not classify a scope result", ...flags });
    if (scope.state === "disabled" || scope.state === "failed") return result(false, true, "failed", ["scope_classification_unavailable"], { reason: "skill context parity drift shape diagnostics could not classify a scope result", ...flags });
    return result(true, true, scope.state, [scope.state === "stable_consistent" ? "stable_consistency_shaped" : scope.state === "stable_mismatch" ? "stable_mismatch_shaped" : "observed_drift_shaped"], { ...flags, shapeAvailable: true, ...evaluateSkillContextParityDriftShape(scope) });
  });
}
