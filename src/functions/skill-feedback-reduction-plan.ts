import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  SkillFeedbackEvent,
  SkillFeedbackReductionPlanCounters,
  SkillFeedbackReductionPlanInput,
  SkillFeedbackReductionPlanResult,
} from "../types.js";
import {
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";
import {
  buildSkillFeedbackReductionEvidence,
  findDuplicateSkillFeedbackEventIds,
  sortSkillFeedbackEvents,
} from "./skill-feedback-reduction-evidence.js";

interface NormalizedReductionPlanInput {
  skillId: string;
  skillVersion?: number;
  project?: string;
  agentId?: string;
}

function counters(success = 0, failure = 0): SkillFeedbackReductionPlanCounters {
  return { success, failure };
}

function result(
  success: boolean,
  enabled: boolean,
  reason?: string,
): SkillFeedbackReductionPlanResult {
  return {
    success,
    enabled,
    applied: false,
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    applicableCount: 0,
    ignoredCount: 0,
    proposedDelta: counters(),
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
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeInput(
  input: SkillFeedbackReductionPlanInput | undefined,
): NormalizedReductionPlanInput | undefined {
  const skillId = normalizedString(input?.skillId, MAX_SKILL_FEEDBACK_ID_LENGTH);
  const skillVersion = optionalPositiveInteger(input?.skillVersion);
  const project = optionalString(input?.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
  const agentId = optionalString(input?.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);

  if (!skillId || skillVersion === null || project === null || agentId === null) {
    return undefined;
  }

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
    (skill.project === undefined || normalizedString(skill.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined) &&
    (skill.agentId === undefined || normalizedString(skill.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH) !== undefined);
}

function appliesToSkill(
  event: SkillFeedbackEvent,
  skill: AgentSkill,
  input: NormalizedReductionPlanInput,
): boolean {
  return event.skillId === skill.id &&
    event.skillVersion === skill.version &&
    (input.project === undefined || event.project === input.project) &&
    (input.agentId === undefined || event.agentId === input.agentId) &&
    (skill.project === undefined || event.project === skill.project) &&
    (skill.agentId === undefined || event.agentId === skill.agentId);
}

function proposedDelta(events: readonly SkillFeedbackEvent[]): SkillFeedbackReductionPlanCounters {
  let success = 0;
  let failure = 0;

  for (const event of events) {
    if (event.kind === "success") success++;
    else if (event.kind === "failure" || event.kind === "correction") failure++;
  }

  return counters(success, failure);
}

export function registerSkillFeedbackReductionPlanFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-feedback-reduction-plan",
    async (
      data: SkillFeedbackReductionPlanInput | undefined,
    ): Promise<SkillFeedbackReductionPlanResult> => {
      if (!loadSkillConfig().feedbackReducerEnabled) {
        return result(true, false, "skill feedback reducer is disabled");
      }

      const input = normalizeInput(data);
      if (!input) return result(false, true, "invalid skill feedback reduction plan input");

      let skill: unknown;
      try {
        skill = await kv.get<unknown>(KV.skills, input.skillId);
      } catch {
        return result(false, true, "failed to load skill feedback reduction plan");
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
        return result(false, true, "failed to load skill feedback reduction plan");
      }

      const validEvents = rows.filter((row): row is SkillFeedbackEvent => isValidSkillFeedbackEvent(row));
      const applicableEvents = sortSkillFeedbackEvents(
        validEvents.filter((event) => appliesToSkill(event, skill, input)),
      );
      const duplicateEventIds = findDuplicateSkillFeedbackEventIds(applicableEvents);
      if (duplicateEventIds.length > 0) {
        return {
          ...result(false, true, "duplicate feedback event id"),
          skillId: skill.id,
          skillVersion: skill.version,
          scannedCount: rows.length,
          validCount: validEvents.length,
          malformedCount: rows.length - validEvents.length,
          applicableCount: applicableEvents.length,
          ignoredCount: validEvents.length - applicableEvents.length,
          duplicateEventIds,
        };
      }

      const evidence = buildSkillFeedbackReductionEvidence(applicableEvents);
      const delta = proposedDelta(applicableEvents);
      const currentCounters = counters(skill.successCount, skill.failureCount);

      return {
        success: true,
        enabled: true,
        applied: false,
        skillId: skill.id,
        skillVersion: skill.version,
        scannedCount: rows.length,
        validCount: validEvents.length,
        malformedCount: rows.length - validEvents.length,
        applicableCount: applicableEvents.length,
        ignoredCount: validEvents.length - applicableEvents.length,
        proposedDelta: delta,
        currentCounters,
        proposedCounters: counters(
          currentCounters.success + delta.success,
          currentCounters.failure + delta.failure,
        ),
        sourceEventIds: applicableEvents.map((event) => event.id),
        duplicateEventIds: [],
        evidenceHash: evidence.evidenceHash,
      };
    },
  );
}
