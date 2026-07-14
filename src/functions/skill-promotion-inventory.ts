import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { AgentSkill, ProceduralMemory } from "../types.js";
import {
  evaluateSkillPromotionEligibility,
  isSkillPromotionReasonCode,
  matchesActiveSkillForProceduralMemory,
  nonEmptyString,
  type SkillPromotionReasonCode,
} from "./skill-promotion-policy.js";

export interface SkillPromotionInventoryInput {
  policyEligible?: boolean;
  currentlyPromotable?: boolean;
  alreadyPromoted?: boolean;
  promotionStateResolved?: boolean;
  reasonCode?: SkillPromotionReasonCode;
  scanLimit?: number;
  limit?: number;
}

export interface SkillPromotionInventoryItem {
  proceduralMemoryId: string;
  name?: string;
  strength: number;
  evidenceCount: number;
  requiredStrength: number;
  requiredEvidence: number;
  policyEligible: boolean;
  currentlyPromotable: boolean;
  currentlyPromotableResolved: boolean;
  alreadyPromoted: boolean;
  promotionStateResolved: boolean;
  existingSkillId?: string;
  reasonCodes: SkillPromotionReasonCode[];
}

export interface SkillPromotionInventoryResult {
  success: boolean;
  error?: string;
  scannedCount: number;
  matchedCount: number;
  returnedCount: number;
  scanTruncated: boolean;
  resultTruncated: boolean;
  skillScannedCount: number;
  promotionStateComplete: boolean;
  unresolvedPromotionStateCount: number;
  skillScanTruncated: boolean;
  truncated: boolean;
  promotionEnabled: boolean;
  summary: {
    policyEligibleCount: number;
    currentlyPromotableCount: number;
    alreadyPromotedCount: number;
    blockedCount: number;
    reasonCounts: Partial<Record<SkillPromotionReasonCode, number>>;
  };
  items: SkillPromotionInventoryItem[];
}

const DEFAULT_SCAN_LIMIT = 500;
const MAX_SCAN_LIMIT = 5000;
const MAX_SKILL_LINEAGE_SCAN = 5000;

function parseClampedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

export function parseSkillPromotionInventoryBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export function isSkillPromotionInventoryBoolean(value: unknown): boolean {
  return value === undefined || value === null || value === "" ||
    parseSkillPromotionInventoryBoolean(value) !== undefined;
}

export function isSkillPromotionInventoryLimit(value: unknown): boolean {
  return value === undefined || value === null || value === "" ||
    (typeof value !== "boolean" && Number.isFinite(Number(value)));
}

function emptyResult(promotionEnabled: boolean, error?: string): SkillPromotionInventoryResult {
  return {
    success: error === undefined,
    error,
    scannedCount: 0,
    matchedCount: 0,
    returnedCount: 0,
    scanTruncated: false,
    resultTruncated: false,
    skillScannedCount: 0,
    promotionStateComplete: error === undefined,
    unresolvedPromotionStateCount: 0,
    skillScanTruncated: false,
    truncated: false,
    promotionEnabled,
    summary: {
      policyEligibleCount: 0,
      currentlyPromotableCount: 0,
      alreadyPromotedCount: 0,
      blockedCount: 0,
      reasonCounts: {},
    },
    items: [],
  };
}

function compareProcedures(a: ProceduralMemory, b: ProceduralMemory): number {
  const aCreatedAt = Date.parse(a.createdAt);
  const bCreatedAt = Date.parse(b.createdAt);
  const byCreatedAt = (Number.isFinite(bCreatedAt) ? bCreatedAt : 0) -
    (Number.isFinite(aCreatedAt) ? aCreatedAt : 0);
  return byCreatedAt || a.id.localeCompare(b.id);
}

function compareSkills(a: AgentSkill, b: AgentSkill): number {
  const aCreatedAt = Date.parse(a.createdAt);
  const bCreatedAt = Date.parse(b.createdAt);
  const byCreatedAt = (Number.isFinite(bCreatedAt) ? bCreatedAt : 0) -
    (Number.isFinite(aCreatedAt) ? aCreatedAt : 0);
  return byCreatedAt || a.id.localeCompare(b.id);
}

