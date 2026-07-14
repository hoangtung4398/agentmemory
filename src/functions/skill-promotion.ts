import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { safeAudit } from "./audit.js";
import { fingerprintId, KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import type { AgentSkill, ProceduralMemory } from "../types.js";
import {
  evaluateSkillPromotionEligibility,
  nonEmptyString,
  promotionResultReason,
  uniqueStrings,
} from "./skill-promotion-policy.js";

type SkillPromotionResult = {
  success: boolean;
  promoted: boolean;
  skill?: AgentSkill;
  existingSkillId?: string;
  reason?: string;
};

function skillIdentity(procedure: ProceduralMemory): string {
  return fingerprintId("skill", procedure.id);
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
      const eligibility = evaluateSkillPromotionEligibility(procedure, config);
      const policyReason = promotionResultReason(eligibility);
      if (policyReason) return { success: true, promoted: false, reason: policyReason };

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
          name: eligibility.name!,
          triggerCondition: eligibility.triggerCondition!,
          steps: eligibility.steps,
          expectedOutcome: eligibility.expectedOutcome!,
          antiPatterns: [],
          files: [],
          concepts: uniqueStrings(procedure.concepts ?? procedure.tags),
          confidence: Math.min(
            eligibility.strength,
            0.5 + Math.min(0.4, Math.max(0, eligibility.evidenceCount - 2) * 0.1),
          ),
          strength: eligibility.strength,
          usageCount: 0,
          successCount: 0,
          failureCount: 0,
          sourceProceduralMemoryIds: [procedure.id],
          sourceCandidateIds: eligibility.sourceCandidateIds,
          sourceObservationIds: eligibility.sourceObservationIds,
          sourceSessionIds: eligibility.sourceSessionIds,
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
          evidenceCount: eligibility.evidenceCount,
          sourceProceduralMemoryId: procedure.id,
        });
        return { success: true, promoted: true, skill };
      });
    },
  );
}
