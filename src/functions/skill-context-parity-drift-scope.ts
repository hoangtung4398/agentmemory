import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityAttributionStage,
  SkillContextParityAttributionSummary,
  SkillContextParityDriftAttributionDiagnosticsResult,
  SkillContextParityDriftScopeDiagnosticsInput,
  SkillContextParityDriftScopeDiagnosticsReasonCode,
  SkillContextParityDriftScopeDiagnosticsResult,
  SkillContextParityDriftScopeLane,
  SkillContextParityDriftScopeEvaluation,
  SkillRecallInput,
} from "../types.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextParityDriftScopeRequestInput = {
  project: string;
  agentId?: string;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type NormalizedInput = {
  recall: SkillRecallInput;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type ParsedAttributionResult = {
  state: SkillContextParityDriftAttributionDiagnosticsResult["state"];
  parityOutcomeChanged: boolean;
  repeatableMismatchAttribution: SkillContextParityAttributionSummary;
  directDriftAttribution: SkillContextParityAttributionSummary;
  runtimeDriftAttribution: SkillContextParityAttributionSummary;
};

const stages: SkillContextParityAttributionStage[] = ["path_contract", "budget", "recall", "packing", "admission"];
const lanes: SkillContextParityDriftScopeLane[] = ["repeatable_mismatch", "direct_drift", "runtime_drift", "parity_outcome"];
const states = new Set(["disabled", "failed", "stable_consistent", "stable_mismatch", "observed_drift"]);

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

function hasExactArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function isEmptyAttribution(value: SkillContextParityAttributionSummary): boolean {
  return value.stages.length === 0 && stages.every((stage) => value.stageCounts[stage] === 0);
}

function parseAttribution(value: unknown): SkillContextParityAttributionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  if (!hasExactKeys(summary, ["stages", "stageCounts"]) || !Array.isArray(summary.stages) || !summary.stageCounts ||
    typeof summary.stageCounts !== "object" || Array.isArray(summary.stageCounts)) return null;
  const stageCounts = summary.stageCounts as Record<string, unknown>;
  if (!hasExactKeys(stageCounts, stages)) return null;
  const parsedStages = summary.stages as unknown[];
  if (!parsedStages.every((stage, index) => typeof stage === "string" && stages.includes(stage as SkillContextParityAttributionStage) &&
    (index === 0 || stages.indexOf(parsedStages[index - 1] as SkillContextParityAttributionStage) < stages.indexOf(stage as SkillContextParityAttributionStage)))) return null;
  const counts = {} as SkillContextParityAttributionSummary["stageCounts"];
  for (const stage of stages) {
    const count = stageCounts[stage];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    counts[stage] = count;
  }
  const expectedStages = stages.filter((stage) => counts[stage] > 0);
  if (!hasExactArray(parsedStages, expectedStages)) return null;
  return { stages: [...expectedStages], stageCounts: { ...counts } };
}

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftScopeDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (!recall.success || !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0) return null;
  return { recall: recall.input, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount };
}

export function buildSkillContextParityDriftScopeRequest(input: SkillContextParityDriftScopeRequestInput): {
  function_id: "mem::skill-context-parity-drift-attribution-diagnostics";
  payload: SkillContextParityDriftScopeRequestInput;
} {
  return {
    function_id: "mem::skill-context-parity-drift-attribution-diagnostics",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    },
  };
}

function parseAttributionResult(value: unknown): ParsedAttributionResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const required = [
    "success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "attributionAvailable",
    "stabilityTriggerAttempted", "stabilityTriggerSucceeded", "stabilityResultParsed", "parityOutcomeChanged",
    "repeatableMismatchAttribution", "directDriftAttribution", "runtimeDriftAttribution",
  ];
  if (!hasExactKeys(result, required, ["reason"]) || (Object.hasOwn(result, "reason") && typeof result.reason !== "string") ||
    result.applied !== false || result.sourceSamplingMode !== "sequential_double_sample_non_atomic" || !states.has(result.state as string) ||
    typeof result.success !== "boolean" || typeof result.enabled !== "boolean" || typeof result.attributionAvailable !== "boolean" ||
    typeof result.stabilityTriggerAttempted !== "boolean" || typeof result.stabilityTriggerSucceeded !== "boolean" ||
    typeof result.stabilityResultParsed !== "boolean" || typeof result.parityOutcomeChanged !== "boolean") return null;
  const repeatableMismatchAttribution = parseAttribution(result.repeatableMismatchAttribution);
  const directDriftAttribution = parseAttribution(result.directDriftAttribution);
  const runtimeDriftAttribution = parseAttribution(result.runtimeDriftAttribution);
  if (!repeatableMismatchAttribution || !directDriftAttribution || !runtimeDriftAttribution) return null;
  const state = result.state as ParsedAttributionResult["state"];
  const allEmpty = isEmptyAttribution(repeatableMismatchAttribution) && isEmptyAttribution(directDriftAttribution) && isEmptyAttribution(runtimeDriftAttribution);
  const flags = [result.stabilityTriggerAttempted, result.stabilityTriggerSucceeded, result.stabilityResultParsed];
  if (state === "disabled") {
    if (!result.success || result.enabled || result.attributionAvailable || result.parityOutcomeChanged || flags.some(Boolean) || !allEmpty || !hasExactArray(result.reasonCodes, ["context_disabled"])) return null;
  } else if (state === "failed") {
    const reasonCodes = result.reasonCodes;
    const expected = ["stability_trigger_failure", "invalid_stability_result", "stability_classification_unavailable"];
    if (result.success || !result.enabled || result.attributionAvailable || result.parityOutcomeChanged || !allEmpty || !Array.isArray(reasonCodes) || reasonCodes.length !== 1 || !expected.includes(reasonCodes[0] as string)) return null;
    if (reasonCodes[0] === "stability_trigger_failure" && !(result.stabilityTriggerAttempted && !result.stabilityTriggerSucceeded && !result.stabilityResultParsed)) return null;
    if (reasonCodes[0] === "invalid_stability_result" && !(result.stabilityTriggerAttempted && result.stabilityTriggerSucceeded && !result.stabilityResultParsed)) return null;
    if (reasonCodes[0] === "stability_classification_unavailable" && !(result.stabilityTriggerAttempted && result.stabilityTriggerSucceeded && result.stabilityResultParsed)) return null;
  } else if (state === "stable_consistent") {
    if (!result.success || !result.enabled || !result.attributionAvailable || result.parityOutcomeChanged || flags.some((flag) => !flag) || !allEmpty || !hasExactArray(result.reasonCodes, ["stable_consistency_attributed"])) return null;
  } else if (state === "stable_mismatch") {
    if (!result.success || !result.enabled || !result.attributionAvailable || result.parityOutcomeChanged || flags.some((flag) => !flag) ||
      isEmptyAttribution(repeatableMismatchAttribution) || !isEmptyAttribution(directDriftAttribution) || !isEmptyAttribution(runtimeDriftAttribution) ||
      !hasExactArray(result.reasonCodes, ["stable_mismatch_attributed"])) return null;
  } else {
    if (!result.success || !result.enabled || !result.attributionAvailable || flags.some((flag) => !flag) ||
      !isEmptyAttribution(repeatableMismatchAttribution) ||
      (isEmptyAttribution(directDriftAttribution) && isEmptyAttribution(runtimeDriftAttribution) && !result.parityOutcomeChanged) ||
      !hasExactArray(result.reasonCodes, ["observed_drift_attributed"])) return null;
  }
  return { state, parityOutcomeChanged: result.parityOutcomeChanged, repeatableMismatchAttribution, directDriftAttribution, runtimeDriftAttribution };
}

