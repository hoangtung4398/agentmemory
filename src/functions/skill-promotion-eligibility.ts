import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { AgentSkill, ProceduralMemory } from "../types.js";
import {
  evaluateSkillPromotionEligibility,
  matchesActiveSkillForProceduralMemory,
  nonEmptyString,
  type SkillPromotionEligibility,
} from "./skill-promotion-policy.js";

export interface SkillPromotionEligibilityResult extends Pick<
  SkillPromotionEligibility,
  | "eligible"
  | "policyEligible"
  | "currentlyPromotable"
  | "alreadyPromoted"
  | "promotionEnabled"
  | "reasonCodes"
  | "reasons"
  | "evidenceCount"
  | "requiredEvidence"
  | "strength"
  | "requiredStrength"
  | "hasName"
  | "hasTriggerCondition"
  | "stepCount"
  | "hasExpectedOutcome"
  | "secretHeavy"
> {
  success: boolean;
  found: boolean;
  proceduralMemoryId: string;
  existingSkillId?: string;
}

function toResult(
  eligibility: SkillPromotionEligibility,
  proceduralMemoryId: string,
  existingSkillId?: string,
): SkillPromotionEligibilityResult {
  return {
    success: true,
    found: true,
    proceduralMemoryId,
    eligible: eligibility.eligible,
    policyEligible: eligibility.policyEligible,
    currentlyPromotable: eligibility.currentlyPromotable,
    alreadyPromoted: eligibility.alreadyPromoted,
    promotionEnabled: eligibility.promotionEnabled,
    reasonCodes: eligibility.reasonCodes,
    reasons: eligibility.reasons,
    evidenceCount: eligibility.evidenceCount,
    requiredEvidence: eligibility.requiredEvidence,
    strength: eligibility.strength,
    requiredStrength: eligibility.requiredStrength,
    hasName: eligibility.hasName,
    hasTriggerCondition: eligibility.hasTriggerCondition,
    stepCount: eligibility.stepCount,
    hasExpectedOutcome: eligibility.hasExpectedOutcome,
    secretHeavy: eligibility.secretHeavy,
    existingSkillId,
  };
}

function missingProcedureResult(proceduralMemoryId: string): SkillPromotionEligibilityResult {
  return {
    success: false,
    found: false,
    proceduralMemoryId,
    eligible: false,
    policyEligible: false,
    currentlyPromotable: false,
    alreadyPromoted: false,
    promotionEnabled: loadSkillConfig().promotionEnabled,
    reasonCodes: [],
    reasons: ["procedural memory not found"],
    evidenceCount: 0,
    requiredEvidence: loadSkillConfig().promotionMinEvidence,
    strength: 0,
    requiredStrength: loadSkillConfig().promotionMinStrength,
    hasName: false,
    hasTriggerCondition: false,
    stepCount: 0,
    hasExpectedOutcome: false,
    secretHeavy: false,
  };
}

export function registerSkillPromotionEligibilityFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-promotion-eligibility",
    async (data: { proceduralMemoryId?: unknown } | undefined): Promise<SkillPromotionEligibilityResult> => {
      const proceduralMemoryId = nonEmptyString(data?.proceduralMemoryId);
      if (!proceduralMemoryId) {
        return {
          ...missingProcedureResult(""),
          reasons: ["proceduralMemoryId is required"],
        };
      }

      let procedure: ProceduralMemory | null;
      try {
        procedure = await kv.get<ProceduralMemory>(KV.procedural, proceduralMemoryId);
      } catch {
        return {
          ...missingProcedureResult(proceduralMemoryId),
          reasons: ["failed to load procedural memory"],
        };
      }
      if (!procedure) return missingProcedureResult(proceduralMemoryId);

      const config = loadSkillConfig();
      let eligibility = evaluateSkillPromotionEligibility(procedure, config);
      let existingSkillId: string | undefined;

      if (eligibility.eligible) {
        try {
          existingSkillId = (await kv.list<AgentSkill>(KV.skills)).find((skill) =>
            matchesActiveSkillForProceduralMemory(skill, procedure.id),
          )?.id;
        } catch {
          return {
            ...toResult(eligibility, proceduralMemoryId),
            success: false,
            reasons: ["failed to inspect existing skills"],
          };
        }
        eligibility = evaluateSkillPromotionEligibility(procedure, config, existingSkillId);
      }

      return toResult(eligibility, proceduralMemoryId, existingSkillId);
    },
  );
}
