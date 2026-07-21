import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { fingerprintId, KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  SkillFeedbackAttribution,
  SkillFeedbackEvent,
  SkillFeedbackKind,
} from "../types.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_SKILL_ID_LENGTH = 200;
const MAX_SCOPE_ID_LENGTH = 500;
const MAX_EVIDENCE_ID_LENGTH = 200;
const MAX_EVIDENCE_IDS = 20;

export interface SkillFeedbackRecordInput {
  idempotencyKey?: unknown;
  skillId?: unknown;
  kind?: unknown;
  attribution?: unknown;
  project?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  sourceObservationIds?: unknown;
  sourceSessionIds?: unknown;
}

export interface SkillFeedbackRecordResult {
  success: boolean;
  recorded: boolean;
  duplicate: boolean;
  feedbackId?: string;
  reason?: string;
}

interface NormalizedSkillFeedbackRequest {
  idempotencyKey: string;
  skillId: string;
  kind: SkillFeedbackKind;
  attribution: SkillFeedbackAttribution;
  project?: string;
  agentId?: string;
  sessionId?: string;
  sourceObservationIds: string[];
  sourceSessionIds: string[];
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : undefined;
}

function optionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  return nonEmptyString(value, maxLength) ?? null;
}

function normalizedStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) return undefined;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = nonEmptyString(item, MAX_EVIDENCE_ID_LENGTH);
    if (!normalized) return undefined;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function isKind(value: unknown): value is SkillFeedbackKind {
  return value === "success" || value === "failure" || value === "correction" || value === "stale";
}

function isAttribution(value: unknown): value is SkillFeedbackAttribution {
  return value === "user-confirmed" || value === "agent-observed";
}

function normalizeRequest(
  data: SkillFeedbackRecordInput | undefined,
): NormalizedSkillFeedbackRequest | undefined {
  const idempotencyKey = nonEmptyString(data?.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  const skillId = nonEmptyString(data?.skillId, MAX_SKILL_ID_LENGTH);
  const project = optionalString(data?.project, MAX_SCOPE_ID_LENGTH);
  const agentId = optionalString(data?.agentId, MAX_SCOPE_ID_LENGTH);
  const sessionId = optionalString(data?.sessionId, MAX_SCOPE_ID_LENGTH);
  const sourceObservationIds = normalizedStringArray(data?.sourceObservationIds);
  const sourceSessionIds = normalizedStringArray(data?.sourceSessionIds);

  if (
    !idempotencyKey ||
    !skillId ||
    !isKind(data?.kind) ||
    !isAttribution(data?.attribution) ||
    project === null ||
    agentId === null ||
    sessionId === null ||
    !sourceObservationIds ||
    !sourceSessionIds ||
    (data.kind === "correction" && data.attribution !== "user-confirmed")
  ) {
    return undefined;
  }

  return {
    idempotencyKey,
    skillId,
    kind: data.kind,
    attribution: data.attribution,
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    sourceObservationIds,
    sourceSessionIds,
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item, MAX_SCOPE_ID_LENGTH) !== undefined);
}

function validOptionalScope(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value, MAX_SCOPE_ID_LENGTH) === value;
}

function isValidAgentSkill(value: unknown, skillId: string): value is AgentSkill {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const skill = value as Record<string, unknown>;
  return skill.id === skillId &&
    skill.status === "active" &&
    Number.isInteger(skill.version) && (skill.version as number) > 0 &&
    nonEmptyString(skill.name, MAX_SCOPE_ID_LENGTH) !== undefined &&
    nonEmptyString(skill.triggerCondition, MAX_SCOPE_ID_LENGTH) !== undefined &&
    nonEmptyString(skill.expectedOutcome, MAX_SCOPE_ID_LENGTH) !== undefined &&
    validStringArray(skill.steps) &&
    validStringArray(skill.antiPatterns) &&
    validStringArray(skill.files) &&
    validStringArray(skill.concepts) &&
    validStringArray(skill.sourceProceduralMemoryIds) &&
    validStringArray(skill.sourceCandidateIds) &&
    validStringArray(skill.sourceObservationIds) &&
    validStringArray(skill.sourceSessionIds) &&
    typeof skill.confidence === "number" && Number.isFinite(skill.confidence) && skill.confidence >= 0 && skill.confidence <= 1 &&
    typeof skill.strength === "number" && Number.isFinite(skill.strength) && skill.strength >= 0 && skill.strength <= 1 &&
    [skill.usageCount, skill.successCount, skill.failureCount].every((count) =>
      Number.isInteger(count) && (count as number) >= 0,
    ) &&
    validTimestamp(skill.createdAt) &&
    validTimestamp(skill.updatedAt) &&
    (skill.lastUsedAt === undefined || validTimestamp(skill.lastUsedAt)) &&
    (skill.lastReinforcedAt === undefined || validTimestamp(skill.lastReinforcedAt)) &&
    validOptionalScope(skill.project) &&
    validOptionalScope(skill.agentId) &&
    (skill.supersedes === undefined || nonEmptyString(skill.supersedes, MAX_SCOPE_ID_LENGTH) !== undefined);
}

function isNormalizedEvidenceArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= MAX_EVIDENCE_IDS &&
    value.every((item) => nonEmptyString(item, MAX_EVIDENCE_ID_LENGTH) === item) &&
    new Set(value).size === value.length;
}

function isValidFeedbackEvent(value: unknown, feedbackId: string): value is SkillFeedbackEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.id === feedbackId &&
    nonEmptyString(event.skillId, MAX_SKILL_ID_LENGTH) === event.skillId &&
    Number.isInteger(event.skillVersion) && (event.skillVersion as number) > 0 &&
    isKind(event.kind) &&
    isAttribution(event.attribution) &&
    (event.kind !== "correction" || event.attribution === "user-confirmed") &&
    event.source === "explicit" &&
    validOptionalScope(event.project) &&
    validOptionalScope(event.agentId) &&
    validOptionalScope(event.sessionId) &&
    isNormalizedEvidenceArray(event.sourceObservationIds) &&
    isNormalizedEvidenceArray(event.sourceSessionIds) &&
    validTimestamp(event.createdAt);
}

function createEvent(
  feedbackId: string,
  request: NormalizedSkillFeedbackRequest,
  skillVersion: number,
  createdAt: string,
): SkillFeedbackEvent {
  return {
    id: feedbackId,
    skillId: request.skillId,
    skillVersion,
    kind: request.kind,
    attribution: request.attribution,
    source: "explicit",
    ...(request.project === undefined ? {} : { project: request.project }),
    ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    sourceObservationIds: request.sourceObservationIds,
    sourceSessionIds: request.sourceSessionIds,
    createdAt,
  };
}

function sameEventIgnoringCreatedAt(a: SkillFeedbackEvent, b: SkillFeedbackEvent): boolean {
  return a.id === b.id &&
    a.skillId === b.skillId &&
    a.skillVersion === b.skillVersion &&
    a.kind === b.kind &&
    a.attribution === b.attribution &&
    a.source === b.source &&
    a.project === b.project &&
    a.agentId === b.agentId &&
    a.sessionId === b.sessionId &&
    a.sourceObservationIds.length === b.sourceObservationIds.length &&
    a.sourceSessionIds.length === b.sourceSessionIds.length &&
    a.sourceObservationIds.every((value, index) => value === b.sourceObservationIds[index]) &&
    a.sourceSessionIds.every((value, index) => value === b.sourceSessionIds[index]);
}

function failure(reason: string): SkillFeedbackRecordResult {
  return { success: false, recorded: false, duplicate: false, reason };
}

export function registerSkillFeedbackFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-feedback-record",
    async (data: SkillFeedbackRecordInput | undefined): Promise<SkillFeedbackRecordResult> => {
      if (!loadSkillConfig().feedbackEnabled) {
        return { success: true, recorded: false, duplicate: false, reason: "skill feedback is disabled" };
      }

      const request = normalizeRequest(data);
      if (!request) return failure("invalid skill feedback input");

      const feedbackId = fingerprintId(
        "skill-feedback",
        `${request.skillId}\n${request.idempotencyKey}`,
      );

      return withKeyedLock(`skill-feedback:${feedbackId}`, async () => {
        let existing: unknown;
        try {
          existing = await kv.get<unknown>(KV.skillFeedback, feedbackId);
        } catch {
          return failure("failed to load skill feedback");
        }

        if (existing !== null) {
          if (!isValidFeedbackEvent(existing, feedbackId)) {
            return failure("existing skill feedback event is malformed");
          }
          const expected = createEvent(
            feedbackId,
            request,
            existing.skillVersion,
            existing.createdAt,
          );
          if (!sameEventIgnoringCreatedAt(existing, expected)) {
            return failure("skill feedback idempotency conflict");
          }
          return { success: true, recorded: false, duplicate: true, feedbackId };
        }

        let skill: unknown;
        try {
          skill = await kv.get<unknown>(KV.skills, request.skillId);
        } catch {
          return failure("failed to load agent skill");
        }
        if (!isValidAgentSkill(skill, request.skillId)) {
          return failure("agent skill is missing or invalid");
        }
        if (
          (skill.project !== undefined && request.project !== skill.project) ||
          (skill.agentId !== undefined && request.agentId !== skill.agentId)
        ) {
          return failure("skill feedback scope does not match agent skill");
        }

        const event = createEvent(
          feedbackId,
          request,
          skill.version,
          new Date().toISOString(),
        );
        try {
          await kv.set(KV.skillFeedback, feedbackId, event);
        } catch {
          return failure("failed to write skill feedback");
        }
        return { success: true, recorded: true, duplicate: false, feedbackId };
      });
    },
  );
}
