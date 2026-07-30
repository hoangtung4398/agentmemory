import type {
  SkillAdvisory,
  SkillRecallExplanationReasonCode,
  SkillRecallInput,
  SkillRecallInputParseResult,
  SkillRecallScoreBreakdown,
} from "../types.js";
import { stripPrivateData } from "./privacy.js";

export const SKILL_RECALL_MAX_QUERY_LENGTH = 1_000;
const MAX_CONTEXT_VALUES = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

type RecallableSkill = {
  id: string;
  name: string;
  triggerCondition: string;
  steps: string[];
  expectedOutcome: string;
  antiPatterns: string[];
  project?: string;
  agentId?: string;
  files: string[];
  concepts: string[];
  confidence: number;
  strength: number;
  sourceProceduralMemoryIds: string[];
  status: "active" | "retired" | "superseded";
  updatedAt: string;
};

export interface SkillRecallRowEvaluation {
  normalizedSkillId?: string;
  containsPrivateData: boolean;
  valid: boolean;
  state: "malformed" | "privacy_suppressed" | "excluded" | "matched";
  reasonCodes: SkillRecallExplanationReasonCode[];
  scoreBreakdown?: SkillRecallScoreBreakdown;
  advisory?: SkillAdvisory;
  rank?: number;
  selected: boolean;
}

export interface SkillRecallPopulationEvaluation {
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  privacySuppressedCount: number;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  advisories: SkillAdvisory[];
  rowEvaluations: SkillRecallRowEvaluation[];
}

function nonEmptyString(value: unknown, field: string): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (field === "query" && normalized.length > SKILL_RECALL_MAX_QUERY_LENGTH) return null;
  return normalized;
}

function normalizedStrings(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].slice(0, MAX_CONTEXT_VALUES);
}

function clampedLimit(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(value)));
}

export function normalizeSkillRecallInput(data: unknown): SkillRecallInputParseResult {
  if (data === undefined || data === null) return { success: true, input: {} };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { success: false, error: "request body must be an object" };
  }
  const value = data as Record<string, unknown>;
  const project = nonEmptyString(value.project, "project");
  const agentId = nonEmptyString(value.agentId, "agentId");
  const query = nonEmptyString(value.query, "query");
  const files = normalizedStrings(value.files);
  const concepts = normalizedStrings(value.concepts);
  const limit = clampedLimit(value.limit);
  if (project === null || agentId === null || query === null) {
    return { success: false, error: `project, agentId, and query must be strings of at most ${SKILL_RECALL_MAX_QUERY_LENGTH} characters for query` };
  }
  if (files === null || concepts === null) return { success: false, error: "files and concepts must be arrays of strings" };
  if (limit === null) return { success: false, error: "limit must be a finite number" };
  return {
    success: true,
    input: {
      ...(project ? { project } : {}),
      ...(agentId ? { agentId } : {}),
      ...(query ? { query } : {}),
      ...(value.files === undefined ? {} : { files }),
      ...(value.concepts === undefined ? {} : { concepts }),
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [])];
}

