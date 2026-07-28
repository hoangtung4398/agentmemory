import type {
  AgentSkill,
  SkillFeedbackEvent,
  SkillFeedbackKind,
  SkillLifecycleRecommendation,
  SkillLifecycleReviewEvidenceCounts,
  SkillLifecycleReviewReasonCode,
} from "../types.js";
import {
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";

export interface SkillLifecycleReviewEvaluation {
  success: boolean;
  recommendation: SkillLifecycleRecommendation;
  reasonCodes: SkillLifecycleReviewReasonCode[];
  applicableCount: number;
  evidenceCounts: SkillLifecycleReviewEvidenceCounts;
  sourceEventIds: string[];
  duplicateEventIds: string[];
  latestEvidenceAt?: string;
  latestUserConfirmedKind?: SkillFeedbackKind;
  reason?: string;
}

export function emptySkillLifecycleEvidenceCounts(): SkillLifecycleReviewEvidenceCounts {
  return {
    total: 0,
    success: 0,
    failure: 0,
    correction: 0,
    stale: 0,
    userConfirmedTotal: 0,
    userConfirmedSuccess: 0,
    userConfirmedFailure: 0,
    userConfirmedCorrection: 0,
    userConfirmedStale: 0,
    agentObservedTotal: 0,
    agentObservedSuccess: 0,
    agentObservedFailure: 0,
    agentObservedStale: 0,
  };
}

function nonBlankString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

export function isValidLifecycleReviewSkill(
  value: unknown,
  expectedId?: string,
): value is AgentSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  return nonBlankString(skill.id, MAX_SKILL_FEEDBACK_ID_LENGTH) &&
    (expectedId === undefined || skill.id === expectedId) &&
    Number.isInteger(skill.version) && (skill.version as number) > 0 &&
    (skill.status === "active" || skill.status === "retired" || skill.status === "superseded") &&
    (skill.project === undefined || nonBlankString(skill.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH)) &&
    (skill.agentId === undefined || nonBlankString(skill.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH));
}

export function compareSkillLifecycleIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isApplicable(event: SkillFeedbackEvent, skill: AgentSkill): boolean {
  return event.skillId === skill.id &&
    event.skillVersion === skill.version &&
    (skill.project === undefined || event.project === skill.project) &&
    (skill.agentId === undefined || event.agentId === skill.agentId);
}

function sortEvents(events: readonly SkillFeedbackEvent[]): SkillFeedbackEvent[] {
  return [...events].sort((left, right) => {
    const byTimestamp = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return byTimestamp !== 0 ? byTimestamp : compareSkillLifecycleIds(left.id, right.id);
  });
}

function countEvidence(events: readonly SkillFeedbackEvent[]): SkillLifecycleReviewEvidenceCounts {
  const counts = emptySkillLifecycleEvidenceCounts();
  for (const event of events) {
    counts.total += 1;
    counts[event.kind] += 1;
    if (event.attribution === "user-confirmed") {
      counts.userConfirmedTotal += 1;
      if (event.kind === "success") counts.userConfirmedSuccess += 1;
      if (event.kind === "failure") counts.userConfirmedFailure += 1;
      if (event.kind === "correction") counts.userConfirmedCorrection += 1;
      if (event.kind === "stale") counts.userConfirmedStale += 1;
    } else {
      counts.agentObservedTotal += 1;
      if (event.kind === "success") counts.agentObservedSuccess += 1;
      if (event.kind === "failure") counts.agentObservedFailure += 1;
      if (event.kind === "stale") counts.agentObservedStale += 1;
    }
  }
  return counts;
}

function duplicateEventIds(events: readonly SkillFeedbackEvent[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) duplicates.add(event.id);
    else seen.add(event.id);
  }
  return [...duplicates].sort(compareSkillLifecycleIds);
}

function decideRecommendation(
  applicableCount: number,
  counts: SkillLifecycleReviewEvidenceCounts,
  latestUserConfirmedKind: SkillFeedbackKind | undefined,
): { recommendation: SkillLifecycleRecommendation; reasonCodes: SkillLifecycleReviewReasonCode[] } {
  if (counts.userConfirmedStale >= 2 && latestUserConfirmedKind === "stale") {
    return { recommendation: "review_for_retirement", reasonCodes: ["repeated_user_confirmed_stale"] };
  }
  if (counts.userConfirmedCorrection >= 1 && latestUserConfirmedKind !== "success") {
    return {
      recommendation: "review_for_revision",
      reasonCodes: [
        "user_confirmed_correction",
        ...(counts.userConfirmedFailure >= 2 ? ["repeated_user_confirmed_failure" as const] : []),
      ],
    };
  }
  if (counts.userConfirmedFailure >= 2 && latestUserConfirmedKind !== "success") {
    return { recommendation: "review_for_revision", reasonCodes: ["repeated_user_confirmed_failure"] };
  }
  if (counts.userConfirmedSuccess >= 2 && counts.failure === 0 && counts.correction === 0 && counts.stale === 0) {
    return { recommendation: "keep_active", reasonCodes: ["stable_user_confirmed_success"] };
  }
  if (applicableCount === 0) {
    return { recommendation: "none", reasonCodes: ["no_applicable_feedback"] };
  }
  if (latestUserConfirmedKind === "success") {
    return {
      recommendation: "none",
      reasonCodes: [
        "latest_user_confirmed_success",
        ...((counts.failure > 0 || counts.correction > 0 || counts.stale > 0)
          ? ["negative_feedback_present" as const]
          : []),
      ],
    };
  }
  return { recommendation: "none", reasonCodes: ["insufficient_user_confirmed_evidence"] };
}

export function evaluateSkillLifecycleReview(
  skill: AgentSkill,
  validEvents: readonly SkillFeedbackEvent[],
): SkillLifecycleReviewEvaluation {
  if (skill.status !== "active") {
    return {
      success: true,
      recommendation: "none",
      reasonCodes: ["skill_not_active"],
      applicableCount: 0,
      evidenceCounts: emptySkillLifecycleEvidenceCounts(),
      sourceEventIds: [],
      duplicateEventIds: [],
    };
  }

  const applicableEvents = sortEvents(validEvents.filter((event) => isApplicable(event, skill)));
  const evidenceCounts = countEvidence(applicableEvents);
  const duplicateIds = duplicateEventIds(applicableEvents);
  const latestUserConfirmedKind = applicableEvents.find(
    (event) => event.attribution === "user-confirmed",
  )?.kind;
  const base = {
    applicableCount: applicableEvents.length,
    evidenceCounts,
    sourceEventIds: applicableEvents.map((event) => event.id),
    duplicateEventIds: duplicateIds,
    ...(applicableEvents[0] === undefined ? {} : { latestEvidenceAt: applicableEvents[0].createdAt }),
    ...(latestUserConfirmedKind === undefined ? {} : { latestUserConfirmedKind }),
  };
  if (duplicateIds.length > 0) {
    return { success: false, recommendation: "none", reasonCodes: [], reason: "duplicate feedback event id", ...base };
  }
  return {
    success: true,
    ...base,
    ...decideRecommendation(applicableEvents.length, evidenceCounts, latestUserConfirmedKind),
  };
}
