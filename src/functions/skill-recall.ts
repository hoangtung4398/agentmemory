import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";

export const SKILL_RECALL_MAX_QUERY_LENGTH = 1_000;
const MAX_CONTEXT_VALUES = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

export interface SkillRecallInput {
  project?: string;
  agentId?: string;
  query?: string;
  files?: string[];
  concepts?: string[];
  limit?: number;
}

export interface SkillAdvisory {
  source: "skill-advisory";
  skillId: string;
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
  score: number;
  sourceProceduralMemoryIds: string[];
}

export interface SkillRecallResult {
  success: boolean;
  enabled: boolean;
  scannedCount: number;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  privacySuppressedCount: number;
  advisories: SkillAdvisory[];
}

export type SkillRecallInputParseResult =
  | { success: true; input: SkillRecallInput }
  | { success: false; error: string };

function nonEmptyString(value: unknown, field: string): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (field === "query" && normalized.length > SKILL_RECALL_MAX_QUERY_LENGTH) {
    return null;
  }
  return normalized;
}

function normalizedStrings(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
    .slice(0, MAX_CONTEXT_VALUES);
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
  if (files === null || concepts === null) {
    return { success: false, error: "files and concepts must be arrays of strings" };
  }
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
  if (Array.isArray(record.steps)) {
    text.push(...record.steps.filter((entry): entry is string => typeof entry === "string"));
  }
  if (typeof record.expectedOutcome === "string") text.push(record.expectedOutcome);
  if (Array.isArray(record.antiPatterns)) {
    text.push(...record.antiPatterns.filter((entry): entry is string => typeof entry === "string"));
  }
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

function requiredStringArray(
  record: Record<string, unknown>,
  field: string,
  requireValue = false,
): string[] | null {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  return requireValue && normalized.length === 0 ? null : normalized;
}

function optionalScope(record: Record<string, unknown>, field: string): string | undefined | null {
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
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
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    typeof strength !== "number" || !Number.isFinite(strength) ||
    (status !== "active" && status !== "retired" && status !== "superseded") ||
    !Number.isFinite(updatedAtMs)
  ) {
    return null;
  }
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

function scopeMatches(skill: RecallableSkill, input: SkillRecallInput): boolean {
  return (!skill.project || skill.project === input.project) &&
    (!skill.agentId || skill.agentId === input.agentId);
}

function scoreSkill(skill: RecallableSkill, input: SkillRecallInput): { score: number; applicable: boolean } {
  let score = 0;
  let applicable = false;
  if (skill.project && skill.project === input.project) score += 6;
  if (skill.agentId && skill.agentId === input.agentId) score += 8;

  const conceptMatches = Math.min(3, includesExact(skill.concepts, input.concepts ?? []));
  const fileMatches = Math.min(3, includesExact(skill.files, input.files ?? []));
  const targetTokens = new Set(queryTokens([
    skill.name,
    skill.triggerCondition,
    skill.expectedOutcome,
  ].join(" ")));
  const queryMatches = Math.min(8, queryTokens(input.query).filter((token) => targetTokens.has(token)).length);
  score += conceptMatches * 3 + fileMatches * 2 + queryMatches;
  applicable = conceptMatches > 0 || fileMatches > 0 || queryMatches > 0;
  return { score, applicable };
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

export function registerSkillRecallFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-recall",
    async (data: unknown): Promise<SkillRecallResult | { success: false; error: string }> => {
      const config = loadSkillConfig();
      if (!config.recallEnabled) {
        return { success: false, error: "Agent skill recall not enabled" };
      }
      const normalized = normalizeSkillRecallInput(data);
      if (!normalized.success) return normalized;
      const input = normalized.input;
      const limit = input.limit ?? config.recallLimit;
      const contextual = Boolean(input.query || input.files?.length || input.concepts?.length);
      const rows = await kv.list<unknown>(KV.skills);
      let privacySuppressedCount = 0;
      const skills = rows.flatMap((row) => {
        if (rowContainsPrivateData(row)) {
          privacySuppressedCount += 1;
          return [];
        }
        const skill = inspectSkillRow(row);
        return skill ? [skill] : [];
      });
      const matched = skills
        .filter((skill) => skill.status === "active" && skill.confidence >= config.recallMinConfidence)
        .filter((skill) => scopeMatches(skill, input))
        .flatMap((skill) => {
          const { score, applicable } = scoreSkill(skill, input);
          if (contextual && !applicable) return [];
          return [{ skill, score }];
        })
        .sort((a, b) =>
          b.score - a.score ||
          b.skill.confidence - a.skill.confidence ||
          b.skill.strength - a.skill.strength ||
          Date.parse(b.skill.updatedAt) - Date.parse(a.skill.updatedAt) ||
          a.skill.id.localeCompare(b.skill.id),
        );
      const advisories = matched.slice(0, limit).map(({ skill, score }) => toAdvisory(skill, score));
      return {
        success: true,
        enabled: true,
        scannedCount: rows.length,
        matchedCount: matched.length,
        returnedCount: advisories.length,
        truncated: matched.length > advisories.length,
        privacySuppressedCount,
        advisories,
      };
    },
  );
}