function resolveActiveSourceLineage(
  skills: AgentSkill[],
  proceduralMemoryIds: Set<string>,
): {
  existingSkills: Map<string, string>;
  skillScannedCount: number;
  skillPopulationExhausted: boolean;
} {
  const existingSkills = new Map<string, string>();
  const orderedSkills = [...skills].sort(compareSkills);
  let skillScannedCount = 0;

  for (const skill of orderedSkills) {
    if (skillScannedCount >= MAX_SKILL_LINEAGE_SCAN) break;
    skillScannedCount += 1;
    for (const proceduralMemoryId of skill.sourceProceduralMemoryIds) {
      if (proceduralMemoryIds.has(proceduralMemoryId) &&
        matchesActiveSkillForProceduralMemory(skill, proceduralMemoryId) &&
        !existingSkills.has(proceduralMemoryId)) {
        existingSkills.set(proceduralMemoryId, skill.id);
      }
    }
    if (existingSkills.size === proceduralMemoryIds.size) {
      return {
        existingSkills,
        skillScannedCount,
        skillPopulationExhausted: false,
      };
    }
  }

  return {
    existingSkills,
    skillScannedCount,
    skillPopulationExhausted: skillScannedCount === orderedSkills.length,
  };
}

function inventoryReasonCodes(
  policyReasonCodes: SkillPromotionReasonCode[],
  promotionEnabled: boolean,
  alreadyPromoted: boolean,
): SkillPromotionReasonCode[] {
  const reasonCodes = [...policyReasonCodes];
  if (!promotionEnabled) reasonCodes.push("promotion_disabled");
  if (alreadyPromoted) reasonCodes.push("already_promoted");
  return reasonCodes;
}

function matchesFilters(item: SkillPromotionInventoryItem, filters: SkillPromotionInventoryInput): boolean {
  const matchesCurrentlyPromotable = filters.currentlyPromotable === undefined ||
    (filters.currentlyPromotable
      ? item.currentlyPromotable
      : item.currentlyPromotableResolved && !item.currentlyPromotable);
  const matchesAlreadyPromoted = filters.alreadyPromoted === undefined ||
    (filters.alreadyPromoted
      ? item.alreadyPromoted
      : item.promotionStateResolved && !item.alreadyPromoted);
  return (filters.policyEligible === undefined || item.policyEligible === filters.policyEligible) &&
    matchesCurrentlyPromotable &&
    matchesAlreadyPromoted &&
    (filters.promotionStateResolved === undefined ||
      item.promotionStateResolved === filters.promotionStateResolved) &&
    (filters.reasonCode === undefined || item.reasonCodes.includes(filters.reasonCode));
}

