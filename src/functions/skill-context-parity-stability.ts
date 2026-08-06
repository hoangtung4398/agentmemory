import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityDiagnosticsReasonCode,
  SkillContextParityDiagnosticsState,
  SkillContextParityMismatchCode,
  SkillContextParitySnapshot,
  SkillContextParityStabilityDiagnosticsInput,
  SkillContextParityStabilityDiagnosticsResult,
  SkillContextParityStabilityEvaluation,
  SkillContextParityStabilityReasonCode,
  SkillContextParityStabilitySampleSummary,
  SkillRecallInput,
} from "../types.js";
import { compareSkillContextParitySnapshots } from "./skill-context-parity.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextParityStabilityRequestInput = {
  project: string;
  agentId?: string;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type StabilityRequest = {
  function_id: "mem::skill-context-parity-diagnostics";
  payload: SkillContextParityStabilityRequestInput;
};

type NormalizedInput = {
  recall: SkillRecallInput;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type ParsedSample = {
  summary: SkillContextParityStabilitySampleSummary;
  direct: SkillContextParitySnapshot | null;
  runtime: SkillContextParitySnapshot | null;
};

const parityStates = new Set<SkillContextParityDiagnosticsState>(["disabled", "failed", "consistent", "mismatch"]);
const snapshotStates = new Set<SkillContextParitySnapshot["state"]>([
  "disabled", "failed", "skipped_no_budget", "recall_empty", "packing_empty", "admitted", "rejected_outer_budget",
]);
const parityReasonCodes = new Set<SkillContextParityDiagnosticsReasonCode>([
  "context_disabled", "invalid_input", "direct_trigger_failure", "invalid_direct_result",
  "runtime_trigger_failure", "invalid_runtime_result", "paths_consistent", "paths_mismatch",
]);
const parityReasonCodeOrder: SkillContextParityDiagnosticsReasonCode[] = [
  "context_disabled", "invalid_input", "direct_trigger_failure", "invalid_direct_result",
  "runtime_trigger_failure", "invalid_runtime_result", "paths_consistent", "paths_mismatch",
];
const mismatchCodeOrder: SkillContextParityMismatchCode[] = [
  "path_success_mismatch", "path_enabled_mismatch", "path_state_mismatch", "overall_budget_mismatch",
  "used_tokens_mismatch", "selected_block_count_mismatch", "configured_skill_budget_mismatch",
  "separator_tokens_mismatch", "remaining_budget_mismatch", "effective_skill_budget_mismatch",
  "effective_recall_limit_mismatch", "recall_attempt_mismatch", "recalled_advisory_count_mismatch",
  "packed_count_mismatch", "omitted_count_mismatch", "packed_tokens_mismatch", "section_created_mismatch",
  "section_admitted_mismatch", "projected_used_tokens_mismatch", "projected_block_count_mismatch",
];

export function buildSkillContextParityStabilityRequests(input: SkillContextParityStabilityRequestInput): {
  first: StabilityRequest;
  second: StabilityRequest;
} {
  const payload = {
    project: input.project,
    ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
    overallBudget: input.overallBudget,
    usedTokens: input.usedTokens,
    selectedBlockCount: input.selectedBlockCount,
  };
  return {
    first: { function_id: "mem::skill-context-parity-diagnostics", payload: { ...payload } },
    second: { function_id: "mem::skill-context-parity-diagnostics", payload: { ...payload } },
  };
}

export function evaluateSkillContextParityStability(
  first: { summary: SkillContextParityStabilitySampleSummary; direct: SkillContextParitySnapshot; runtime: SkillContextParitySnapshot },
  second: { summary: SkillContextParityStabilitySampleSummary; direct: SkillContextParitySnapshot; runtime: SkillContextParitySnapshot },
): SkillContextParityStabilityEvaluation {
  const directDriftCodes = compareSkillContextParitySnapshots(first.direct, second.direct);
  const runtimeDriftCodes = compareSkillContextParitySnapshots(first.runtime, second.runtime);
  const stableAcrossSamples = directDriftCodes.length === 0 && runtimeDriftCodes.length === 0;
  const sameMismatches = first.summary.mismatchCodes.length === second.summary.mismatchCodes.length &&
    first.summary.mismatchCodes.every((code, index) => code === second.summary.mismatchCodes[index]);
  if (stableAcrossSamples && first.summary.consistent && second.summary.consistent &&
    first.summary.mismatchCodes.length === 0 && second.summary.mismatchCodes.length === 0) {
    return { state: "stable_consistent", directDriftCodes: [], runtimeDriftCodes: [], stableAcrossSamples: true, repeatableMismatch: false };
  }
  if (stableAcrossSamples && !first.summary.consistent && !second.summary.consistent &&
    first.summary.mismatchCodes.length > 0 && sameMismatches) {
    return { state: "stable_mismatch", directDriftCodes: [], runtimeDriftCodes: [], stableAcrossSamples: true, repeatableMismatch: true };
  }
  return {
    state: "observed_drift",
    directDriftCodes: [...directDriftCodes],
    runtimeDriftCodes: [...runtimeDriftCodes],
    stableAcrossSamples,
    repeatableMismatch: false,
  };
}

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityStabilityDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (!recall.success || !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0) return null;
  return { recall: recall.input, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCanonicalMismatchCodes(value: unknown): value is SkillContextParityMismatchCode[] {
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string" || !mismatchCodeOrder.includes(code as SkillContextParityMismatchCode))) return false;
  return value.every((code, index) => index === 0 || mismatchCodeOrder.indexOf(value[index - 1] as SkillContextParityMismatchCode) < mismatchCodeOrder.indexOf(code as SkillContextParityMismatchCode));
}

function isCanonicalReasonCodes(value: unknown): value is SkillContextParityDiagnosticsReasonCode[] {
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string" || !parityReasonCodes.has(code as SkillContextParityDiagnosticsReasonCode))) return false;
  return value.every((code, index) => index === 0 ||
    parityReasonCodeOrder.indexOf(value[index - 1] as SkillContextParityDiagnosticsReasonCode) <
    parityReasonCodeOrder.indexOf(code as SkillContextParityDiagnosticsReasonCode));
}

function hasExactCodes<T extends string>(actual: T[], expected: T[]): boolean {
  return actual.length === expected.length && actual.every((code, index) => code === expected[index]);
}

function parseSnapshot(value: unknown): SkillContextParitySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const integerFields = [
    "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill", "configuredSkillTokenBudget", "separatorTokens",
    "remainingOverallBudget", "effectiveSkillTokenBudget", "effectiveRecallLimit", "recalledAdvisoryCount", "packedCount",
    "omittedCount", "packedTokens", "projectedUsedTokens", "projectedBlockCount",
  ];
  if (!snapshotStates.has(snapshot.state as SkillContextParitySnapshot["state"]) ||
    typeof snapshot.success !== "boolean" || typeof snapshot.enabled !== "boolean" || typeof snapshot.recallAttempted !== "boolean" ||
    typeof snapshot.sectionCreated !== "boolean" || typeof snapshot.sectionAdmitted !== "boolean" ||
    integerFields.some((field) => !isSafeInteger(snapshot[field]))) return null;
  return {
    success: snapshot.success,
    enabled: snapshot.enabled,
    state: snapshot.state as SkillContextParitySnapshot["state"],
    overallBudget: snapshot.overallBudget as number,
    usedTokensBeforeSkill: snapshot.usedTokensBeforeSkill as number,
    selectedBlockCountBeforeSkill: snapshot.selectedBlockCountBeforeSkill as number,
    configuredSkillTokenBudget: snapshot.configuredSkillTokenBudget as number,
    separatorTokens: snapshot.separatorTokens as number,
    remainingOverallBudget: snapshot.remainingOverallBudget as number,
    effectiveSkillTokenBudget: snapshot.effectiveSkillTokenBudget as number,
    effectiveRecallLimit: snapshot.effectiveRecallLimit as number,
    recallAttempted: snapshot.recallAttempted,
    recalledAdvisoryCount: snapshot.recalledAdvisoryCount as number,
    packedCount: snapshot.packedCount as number,
    omittedCount: snapshot.omittedCount as number,
    packedTokens: snapshot.packedTokens as number,
    sectionCreated: snapshot.sectionCreated,
    sectionAdmitted: snapshot.sectionAdmitted,
    projectedUsedTokens: snapshot.projectedUsedTokens as number,
    projectedBlockCount: snapshot.projectedBlockCount as number,
  };
}

function parseSample(value: unknown): ParsedSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.applied !== false || !parityStates.has(result.state as SkillContextParityDiagnosticsState) ||
    result.comparisonMode !== "sequential_best_effort_non_atomic" || typeof result.success !== "boolean" ||
    typeof result.enabled !== "boolean" || typeof result.comparisonAvailable !== "boolean" || typeof result.consistent !== "boolean" ||
    typeof result.directTriggerAttempted !== "boolean" || typeof result.directTriggerSucceeded !== "boolean" ||
    typeof result.directResultParsed !== "boolean" || typeof result.runtimeTriggerAttempted !== "boolean" ||
    typeof result.runtimeTriggerSucceeded !== "boolean" || typeof result.runtimeResultParsed !== "boolean" ||
    !isCanonicalReasonCodes(result.reasonCodes) ||
    !isCanonicalMismatchCodes(result.mismatchCodes)) return null;
  const direct = result.direct === null ? null : parseSnapshot(result.direct);
  const runtime = result.runtime === null ? null : parseSnapshot(result.runtime);
  if ((result.direct !== null && !direct) || (result.runtime !== null && !runtime)) return null;
  if (result.directResultParsed !== (direct !== null) || result.runtimeResultParsed !== (runtime !== null) ||
    result.directResultParsed && !result.directTriggerSucceeded || result.runtimeResultParsed && !result.runtimeTriggerSucceeded ||
    result.directTriggerSucceeded && !result.directTriggerAttempted || result.runtimeTriggerSucceeded && !result.runtimeTriggerAttempted) return null;
  const summary = {
    success: result.success,
    enabled: result.enabled,
    state: result.state as SkillContextParityDiagnosticsState,
    comparisonAvailable: result.comparisonAvailable,
    consistent: result.consistent,
    mismatchCodes: [...(result.mismatchCodes as SkillContextParityMismatchCode[])],
  };
  if (!summary.comparisonAvailable) {
    if ((summary.state !== "disabled" && summary.state !== "failed") || summary.consistent || summary.mismatchCodes.length > 0) return null;
    if (summary.state === "disabled" && (!summary.success || summary.enabled || !hasExactCodes(result.reasonCodes as SkillContextParityDiagnosticsReasonCode[], ["context_disabled"]) ||
      result.directTriggerAttempted || result.directTriggerSucceeded || result.directResultParsed ||
      result.runtimeTriggerAttempted || result.runtimeTriggerSucceeded || result.runtimeResultParsed || direct || runtime)) return null;
    if (summary.state === "failed" && (summary.success || result.reasonCodes.length === 0)) return null;
    return { summary, direct, runtime };
  }
  if (!summary.success || (summary.state !== "consistent" && summary.state !== "mismatch") || !direct || !runtime ||
    !result.directTriggerAttempted || !result.directTriggerSucceeded || !result.directResultParsed ||
    !result.runtimeTriggerAttempted || !result.runtimeTriggerSucceeded || !result.runtimeResultParsed) return null;
  const mismatchCodes = compareSkillContextParitySnapshots(direct, runtime);
  if (mismatchCodes.length !== summary.mismatchCodes.length || mismatchCodes.some((code, index) => code !== summary.mismatchCodes[index])) return null;
  const invalidConsistent = summary.state === "consistent" && (
    !summary.consistent || summary.mismatchCodes.length > 0 ||
    !hasExactCodes(result.reasonCodes as SkillContextParityDiagnosticsReasonCode[], ["paths_consistent"])
  );
  const invalidMismatch = summary.state === "mismatch" && (
    summary.consistent || summary.mismatchCodes.length === 0 ||
    !hasExactCodes(result.reasonCodes as SkillContextParityDiagnosticsReasonCode[], ["paths_mismatch"])
  );
  if (invalidConsistent || invalidMismatch) return null;
  return { summary, direct, runtime };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityStabilityDiagnosticsResult["state"],
  reasonCodes: SkillContextParityStabilityReasonCode[],
  values: Partial<SkillContextParityStabilityDiagnosticsResult> = {},
): SkillContextParityStabilityDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    state,
    reasonCodes: [...reasonCodes],
    samplingMode: "sequential_double_sample_non_atomic",
    sampleCount: 2,
    firstTriggerAttempted: false,
    firstTriggerSucceeded: false,
    firstResultParsed: false,
    secondTriggerAttempted: false,
    secondTriggerSucceeded: false,
    secondResultParsed: false,
    first: null,
    second: null,
    directDriftCodes: [],
    runtimeDriftCodes: [],
    stableAcrossSamples: false,
    repeatableMismatch: false,
    ...values,
  };
}

