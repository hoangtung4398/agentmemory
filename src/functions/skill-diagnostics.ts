import type { AgentSkill } from "../types.js";

export interface AgentSkillFilters {
  status?: string;
  project?: string;
  agentId?: string;
  concept?: string;
  file?: string;
  limit: number;
}

export interface CompactAgentSkill {
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
  usageCount: number;
  successCount: number;
  failureCount: number;
  sourceProceduralMemoryCount: number;
  sourceCandidateCount: number;
  sourceObservationCount: number;
  sourceSessionCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastReinforcedAt?: string;
  status: AgentSkill["status"];
  supersedes?: string;
  version: number;
}

export function nonEmptySkillFilterValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function parseSkillDiagnosticsLimit(
  value: unknown,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

export function filterAgentSkills(
  skills: AgentSkill[],
  filters: AgentSkillFilters,
): AgentSkill[] {
  return [...skills]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((skill) =>
      (filters.status === undefined || skill.status === filters.status) &&
      (filters.project === undefined || skill.project === filters.project) &&
      (filters.agentId === undefined || skill.agentId === filters.agentId) &&
      (filters.concept === undefined || skill.concepts.includes(filters.concept)) &&
      (filters.file === undefined || skill.files.includes(filters.file))
    )
    .slice(0, filters.limit);
}

export function compactAgentSkill(skill: AgentSkill): CompactAgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    triggerCondition: skill.triggerCondition,
    steps: skill.steps,
    expectedOutcome: skill.expectedOutcome,
    antiPatterns: skill.antiPatterns,
    project: skill.project,
    agentId: skill.agentId,
    files: skill.files,
    concepts: skill.concepts,
    confidence: skill.confidence,
    strength: skill.strength,
    usageCount: skill.usageCount,
    successCount: skill.successCount,
    failureCount: skill.failureCount,
    sourceProceduralMemoryCount: skill.sourceProceduralMemoryIds.length,
    sourceCandidateCount: skill.sourceCandidateIds.length,
    sourceObservationCount: skill.sourceObservationIds.length,
    sourceSessionCount: skill.sourceSessionIds.length,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    lastUsedAt: skill.lastUsedAt,
    lastReinforcedAt: skill.lastReinforcedAt,
    status: skill.status,
    supersedes: skill.supersedes,
    version: skill.version,
  };
}
