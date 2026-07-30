import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextRuntimeExplainInput,
  SkillContextRuntimeExplainResult,
  SkillContextRuntimeReasonCode,
  SkillContextRuntimeState,
  SkillRecallInput,
} from "../types.js";
import { evaluateSkillContextAdmission } from "./skill-context-admission.js";
import { evaluateSkillAdvisoryPacking, parseSkillAdvisories } from "./skill-context.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextRecallRequestInput = {
  project: string;
  agentId?: string;
  recallLimit: number;
};

export function buildSkillContextRecallRequest(input: SkillContextRecallRequestInput): {
  function_id: "mem::skill-recall";
  payload: { project: string; agentId?: string; limit: number };
} {
  return {
    function_id: "mem::skill-recall",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      limit: input.recallLimit,
    },
  };
}

type NormalizedInput = {
  recall: SkillRecallInput;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextRuntimeExplainInput;
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

function baseResult(
  success: boolean,
  enabled: boolean,
  state: SkillContextRuntimeState,
  reasonCodes: SkillContextRuntimeReasonCode[],
  configuredSkillTokenBudget: number,
  effectiveRecallLimit: number,
  values: Partial<Pick<SkillContextRuntimeExplainResult, "overallBudget" | "usedTokensBeforeSkill" | "selectedBlockCountBeforeSkill">> = {},
  reason?: string,
): SkillContextRuntimeExplainResult {
  const overallBudget = values.overallBudget ?? 0;
  const usedTokensBeforeSkill = values.usedTokensBeforeSkill ?? 0;
  const selectedBlockCountBeforeSkill = values.selectedBlockCountBeforeSkill ?? 0;
  const admission = evaluateSkillContextAdmission({
    enabled,
    overallBudget,
    usedTokens: usedTokensBeforeSkill,
    selectedBlockCount: selectedBlockCountBeforeSkill,
    configuredSkillTokenBudget,
  });
  return {
    success,
    enabled,
    applied: false,
    ...(reason ? { reason } : {}),
    state,
    reasonCodes: [...reasonCodes],
    overallBudget,
    usedTokensBeforeSkill,
    selectedBlockCountBeforeSkill,
    configuredSkillTokenBudget,
    separatorTokens: admission.separatorTokens,
    remainingOverallBudget: admission.remainingOverallBudget,
    effectiveSkillTokenBudget: admission.effectiveSkillTokenBudget,
    effectiveRecallLimit,
    recallAttempted: admission.shouldAttemptRecall,
    recallTriggerSucceeded: false,
    recallResultParsed: false,
    parsedAdvisoryCount: 0,
    packedCount: 0,
    omittedCount: 0,
    packedTokens: 0,
    sectionCreated: false,
    sectionAdmitted: false,
    projectedUsedTokens: usedTokensBeforeSkill,
    projectedBlockCount: selectedBlockCountBeforeSkill,
  };
}

export function registerSkillContextRuntimeExplainFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-runtime-explain", async (data: unknown): Promise<SkillContextRuntimeExplainResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) {
      return baseResult(true, false, "disabled", ["context_disabled"], config.contextTokenBudget, config.recallLimit, {}, "skill context runtime explanation is disabled");
    }
    const input = normalizeInput(data);
    if (!input) {
      return baseResult(false, true, "failed", ["invalid_input"], config.contextTokenBudget, config.recallLimit, {}, "invalid skill context runtime explanation input");
    }
    const values = {
      overallBudget: input.overallBudget,
      usedTokensBeforeSkill: input.usedTokens,
      selectedBlockCountBeforeSkill: input.selectedBlockCount,
    };
    const initial = evaluateSkillContextAdmission({
      enabled: true,
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
      configuredSkillTokenBudget: config.contextTokenBudget,
    });
    if (!initial.shouldAttemptRecall) {
      return baseResult(true, true, "skipped_no_budget", ["no_remaining_budget"], config.contextTokenBudget, config.recallLimit, values);
    }
    let recallResult: unknown;
    try {
      recallResult = await sdk.trigger(buildSkillContextRecallRequest({
        project: input.recall.project!,
        ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}),
        recallLimit: config.recallLimit,
      }));
    } catch {
      return { ...baseResult(false, true, "failed", ["recall_trigger_failure"], config.contextTokenBudget, config.recallLimit, values, "failed to invoke skill recall"), recallAttempted: true };
    }
    const advisories = parseSkillAdvisories(recallResult);
    if (!advisories) {
      return {
        ...baseResult(false, true, "failed", ["invalid_recall_result"], config.contextTokenBudget, config.recallLimit, values, "invalid skill recall result"),
        recallAttempted: true,
        recallTriggerSucceeded: true,
      };
    }
    if (advisories.length === 0) {
      return {
        ...baseResult(true, true, "recall_empty", ["no_recalled_advisories"], config.contextTokenBudget, config.recallLimit, values),
        recallAttempted: true,
        recallTriggerSucceeded: true,
        recallResultParsed: true,
      };
    }
    const packing = evaluateSkillAdvisoryPacking(advisories, initial.effectiveSkillTokenBudget);
    const packedCount = packing.decisions.filter((item) => item.state === "packed").length;
    const omittedCount = packing.decisions.length - packedCount;
    const shared = {
      recallAttempted: true,
      recallTriggerSucceeded: true,
      recallResultParsed: true,
      parsedAdvisoryCount: advisories.length,
      packedCount,
      omittedCount,
    };
    if (!packing.content) {
      return {
        ...baseResult(true, true, "packing_empty", ["no_advisory_fits"], config.contextTokenBudget, config.recallLimit, values),
        ...shared,
      };
    }
    const admission = evaluateSkillContextAdmission({
      enabled: true,
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
      configuredSkillTokenBudget: config.contextTokenBudget,
      packedSectionTokens: packing.tokens,
    });
    const state: SkillContextRuntimeState = admission.sectionAdmitted ? "admitted" : "rejected_outer_budget";
    const reasonCode: SkillContextRuntimeReasonCode = admission.sectionAdmitted ? "section_admitted" : "section_exceeds_outer_budget";
    return {
      ...baseResult(true, true, state, [reasonCode], config.contextTokenBudget, config.recallLimit, values),
      ...shared,
      separatorTokens: admission.separatorTokens,
      remainingOverallBudget: admission.remainingOverallBudget,
      effectiveSkillTokenBudget: admission.effectiveSkillTokenBudget,
      packedTokens: packing.tokens,
      sectionCreated: true,
      sectionAdmitted: admission.sectionAdmitted,
      projectedUsedTokens: admission.projectedUsedTokens,
      projectedBlockCount: admission.projectedBlockCount,
    };
  });
}