function normalizeInput(data: SkillPromotionInventoryInput | undefined, diagnosticsLimit: number) {
  const policyEligible = parseSkillPromotionInventoryBoolean(data?.policyEligible);
  const currentlyPromotable = parseSkillPromotionInventoryBoolean(data?.currentlyPromotable);
  const alreadyPromoted = parseSkillPromotionInventoryBoolean(data?.alreadyPromoted);
  const promotionStateResolved = parseSkillPromotionInventoryBoolean(data?.promotionStateResolved);
  const reasonCode = isSkillPromotionReasonCode(data?.reasonCode) ? data?.reasonCode : undefined;
  const scanLimit = parseClampedLimit(data?.scanLimit, DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
  const limit = Math.min(
    parseClampedLimit(data?.limit, diagnosticsLimit, 500),
    scanLimit,
  );
  return {
    policyEligible,
    currentlyPromotable,
    alreadyPromoted,
    promotionStateResolved,
    reasonCode,
    scanLimit,
    limit,
  };
}

export function registerSkillPromotionInventoryFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-promotion-inventory",
    async (data: SkillPromotionInventoryInput | undefined): Promise<SkillPromotionInventoryResult> => {
      const config = loadSkillConfig();
      const input = normalizeInput(data, config.diagnosticsLimit);
      let allProcedures: ProceduralMemory[];
      try {
        allProcedures = await kv.list<ProceduralMemory>(KV.procedural);
      } catch {
        return emptyResult(config.promotionEnabled, "failed to list procedural memories");
      }

      const procedures = [...allProcedures].sort(compareProcedures).slice(0, input.scanLimit);
      const scanTruncated = allProcedures.length > procedures.length;
      const policy = procedures.map((procedure) => ({
        procedure,
        eligibility: evaluateSkillPromotionEligibility(procedure, config),
      }));
      const proceduralMemoryIds = new Set(policy.map(({ procedure }) => procedure.id));
      let existingSkills = new Map<string, string>();
      let skillScannedCount = 0;
      let skillPopulationExhausted = true;

      if (proceduralMemoryIds.size > 0) {
        let skills: AgentSkill[];
        try {
          skills = await kv.list<AgentSkill>(KV.skills);
        } catch {
          return emptyResult(config.promotionEnabled, "failed to inspect existing skills");
        }
        ({ existingSkills, skillScannedCount, skillPopulationExhausted } =
          resolveActiveSourceLineage(skills, proceduralMemoryIds));
      }

      const items = policy.map(({ procedure }) => {
        const existingSkillId = existingSkills.get(procedure.id);
        const eligibility = evaluateSkillPromotionEligibility(procedure, config, existingSkillId);
        const promotionStateResolved = existingSkillId !== undefined || skillPopulationExhausted;
        const currentlyPromotableResolved = !eligibility.policyEligible ||
          !config.promotionEnabled || promotionStateResolved;
        const currentlyPromotable = promotionStateResolved && eligibility.currentlyPromotable;
        const reasonCodes = inventoryReasonCodes(
          eligibility.policyReasonCodes,
          config.promotionEnabled,
          eligibility.alreadyPromoted,
        );
        return {
          proceduralMemoryId: procedure.id,
          ...(eligibility.secretHeavy ? {} : { name: nonEmptyString(procedure.name) }),
          strength: eligibility.strength,
          evidenceCount: eligibility.evidenceCount,
          requiredStrength: eligibility.requiredStrength,
          requiredEvidence: eligibility.requiredEvidence,
          policyEligible: eligibility.policyEligible,
          currentlyPromotable,
          currentlyPromotableResolved,
          alreadyPromoted: eligibility.alreadyPromoted,
          promotionStateResolved,
          ...(existingSkillId ? { existingSkillId } : {}),
          reasonCodes,
        } satisfies SkillPromotionInventoryItem;
      });

      const reasonCounts: Partial<Record<SkillPromotionReasonCode, number>> = {};
      for (const item of items) {
        for (const reasonCode of item.reasonCodes) {
          reasonCounts[reasonCode] = (reasonCounts[reasonCode] ?? 0) + 1;
        }
      }
      const filtered = items.filter((item) => matchesFilters(item, input));
      const returned = filtered.slice(0, input.limit);
      const resultTruncated = filtered.length > returned.length;
      const unresolvedPromotionStateCount = items.filter((item) =>
        !item.promotionStateResolved,
      ).length;
      const promotionStateComplete = unresolvedPromotionStateCount === 0;
      const skillScanTruncated = !skillPopulationExhausted && !promotionStateComplete;

      return {
        success: true,
        scannedCount: items.length,
        matchedCount: filtered.length,
        returnedCount: returned.length,
        scanTruncated,
        resultTruncated,
        skillScannedCount,
        promotionStateComplete,
        unresolvedPromotionStateCount,
        skillScanTruncated,
        truncated: scanTruncated || resultTruncated || skillScanTruncated,
        promotionEnabled: config.promotionEnabled,
        summary: {
          policyEligibleCount: items.filter((item) => item.policyEligible).length,
          currentlyPromotableCount: items.filter((item) => item.currentlyPromotable).length,
          alreadyPromotedCount: items.filter((item) => item.alreadyPromoted).length,
          blockedCount: items.filter((item) => !item.policyEligible).length,
          reasonCounts,
        },
        items: returned,
      };
    },
  );
}
