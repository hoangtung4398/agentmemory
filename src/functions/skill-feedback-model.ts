import type {
  SkillFeedbackAttribution,
  SkillFeedbackEvent,
  SkillFeedbackKind,
} from "../types.js";

export const MAX_SKILL_FEEDBACK_ID_LENGTH = 200;
export const MAX_SKILL_FEEDBACK_SCOPE_LENGTH = 500;
export const MAX_SKILL_FEEDBACK_EVIDENCE_IDS = 20;

function isNormalizedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isValidOptionalScope(value: unknown): value is string | undefined {
  return value === undefined || isNormalizedNonEmptyString(value, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
}

function isValidEvidenceIds(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= MAX_SKILL_FEEDBACK_EVIDENCE_IDS &&
    value.every((item) => isNormalizedNonEmptyString(item, MAX_SKILL_FEEDBACK_ID_LENGTH)) &&
    new Set(value).size === value.length;
}

export function isSkillFeedbackKind(value: unknown): value is SkillFeedbackKind {
  return value === "success" || value === "failure" || value === "correction" || value === "stale";
}

export function isSkillFeedbackAttribution(value: unknown): value is SkillFeedbackAttribution {
  return value === "user-confirmed" || value === "agent-observed";
}

export function isValidSkillFeedbackEvent(
  value: unknown,
  expectedId?: string,
): value is SkillFeedbackEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return isNormalizedNonEmptyString(event.id, MAX_SKILL_FEEDBACK_ID_LENGTH) &&
    (expectedId === undefined || event.id === expectedId) &&
    isNormalizedNonEmptyString(event.skillId, MAX_SKILL_FEEDBACK_ID_LENGTH) &&
    Number.isInteger(event.skillVersion) && (event.skillVersion as number) > 0 &&
    isSkillFeedbackKind(event.kind) &&
    isSkillFeedbackAttribution(event.attribution) &&
    (event.kind !== "correction" || event.attribution === "user-confirmed") &&
    event.source === "explicit" &&
    isValidOptionalScope(event.project) &&
    isValidOptionalScope(event.agentId) &&
    isValidOptionalScope(event.sessionId) &&
    isValidEvidenceIds(event.sourceObservationIds) &&
    isValidEvidenceIds(event.sourceSessionIds) &&
    isValidTimestamp(event.createdAt);
}
