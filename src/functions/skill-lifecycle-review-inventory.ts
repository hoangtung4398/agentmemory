import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  AgentSkillStatus,
  SkillFeedbackEvent,
  SkillLifecycleRecommendation,
  SkillLifecycleReviewEvidenceCounts,
  SkillLifecycleReviewInventoryInput,
  SkillLifecycleReviewInventoryItem,
  SkillLifecycleReviewInventoryResult,
  SkillLifecycleReviewInventorySummary,
  SkillLifecycleReviewReasonCode,
} from "../types.js";
import {
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";
import {
  compareSkillLifecycleIds,
  evaluateSkillLifecycleReview,
  isValidLifecycleReviewSkill,
} from "./skill-lifecycle-review-policy.js";

const DEFAULT_SCAN_LIMIT = 500;
const MAX_SCAN_LIMIT = 5000;
const MAX_RESULT_LIMIT = 500;

interface NormalizedInventoryInput {
  project?: string;
  agentId?: string;
  status?: AgentSkillStatus;
  recommendation?: SkillLifecycleRecommendation;
  reasonCode?: SkillLifecycleReviewReasonCode;
  scanLimit: number;
  limit: number;
}

function emptySummary(): SkillLifecycleReviewInventorySummary {
  return {
    statusCounts: { active: 0, retired: 0, superseded: 0 },
    recommendationCounts: {
      none: 0,
      keep_active: 0,
      review_for_revision: 0,
      review_for_retirement: 0,
    },
    reasonCounts: {},
    failedItemCount: 0,
  };
}

function emptyResult(
  success: boolean,
  enabled: boolean,
  reason?: string,
): SkillLifecycleReviewInventoryResult {
  return {
    success,
    enabled,
    applied: false,
    ...(reason === undefined ? {} : { reason }),
    skillRowCount: 0,
    validSkillCount: 0,
    malformedSkillCount: 0,
    candidateCount: 0,
    ignoredSkillCount: 0,
    scannedCount: 0,
    matchedCount: 0,
    returnedCount: 0,
    scanTruncated: false,
    resultTruncated: false,
    truncated: false,
    feedbackScannedCount: 0,
    validFeedbackCount: 0,
    malformedFeedbackCount: 0,
    duplicateSkillIds: [],
    summary: emptySummary(),
    items: [],
  };
}

function normalizeScope(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SKILL_FEEDBACK_SCOPE_LENGTH
    ? normalized
    : null;
}

function isStatus(value: unknown): value is AgentSkillStatus {
  return value === "active" || value === "retired" || value === "superseded";
}

function isRecommendation(value: unknown): value is SkillLifecycleRecommendation {
  return value === "none" || value === "keep_active" ||
    value === "review_for_revision" || value === "review_for_retirement";
}

function isReasonCode(value: unknown): value is SkillLifecycleReviewReasonCode {
  return value === "skill_not_active" || value === "no_applicable_feedback" ||
    value === "repeated_user_confirmed_stale" || value === "user_confirmed_correction" ||
    value === "repeated_user_confirmed_failure" || value === "stable_user_confirmed_success" ||
    value === "latest_user_confirmed_success" || value === "negative_feedback_present" ||
    value === "insufficient_user_confirmed_evidence";
}

function optionalEnum<T>(value: unknown, valid: (candidate: unknown) => candidate is T): T | undefined | null {
  if (value === undefined) return undefined;
  return valid(value) ? value : null;
}

function optionalLimit(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : null;
}

function normalizeInput(
  input: SkillLifecycleReviewInventoryInput | undefined,
  diagnosticsLimit: number,
): NormalizedInventoryInput | undefined {
  const project = normalizeScope(input?.project);
  const agentId = normalizeScope(input?.agentId);
  const status = optionalEnum(input?.status, isStatus);
  const recommendation = optionalEnum(input?.recommendation, isRecommendation);
  const reasonCode = optionalEnum(input?.reasonCode, isReasonCode);
  const scanLimit = optionalLimit(input?.scanLimit, DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
  const limit = optionalLimit(input?.limit, diagnosticsLimit, MAX_RESULT_LIMIT);
  if (project === null || agentId === null || status === null || recommendation === null ||
    reasonCode === null || scanLimit === null || limit === null) return undefined;
  return {
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(status === undefined ? {} : { status }),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    scanLimit,
    limit,
  };
}

function cloneEvidenceCounts(counts: SkillLifecycleReviewEvidenceCounts): SkillLifecycleReviewEvidenceCounts {
  return { ...counts };
}

function toItem(skill: AgentSkill, validEvents: readonly SkillFeedbackEvent[]): SkillLifecycleReviewInventoryItem {
  const evaluation = evaluateSkillLifecycleReview(skill, validEvents);
  return {
    success: evaluation.success,
    skillId: skill.id,
    skillVersion: skill.version,
    currentStatus: skill.status,
    ...(skill.project === undefined ? {} : { project: skill.project }),
    ...(skill.agentId === undefined ? {} : { agentId: skill.agentId }),
    recommendation: evaluation.recommendation,
    reasonCodes: [...evaluation.reasonCodes],
    applicableCount: evaluation.applicableCount,
    evidenceCounts: cloneEvidenceCounts(evaluation.evidenceCounts),
    duplicateEventIds: [...evaluation.duplicateEventIds],
    ...(evaluation.latestEvidenceAt === undefined ? {} : { latestEvidenceAt: evaluation.latestEvidenceAt }),
    ...(evaluation.latestUserConfirmedKind === undefined
      ? {}
      : { latestUserConfirmedKind: evaluation.latestUserConfirmedKind }),
    ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
  };
}

function matchesPreEvaluationFilters(skill: AgentSkill, input: NormalizedInventoryInput): boolean {
  return (input.project === undefined || skill.project === input.project) &&
    (input.agentId === undefined || skill.agentId === input.agentId) &&
    (input.status === undefined || skill.status === input.status);
}

function matchesPostEvaluationFilters(item: SkillLifecycleReviewInventoryItem, input: NormalizedInventoryInput): boolean {
  return (input.recommendation === undefined || item.recommendation === input.recommendation) &&
    (input.reasonCode === undefined || item.reasonCodes.includes(input.reasonCode));
}

function compareSkillRows(left: AgentSkill, right: AgentSkill): number {
  const byId = compareSkillLifecycleIds(left.id, right.id);
  return byId !== 0 ? byId : right.version - left.version;
}

function itemPriority(item: SkillLifecycleReviewInventoryItem): number {
  if (!item.success) return 0;
  if (item.recommendation === "review_for_retirement") return 1;
  if (item.recommendation === "review_for_revision") return 2;
  if (item.recommendation === "keep_active") return 3;
  return 4;
}

function compareItems(left: SkillLifecycleReviewInventoryItem, right: SkillLifecycleReviewInventoryItem): number {
  const byPriority = itemPriority(left) - itemPriority(right);
  if (byPriority !== 0) return byPriority;
  if (left.latestEvidenceAt !== undefined && right.latestEvidenceAt === undefined) return -1;
  if (left.latestEvidenceAt === undefined && right.latestEvidenceAt !== undefined) return 1;
  if (left.latestEvidenceAt !== undefined && right.latestEvidenceAt !== undefined) {
    const byEvidence = Date.parse(right.latestEvidenceAt) - Date.parse(left.latestEvidenceAt);
    if (byEvidence !== 0) return byEvidence;
  }
  const byId = compareSkillLifecycleIds(left.skillId, right.skillId);
  return byId !== 0 ? byId : right.skillVersion - left.skillVersion;
}

function buildSummary(items: readonly SkillLifecycleReviewInventoryItem[]): SkillLifecycleReviewInventorySummary {
  const summary = emptySummary();
  for (const item of items) {
    summary.statusCounts[item.currentStatus] += 1;
    summary.recommendationCounts[item.recommendation] += 1;
    if (!item.success) {
      summary.failedItemCount += 1;
      continue;
    }
    for (const reasonCode of item.reasonCodes) {
      summary.reasonCounts[reasonCode] = (summary.reasonCounts[reasonCode] ?? 0) + 1;
    }
  }
  return summary;
}

export function registerSkillLifecycleReviewInventoryFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-lifecycle-review-inventory",
    async (data: SkillLifecycleReviewInventoryInput | undefined): Promise<SkillLifecycleReviewInventoryResult> => {
      const config = loadSkillConfig();
      if (!config.lifecycleReviewEnabled) {
        return emptyResult(true, false, "skill lifecycle review inventory is disabled");
      }

      const input = normalizeInput(data, config.diagnosticsLimit);
      if (!input) return emptyResult(false, true, "invalid skill lifecycle review inventory input");

      let skillRows: unknown[];
      try {
        skillRows = await kv.list<unknown>(KV.skills);
      } catch {
        return emptyResult(false, true, "failed to load skill lifecycle review inventory");
      }

      const validSkills = skillRows.filter((row): row is AgentSkill => isValidLifecycleReviewSkill(row));
      const ids = new Set<string>();
      const duplicateIds = new Set<string>();
      for (const skill of validSkills) {
        if (ids.has(skill.id)) duplicateIds.add(skill.id);
        else ids.add(skill.id);
      }
      const duplicateSkillIds = [...duplicateIds].sort(compareSkillLifecycleIds);
      const counts = {
        skillRowCount: skillRows.length,
        validSkillCount: validSkills.length,
        malformedSkillCount: skillRows.length - validSkills.length,
      };
      if (duplicateSkillIds.length > 0) {
        return { ...emptyResult(false, true, "duplicate skill id"), ...counts, duplicateSkillIds };
      }

      const candidates = validSkills
        .filter((skill) => matchesPreEvaluationFilters(skill, input))
        .sort(compareSkillRows);
      const scannedSkills = candidates.slice(0, input.scanLimit);
      const scanTruncated = candidates.length > scannedSkills.length;
      let feedbackRows: unknown[] = [];
      let validFeedback: SkillFeedbackEvent[] = [];
      if (scannedSkills.some((skill) => skill.status === "active")) {
        try {
          feedbackRows = await kv.list<unknown>(KV.skillFeedback);
        } catch {
          return {
            ...emptyResult(false, true, "failed to load skill lifecycle review inventory"),
            ...counts,
            candidateCount: candidates.length,
            ignoredSkillCount: validSkills.length - candidates.length,
            scannedCount: scannedSkills.length,
            scanTruncated,
            truncated: scanTruncated,
          };
        }
        validFeedback = feedbackRows.filter((row): row is SkillFeedbackEvent => isValidSkillFeedbackEvent(row));
      }

      const evaluated = scannedSkills.map((skill) => toItem(skill, validFeedback));
      const summary = buildSummary(evaluated);
      const matched = evaluated.filter((item) => matchesPostEvaluationFilters(item, input)).sort(compareItems);
      const items = matched.slice(0, input.limit).map((item) => ({
        ...item,
        reasonCodes: [...item.reasonCodes],
        evidenceCounts: cloneEvidenceCounts(item.evidenceCounts),
        duplicateEventIds: [...item.duplicateEventIds],
      }));
      const resultTruncated = matched.length > items.length;
      return {
        success: true,
        enabled: true,
        applied: false,
        ...counts,
        candidateCount: candidates.length,
        ignoredSkillCount: validSkills.length - candidates.length,
        scannedCount: scannedSkills.length,
        matchedCount: matched.length,
        returnedCount: items.length,
        scanTruncated,
        resultTruncated,
        truncated: scanTruncated || resultTruncated,
        feedbackScannedCount: feedbackRows.length,
        validFeedbackCount: validFeedback.length,
        malformedFeedbackCount: feedbackRows.length - validFeedback.length,
        duplicateSkillIds: [],
        summary,
        items,
      };
    },
  );
}
