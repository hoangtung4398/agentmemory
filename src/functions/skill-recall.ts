import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { AgentSkill } from "../types.js";
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

function hasPrivateData(skill: AgentSkill): boolean {
  const text = [
    skill.name,
    skill.triggerCondition,
    skill.expectedOutcome,
    ...skill.steps,
    ...skill.antiPatterns,
  ];
  return text.some((value) =>
    typeof value !== "string" ||
    stripPrivateData(value) !== value ||
    /<private\b/i.test(value)
  );
}

function scopeMatches(skill: AgentSkill, input: SkillRecallInput): boolean {
  return (!skill.project || skill.project === input.project) &&
    (!skill.agentId || skill.agentId === input.agentId);
}

function scoreSkill(skill: AgentSkill, input: SkillRecallInput): { score: number; applicable: boolean } {
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

function toAdvisory(skill: AgentSkill, score: number): SkillAdvisory {
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
      const skills = await kv.list<AgentSkill>(KV.skills);
      let privacySuppressedCount = 0;
      const matched = skills
        .filter((skill) => skill.status === "active" && skill.confidence >= config.recallMinConfidence)
        .filter((skill) => scopeMatches(skill, input))
        .flatMap((skill) => {
          const { score, applicable } = scoreSkill(skill, input);
          if (contextual && !applicable) return [];
          if (hasPrivateData(skill)) {
            privacySuppressedCount += 1;
            return [];
          }
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
        scannedCount: skills.length,
        matchedCount: matched.length,
        returnedCount: advisories.length,
        truncated: matched.length > advisories.length,
        privacySuppressedCount,
        advisories,
      };
    },
  );
}
