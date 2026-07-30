import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  SkillContextExplainInput,
  SkillContextExplainResult,
  SkillRecallInput,
} from "../types.js";
import { evaluateSkillAdvisoryPacking } from "./skill-context.js";
import {
  evaluateSkillRecallPopulation,
  normalizeSkillRecallInput,
} from "./skill-recall-policy.js";

const MAX_TOKEN_BUDGET = 1_000;

type NormalizedSkillContextExplainInput = {
  input: SkillRecallInput;
  requestedTokenBudget?: number;
};

function baseResult(
  success: boolean,
  enabled: boolean,
  configuredTokenBudget: number,
  effectiveRecallLimit: number,
  reason?: string,
  requestedTokenBudget?: number,
  effectiveTokenBudget = configuredTokenBudget,
): SkillContextExplainResult {
  return {
    success,
    enabled,
    applied: false,
    ...(reason === undefined ? {} : { reason }),
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    privacySuppressedCount: 0,
    privateProtectedCount: 0,
    matchedCount: 0,
    recallReturnedCount: 0,
    recallTruncated: false,
    effectiveRecallLimit,
    configuredTokenBudget,
    ...(requestedTokenBudget === undefined ? {} : { requestedTokenBudget }),
    effectiveTokenBudget,
    sectionOverheadTokens: 0,
    packedCount: 0,
    omittedCount: 0,
    packedTokens: 0,
    sectionCreated: false,
    duplicateSkillIdCount: 0,
    items: [],
  };
}

export function normalizeSkillContextExplainInput(
  data: unknown,
): NormalizedSkillContextExplainInput | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as SkillContextExplainInput;
  const normalized = normalizeSkillRecallInput({
    project: value.project,
    agentId: value.agentId,
    query: value.query,
    files: value.files,
    concepts: value.concepts,
    limit: value.limit,
  });
  if (!normalized.success) return null;
  if (value.tokenBudget === undefined) return { input: normalized.input };
  if (
    typeof value.tokenBudget !== "number" ||
    !Number.isFinite(value.tokenBudget) ||
    !Number.isInteger(value.tokenBudget) ||
    value.tokenBudget < 1 ||
    value.tokenBudget > MAX_TOKEN_BUDGET
  ) return null;
  return { input: normalized.input, requestedTokenBudget: value.tokenBudget };
}

function cloneResult(value: SkillContextExplainResult): SkillContextExplainResult {
  return {
    ...value,
    items: value.items.map((item) => ({ ...item, reasonCodes: [...item.reasonCodes] })),
  };
}

export function registerSkillContextExplainFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-context-explain",
    async (data: unknown): Promise<SkillContextExplainResult> => {
      const config = loadSkillConfig();
      if (!config.contextEnabled) {
        return baseResult(
          true,
          false,
          config.contextTokenBudget,
          config.recallLimit,
          "skill context explanation is disabled",
        );
      }
      const normalized = normalizeSkillContextExplainInput(data);
      if (!normalized) {
        return baseResult(
          false,
          true,
          config.contextTokenBudget,
          config.recallLimit,
          "invalid skill context explanation input",
        );
      }
      const effectiveRecallLimit = normalized.input.limit ?? config.recallLimit;
      const effectiveTokenBudget = Math.min(
        normalized.requestedTokenBudget ?? config.contextTokenBudget,
        config.contextTokenBudget,
      );
      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skills);
      } catch {
        return baseResult(
          false,
          true,
          config.contextTokenBudget,
          effectiveRecallLimit,
          "failed to load skill context explanation",
          normalized.requestedTokenBudget,
          effectiveTokenBudget,
        );
      }
      const evaluation = evaluateSkillRecallPopulation(
        rows,
        normalized.input,
        config.recallMinConfidence,
        effectiveRecallLimit,
      );
      const duplicateCounts = new Map<string, number>();
      for (const row of evaluation.rowEvaluations) {
        if (row.normalizedSkillId !== undefined) {
          duplicateCounts.set(row.normalizedSkillId, (duplicateCounts.get(row.normalizedSkillId) ?? 0) + 1);
        }
      }
      const duplicateSkillIdCount = [...duplicateCounts.values()].filter((count) => count > 1).length;
      const privateProtectedCount = evaluation.rowEvaluations.filter((row) => row.containsPrivateData).length;
      const result = {
        success: true,
        enabled: true,
        applied: false as const,
        scannedCount: evaluation.scannedCount,
        validCount: evaluation.validCount,
        malformedCount: evaluation.malformedCount,
        privacySuppressedCount: evaluation.privacySuppressedCount,
        privateProtectedCount,
        matchedCount: evaluation.matchedCount,
        recallReturnedCount: evaluation.returnedCount,
        recallTruncated: evaluation.truncated,
        effectiveRecallLimit,
        configuredTokenBudget: config.contextTokenBudget,
        ...(normalized.requestedTokenBudget === undefined
          ? {}
          : { requestedTokenBudget: normalized.requestedTokenBudget }),
        effectiveTokenBudget,
        duplicateSkillIdCount,
      };
      if (duplicateSkillIdCount > 0) {
        return {
          ...baseResult(false, true, config.contextTokenBudget, effectiveRecallLimit, "duplicate skill id"),
          ...result,
          success: false,
          items: [],
        };
      }
      const packing = evaluateSkillAdvisoryPacking(evaluation.advisories, effectiveTokenBudget);
      return cloneResult({
        ...result,
        sectionOverheadTokens: packing.sectionOverheadTokens,
        packedCount: packing.decisions.filter((item) => item.state === "packed").length,
        omittedCount: packing.decisions.filter((item) => item.state === "omitted_budget").length,
        packedTokens: packing.tokens,
        sectionCreated: packing.content !== null,
        items: packing.decisions.map((item) => ({ ...item, reasonCodes: [...item.reasonCodes] })),
      });
    },
  );
}