function sampleFailureCode(position: "first" | "second", succeeded: boolean, parsed: ParsedSample | null): SkillContextParityStabilityReasonCode | null {
  if (!succeeded) return position === "first" ? "first_trigger_failure" : "second_trigger_failure";
  if (!parsed) return position === "first" ? "invalid_first_result" : "invalid_second_result";
  if (!parsed.summary.comparisonAvailable) return position === "first" ? "first_comparison_unavailable" : "second_comparison_unavailable";
  return null;
}

export function registerSkillContextParityStabilityDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-stability-diagnostics", async (data: unknown): Promise<SkillContextParityStabilityDiagnosticsResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) {
      return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity stability diagnostics is disabled" });
    }
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity stability diagnostics input" });
    const requests = buildSkillContextParityStabilityRequests({
      project: input.recall.project!,
      ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    });
    let firstRaw: unknown;
    let secondRaw: unknown;
    let firstTriggerSucceeded = false;
    let secondTriggerSucceeded = false;
    try {
      firstRaw = await sdk.trigger(requests.first);
      firstTriggerSucceeded = true;
    } catch {}
    try {
      secondRaw = await sdk.trigger(requests.second);
      secondTriggerSucceeded = true;
    } catch {}
    const first = firstTriggerSucceeded ? parseSample(firstRaw) : null;
    const second = secondTriggerSucceeded ? parseSample(secondRaw) : null;
    const failureCodes = [
      sampleFailureCode("first", firstTriggerSucceeded, first),
      sampleFailureCode("second", secondTriggerSucceeded, second),
    ].filter((code): code is SkillContextParityStabilityReasonCode => code !== null);
    const values = {
      firstTriggerAttempted: true,
      firstTriggerSucceeded,
      firstResultParsed: first !== null,
      secondTriggerAttempted: true,
      secondTriggerSucceeded,
      secondResultParsed: second !== null,
      first: first?.summary ?? null,
      second: second?.summary ?? null,
    };
    if (failureCodes.length > 0 || !first?.direct || !first.runtime || !second?.direct || !second.runtime) {
      return result(false, true, "failed", failureCodes, {
        reason: "skill context parity stability diagnostics could not compare both samples",
        ...values,
      });
    }
    const evaluation = evaluateSkillContextParityStability(
      { summary: first.summary, direct: first.direct, runtime: first.runtime },
      { summary: second.summary, direct: second.direct, runtime: second.runtime },
    );
    const reasonCode = evaluation.state === "stable_consistent" ? "stable_consistency_observed" :
      evaluation.state === "stable_mismatch" ? "stable_mismatch_observed" : "sample_drift_observed";
    return result(true, true, evaluation.state, [reasonCode], { ...values, ...evaluation });
  });
}
