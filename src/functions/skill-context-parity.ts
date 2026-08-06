import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextAdmissionExplainResult,
  SkillContextAdmissionState,
  SkillContextParityDiagnosticsInput,
  SkillContextParityDiagnosticsReasonCode,
  SkillContextParityDiagnosticsResult,
  SkillContextParityMismatchCode,
  SkillContextParitySnapshot,
  SkillContextRuntimeExplainResult,
  SkillContextRuntimeState,
  SkillRecallInput,
} from "../types.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextParityRequestInput = {
  project: string;
  agentId?: string;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type ParityRequest = {
  function_id: "mem::skill-context-admission-explain" | "mem::skill-context-runtime-explain";
  payload: {
    project: string;
    agentId?: string;
    overallBudget: number;
    usedTokens: number;
    selectedBlockCount: number;
  };
};

type NormalizedInput = {
  recall: SkillRecallInput;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

const parityStates = new Set<SkillContextAdmissionState | SkillContextRuntimeState>([
  "disabled", "failed", "skipped_no_budget", "recall_empty", "packing_empty", "admitted", "rejected_outer_budget",
]);

const mismatchFields: Array<[SkillContextParityMismatchCode, keyof SkillContextParitySnapshot]> = [
  ["path_success_mismatch", "success"],
  ["path_enabled_mismatch", "enabled"],
  ["path_state_mismatch", "state"],
  ["overall_budget_mismatch", "overallBudget"],
  ["used_tokens_mismatch", "usedTokensBeforeSkill"],
  ["selected_block_count_mismatch", "selectedBlockCountBeforeSkill"],
  ["configured_skill_budget_mismatch", "configuredSkillTokenBudget"],
  ["separator_tokens_mismatch", "separatorTokens"],
  ["remaining_budget_mismatch", "remainingOverallBudget"],
  ["effective_skill_budget_mismatch", "effectiveSkillTokenBudget"],
  ["effective_recall_limit_mismatch", "effectiveRecallLimit"],
  ["recall_attempt_mismatch", "recallAttempted"],
  ["recalled_advisory_count_mismatch", "recalledAdvisoryCount"],
  ["packed_count_mismatch", "packedCount"],
  ["omitted_count_mismatch", "omittedCount"],
  ["packed_tokens_mismatch", "packedTokens"],
  ["section_created_mismatch", "sectionCreated"],
  ["section_admitted_mismatch", "sectionAdmitted"],
  ["projected_used_tokens_mismatch", "projectedUsedTokens"],
  ["projected_block_count_mismatch", "projectedBlockCount"],
];

export function buildSkillContextParityRequests(input: SkillContextParityRequestInput): { direct: ParityRequest; runtime: ParityRequest } {
  const payload = {
    project: input.project,
    ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
    overallBudget: input.overallBudget,
    usedTokens: input.usedTokens,
    selectedBlockCount: input.selectedBlockCount,
  };
  return {
    direct: { function_id: "mem::skill-context-admission-explain", payload: { ...payload } },
    runtime: { function_id: "mem::skill-context-runtime-explain", payload: { ...payload } },
  };
}

export function compareSkillContextParitySnapshots(
  direct: SkillContextParitySnapshot,
  runtime: SkillContextParitySnapshot,
): SkillContextParityMismatchCode[] {
  return mismatchFields.filter(([, field]) => direct[field] !== runtime[field]).map(([code]) => code);
}

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (!recall.success || !recall.input.project) return null;
  if (
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0
  ) return null;
  return {
    recall: recall.input,
    overallBudget: input.overallBudget,
    usedTokens: input.usedTokens,
    selectedBlockCount: input.selectedBlockCount,
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseSnapshot(value: unknown, recalledField: "recallReturnedCount" | "parsedAdvisoryCount"): SkillContextParitySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Partial<SkillContextAdmissionExplainResult & SkillContextRuntimeExplainResult> & Record<string, unknown>;
  const integerFields = [
    "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill", "configuredSkillTokenBudget",
    "separatorTokens", "remainingOverallBudget", "effectiveSkillTokenBudget", "effectiveRecallLimit",
    recalledField, "packedCount", "omittedCount", "packedTokens", "projectedUsedTokens", "projectedBlockCount",
  ];
  if (
    result.applied !== false || !parityStates.has(result.state as SkillContextAdmissionState) ||
    typeof result.success !== "boolean" || typeof result.enabled !== "boolean" || typeof result.recallAttempted !== "boolean" ||
    typeof result.sectionCreated !== "boolean" || typeof result.sectionAdmitted !== "boolean" ||
    integerFields.some((field) => !isSafeInteger(result[field]))
  ) return null;
  return {
    success: result.success,
    enabled: result.enabled,
    state: result.state as SkillContextAdmissionState | SkillContextRuntimeState,
    overallBudget: result.overallBudget as number,
    usedTokensBeforeSkill: result.usedTokensBeforeSkill as number,
    selectedBlockCountBeforeSkill: result.selectedBlockCountBeforeSkill as number,
    configuredSkillTokenBudget: result.configuredSkillTokenBudget as number,
    separatorTokens: result.separatorTokens as number,
    remainingOverallBudget: result.remainingOverallBudget as number,
    effectiveSkillTokenBudget: result.effectiveSkillTokenBudget as number,
    effectiveRecallLimit: result.effectiveRecallLimit as number,
    recallAttempted: result.recallAttempted,
    recalledAdvisoryCount: result[recalledField] as number,
    packedCount: result.packedCount as number,
    omittedCount: result.omittedCount as number,
    packedTokens: result.packedTokens as number,
    sectionCreated: result.sectionCreated,
    sectionAdmitted: result.sectionAdmitted,
    projectedUsedTokens: result.projectedUsedTokens as number,
    projectedBlockCount: result.projectedBlockCount as number,
  };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDiagnosticsResult> = {},
): SkillContextParityDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    state,
    reasonCodes: [...reasonCodes],
    comparisonMode: "sequential_best_effort_non_atomic",
    comparisonAvailable: false,
    consistent: false,
    directTriggerAttempted: false,
    directTriggerSucceeded: false,
    directResultParsed: false,
    runtimeTriggerAttempted: false,
    runtimeTriggerSucceeded: false,
    runtimeResultParsed: false,
    mismatchCodes: [],
    direct: null,
    runtime: null,
    ...values,
  };
}

