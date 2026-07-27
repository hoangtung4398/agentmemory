import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  SkillFeedbackEvent,
  SkillLifecycleReviewEvidenceCounts,
  SkillLifecycleReviewInput,
  SkillLifecycleReviewResult,
} from "../types.js";
import {
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";
import {
  emptySkillLifecycleEvidenceCounts,
  evaluateSkillLifecycleReview,
  isValidLifecycleReviewSkill,
} from "./skill-lifecycle-review-policy.js";

interface NormalizedReviewInput {
  skillId: string;
  skillVersion?: number;
  project?: string;
  agentId?: string;
}

function evidenceCounts(): SkillLifecycleReviewEvidenceCounts {
  return emptySkillLifecycleEvidenceCounts();
}

function result(success: boolean, enabled: boolean, reason?: string): SkillLifecycleReviewResult {
  return {
    success,
    enabled,
    applied: false,
    recommendation: "none",
    reasonCodes: [],
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    applicableCount: 0,
    ignoredCount: 0,
    evidenceCounts: evidenceCounts(),
    sourceEventIds: [],
    duplicateEventIds: [],
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function optionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  return normalizedString(value, maxLength) ?? null;
}

function optionalPositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function normalizeInput(input: SkillLifecycleReviewInput | undefined): NormalizedReviewInput | undefined {
  const skillId = normalizedString(input?.skillId, MAX_SKILL_FEEDBACK_ID_LENGTH);
  const skillVersion = optionalPositiveInteger(input?.skillVersion);
  const project = optionalString(input?.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
  const agentId = optionalString(input?.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);

  if (!skillId || skillVersion === null || project === null || agentId === null) return undefined;
  return {
    skillId,
    ...(skillVersion === undefined ? {} : { skillVersion }),
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function hasMatchingScope(skill: AgentSkill, input: NormalizedReviewInput): boolean {
  return skill.project === input.project && skill.agentId === input.agentId;
}

export function registerSkillLifecycleReviewFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-lifecycle-review",
    async (data: SkillLifecycleReviewInput | undefined): Promise<SkillLifecycleReviewResult> => {
      if (!loadSkillConfig().lifecycleReviewEnabled) {
        return result(true, false, "skill lifecycle review is disabled");
      }

      const input = normalizeInput(data);
      if (!input) return result(false, true, "invalid skill lifecycle review input");

      let stored: unknown;
      try {
        stored = await kv.get<unknown>(KV.skills, input.skillId);
      } catch {
        return result(false, true, "failed to load skill lifecycle review");
      }
      if (stored === null || !isValidLifecycleReviewSkill(stored, input.skillId)) {
        return result(false, true, "skill not found");
      }
      if (input.skillVersion !== undefined && input.skillVersion !== stored.version) {
        return result(false, true, "skill version mismatch");
      }
      if (!hasMatchingScope(stored, input)) {
        return result(false, true, "skill scope mismatch");
      }

      const base = {
        skillId: stored.id,
        skillVersion: stored.version,
        currentStatus: stored.status,
      };
      if (stored.status !== "active") {
        return {
          ...result(true, true),
          ...base,
          reasonCodes: ["skill_not_active"],
        };
      }

      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skillFeedback);
      } catch {
        return { ...result(false, true, "failed to load skill lifecycle review"), ...base };
      }

      const validEvents = rows.filter((row): row is SkillFeedbackEvent => isValidSkillFeedbackEvent(row));
      const evaluation = evaluateSkillLifecycleReview(stored, validEvents);
      const response = {
        ...base,
        scannedCount: rows.length,
        validCount: validEvents.length,
        malformedCount: rows.length - validEvents.length,
        applicableCount: evaluation.applicableCount,
        ignoredCount: validEvents.length - evaluation.applicableCount,
        evidenceCounts: evaluation.evidenceCounts,
        sourceEventIds: evaluation.sourceEventIds,
        duplicateEventIds: evaluation.duplicateEventIds,
        ...(evaluation.latestEvidenceAt === undefined ? {} : { latestEvidenceAt: evaluation.latestEvidenceAt }),
        ...(evaluation.latestUserConfirmedKind === undefined ? {} : { latestUserConfirmedKind: evaluation.latestUserConfirmedKind }),
      };

      if (!evaluation.success) {
        return {
          ...result(false, true, evaluation.reason),
          ...response,
        };
      }
      return {
        ...result(true, true),
        ...response,
        recommendation: evaluation.recommendation,
        reasonCodes: evaluation.reasonCodes,
      };
    },
  );
}