export function evaluateSkillContextParityDriftScope(input: {
  repeatableMismatchAttribution: SkillContextParityAttributionSummary;
  directDriftAttribution: SkillContextParityAttributionSummary;
  runtimeDriftAttribution: SkillContextParityAttributionSummary;
  parityOutcomeChanged: boolean;
}): SkillContextParityDriftScopeEvaluation {
  const affected = new Set<SkillContextParityAttributionStage>([
    ...input.repeatableMismatchAttribution.stages,
    ...input.directDriftAttribution.stages,
    ...input.runtimeDriftAttribution.stages,
  ]);
  const active = new Set<SkillContextParityDriftScopeLane>();
  if (input.repeatableMismatchAttribution.stages.length) active.add("repeatable_mismatch");
  if (input.directDriftAttribution.stages.length) active.add("direct_drift");
  if (input.runtimeDriftAttribution.stages.length) active.add("runtime_drift");
  if (input.parityOutcomeChanged) active.add("parity_outcome");
  const affectedStages = stages.filter((stage) => affected.has(stage));
  const activeLanes = lanes.filter((lane) => active.has(lane));
  return {
    affectedStages,
    activeLanes,
    stageCount: affectedStages.length,
    laneCount: activeLanes.length,
    crossStage: affectedStages.length > 1,
    crossPathDrift: active.has("direct_drift") && active.has("runtime_drift"),
    parityOnly: activeLanes.length === 1 && activeLanes[0] === "parity_outcome" && affectedStages.length === 0,
  };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDriftScopeDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDriftScopeDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDriftScopeDiagnosticsResult> = {},
): SkillContextParityDriftScopeDiagnosticsResult {
  return {
    success, enabled, applied: false, state, reasonCodes: [...reasonCodes], sourceSamplingMode: "sequential_double_sample_non_atomic",
    scopeAvailable: false, attributionTriggerAttempted: false, attributionTriggerSucceeded: false, attributionResultParsed: false,
    affectedStages: [], activeLanes: [], stageCount: 0, laneCount: 0, crossStage: false, crossPathDrift: false, parityOnly: false,
    ...values,
  };
}

export function registerSkillContextParityDriftScopeDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-scope-diagnostics", async (data: unknown): Promise<SkillContextParityDriftScopeDiagnosticsResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift scope diagnostics is disabled" });
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift scope diagnostics input" });
    const request = buildSkillContextParityDriftScopeRequest({ project: input.recall.project!, ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}), overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount });
    let raw: unknown;
    try {
      raw = await sdk.trigger(request);
    } catch {
      return result(false, true, "failed", ["attribution_trigger_failure"], { reason: "skill context parity drift scope diagnostics could not summarize an attribution result", attributionTriggerAttempted: true });
    }
    const attribution = parseAttributionResult(raw);
    const values = { attributionTriggerAttempted: true, attributionTriggerSucceeded: true, attributionResultParsed: attribution !== null };
    if (!attribution) return result(false, true, "failed", ["invalid_attribution_result"], { reason: "skill context parity drift scope diagnostics could not summarize an attribution result", ...values });
    if (attribution.state === "disabled" || attribution.state === "failed") return result(false, true, "failed", ["attribution_classification_unavailable"], { reason: "skill context parity drift scope diagnostics could not summarize an attribution result", ...values });
    const scope = evaluateSkillContextParityDriftScope(attribution);
    return result(true, true, attribution.state, [attribution.state === "stable_consistent" ? "stable_consistency_scoped" : attribution.state === "stable_mismatch" ? "stable_mismatch_scoped" : "observed_drift_scoped"], {
      ...values, scopeAvailable: true, ...scope,
    });
  });
}
