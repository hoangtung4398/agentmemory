import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  SkillFeedbackEvent,
  SkillLifecycleReviewFeedbackCounts,
  SkillLifecycleReviewInput,
  SkillLifecycleReviewReason,
  SkillLifecycleReviewResult,
} from "../types.js";
import {
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";
import { sortSkillFeedbackEvents } from "./skill-feedback-reduction-evidence.js";

interface NormalizedReviewInput {
  skillId: string;
  skillVersion?: number;
  project?: string;
  agentId?: string;
}

function feedbackCounts(): SkillLifecycleReviewFeedbackCounts {
  return { success: 0, failure: 0, correction: 0, stale: 0 };
}

function result(
  success: boolean,
  enabled: boolean,
  reason?: string,
): SkillLifecycleReviewResult {
  return {
    success,
    enabled,
    applied: false,
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    applicableCount: 0,
    ignoredCount: 0,
    feedback: feedbackCounts(),
    recommendation: "no_review",
    reasons: [],
    sourceEventIds: [],
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
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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

function isValidAgentSkill(value: unknown, skillId: string): value is AgentSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  return skill.id === skillId &&
    Number.isInteger(skill.version) && (skill.version as number) > 0 &&
    Number.isInteger(skill.successCount) && (skill.successCount as number) >= 0 &&
    Number.isInteger(skill.failureCount) && (skill.failureCount as number) >= 0 &&
    (skill.status === "active" || skill.status === "retired" || skill.status === "superseded") &&
    (skill.project === undefined || normalizedString(skill.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined) &&
    (skill.agentId === undefined || normalizedString(skill.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined);
}

function appliesToSkill(
  event: SkillFeedbackEvent,
  skill: AgentSkill,
  input: NormalizedReviewInput,
): boolean {
  return event.skillId === skill.id &&
    event.skillVersion === skill.version &&
    (input.project === undefined || event.project === input.project) &&
    (input.agentId === undefined || event.agentId === input.agentId) &&
    (skill.project === undefined || event.project === skill.project) &&
    (skill.agentId === undefined || event.agentId === skill.agentId);
}

function countFeedback(events: readonly SkillFeedbackEvent[]): SkillLifecycleReviewFeedbackCounts {
  const counts = feedbackCounts();
  for (const event of events) counts[event.kind]++;
  return counts;
}

function reviewReasons(
  skill: AgentSkill,
  counts: SkillLifecycleReviewFeedbackCounts,
): SkillLifecycleReviewReason[] {
  if (skill.status !== "active") return ["skill_not_active"];
  if (counts.success + counts.failure + counts.correction + counts.stale === 0) {
    return ["no_applicable_feedback"];
  }

  const reasons: SkillLifecycleReviewReason[] = [];
  if (counts.correction > 0) reasons.push("correction_feedback");
  if (counts.stale > 0) reasons.push("stale_feedback");
  if (counts.failure > counts.success) reasons.push("failures_exceed_successes");
  return reasons.length > 0 ? reasons : ["feedback_within_expected_range"];
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

      let skill: unknown;
      try {
        skill = await kv.get<unknown>(KV.skills, input.skillId);
      } catch {
        return result(false, true, "failed to load skill lifecycle review");
      }

      if (skill === null || !isValidAgentSkill(skill, input.skillId)) {
        return result(false, true, "skill not found");
      }
      if (input.skillVersion !== undefined && input.skillVersion !== skill.version) {
        return result(false, true, "skill version mismatch");
      }

      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skillFeedback);
      } catch {
        return result(false, true, "failed to load skill lifecycle review");
      }

      const validEvents = rows.filter((row): row is SkillFeedbackEvent => isValidSkillFeedbackEvent(row));
      const applicableEvents = sortSkillFeedbackEvents(
        validEvents.filter((event) => appliesToSkill(event, skill, input)),
      );
      const feedback = countFeedback(applicableEvents);
      const reasons = reviewReasons(skill, feedback);
      const reviewRequired = reasons.some((reason) =>
        reason === "correction_feedback" ||
        reason === "stale_feedback" ||
        reason === "failures_exceed_successes",
      );

      return {
        success: true,
        enabled: true,
        applied: false,
        skillId: skill.id,
        skillVersion: skill.version,
        status: skill.status,
        scannedCount: rows.length,
        validCount: validEvents.length,
        malformedCount: rows.length - validEvents.length,
        applicableCount: applicableEvents.length,
        ignoredCount: validEvents.length - applicableEvents.length,
        feedback,
        recommendation: reviewRequired ? "review" : "no_review",
        reasons,
        sourceEventIds: applicableEvents.map((event) => event.id),
      };
    },
  );
}
