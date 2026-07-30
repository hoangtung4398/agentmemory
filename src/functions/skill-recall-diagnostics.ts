import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  SkillRecallDiagnosticsInput,
  SkillRecallDiagnosticsItem,
  SkillRecallDiagnosticsReasonCode,
  SkillRecallDiagnosticsResult,
  SkillRecallDiagnosticsSummary,
  SkillRecallDiagnosticsState,
  SkillRecallInput,
  SkillRecallScoreBreakdown,
} from "../types.js";
import {
  evaluateSkillRecallPopulation,
  normalizeSkillRecallInput,
} from "./skill-recall-policy.js";

const DEFAULT_ITEM_LIMIT = 50;
const MAX_ITEM_LIMIT = 500;
const STATES: ReadonlySet<SkillRecallDiagnosticsState> = new Set([
  "malformed",
  "excluded",
  "matched_not_returned",
  "selected",
]);
const REASON_CODES: ReadonlySet<SkillRecallDiagnosticsReasonCode> = new Set([
  "malformed_skill",
  "inactive",
  "below_min_confidence",
  "project_scope_mismatch",
  "agent_scope_mismatch",
  "no_context_match",
  "outside_limit",
  "selected",
]);
const STATE_PRIORITY: Record<SkillRecallDiagnosticsState, number> = {
  selected: 0,
  matched_not_returned: 1,
  excluded: 2,
  malformed: 3,
};

type NormalizedSkillRecallDiagnosticsInput = {
  input: SkillRecallInput;
  state?: SkillRecallDiagnosticsState;
  reasonCode?: SkillRecallDiagnosticsReasonCode;
  itemLimit: number;
};

function emptySummary(): SkillRecallDiagnosticsSummary {
  return {
    stateCounts: {
      malformed: 0,
      excluded: 0,
      matched_not_returned: 0,
      selected: 0,
    },
    reasonCounts: {},
  };
}

function baseResult(
  success: boolean,
  enabled: boolean,
  effectiveLimit: number,
  reason?: string,
): SkillRecallDiagnosticsResult {
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
    anonymousMalformedCount: 0,
    matchedCount: 0,
    recallReturnedCount: 0,
    effectiveLimit,
    recallTruncated: false,
    duplicateSkillIdCount: 0,
    diagnosticMatchedCount: 0,
    diagnosticReturnedCount: 0,
    diagnosticTruncated: false,
    summary: emptySummary(),
    items: [],
  };
}

function cloneBreakdown(value: SkillRecallScoreBreakdown): SkillRecallScoreBreakdown {
  return { ...value };
}

function cloneItem(value: SkillRecallDiagnosticsItem): SkillRecallDiagnosticsItem {
  return {
    ...value,
    reasonCodes: [...value.reasonCodes],
    ...(value.scoreBreakdown === undefined ? {} : { scoreBreakdown: cloneBreakdown(value.scoreBreakdown) }),
  };
}

function cloneResult(value: SkillRecallDiagnosticsResult): SkillRecallDiagnosticsResult {
  return {
    ...value,
    summary: {
      stateCounts: { ...value.summary.stateCounts },
      reasonCounts: { ...value.summary.reasonCounts },
    },
    items: value.items.map(cloneItem),
  };
}

export function normalizeSkillRecallDiagnosticsInput(
  data: unknown,
): NormalizedSkillRecallDiagnosticsInput | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as SkillRecallDiagnosticsInput;
  const normalized = normalizeSkillRecallInput({
    project: value.project,
    agentId: value.agentId,
    query: value.query,
    files: value.files,
    concepts: value.concepts,
    limit: value.limit,
  });
  if (!normalized.success) return null;
  const state = value.state === undefined
    ? undefined
    : typeof value.state === "string" && STATES.has(value.state as SkillRecallDiagnosticsState)
      ? value.state as SkillRecallDiagnosticsState
      : null;
  const reasonCode = value.reasonCode === undefined
    ? undefined
    : typeof value.reasonCode === "string" && REASON_CODES.has(value.reasonCode as SkillRecallDiagnosticsReasonCode)
      ? value.reasonCode as SkillRecallDiagnosticsReasonCode
      : null;
  const itemLimit = value.itemLimit === undefined ? DEFAULT_ITEM_LIMIT : value.itemLimit;
  if (
    state === null || reasonCode === null || typeof itemLimit !== "number" ||
    !Number.isFinite(itemLimit) || !Number.isInteger(itemLimit) ||
    itemLimit < 1 || itemLimit > MAX_ITEM_LIMIT
  ) return null;
  return { input: normalized.input, ...(state === undefined ? {} : { state }), ...(reasonCode === undefined ? {} : { reasonCode }), itemLimit };
}