export function registerSkillContextParityDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-diagnostics", async (data: unknown): Promise<SkillContextParityDiagnosticsResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) {
      return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity diagnostics is disabled" });
    }
    const input = normalizeInput(data);
    if (!input) {
      return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity diagnostics input" });
    }
    const requests = buildSkillContextParityRequests({
      project: input.recall.project!,
      ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    });
    let directRaw: unknown;
    let runtimeRaw: unknown;
    let directTriggerSucceeded = false;
    let runtimeTriggerSucceeded = false;
    try {
      directRaw = await sdk.trigger(requests.direct);
      directTriggerSucceeded = true;
    } catch {}
    try {
      runtimeRaw = await sdk.trigger(requests.runtime);
      runtimeTriggerSucceeded = true;
    } catch {}
    const direct = directTriggerSucceeded ? parseSnapshot(directRaw, "recallReturnedCount") : null;
    const runtime = runtimeTriggerSucceeded ? parseSnapshot(runtimeRaw, "parsedAdvisoryCount") : null;
    const reasonCodes: SkillContextParityDiagnosticsReasonCode[] = [];
    if (!directTriggerSucceeded) reasonCodes.push("direct_trigger_failure");
    else if (!direct) reasonCodes.push("invalid_direct_result");
    if (!runtimeTriggerSucceeded) reasonCodes.push("runtime_trigger_failure");
    else if (!runtime) reasonCodes.push("invalid_runtime_result");
    if (!direct || !runtime) {
      return result(false, true, "failed", reasonCodes, {
        reason: "skill context parity diagnostics could not compare both paths",
        directTriggerAttempted: true,
        directTriggerSucceeded,
        directResultParsed: direct !== null,
        runtimeTriggerAttempted: true,
        runtimeTriggerSucceeded,
        runtimeResultParsed: runtime !== null,
        direct,
        runtime,
      });
    }
    const mismatchCodes = compareSkillContextParitySnapshots(direct, runtime);
    const consistent = mismatchCodes.length === 0;
    return result(true, true, consistent ? "consistent" : "mismatch", [consistent ? "paths_consistent" : "paths_mismatch"], {
      comparisonAvailable: true,
      consistent,
      directTriggerAttempted: true,
      directTriggerSucceeded: true,
      directResultParsed: true,
      runtimeTriggerAttempted: true,
      runtimeTriggerSucceeded: true,
      runtimeResultParsed: true,
      mismatchCodes,
      direct,
      runtime,
    });
  });
}
