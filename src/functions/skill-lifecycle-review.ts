import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  SkillFeedbackEvent,
  SkillFeedbackKind,
  SkillLifecycleRecommendation,
  SkillLifecycleReviewEvidenceCounts,
  SkillLifecycleReviewInput,
  SkillLifecycleReviewReasonCode,
  SkillLifecycleReviewResult,
} from "../types.js";
import {
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";

interface NormalizedReviewInput {
  skillId: string;
  skillVersion?: number;
  project?: string;
  agentId?: string;
}

function evidenceCounts(): SkillLifecycleReviewEvidenceCounts {
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

function isValidAgentSkill(value: unknown, skillId: string): value is AgentSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  return skill.id === skillId &&
    Number.isInteger(skill.version) && (skill.version as number) > 0 &&
    (skill.status === "active" || skill.status === "retired" || skill.status === "superseded") &&
    (skill.project === undefined || normalizedString(skill.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined) &&
    (skill.agentId === undefined || normalizedString(skill.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined);
}

function hasMatchingScope(skill: AgentSkill, input: NormalizedReviewInput): boolean {
  return skill.project === input.project && skill.agentId === input.agentId;
}

function isApplicable(event: SkillFeedbackEvent, skill: AgentSkill): boolean {
  return event.skillId === skill.id &&
    event.skillVersion === skill.version &&
    (skill.project === undefined || event.project === skill.project) &&
    (skill.agentId === undefined || event.agentId === skill.agentId);
}

function compareIdsAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortEvents(events: readonly SkillFeedbackEvent[]): SkillFeedbackEvent[] {
  return [...events].sort((a, b) => {
    const timestampDifference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return timestampDifference !== 0 ? timestampDifference : compareIdsAscending(a.id, b.id);
  });
}

function countEvidence(events: readonly SkillFeedbackEvent[]): SkillLifecycleReviewEvidenceCounts {
  const counts = evidenceCounts();
  for (const event of events) {
    counts.total++;
    counts[event.kind]++;
    if (event.attribution === "user-confirmed") {
      counts.userConfirmedTotal++;
      if (event.kind === "success") counts.userConfirmedSuccess++;
      if (event.kind === "failure") counts.userConfirmedFailure++;
      if (event.kind === "correction") counts.userConfirmedCorrection++;
      if (event.kind === "stale") counts.userConfirmedStale++;
    } else {
      counts.agentObservedTotal++;
      if (event.kind === "success") counts.agentObservedSuccess++;
      if (event.kind === "failure") counts.agentObservedFailure++;
      if (event.kind === "stale") counts.agentObservedStale++;
    }
  }
  return counts;
}

function duplicateIds(events: readonly SkillFeedbackEvent[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) duplicates.add(event.id);
    else seen.add(event.id);
  }
  return [...duplicates].sort(compareIdsAscending);
}

function recommendation(
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
  if (
    counts.userConfirmedSuccess >= 2 &&
    counts.failure === 0 &&
    counts.correction === 0 &&
    counts.stale === 0
  ) {
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
      if (stored === null || !isValidAgentSkill(stored, input.skillId)) {
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
      const applicableEvents = sortEvents(validEvents.filter((event) => isApplicable(event, stored)));
      const sourceEventIds = applicableEvents.map((event) => event.id);
      const evidenceCounts = countEvidence(applicableEvents);
      const duplicates = duplicateIds(applicableEvents);
      const latestUserConfirmedKind = applicableEvents.find(
        (event) => event.attribution === "user-confirmed",
      )?.kind;
      const response = {
        ...base,
        scannedCount: rows.length,
        validCount: validEvents.length,
        malformedCount: rows.length - validEvents.length,
        applicableCount: applicableEvents.length,
        ignoredCount: validEvents.length - applicableEvents.length,
        evidenceCounts,
        sourceEventIds,
        duplicateEventIds: duplicates,
        ...(applicableEvents[0] === undefined ? {} : { latestEvidenceAt: applicableEvents[0].createdAt }),
        ...(latestUserConfirmedKind === undefined ? {} : { latestUserConfirmedKind }),
      };

      if (duplicates.length > 0) {
        return {
          ...result(false, true, "duplicate feedback event id"),
          ...response,
        };
      }
      return {
        ...result(true, true),
        ...response,
        ...recommendation(applicableEvents.length, evidenceCounts, latestUserConfirmedKind),
      };
    },
  );
}
