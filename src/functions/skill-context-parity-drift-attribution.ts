import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityAttributionStage,
  SkillContextParityAttributionSummary,
  SkillContextParityDiagnosticsState,
  SkillContextParityDriftAttributionDiagnosticsInput,
  SkillContextParityDriftAttributionDiagnosticsReasonCode,
  SkillContextParityDriftAttributionDiagnosticsResult,
  SkillContextParityMismatchCode,
  SkillContextParityStabilityDiagnosticsResult,
  SkillContextParityStabilitySampleSummary,
  SkillRecallInput,
} from "../types.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextParityDriftAttributionRequestInput = {
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

type ParsedStabilityResult = Pick<
  SkillContextParityStabilityDiagnosticsResult,
  "state" | "first" | "second" | "directDriftCodes" | "runtimeDriftCodes"
>;

const stages: SkillContextParityAttributionStage[] = ["path_contract", "budget", "recall", "packing", "admission"];
const mismatchCodeOrder: SkillContextParityMismatchCode[] = [
  "path_success_mismatch", "path_enabled_mismatch", "path_state_mismatch", "overall_budget_mismatch",
  "used_tokens_mismatch", "selected_block_count_mismatch", "configured_skill_budget_mismatch",
  "separator_tokens_mismatch", "remaining_budget_mismatch", "effective_skill_budget_mismatch",
  "effective_recall_limit_mismatch", "recall_attempt_mismatch", "recalled_advisory_count_mismatch",
  "packed_count_mismatch", "omitted_count_mismatch", "packed_tokens_mismatch", "section_created_mismatch",
  "section_admitted_mismatch", "projected_used_tokens_mismatch", "projected_block_count_mismatch",
];
const stabilityStates = new Set(["disabled", "failed", "stable_consistent", "stable_mismatch", "observed_drift"]);
const stabilityReasonCodes = new Set([
  "context_disabled", "invalid_input", "first_trigger_failure", "invalid_first_result", "first_comparison_unavailable",
  "second_trigger_failure", "invalid_second_result", "second_comparison_unavailable", "stable_consistency_observed",
  "stable_mismatch_observed", "sample_drift_observed",
]);
const stabilityReasonOrder = [
  "context_disabled", "invalid_input", "first_trigger_failure", "invalid_first_result", "first_comparison_unavailable",
  "second_trigger_failure", "invalid_second_result", "second_comparison_unavailable", "stable_consistency_observed",
  "stable_mismatch_observed", "sample_drift_observed",
];
const parityStates = new Set<SkillContextParityDiagnosticsState>(["disabled", "failed", "consistent", "mismatch"]);
const codeStages: Record<SkillContextParityMismatchCode, SkillContextParityAttributionStage> = {
  path_success_mismatch: "path_contract", path_enabled_mismatch: "path_contract", path_state_mismatch: "path_contract",
  overall_budget_mismatch: "budget", used_tokens_mismatch: "budget", selected_block_count_mismatch: "budget",
  configured_skill_budget_mismatch: "budget", separator_tokens_mismatch: "budget", remaining_budget_mismatch: "budget",
  effective_skill_budget_mismatch: "budget", effective_recall_limit_mismatch: "recall", recall_attempt_mismatch: "recall",
  recalled_advisory_count_mismatch: "recall", packed_count_mismatch: "packing", omitted_count_mismatch: "packing",
  packed_tokens_mismatch: "packing", section_created_mismatch: "packing", section_admitted_mismatch: "admission",
  projected_used_tokens_mismatch: "admission", projected_block_count_mismatch: "admission",
};

function emptyAttribution(): SkillContextParityAttributionSummary {
  return { stages: [], stageCounts: { path_contract: 0, budget: 0, recall: 0, packing: 0, admission: 0 } };
}

export function attributeSkillContextParityCodes(codes: SkillContextParityMismatchCode[]): SkillContextParityAttributionSummary {
  const stageCounts = emptyAttribution().stageCounts;
  for (const code of codes) stageCounts[codeStages[code]]++;
  return { stages: stages.filter((stage) => stageCounts[stage] > 0), stageCounts };
}

export function buildSkillContextParityDriftAttributionRequest(input: SkillContextParityDriftAttributionRequestInput): {
  function_id: "mem::skill-context-parity-stability-diagnostics";
  payload: SkillContextParityDriftAttributionRequestInput;
} {
  return {
    function_id: "mem::skill-context-parity-stability-diagnostics",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    },
  };
}

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftAttributionDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (!recall.success || !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0) return null;
  return { recall: recall.input, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount };
}

function isCanonicalCodes(value: unknown): value is SkillContextParityMismatchCode[] {
  return Array.isArray(value) && value.every((code, index) => typeof code === "string" && mismatchCodeOrder.includes(code as SkillContextParityMismatchCode) &&
    (index === 0 || mismatchCodeOrder.indexOf(value[index - 1] as SkillContextParityMismatchCode) < mismatchCodeOrder.indexOf(code as SkillContextParityMismatchCode)));
}