function diagnosticItem(
  evaluation: ReturnType<typeof evaluateSkillRecallPopulation>["rowEvaluations"][number],
): SkillRecallDiagnosticsItem | null {
  if (evaluation.containsPrivateData || evaluation.normalizedSkillId === undefined) return null;
  if (evaluation.state === "malformed") {
    return {
      skillId: evaluation.normalizedSkillId,
      state: "malformed",
      reasonCodes: ["malformed_skill"],
      selected: false,
    };
  }
  if (evaluation.state === "excluded") {
    return {
      skillId: evaluation.normalizedSkillId,
      state: "excluded",
      reasonCodes: [...evaluation.reasonCodes] as SkillRecallDiagnosticsReasonCode[],
      selected: false,
      ...(evaluation.scoreBreakdown === undefined ? {} : { scoreBreakdown: cloneBreakdown(evaluation.scoreBreakdown) }),
    };
  }
  if (evaluation.state === "matched") {
    return {
      skillId: evaluation.normalizedSkillId,
      state: evaluation.selected ? "selected" : "matched_not_returned",
      reasonCodes: [evaluation.selected ? "selected" : "outside_limit"],
      selected: evaluation.selected,
      ...(evaluation.rank === undefined ? {} : { rank: evaluation.rank }),
      ...(evaluation.scoreBreakdown === undefined ? {} : { scoreBreakdown: cloneBreakdown(evaluation.scoreBreakdown) }),
    };
  }
  return null;
}

function sortedItems(items: SkillRecallDiagnosticsItem[]): SkillRecallDiagnosticsItem[] {
  return [...items].sort((left, right) =>
    STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state] ||
    (left.rank ?? 0) - (right.rank ?? 0) ||
    left.skillId.localeCompare(right.skillId),
  );
}

export function registerSkillRecallDiagnosticsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-recall-diagnostics",
    async (data: unknown): Promise<SkillRecallDiagnosticsResult> => {
      const config = loadSkillConfig();
      if (!config.recallEnabled) {
        return baseResult(true, false, 0, "skill recall diagnostics is disabled");
      }
      const normalized = normalizeSkillRecallDiagnosticsInput(data);
      if (!normalized) {
        return baseResult(false, true, 0, "invalid skill recall diagnostics input");
      }
      const effectiveLimit = normalized.input.limit ?? config.recallLimit;
      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skills);
      } catch {
        return baseResult(false, true, effectiveLimit, "failed to load skill recall diagnostics");
      }
      const evaluation = evaluateSkillRecallPopulation(
        rows,
        normalized.input,
        config.recallMinConfidence,
        effectiveLimit,
      );
      const duplicateCounts = new Map<string, number>();
      for (const row of evaluation.rowEvaluations) {
        if (row.normalizedSkillId !== undefined) {
          duplicateCounts.set(row.normalizedSkillId, (duplicateCounts.get(row.normalizedSkillId) ?? 0) + 1);
        }
      }
      const duplicateSkillIdCount = [...duplicateCounts.values()].filter((count) => count > 1).length;
      const privateProtectedCount = evaluation.rowEvaluations.filter((row) => row.containsPrivateData).length;
      const anonymousMalformedCount = evaluation.rowEvaluations.filter(
        (row) => !row.containsPrivateData && row.state === "malformed" && row.normalizedSkillId === undefined,
      ).length;
      const result = {
        success: true,
        enabled: true,
        applied: false as const,
        scannedCount: evaluation.scannedCount,
        validCount: evaluation.validCount,
        malformedCount: evaluation.malformedCount,
        privacySuppressedCount: evaluation.privacySuppressedCount,
        privateProtectedCount,
        anonymousMalformedCount,
        matchedCount: evaluation.matchedCount,
        recallReturnedCount: evaluation.returnedCount,
        effectiveLimit,
        recallTruncated: evaluation.truncated,
        duplicateSkillIdCount,
      };
      if (duplicateSkillIdCount > 0) {
        return {
          ...baseResult(false, true, effectiveLimit, "duplicate skill id"),
          ...result,
          success: false,
          items: [],
        };
      }
      const items = evaluation.rowEvaluations.flatMap((row) => {
        const item = diagnosticItem(row);
        return item === null ? [] : [item];
      });
      const summary = emptySummary();
      for (const item of items) {
        summary.stateCounts[item.state] += 1;
        for (const reasonCode of item.reasonCodes) {
          summary.reasonCounts[reasonCode] = (summary.reasonCounts[reasonCode] ?? 0) + 1;
        }
      }
      const filtered = items.filter((item) =>
        (normalized.state === undefined || item.state === normalized.state) &&
        (normalized.reasonCode === undefined || item.reasonCodes.includes(normalized.reasonCode)),
      );
      const diagnosticMatchedCount = filtered.length;
      const returnedItems = sortedItems(filtered).slice(0, normalized.itemLimit).map(cloneItem);
      return cloneResult({
        ...result,
        diagnosticMatchedCount,
        diagnosticReturnedCount: returnedItems.length,
        diagnosticTruncated: diagnosticMatchedCount > returnedItems.length,
        summary,
        items: returnedItems,
      });
    },
  );
}
