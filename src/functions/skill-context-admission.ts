import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  SkillContextAdmissionEvaluation,
  SkillContextAdmissionExplainInput,
  SkillContextAdmissionExplainResult,
  SkillContextAdmissionReasonCode,
  SkillContextAdmissionState,
  SkillRecallInput,
} from "../types.js";
import { evaluateSkillAdvisoryPacking } from "./skill-context.js";
import { evaluateSkillRecallPopulation, normalizeSkillRecallInput } from "./skill-recall-policy.js";

export type SkillContextAdmissionInput = {
  enabled: boolean;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
  configuredSkillTokenBudget: number;
  packedSectionTokens?: number | null;
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function evaluateSkillContextAdmission(input: SkillContextAdmissionInput): SkillContextAdmissionEvaluation {
  const separatorTokens = input.selectedBlockCount > 0 ? estimateTokens("\n\n") : 0;
  const remainingOverallBudget = input.overallBudget - input.usedTokens - separatorTokens;
  const effectiveSkillTokenBudget = Math.max(0, Math.min(input.configuredSkillTokenBudget, remainingOverallBudget));
  const shouldAttemptRecall = input.enabled && effectiveSkillTokenBudget > 0;
  const packedSectionTokens = input.packedSectionTokens;
  const sectionCreated = Number.isInteger(packedSectionTokens) && (packedSectionTokens ?? 0) > 0;
  const sectionAdmitted = shouldAttemptRecall && sectionCreated && input.usedTokens + separatorTokens + (packedSectionTokens ?? 0) <= input.overallBudget;
  return {
    separatorTokens,
    remainingOverallBudget,
    effectiveSkillTokenBudget,
    shouldAttemptRecall,
    sectionCreated,
    sectionAdmitted,
    projectedUsedTokens: sectionAdmitted ? input.usedTokens + separatorTokens + (packedSectionTokens ?? 0) : input.usedTokens,
    projectedBlockCount: sectionAdmitted ? input.selectedBlockCount + 1 : input.selectedBlockCount,
  };
}

type NormalizedInput = { recall: SkillRecallInput; overallBudget: number; usedTokens: number; selectedBlockCount: number };

function normalizeInput(value: unknown): NormalizedInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextAdmissionExplainInput;
  const recall = normalizeSkillRecallInput(input);
  if (!recall.success) return null;
  const { overallBudget, usedTokens, selectedBlockCount } = input;
  if (
    typeof overallBudget !== "number" || !Number.isSafeInteger(overallBudget) || overallBudget <= 0 ||
    typeof usedTokens !== "number" || !Number.isSafeInteger(usedTokens) || usedTokens < 0 ||
    typeof selectedBlockCount !== "number" || !Number.isSafeInteger(selectedBlockCount) || selectedBlockCount < 0
  ) return null;
  return { recall: recall.input, overallBudget, usedTokens, selectedBlockCount };
}

function baseResult(
  success: boolean,
  enabled: boolean,
  state: SkillContextAdmissionState,
  reasonCodes: SkillContextAdmissionReasonCode[],
  configuredSkillTokenBudget: number,
  effectiveRecallLimit: number,
  values: Partial<Pick<SkillContextAdmissionExplainResult, "overallBudget" | "usedTokensBeforeSkill" | "selectedBlockCountBeforeSkill">> = {},
  reason?: string,
): SkillContextAdmissionExplainResult {
  const overallBudget = values.overallBudget ?? 0;
  const usedTokensBeforeSkill = values.usedTokensBeforeSkill ?? 0;
  const selectedBlockCountBeforeSkill = values.selectedBlockCountBeforeSkill ?? 0;
  const admission = evaluateSkillContextAdmission({ enabled, overallBudget, usedTokens: usedTokensBeforeSkill, selectedBlockCount: selectedBlockCountBeforeSkill, configuredSkillTokenBudget });
  return {
    success, enabled, applied: false, ...(reason ? { reason } : {}), state, reasonCodes: [...reasonCodes], overallBudget,
    usedTokensBeforeSkill, selectedBlockCountBeforeSkill, configuredSkillTokenBudget,
    separatorTokens: admission.separatorTokens, remainingOverallBudget: admission.remainingOverallBudget,
    effectiveSkillTokenBudget: admission.effectiveSkillTokenBudget, recallAttempted: admission.shouldAttemptRecall,
    effectiveRecallLimit, scannedCount: 0, validCount: 0, malformedCount: 0, privacySuppressedCount: 0,
    privateProtectedCount: 0, matchedCount: 0, recallReturnedCount: 0, recallTruncated: false,
    duplicateSkillIdCount: 0, packedCount: 0, omittedCount: 0, packedTokens: 0,
    sectionCreated: false, sectionAdmitted: false, projectedUsedTokens: usedTokensBeforeSkill,
    projectedBlockCount: selectedBlockCountBeforeSkill,
  };
}

export function registerSkillContextAdmissionExplainFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::skill-context-admission-explain", async (data: unknown): Promise<SkillContextAdmissionExplainResult> => {
    const config = loadSkillConfig();
    if (!config.contextEnabled) return baseResult(true, false, "disabled", ["context_disabled"], config.contextTokenBudget, config.recallLimit, {}, "skill context admission explanation is disabled");
    const input = normalizeInput(data);
    if (!input) return baseResult(false, true, "failed", ["invalid_input"], config.contextTokenBudget, config.recallLimit, {}, "invalid skill context admission explanation input");
    const effectiveRecallLimit = input.recall.limit ?? config.recallLimit;
    const initial = evaluateSkillContextAdmission({ enabled: true, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount, configuredSkillTokenBudget: config.contextTokenBudget });
    const values = { overallBudget: input.overallBudget, usedTokensBeforeSkill: input.usedTokens, selectedBlockCountBeforeSkill: input.selectedBlockCount };
    if (!initial.shouldAttemptRecall) return baseResult(true, true, "skipped_no_budget", ["no_remaining_budget"], config.contextTokenBudget, effectiveRecallLimit, values);
    let rows: unknown[];
    try { rows = await kv.list<unknown>(KV.skills); } catch {
      return baseResult(false, true, "failed", ["storage_failure"], config.contextTokenBudget, effectiveRecallLimit, values, "failed to load skill context admission explanation");
    }
    const recall = evaluateSkillRecallPopulation(rows, input.recall, config.recallMinConfidence, effectiveRecallLimit);
    const counts = new Map<string, number>();
    for (const row of recall.rowEvaluations) if (row.normalizedSkillId) counts.set(row.normalizedSkillId, (counts.get(row.normalizedSkillId) ?? 0) + 1);
    const duplicateSkillIdCount = [...counts.values()].filter((count) => count > 1).length;
    const shared = {
      ...values, effectiveRecallLimit, scannedCount: recall.scannedCount, validCount: recall.validCount,
      malformedCount: recall.malformedCount, privacySuppressedCount: recall.privacySuppressedCount,
      privateProtectedCount: recall.rowEvaluations.filter((row) => row.containsPrivateData).length,
      matchedCount: recall.matchedCount, recallReturnedCount: recall.returnedCount, recallTruncated: recall.truncated,
      duplicateSkillIdCount,
    };
    if (duplicateSkillIdCount > 0) return { ...baseResult(false, true, "failed", ["duplicate_skill_id"], config.contextTokenBudget, effectiveRecallLimit, values, "duplicate skill id"), ...shared, recallAttempted: true };
    if (recall.returnedCount === 0) return { ...baseResult(true, true, "recall_empty", ["no_recalled_advisories"], config.contextTokenBudget, effectiveRecallLimit, values), ...shared, recallAttempted: true };
    const packing = evaluateSkillAdvisoryPacking(recall.advisories, initial.effectiveSkillTokenBudget);
    const packedCount = packing.decisions.filter((item) => item.state === "packed").length;
    const omittedCount = packing.decisions.length - packedCount;
    if (!packing.content) return { ...baseResult(true, true, "packing_empty", ["no_advisory_fits"], config.contextTokenBudget, effectiveRecallLimit, values), ...shared, recallAttempted: true, packedCount, omittedCount };
    const admission = evaluateSkillContextAdmission({ enabled: true, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount, configuredSkillTokenBudget: config.contextTokenBudget, packedSectionTokens: packing.tokens });
    const state: SkillContextAdmissionState = admission.sectionAdmitted ? "admitted" : "rejected_outer_budget";
    const code: SkillContextAdmissionReasonCode = admission.sectionAdmitted ? "section_admitted" : "section_exceeds_outer_budget";
    return { ...baseResult(true, true, state, [code], config.contextTokenBudget, effectiveRecallLimit, values), ...shared,
      separatorTokens: admission.separatorTokens, remainingOverallBudget: admission.remainingOverallBudget,
      effectiveSkillTokenBudget: admission.effectiveSkillTokenBudget, recallAttempted: true,
      packedCount, omittedCount, packedTokens: packing.tokens, sectionCreated: true,
      sectionAdmitted: admission.sectionAdmitted, projectedUsedTokens: admission.projectedUsedTokens,
      projectedBlockCount: admission.projectedBlockCount };
  });
}