function isCanonicalStabilityReasons(value: unknown): boolean {
  return Array.isArray(value) && value.every((code, index) => typeof code === "string" && stabilityReasonCodes.has(code) &&
    (index === 0 || stabilityReasonOrder.indexOf(value[index - 1] as string) < stabilityReasonOrder.indexOf(code)));
}

function hasExactStabilityReasons(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((code, index) => code === expected[index]);
}

function sameCodes(first: SkillContextParityMismatchCode[], second: SkillContextParityMismatchCode[]): boolean {
  return first.length === second.length && first.every((code, index) => code === second[index]);
}

function parseSummary(value: unknown): SkillContextParityStabilitySampleSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const keys = Object.keys(summary).sort();
  const expected = ["comparisonAvailable", "consistent", "enabled", "mismatchCodes", "state", "success"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
    typeof summary.success !== "boolean" || typeof summary.enabled !== "boolean" ||
    typeof summary.comparisonAvailable !== "boolean" || typeof summary.consistent !== "boolean" ||
    !parityStates.has(summary.state as SkillContextParityDiagnosticsState) || !isCanonicalCodes(summary.mismatchCodes)) return null;
  return {
    success: summary.success,
    enabled: summary.enabled,
    state: summary.state as SkillContextParityDiagnosticsState,
    comparisonAvailable: summary.comparisonAvailable,
    consistent: summary.consistent,
    mismatchCodes: [...summary.mismatchCodes],
  };
}

function comparableConsistent(summary: SkillContextParityStabilitySampleSummary): boolean {
  return summary.success && summary.enabled && summary.state === "consistent" && summary.comparisonAvailable && summary.consistent && summary.mismatchCodes.length === 0;
}

function comparableMismatch(summary: SkillContextParityStabilitySampleSummary): boolean {
  return summary.success && summary.enabled && summary.state === "mismatch" && summary.comparisonAvailable && !summary.consistent && summary.mismatchCodes.length > 0;
}

function validFailedStabilityPath(
  failureCode: string | undefined,
  attempted: boolean,
  succeeded: boolean,
  parsed: boolean,
  sample: SkillContextParityStabilitySampleSummary | null,
): boolean {
  if (!attempted) return false;
  if (failureCode === "first_trigger_failure" || failureCode === "second_trigger_failure") return !succeeded && !parsed && sample === null;
  if (failureCode === "invalid_first_result" || failureCode === "invalid_second_result") return succeeded && !parsed && sample === null;
  if (failureCode === "first_comparison_unavailable" || failureCode === "second_comparison_unavailable") {
    return succeeded && parsed && sample !== null && !sample.success && sample.enabled && sample.state === "failed" &&
      !sample.comparisonAvailable && !sample.consistent && sample.mismatchCodes.length === 0;
  }
  return succeeded && parsed && sample !== null && (comparableConsistent(sample) || comparableMismatch(sample));
}