function includesExact(values: string[], requested: string[]): number {
  const valuesSet = new Set(values);
  return requested.filter((value) => valuesSet.has(value)).length;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function visibleInstructionPayload(row: unknown): string {
  const record = recordValue(row);
  if (!record) return "";
  const text: string[] = [];
  for (const field of ["name", "triggerCondition"] as const) {
    if (typeof record[field] === "string") text.push(record[field]);
  }
  if (Array.isArray(record.steps)) text.push(...record.steps.filter((entry): entry is string => typeof entry === "string"));
  if (typeof record.expectedOutcome === "string") text.push(record.expectedOutcome);
  if (Array.isArray(record.antiPatterns)) text.push(...record.antiPatterns.filter((entry): entry is string => typeof entry === "string"));
  return text.join("\n");
}

function rowContainsPrivateData(row: unknown): boolean {
  const payload = visibleInstructionPayload(row);
  return /<private\b/i.test(payload) || stripPrivateData(payload) !== payload;
}

function requiredString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredStringArray(record: Record<string, unknown>, field: string, requireValue = false): string[] | null {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  return requireValue && normalized.length === 0 ? null : normalized;
}

function optionalScope(record: Record<string, unknown>, field: string): string | undefined | null {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function privateRowIsVisible(row: unknown, input: SkillRecallInput, recallMinConfidence: number): boolean {
  const record = recordValue(row);
  if (!record) return false;
  const project = optionalScope(record, "project");
  const agentId = optionalScope(record, "agentId");
  return project !== null && agentId !== null &&
    (project === undefined || project === input.project) &&
    (agentId === undefined || agentId === input.agentId) &&
    record.status === "active" &&
    validScore(record.confidence) && record.confidence >= recallMinConfidence;
}

function inspectSkillRow(row: unknown): RecallableSkill | null {
  const record = recordValue(row);
  if (!record) return null;
  const id = requiredString(record, "id");
  const name = requiredString(record, "name");
  const triggerCondition = requiredString(record, "triggerCondition");
  const steps = requiredStringArray(record, "steps", true);
  const expectedOutcome = requiredString(record, "expectedOutcome");
  const antiPatterns = requiredStringArray(record, "antiPatterns");
  const files = requiredStringArray(record, "files");
  const concepts = requiredStringArray(record, "concepts");
  const sourceProceduralMemoryIds = requiredStringArray(record, "sourceProceduralMemoryIds");
  const project = optionalScope(record, "project");
  const agentId = optionalScope(record, "agentId");
  const confidence = record.confidence;
  const strength = record.strength;
  const status = record.status;
  const updatedAt = requiredString(record, "updatedAt");
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (
    !id || !name || !triggerCondition || !steps || !expectedOutcome || !antiPatterns ||
    !files || !concepts || !sourceProceduralMemoryIds || project === null || agentId === null ||
    !validScore(confidence) || !validScore(strength) ||
    (status !== "active" && status !== "retired" && status !== "superseded") ||
    !Number.isFinite(updatedAtMs)
  ) return null;
  return {
    id,
    name,
    triggerCondition,
    steps,
    expectedOutcome,
    antiPatterns,
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
    files,
    concepts,
    confidence,
    strength,
    sourceProceduralMemoryIds,
    status,
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

function exclusionReasons(skill: RecallableSkill, input: SkillRecallInput, recallMinConfidence: number): SkillRecallExplanationReasonCode[] {
  const reasons: SkillRecallExplanationReasonCode[] = [];
  if (skill.status !== "active") reasons.push("inactive");
  if (skill.confidence < recallMinConfidence) reasons.push("below_min_confidence");
  if (skill.project && skill.project !== input.project) reasons.push("project_scope_mismatch");
  if (skill.agentId && skill.agentId !== input.agentId) reasons.push("agent_scope_mismatch");
  return reasons;
}

function scoreSkill(skill: RecallableSkill, input: SkillRecallInput): { breakdown: SkillRecallScoreBreakdown; applicable: boolean } {
  const projectScopeScore = skill.project && skill.project === input.project ? 6 : 0;
  const agentScopeScore = skill.agentId && skill.agentId === input.agentId ? 8 : 0;
  const conceptMatchCount = Math.min(3, includesExact(skill.concepts, input.concepts ?? []));
  const fileMatchCount = Math.min(3, includesExact(skill.files, input.files ?? []));
  const targetTokens = new Set(queryTokens([skill.name, skill.triggerCondition, skill.expectedOutcome].join(" ")));
  const queryTokenMatchCount = Math.min(8, queryTokens(input.query).filter((token) => targetTokens.has(token)).length);
  const breakdown = {
    projectScopeScore,
    agentScopeScore,
    conceptMatchCount,
    conceptScore: conceptMatchCount * 3,
    fileMatchCount,
    fileScore: fileMatchCount * 2,
    queryTokenMatchCount,
    queryScore: queryTokenMatchCount,
    totalScore: projectScopeScore + agentScopeScore + conceptMatchCount * 3 + fileMatchCount * 2 + queryTokenMatchCount,
  };
  return { breakdown, applicable: conceptMatchCount > 0 || fileMatchCount > 0 || queryTokenMatchCount > 0 };
}

function toAdvisory(skill: RecallableSkill, score: number): SkillAdvisory {
  return {
    source: "skill-advisory",
    skillId: skill.id,
    name: skill.name,
    triggerCondition: skill.triggerCondition,
    steps: [...skill.steps],
    expectedOutcome: skill.expectedOutcome,
    antiPatterns: [...skill.antiPatterns],
    project: skill.project,
    agentId: skill.agentId,
    files: [...skill.files],
    concepts: [...skill.concepts],
    confidence: skill.confidence,
    strength: skill.strength,
    score,
    sourceProceduralMemoryIds: [...skill.sourceProceduralMemoryIds],
  };
}

function cloneBreakdown(value: SkillRecallScoreBreakdown): SkillRecallScoreBreakdown {
  return { ...value };
}

function cloneAdvisory(value: SkillAdvisory): SkillAdvisory {
  return {
    ...value,
    steps: [...value.steps],
    antiPatterns: [...value.antiPatterns],
    files: [...value.files],
    concepts: [...value.concepts],
    sourceProceduralMemoryIds: [...value.sourceProceduralMemoryIds],
  };
}

function cloneRowEvaluation(value: SkillRecallRowEvaluation): SkillRecallRowEvaluation {
  return {
    ...value,
    reasonCodes: [...value.reasonCodes],
    ...(value.scoreBreakdown === undefined ? {} : { scoreBreakdown: cloneBreakdown(value.scoreBreakdown) }),
    ...(value.advisory === undefined ? {} : { advisory: cloneAdvisory(value.advisory) }),
  };
}

export function evaluateSkillRecallPopulation(
  rows: readonly unknown[],
  input: SkillRecallInput,
  recallMinConfidence: number,
  effectiveLimit: number,
): SkillRecallPopulationEvaluation {
  const contextual = Boolean(input.query || input.files?.length || input.concepts?.length);
  let validCount = 0;
  let malformedCount = 0;
  let privacySuppressedCount = 0;
  const rowEvaluations: SkillRecallRowEvaluation[] = [];
  const matched: Array<{ rowIndex: number; skill: RecallableSkill; advisory: SkillAdvisory; score: number }> = [];

  for (const [rowIndex, row] of rows.entries()) {
    const record = recordValue(row);
    const normalizedSkillId = record ? requiredString(record, "id") ?? undefined : undefined;
    const containsPrivateData = rowContainsPrivateData(row);
    const privacyVisible = containsPrivateData && privateRowIsVisible(row, input, recallMinConfidence);
    const skill = inspectSkillRow(row);
    if (skill) validCount += 1;
    else malformedCount += 1;

    if (privacyVisible) {
      privacySuppressedCount += 1;
      rowEvaluations.push({
        ...(normalizedSkillId === undefined ? {} : { normalizedSkillId }),
        containsPrivateData,
        valid: skill !== null,
        state: "privacy_suppressed",
        reasonCodes: ["privacy_suppressed"],
        selected: false,
      });
      continue;
    }
    if (!skill) {
      rowEvaluations.push({
        ...(normalizedSkillId === undefined ? {} : { normalizedSkillId }),
        containsPrivateData,
        valid: false,
        state: "malformed",
        reasonCodes: ["malformed_skill"],
        selected: false,
      });
      continue;
    }

    const reasons = exclusionReasons(skill, input, recallMinConfidence);
    if (reasons.length > 0) {
      rowEvaluations.push({ normalizedSkillId: skill.id, containsPrivateData, valid: true, state: "excluded", reasonCodes: reasons, selected: false });
      continue;
    }

    const { breakdown, applicable } = scoreSkill(skill, input);
    if (contextual && !applicable) {
      rowEvaluations.push({
        normalizedSkillId: skill.id,
        containsPrivateData,
        valid: true,
        state: "excluded",
        reasonCodes: ["no_context_match"],
        scoreBreakdown: breakdown,
        selected: false,
      });
      continue;
    }

    const advisory = toAdvisory(skill, breakdown.totalScore);
    const evaluation: SkillRecallRowEvaluation = {
      normalizedSkillId: skill.id,
      containsPrivateData,
      valid: true,
      state: "matched",
      reasonCodes: [],
      scoreBreakdown: breakdown,
      advisory,
      selected: false,
    };
    rowEvaluations.push(evaluation);
    if (!containsPrivateData) matched.push({ rowIndex, skill, advisory, score: breakdown.totalScore });
  }

  matched.sort((a, b) =>
    b.score - a.score ||
    b.skill.confidence - a.skill.confidence ||
    b.skill.strength - a.skill.strength ||
    Date.parse(b.skill.updatedAt) - Date.parse(a.skill.updatedAt) ||
    a.skill.id.localeCompare(b.skill.id),
  );
  for (const [index, entry] of matched.entries()) {
    const evaluation = rowEvaluations[entry.rowIndex];
    evaluation.rank = index + 1;
    evaluation.selected = index < effectiveLimit;
  }
  const advisories = matched.slice(0, effectiveLimit).map((entry) => cloneAdvisory(entry.advisory));
  return {
    scannedCount: rows.length,
    validCount,
    malformedCount,
    privacySuppressedCount,
    matchedCount: matched.length,
    returnedCount: advisories.length,
    truncated: matched.length > advisories.length,
    advisories,
    rowEvaluations: rowEvaluations.map(cloneRowEvaluation),
  };
}

export type {
  SkillAdvisory,
  SkillRecallInput,
  SkillRecallInputParseResult,
};
