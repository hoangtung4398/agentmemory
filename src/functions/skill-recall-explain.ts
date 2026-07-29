import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  SkillRecallExplainInput,
  SkillRecallExplainResult,
  SkillRecallInput,
} from "../types.js";
import { MAX_SKILL_FEEDBACK_ID_LENGTH } from "./skill-feedback-model.js";
import {
  evaluateSkillRecallPopulation,
  normalizeSkillRecallInput,
} from "./skill-recall-policy.js";

type NormalizedSkillRecallExplainInput = {
  skillId: string;
  input: SkillRecallInput;
};

function baseResult(
  success: boolean,
  enabled: boolean,
  effectiveLimit: number,
  reason?: string,
): SkillRecallExplainResult {
  return {
    success,
    enabled,
    applied: false,
    ...(reason === undefined ? {} : { reason }),
    reasonCodes: [],
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    privacySuppressedCount: 0,
    matchedCount: 0,
    effectiveLimit,
    selected: false,
  };
}

export function normalizeSkillRecallExplainInput(
  data: unknown,
): NormalizedSkillRecallExplainInput | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as SkillRecallExplainInput;
  if (typeof value.skillId !== "string") return null;
  const skillId = value.skillId.trim();
  if (!skillId || skillId.length > MAX_SKILL_FEEDBACK_ID_LENGTH) return null;
  const normalized = normalizeSkillRecallInput({
    project: value.project,
    agentId: value.agentId,
    query: value.query,
    files: value.files,
    concepts: value.concepts,
    limit: value.limit,
  });
  return normalized.success ? { skillId, input: normalized.input } : null;
}

export function registerSkillRecallExplainFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-recall-explain",
    async (data: unknown): Promise<SkillRecallExplainResult> => {
      const config = loadSkillConfig();
      if (!config.recallEnabled) {
        return baseResult(true, false, 0, "skill recall explanation is disabled");
      }
      const normalized = normalizeSkillRecallExplainInput(data);
      if (!normalized) {
        return baseResult(false, true, 0, "invalid skill recall explanation input");
      }
      const effectiveLimit = normalized.input.limit ?? config.recallLimit;
      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skills);
      } catch {
        return baseResult(false, true, effectiveLimit, "failed to load skill recall explanation");
      }
      const evaluation = evaluateSkillRecallPopulation(
        rows,
        normalized.input,
        config.recallMinConfidence,
        effectiveLimit,
      );
      const result = {
        success: true,
        enabled: true,
        applied: false as const,
        skillId: normalized.skillId,
        scannedCount: evaluation.scannedCount,
        validCount: evaluation.validCount,
        malformedCount: evaluation.malformedCount,
        privacySuppressedCount: evaluation.privacySuppressedCount,
        matchedCount: evaluation.matchedCount,
        effectiveLimit,
      };
      const targets = evaluation.rowEvaluations.filter(
        (entry) => entry.normalizedSkillId === normalized.skillId,
      );
      const validTargets = targets.filter((entry) => entry.valid);
      if (targets.length === 0) {
        return { ...result, success: false, reason: "skill not found", reasonCodes: [], selected: false };
      }
      if (validTargets.length > 1) {
        return { ...result, success: false, reason: "duplicate skill id", reasonCodes: [], selected: false };
      }
      const target = validTargets[0] ?? targets[0];
      if (target.state === "malformed") {
        return {
          ...result,
          state: "malformed" as const,
          reasonCodes: ["malformed_skill" as const],
          selected: false,
        };
      }
      if (target.state === "privacy_suppressed") {
        return {
          ...result,
          state: "privacy_suppressed" as const,
          reasonCodes: ["privacy_suppressed" as const],
          selected: false,
        };
      }
      if (target.state === "excluded") {
        return {
          ...result,
          state: "excluded" as const,
          reasonCodes: [...target.reasonCodes],
          selected: false,
          ...(target.scoreBreakdown === undefined ? {} : { scoreBreakdown: { ...target.scoreBreakdown } }),
        };
      }
      if (!target.selected) {
        return {
          ...result,
          state: "matched_not_returned" as const,
          reasonCodes: ["outside_limit" as const],
          selected: false,
          rank: target.rank,
          scoreBreakdown: { ...target.scoreBreakdown! },
          advisory: cloneAdvisory(target.advisory!),
        };
      }
      return {
        ...result,
        state: "selected" as const,
        reasonCodes: ["selected" as const],
        selected: true,
        rank: target.rank,
        scoreBreakdown: { ...target.scoreBreakdown! },
        advisory: cloneAdvisory(target.advisory!),
      };
    },
  );
}

function cloneAdvisory(advisory: NonNullable<SkillRecallExplainResult["advisory"]>) {
  return {
    ...advisory,
    steps: [...advisory.steps],
    antiPatterns: [...advisory.antiPatterns],
    files: [...advisory.files],
    concepts: [...advisory.concepts],
    sourceProceduralMemoryIds: [...advisory.sourceProceduralMemoryIds],
  };
}