function parseStabilityResult(value: unknown): ParsedStabilityResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.applied !== false || result.samplingMode !== "sequential_double_sample_non_atomic" || result.sampleCount !== 2 ||
    !stabilityStates.has(result.state as string) || typeof result.success !== "boolean" || typeof result.enabled !== "boolean" ||
    typeof result.firstTriggerAttempted !== "boolean" || typeof result.firstTriggerSucceeded !== "boolean" || typeof result.firstResultParsed !== "boolean" ||
    typeof result.secondTriggerAttempted !== "boolean" || typeof result.secondTriggerSucceeded !== "boolean" || typeof result.secondResultParsed !== "boolean" ||
    typeof result.stableAcrossSamples !== "boolean" || typeof result.repeatableMismatch !== "boolean" ||
    !isCanonicalStabilityReasons(result.reasonCodes) || !isCanonicalCodes(result.directDriftCodes) || !isCanonicalCodes(result.runtimeDriftCodes)) return null;
  const first = result.first === null ? null : parseSummary(result.first);
  const second = result.second === null ? null : parseSummary(result.second);
  if ((result.first !== null && !first) || (result.second !== null && !second)) return null;
  const state = result.state as SkillContextParityDriftAttributionDiagnosticsResult["state"];
  if (state === "disabled") {
    if (!result.success || result.enabled || first || second || result.firstTriggerAttempted || result.firstTriggerSucceeded || result.firstResultParsed ||
      result.secondTriggerAttempted || result.secondTriggerSucceeded || result.secondResultParsed || result.directDriftCodes.length || result.runtimeDriftCodes.length || result.stableAcrossSamples || result.repeatableMismatch) return null;
    if (!hasExactStabilityReasons(result.reasonCodes, ["context_disabled"])) return null;
  } else if (state === "failed") {
    const reasonCodes = result.reasonCodes as string[];
    const firstFailure = reasonCodes.find((code) => code.startsWith("first_"));
    const secondFailure = reasonCodes.find((code) => code.startsWith("second_"));
    if (result.success || !result.enabled || result.stableAcrossSamples || result.repeatableMismatch ||
      result.directDriftCodes.length || result.runtimeDriftCodes.length ||
      !reasonCodes.length || !validFailedStabilityPath(firstFailure, result.firstTriggerAttempted, result.firstTriggerSucceeded, result.firstResultParsed, first) ||
      !validFailedStabilityPath(secondFailure, result.secondTriggerAttempted, result.secondTriggerSucceeded, result.secondResultParsed, second)) return null;
  } else {
    if (!result.success || !result.enabled || !first || !second || !result.firstTriggerAttempted || !result.firstTriggerSucceeded || !result.firstResultParsed ||
      !result.secondTriggerAttempted || !result.secondTriggerSucceeded || !result.secondResultParsed) return null;
    const parityOutcomeChanged = first.consistent !== second.consistent || !sameCodes(first.mismatchCodes, second.mismatchCodes);
    if (state === "stable_consistent" && (!comparableConsistent(first) || !comparableConsistent(second) || result.directDriftCodes.length || result.runtimeDriftCodes.length || !result.stableAcrossSamples || result.repeatableMismatch || !hasExactStabilityReasons(result.reasonCodes, ["stable_consistency_observed"]))) return null;
    if (state === "stable_mismatch" && (!comparableMismatch(first) || !comparableMismatch(second) || !sameCodes(first.mismatchCodes, second.mismatchCodes) || result.directDriftCodes.length || result.runtimeDriftCodes.length || !result.stableAcrossSamples || !result.repeatableMismatch || !hasExactStabilityReasons(result.reasonCodes, ["stable_mismatch_observed"]))) return null;
    if (state === "observed_drift" && (!first.comparisonAvailable || !second.comparisonAvailable || result.repeatableMismatch ||
      (!result.directDriftCodes.length && !result.runtimeDriftCodes.length && !parityOutcomeChanged) || !hasExactStabilityReasons(result.reasonCodes, ["sample_drift_observed"]))) return null;
  }
  return { state, first, second, directDriftCodes: [...result.directDriftCodes], runtimeDriftCodes: [...result.runtimeDriftCodes] };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDriftAttributionDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDriftAttributionDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDriftAttributionDiagnosticsResult> = {},
): SkillContextParityDriftAttributionDiagnosticsResult {
  return {
    success, enabled, applied: false, state, reasonCodes: [...reasonCodes], sourceSamplingMode: "sequential_double_sample_non_atomic",
    attributionAvailable: false, stabilityTriggerAttempted: false, stabilityTriggerSucceeded: false, stabilityResultParsed: false,
    parityOutcomeChanged: false, repeatableMismatchAttribution: emptyAttribution(), directDriftAttribution: emptyAttribution(), runtimeDriftAttribution: emptyAttribution(),
    ...values,
  };
}

export function registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-attribution-diagnostics", async (data: unknown): Promise<SkillContextParityDriftAttributionDiagnosticsResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift attribution diagnostics is disabled" });
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift attribution diagnostics input" });
    const request = buildSkillContextParityDriftAttributionRequest({ project: input.recall.project!, ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}), overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount });
    let raw: unknown;
    try {
      raw = await sdk.trigger(request);
    } catch {
      return result(false, true, "failed", ["stability_trigger_failure"], { reason: "skill context parity drift attribution diagnostics could not attribute a stability result", stabilityTriggerAttempted: true });
    }
    const stability = parseStabilityResult(raw);
    const values = { stabilityTriggerAttempted: true, stabilityTriggerSucceeded: true, stabilityResultParsed: stability !== null };
    if (!stability) return result(false, true, "failed", ["invalid_stability_result"], { reason: "skill context parity drift attribution diagnostics could not attribute a stability result", ...values });
    if (stability.state === "disabled" || stability.state === "failed") return result(false, true, "failed", ["stability_classification_unavailable"], { reason: "skill context parity drift attribution diagnostics could not attribute a stability result", ...values });
    const parityOutcomeChanged = stability.first!.consistent !== stability.second!.consistent || !sameCodes(stability.first!.mismatchCodes, stability.second!.mismatchCodes);
    const repeatableMismatchAttribution = stability.state === "stable_mismatch" ? attributeSkillContextParityCodes(stability.first!.mismatchCodes) : emptyAttribution();
    return result(true, true, stability.state, [stability.state === "stable_consistent" ? "stable_consistency_attributed" : stability.state === "stable_mismatch" ? "stable_mismatch_attributed" : "observed_drift_attributed"], {
      ...values, attributionAvailable: true, parityOutcomeChanged,
      repeatableMismatchAttribution,
      directDriftAttribution: attributeSkillContextParityCodes(stability.directDriftCodes),
      runtimeDriftAttribution: attributeSkillContextParityCodes(stability.runtimeDriftCodes),
    });
  });
}
