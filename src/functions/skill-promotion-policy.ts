import { stripPrivateData } from "./privacy.js";
import type { AgentSkill, SkillConfig, ProceduralMemory } from "../types.js";

export type SkillPromotionReasonCode =
  | "promotion_disabled"
  | "missing_name"
  | "missing_trigger_condition"
  | "missing_expected_outcome"
  | "insufficient_steps"
  | "secret_heavy"
  | "insufficient_strength"
  | "insufficient_evidence"
  | "already_promoted";

export interface SkillPromotionEligibility {
  eligible: boolean;
  policyEligible: boolean;
  currentlyPromotable: boolean;
  alreadyPromoted: boolean;
  promotionEnabled: boolean;
  reasonCodes: SkillPromotionReasonCode[];
  policyReasonCodes: Exclude<SkillPromotionReasonCode, "promotion_disabled" | "already_promoted">[];
  reasons: string[];
  evidenceCount: number;
  requiredEvidence: number;
  strength: number;
  requiredStrength: number;
  hasName: boolean;
  hasTriggerCondition: boolean;
  stepCount: number;
  hasExpectedOutcome: boolean;
  secretHeavy: boolean;
  name?: string;
  triggerCondition?: string;
  expectedOutcome?: string;
  steps: string[];
  sourceSessionIds: string[];
  sourceObservationIds: string[];
  sourceCandidateIds: string[];
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(nonEmptyString).filter((item): item is string => item !== undefined))];
}

function clampStrength(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function reasonFor(code: SkillPromotionReasonCode): string {
  switch (code) {
    case "promotion_disabled":
      return "skill promotion is disabled";
    case "missing_name":
      return "procedural memory is missing a name";
    case "missing_trigger_condition":
      return "procedural memory is missing a trigger condition";
    case "missing_expected_outcome":
      return "procedural memory is missing an expected outcome";
    case "insufficient_steps":
      return "procedural memory requires at least two meaningful steps";
    case "secret_heavy":
      return "procedural memory contains secret-heavy content";
    case "insufficient_strength":
      return "procedural memory strength is below the promotion threshold";
    case "insufficient_evidence":
      return "procedural memory has insufficient independent evidence";
    case "already_promoted":
      return "an active skill already exists for this procedural memory";
  }
}

export function isSkillPromotionReasonCode(value: unknown): value is SkillPromotionReasonCode {
  return typeof value === "string" && [
    "promotion_disabled",
    "missing_name",
    "missing_trigger_condition",
    "missing_expected_outcome",
    "insufficient_steps",
    "secret_heavy",
    "insufficient_strength",
    "insufficient_evidence",
    "already_promoted",
  ].includes(value);
}

export function matchesActiveSkillForProceduralMemory(
  skill: AgentSkill,
  proceduralMemoryId: string,
): boolean {
  return skill.status === "active" &&
    skill.sourceProceduralMemoryIds.includes(proceduralMemoryId);
}

export function evaluateSkillPromotionEligibility(
  procedure: ProceduralMemory,
  config: SkillConfig,
  existingSkillId?: string,
): SkillPromotionEligibility {
  const name = nonEmptyString(procedure.name);
  const triggerCondition = nonEmptyString(procedure.triggerCondition);
  const expectedOutcome = nonEmptyString(procedure.expectedOutcome);
  const steps = uniqueStrings(procedure.steps);
  const sourceSessionIds = uniqueStrings(procedure.sourceSessionIds);
  const sourceObservationIds = uniqueStrings(procedure.sourceObservationIds);
  const sourceCandidateIds: string[] = [];
  const evidenceCount = sourceSessionIds.length > 0
    ? sourceSessionIds.length
    : Math.max(sourceObservationIds.length, sourceCandidateIds.length);
  const strength = clampStrength(procedure.strength);
  const privacyPayload = [name, triggerCondition, expectedOutcome, ...steps]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  const secretHeavy = privacyPayload.length > 0 &&
    stripPrivateData(privacyPayload) !== privacyPayload;
  const policyReasonCodes: SkillPromotionEligibility["policyReasonCodes"] = [];
  if (!name) policyReasonCodes.push("missing_name");
  if (!triggerCondition) policyReasonCodes.push("missing_trigger_condition");
  if (!expectedOutcome) policyReasonCodes.push("missing_expected_outcome");
  if (steps.length < 2) policyReasonCodes.push("insufficient_steps");
  if (secretHeavy) policyReasonCodes.push("secret_heavy");
  if (strength < config.promotionMinStrength) policyReasonCodes.push("insufficient_strength");
  if (evidenceCount < config.promotionMinEvidence) policyReasonCodes.push("insufficient_evidence");

  const policyEligible = policyReasonCodes.length === 0;
  const alreadyPromoted = existingSkillId !== undefined;
  const currentlyPromotable = config.promotionEnabled && policyEligible && !alreadyPromoted;
  const reasonCodes: SkillPromotionReasonCode[] = !config.promotionEnabled
    ? ["promotion_disabled"]
    : policyEligible && alreadyPromoted
      ? ["already_promoted"]
      : [...policyReasonCodes];

  return {
    eligible: currentlyPromotable,
    policyEligible,
    currentlyPromotable,
    alreadyPromoted,
    promotionEnabled: config.promotionEnabled,
    reasonCodes,
    policyReasonCodes,
    reasons: reasonCodes.map(reasonFor),
    evidenceCount,
    requiredEvidence: config.promotionMinEvidence,
    strength,
    requiredStrength: config.promotionMinStrength,
    hasName: name !== undefined,
    hasTriggerCondition: triggerCondition !== undefined,
    stepCount: steps.length,
    hasExpectedOutcome: expectedOutcome !== undefined,
    secretHeavy,
    name,
    triggerCondition,
    expectedOutcome,
    steps,
    sourceSessionIds,
    sourceObservationIds,
    sourceCandidateIds,
  };
}

export function promotionResultReason(
  eligibility: SkillPromotionEligibility,
): string | undefined {
  if (eligibility.eligible) return undefined;
  if (eligibility.reasonCodes.some((code) =>
    code === "missing_name" ||
    code === "missing_trigger_condition" ||
    code === "missing_expected_outcome"
  )) {
    return "procedural memory is missing required skill details";
  }
  return eligibility.reasons[0];
}
