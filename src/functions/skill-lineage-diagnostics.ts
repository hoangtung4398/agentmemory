import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  AgentSkill,
  AgentSkillStatus,
  SkillLineageDiagnosticsInput,
  SkillLineageDiagnosticsItem,
  SkillLineageDiagnosticsResult,
  SkillLineageDiagnosticsSummary,
  SkillLineageFindingCode,
  SkillLineageRelationState,
  SkillLineageScopeRelation,
} from "../types.js";
import { MAX_SKILL_FEEDBACK_ID_LENGTH, MAX_SKILL_FEEDBACK_SCOPE_LENGTH } from "./skill-feedback-model.js";
import { compareSkillLifecycleIds, isValidLifecycleReviewSkill } from "./skill-lifecycle-review-policy.js";

const MAX_RESULT_LIMIT = 500;
const FINDING_ORDER: SkillLineageFindingCode[] = [
  "malformed_supersedes",
  "self_supersedes",
  "cycle_detected",
  "missing_superseded_skill",
  "multiple_superseders",
];
const RELATION_ORDER: SkillLineageRelationState[] = [
  "root",
  "resolved",
  "missing_target",
  "malformed_reference",
  "self_reference",
  "cycle",
];

interface NormalizedInput {
  project?: string;
  agentId?: string;
  status?: AgentSkillStatus;
  relationState?: SkillLineageRelationState;
  findingCode?: SkillLineageFindingCode;
  scopeRelation?: SkillLineageScopeRelation;
  limit: number;
}

interface Relation {
  skill: AgentSkill;
  supersedes?: string;
  relationState: SkillLineageRelationState;
  scopeRelation: SkillLineageScopeRelation;
  target?: AgentSkill;
  findings: Set<SkillLineageFindingCode>;
}

function emptySummary(): SkillLineageDiagnosticsSummary {
  return {
    statusCounts: { active: 0, retired: 0, superseded: 0 },
    relationStateCounts: {
      root: 0,
      resolved: 0,
      missing_target: 0,
      malformed_reference: 0,
      self_reference: 0,
      cycle: 0,
    },
    findingCounts: {},
    declaredReferenceCount: 0,
    resolvedReferenceCount: 0,
    missingReferenceCount: 0,
    cycleComponentCount: 0,
    cycleSkillCount: 0,
    branchingTargetCount: 0,
  };
}

function emptyResult(success: boolean, enabled: boolean, reason?: string): SkillLineageDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    ...(reason === undefined ? {} : { reason }),
    skillRowCount: 0,
    validSkillCount: 0,
    malformedSkillCount: 0,
    duplicateSkillIds: [],
    matchedCount: 0,
    returnedCount: 0,
    resultTruncated: false,
    truncated: false,
    summary: emptySummary(),
    items: [],
  };
}

function normalizeScope(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SKILL_FEEDBACK_SCOPE_LENGTH ? normalized : null;
}

function isStatus(value: unknown): value is AgentSkillStatus {
  return value === "active" || value === "retired" || value === "superseded";
}

function isRelationState(value: unknown): value is SkillLineageRelationState {
  return RELATION_ORDER.includes(value as SkillLineageRelationState);
}

function isFindingCode(value: unknown): value is SkillLineageFindingCode {
  return FINDING_ORDER.includes(value as SkillLineageFindingCode);
}

function isScopeRelation(value: unknown): value is SkillLineageScopeRelation {
  return value === "not_applicable" || value === "same" || value === "different";
}

function optionalEnum<T>(value: unknown, valid: (candidate: unknown) => candidate is T): T | undefined | null {
  if (value === undefined) return undefined;
  return valid(value) ? value : null;
}

function optionalLimit(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) &&
    value >= 1 && value <= MAX_RESULT_LIMIT ? value : null;
}

function normalizeInput(input: SkillLineageDiagnosticsInput | undefined, diagnosticsLimit: number): NormalizedInput | undefined {
  const project = normalizeScope(input?.project);
  const agentId = normalizeScope(input?.agentId);
  const status = optionalEnum(input?.status, isStatus);
  const relationState = optionalEnum(input?.relationState, isRelationState);
  const findingCode = optionalEnum(input?.findingCode, isFindingCode);
  const scopeRelation = optionalEnum(input?.scopeRelation, isScopeRelation);
  const limit = optionalLimit(input?.limit, diagnosticsLimit);
  if (project === null || agentId === null || status === null || relationState === null ||
    findingCode === null || scopeRelation === null || limit === null) return undefined;
  return {
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(status === undefined ? {} : { status }),
    ...(relationState === undefined ? {} : { relationState }),
    ...(findingCode === undefined ? {} : { findingCode }),
    ...(scopeRelation === undefined ? {} : { scopeRelation }),
    limit,
  };
}

function isValidReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_SKILL_FEEDBACK_ID_LENGTH;
}

function findDuplicates(skills: readonly AgentSkill[]): string[] {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) duplicateIds.add(skill.id);
    else seen.add(skill.id);
  }
  return [...duplicateIds].sort(compareSkillLifecycleIds);
}

function findingCodes(findings: ReadonlySet<SkillLineageFindingCode>): SkillLineageFindingCode[] {
  return FINDING_ORDER.filter((code) => findings.has(code));
}

function isSameScope(skill: AgentSkill, target: AgentSkill): boolean {
  return skill.project === target.project && skill.agentId === target.agentId;
}

function detectCycles(edges: ReadonlyMap<string, string>): Map<string, string[]> {
  const cycles = new Map<string, string[]>();
  const visited = new Set<string>();
  const ids = [...edges.keys()].sort(compareSkillLifecycleIds);
  for (const start of ids) {
    if (visited.has(start)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !visited.has(current) && !pathIndex.has(current)) {
      pathIndex.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    if (current !== undefined) {
      const cycleStart = pathIndex.get(current);
      if (cycleStart !== undefined) {
        const members = path.slice(cycleStart).sort(compareSkillLifecycleIds);
        for (const member of members) cycles.set(member, members);
      }
    }
    for (const id of path) visited.add(id);
  }
  return cycles;
}

function compareItems(left: SkillLineageDiagnosticsItem, right: SkillLineageDiagnosticsItem): number {
  const leftFinding = left.findingCodes[0];
  const rightFinding = right.findingCodes[0];
  if (leftFinding !== undefined || rightFinding !== undefined) {
    if (leftFinding === undefined) return 1;
    if (rightFinding === undefined) return -1;
    const findingOrder = FINDING_ORDER.indexOf(leftFinding) - FINDING_ORDER.indexOf(rightFinding);
    if (findingOrder !== 0) return findingOrder;
  } else {
    const relationOrder = (left.relationState === "resolved" ? 0 : 1) -
      (right.relationState === "resolved" ? 0 : 1);
    if (relationOrder !== 0) return relationOrder;
  }
  const byId = compareSkillLifecycleIds(left.skillId, right.skillId);
  return byId !== 0 ? byId : right.skillVersion - left.skillVersion;
}

function matchesFilters(item: SkillLineageDiagnosticsItem, input: NormalizedInput): boolean {
  return (input.project === undefined || item.project === input.project) &&
    (input.agentId === undefined || item.agentId === input.agentId) &&
    (input.status === undefined || item.currentStatus === input.status) &&
    (input.relationState === undefined || item.relationState === input.relationState) &&
    (input.findingCode === undefined || item.findingCodes.includes(input.findingCode)) &&
    (input.scopeRelation === undefined || item.scopeRelation === input.scopeRelation);
}

function cloneItem(item: SkillLineageDiagnosticsItem): SkillLineageDiagnosticsItem {
  return {
    ...item,
    incomingSupersederIds: [...item.incomingSupersederIds],
    cycleMemberIds: [...item.cycleMemberIds],
    findingCodes: [...item.findingCodes],
  };
}

export function registerSkillLineageDiagnosticsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-lineage-diagnostics",
    async (data: SkillLineageDiagnosticsInput | undefined): Promise<SkillLineageDiagnosticsResult> => {
      const config = loadSkillConfig();
      if (!config.diagnosticsEnabled) {
        return emptyResult(true, false, "skill lineage diagnostics is disabled");
      }

      const input = normalizeInput(data, config.diagnosticsLimit);
      if (!input) return emptyResult(false, true, "invalid skill lineage diagnostics input");

      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skills);
      } catch {
        return emptyResult(false, true, "failed to load skill lineage diagnostics");
      }

      const skills = rows.filter((row): row is AgentSkill => isValidLifecycleReviewSkill(row));
      const counts = {
        skillRowCount: rows.length,
        validSkillCount: skills.length,
        malformedSkillCount: rows.length - skills.length,
      };
      const duplicateSkillIds = findDuplicates(skills);
      if (duplicateSkillIds.length > 0) {
        return { ...emptyResult(false, true, "duplicate skill id"), ...counts, duplicateSkillIds };
      }

      const byId = new Map(skills.map((skill) => [skill.id, skill]));
      const relations = new Map<string, Relation>();
      const edges = new Map<string, string>();
      const incoming = new Map<string, string[]>();
      let declaredReferenceCount = 0;
      let resolvedReferenceCount = 0;
      let missingReferenceCount = 0;

      for (const skill of skills) {
        const rawReference = (skill as unknown as Record<string, unknown>).supersedes;
        if (rawReference === undefined) {
          relations.set(skill.id, {
            skill,
            relationState: "root",
            scopeRelation: "not_applicable",
            findings: new Set(),
          });
          continue;
        }
        if (!isValidReference(rawReference)) {
          relations.set(skill.id, {
            skill,
            relationState: "malformed_reference",
            scopeRelation: "not_applicable",
            findings: new Set(["malformed_supersedes"]),
          });
          continue;
        }
        if (rawReference === skill.id) {
          relations.set(skill.id, {
            skill,
            relationState: "self_reference",
            scopeRelation: "not_applicable",
            findings: new Set(["self_supersedes"]),
          });
          continue;
        }
        declaredReferenceCount += 1;
        const target = byId.get(rawReference);
        if (target === undefined) {
          missingReferenceCount += 1;
          relations.set(skill.id, {
            skill,
            supersedes: rawReference,
            relationState: "missing_target",
            scopeRelation: "not_applicable",
            findings: new Set(["missing_superseded_skill"]),
          });
          continue;
        }
        resolvedReferenceCount += 1;
        edges.set(skill.id, target.id);
        const sources = incoming.get(target.id) ?? [];
        sources.push(skill.id);
        incoming.set(target.id, sources);
        relations.set(skill.id, {
          skill,
          supersedes: rawReference,
          relationState: "resolved",
          scopeRelation: isSameScope(skill, target) ? "same" : "different",
          target,
          findings: new Set(),
        });
      }

      const cycles = detectCycles(edges);
      const components = new Set<string[]>(cycles.values());
      for (const id of cycles.keys()) {
        const relation = relations.get(id)!;
        relation.relationState = "cycle";
        relation.findings.add("cycle_detected");
      }
      for (const [targetId, sourceIds] of incoming) {
        sourceIds.sort(compareSkillLifecycleIds);
        if (sourceIds.length > 1) relations.get(targetId)!.findings.add("multiple_superseders");
      }

      const summary = emptySummary();
      summary.declaredReferenceCount = declaredReferenceCount;
      summary.resolvedReferenceCount = resolvedReferenceCount;
      summary.missingReferenceCount = missingReferenceCount;
      summary.cycleComponentCount = components.size;
      summary.cycleSkillCount = cycles.size;
      summary.branchingTargetCount = [...incoming.values()].filter((ids) => ids.length > 1).length;

      const allItems = skills.map((skill): SkillLineageDiagnosticsItem => {
        const relation = relations.get(skill.id)!;
        const codes = findingCodes(relation.findings);
        const cycleMembers = cycles.get(skill.id) ?? [];
        const item: SkillLineageDiagnosticsItem = {
          skillId: skill.id,
          skillVersion: skill.version,
          currentStatus: skill.status,
          ...(skill.project === undefined ? {} : { project: skill.project }),
          ...(skill.agentId === undefined ? {} : { agentId: skill.agentId }),
          ...(relation.supersedes === undefined ? {} : { supersedes: relation.supersedes }),
          relationState: relation.relationState,
          scopeRelation: relation.scopeRelation,
          ...(relation.target === undefined ? {} : { targetStatus: relation.target.status }),
          incomingSupersederIds: [...(incoming.get(skill.id) ?? [])],
          cycleMemberIds: [...cycleMembers],
          findingCodes: codes,
        };
        summary.statusCounts[item.currentStatus] += 1;
        summary.relationStateCounts[item.relationState] += 1;
        for (const code of codes) summary.findingCounts[code] = (summary.findingCounts[code] ?? 0) + 1;
        return item;
      });

      const matched = allItems.filter((item) => matchesFilters(item, input)).sort(compareItems);
      const items = matched.slice(0, input.limit).map(cloneItem);
      const resultTruncated = matched.length > items.length;
      return {
        success: true,
        enabled: true,
        applied: false,
        ...counts,
        duplicateSkillIds: [],
        matchedCount: matched.length,
        returnedCount: items.length,
        resultTruncated,
        truncated: resultTruncated,
        summary,
        items,
      };
    },
  );
}
