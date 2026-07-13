import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { safeAudit } from "./audit.js";
import { stripPrivateData } from "./privacy.js";
import { fingerprintId, KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import type { AgentSkill, ProceduralMemory } from "../types.js";

type SkillPromotionResult = {
  success: boolean;
  promoted: boolean;
  skill?: AgentSkill;
  existingSkillId?: string;
  reason?: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nonEmptyString).filter((item): item is string => item !== undefined))];
}

function normalizedSteps(steps: unknown): string[] {
  return uniqueStrings(steps);
}

function clampStrength(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function skillIdentity(procedure: ProceduralMemory): string {
  return fingerprintId("skill", procedure.id);
}

function hasSecretHeavyContent(values: string[]): boolean {
  const source = values.join("\n");
  return stripPrivateData(source) !== source;
}

function evidence(procedure: ProceduralMemory): {
  sourceSessionIds: string[];
  sourceObservationIds: string[];
  sourceCandidateIds: string[];
  count: number;
} {
  const sourceSessionIds = uniqueStrings(procedure.sourceSessionIds);
  const sourceObservationIds = uniqueStrings(procedure.sourceObservationIds);
  const sourceCandidateIds: string[] = [];
  return {
    sourceSessionIds,
    sourceObservationIds,
    sourceCandidateIds,
    count: sourceSessionIds.length > 0
      ? sourceSessionIds.length
      : Math.max(sourceObservationIds.length, sourceCandidateIds.length),
  };
}

function matchesExistingSkill(
  skill: AgentSkill,
  proceduralMemoryId: string,
): boolean {
  return skill.status === "active" &&
    skill.sourceProceduralMemoryIds.includes(proceduralMemoryId);
}

export function registerSkillPromotionFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-promote",
    async (data: { proceduralMemoryId?: unknown } | undefined): Promise<SkillPromotionResult> => {
      const proceduralMemoryId = nonEmptyString(data?.proceduralMemoryId);
      if (!proceduralMemoryId) {
        return { success: false, promoted: false, reason: "proceduralMemoryId is required" };
      }

      const config = loadSkillConfig();
      if (!config.promotionEnabled) {
        return { success: true, promoted: false, reason: "skill promotion is disabled" };
      }

      let procedure: ProceduralMemory | null;
      try {
        procedure = await kv.get<ProceduralMemory>(KV.procedural, proceduralMemoryId);
      } catch {
        return { success: false, promoted: false, reason: "failed to load procedural memory" };
      }
      if (!procedure) {
        return { success: false, promoted: false, reason: "procedural memory not found" };
      }
      const name = nonEmptyString(procedure.name);
      const triggerCondition = nonEmptyString(procedure.triggerCondition);
      const expectedOutcome = nonEmptyString(procedure.expectedOutcome);
      const steps = normalizedSteps(procedure.steps);
      if (!name || !triggerCondition || !expectedOutcome) {
        return { success: true, promoted: false, reason: "procedural memory is missing required skill details" };
      }
      if (steps.length < 2) {
        return { success: true, promoted: false, reason: "procedural memory requires at least two meaningful steps" };
      }
      if (hasSecretHeavyContent([name, triggerCondition, expectedOutcome, ...steps])) {
        return { success: true, promoted: false, reason: "procedural memory contains secret-heavy content" };
      }

      const strength = clampStrength(procedure.strength);
      if (strength < config.promotionMinStrength) {
        return { success: true, promoted: false, reason: "procedural memory strength is below the promotion threshold" };
      }
      const provenance = evidence(procedure);
      if (provenance.count < config.promotionMinEvidence) {
        return { success: true, promoted: false, reason: "procedural memory has insufficient independent evidence" };
      }

      return withKeyedLock(`skill-promote:${procedure.id}`, async () => {
        let existing: AgentSkill | undefined;
        try {
          existing = (await kv.list<AgentSkill>(KV.skills)).find((skill) =>
            matchesExistingSkill(skill, procedure.id),
          );
        } catch {
          return { success: false, promoted: false, reason: "failed to inspect existing skills" };
        }
        if (existing) {
          return {
            success: true,
            promoted: false,
            existingSkillId: existing.id,
            reason: "an active skill already exists for this procedural memory",
          };
        }

        const now = new Date().toISOString();
        const skill: AgentSkill = {
          id: skillIdentity(procedure),
          name,
          triggerCondition,
          steps,
          expectedOutcome,
          antiPatterns: [],
          files: [],
          concepts: uniqueStrings(procedure.concepts ?? procedure.tags),
          confidence: Math.min(
            strength,
            0.5 + Math.min(0.4, Math.max(0, provenance.count - 2) * 0.1),
          ),
          strength,
          usageCount: 0,
          successCount: 0,
          failureCount: 0,
          sourceProceduralMemoryIds: [procedure.id],
          sourceCandidateIds: provenance.sourceCandidateIds,
          sourceObservationIds: provenance.sourceObservationIds,
          sourceSessionIds: provenance.sourceSessionIds,
          createdAt: now,
          updatedAt: now,
          status: "active",
          version: 1,
        };

        try {
          await kv.set(KV.skills, skill.id, skill);
        } catch {
          return { success: false, promoted: false, reason: "failed to write agent skill" };
        }
        await safeAudit(kv, "skill_promote", "mem::skill-promote", [procedure.id, skill.id], {
          evidenceCount: provenance.count,
          sourceProceduralMemoryId: procedure.id,
        });
        return { success: true, promoted: true, skill };
      });
    },
  );
}
