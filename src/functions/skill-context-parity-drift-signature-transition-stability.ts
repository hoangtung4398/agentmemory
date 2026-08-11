import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityDriftSignatureTransitionClass,
  SkillContextParityDriftSignatureTransitionStabilityDiagnosticsInput,
  SkillContextParityDriftSignatureTransitionStabilityDiagnosticsReasonCode,
  SkillContextParityDriftSignatureTransitionStabilityDiagnosticsResult,
  SkillContextParityDriftSignatureTransitionStabilityEvaluation,
  SkillRecallInput,
} from "../types.js";
import { normalizeSkillRecallInput } from "./skill-recall-policy.js";

type RequestInput = {
  project: string;
  agentId?: string;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
};

type ParsedSample = { transitionClass: SkillContextParityDriftSignatureTransitionClass } | { unavailable: true };

const transitionClasses = new Set<SkillContextParityDriftSignatureTransitionClass>([
  "same_signature",
  "stable_mismatch_variant_changed",
  "observed_drift_variant_changed",
  "stable_consistent_to_stable_mismatch",
  "stable_consistent_to_observed_drift",
  "stable_mismatch_to_stable_consistent",
  "stable_mismatch_to_observed_drift",
  "observed_drift_to_stable_consistent",
  "observed_drift_to_stable_mismatch",
]);

const failedSamples: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean]> = {
  invalid_input: [false, false, false, false, false, false],
  first_signature_trigger_failure: [true, false, false, false, false, false],
  invalid_first_signature_result: [true, true, false, false, false, false],
  first_signature_classification_unavailable: [true, true, true, false, false, false],
  second_signature_trigger_failure: [true, true, true, true, false, false],
  invalid_second_signature_result: [true, true, true, true, true, false],
  second_signature_classification_unavailable: [true, true, true, true, true, true],
};

function exact(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function buildSkillContextParityDriftSignatureTransitionStabilityRequest(input: RequestInput): {
  function_id: "mem::skill-context-parity-drift-signature-transition-diagnostics";
  payload: RequestInput;
} {
  return {
    function_id: "mem::skill-context-parity-drift-signature-transition-diagnostics",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    },
  };
}

export function evaluateSkillContextParityDriftSignatureTransitionStability(input: {
  firstTransitionClass: SkillContextParityDriftSignatureTransitionClass;
  secondTransitionClass: SkillContextParityDriftSignatureTransitionClass;
}): SkillContextParityDriftSignatureTransitionStabilityEvaluation {
  if (!transitionClasses.has(input.firstTransitionClass) || !transitionClasses.has(input.secondTransitionClass)) {
    throw new Error("invalid canonical drift signature transition class");
  }
  const stableAcrossSamples = input.firstTransitionClass === input.secondTransitionClass;
  return { stableAcrossSamples, transitionChanged: !stableAcrossSamples };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDriftSignatureTransitionStabilityDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDriftSignatureTransitionStabilityDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDriftSignatureTransitionStabilityDiagnosticsResult> = {},
): SkillContextParityDriftSignatureTransitionStabilityDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    state,
    reasonCodes: [...reasonCodes],
    transitionStabilitySamplingMode: "sequential_double_transition_stability_sample_non_atomic",
    stabilityAvailable: false,
    firstTransitionTriggerAttempted: false,
    firstTransitionTriggerSucceeded: false,
    firstTransitionResultParsed: false,
    secondTransitionTriggerAttempted: false,
    secondTransitionTriggerSucceeded: false,
    secondTransitionResultParsed: false,
    stableAcrossSamples: false,
    transitionChanged: false,
    ...values,
  };
}

function normalizeInput(value: unknown): { recall: SkillRecallInput; request: Omit<RequestInput, "project" | "agentId"> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftSignatureTransitionStabilityDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (
    !recall.success || !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0
  ) return null;
  return { recall: recall.input, request: { overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount } };
}

function flagsMatch(sample: Record<string, unknown>, expected: [boolean, boolean, boolean, boolean, boolean, boolean]): boolean {
  return sample.firstSignatureTriggerAttempted === expected[0] && sample.firstSignatureTriggerSucceeded === expected[1] && sample.firstSignatureResultParsed === expected[2] &&
    sample.secondSignatureTriggerAttempted === expected[3] && sample.secondSignatureTriggerSucceeded === expected[4] && sample.secondSignatureResultParsed === expected[5];
}

function parse(value: unknown): ParsedSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  const required = [
    "success", "enabled", "applied", "state", "reasonCodes", "transitionSamplingMode", "transitionAvailable",
    "firstSignatureTriggerAttempted", "firstSignatureTriggerSucceeded", "firstSignatureResultParsed",
    "secondSignatureTriggerAttempted", "secondSignatureTriggerSucceeded", "secondSignatureResultParsed",
    "transitionClass", "signatureChanged", "familyChanged",
  ];
  if (
    !exactKeys(sample, required, ["reason"]) ||
    (Object.hasOwn(sample, "reason") && typeof sample.reason !== "string") ||
    typeof sample.success !== "boolean" || typeof sample.enabled !== "boolean" || sample.applied !== false ||
    sample.transitionSamplingMode !== "sequential_double_signature_transition_sample_non_atomic" || typeof sample.transitionAvailable !== "boolean" ||
    typeof sample.firstSignatureTriggerAttempted !== "boolean" || typeof sample.firstSignatureTriggerSucceeded !== "boolean" || typeof sample.firstSignatureResultParsed !== "boolean" ||
    typeof sample.secondSignatureTriggerAttempted !== "boolean" || typeof sample.secondSignatureTriggerSucceeded !== "boolean" || typeof sample.secondSignatureResultParsed !== "boolean" ||
    typeof sample.signatureChanged !== "boolean" || typeof sample.familyChanged !== "boolean"
  ) return null;

  if (
    sample.success === true && sample.enabled === false && sample.state === "disabled" &&
    exact(sample.reasonCodes, ["context_disabled"]) && sample.transitionAvailable === false && sample.transitionClass === null &&
    sample.signatureChanged === false && sample.familyChanged === false && flagsMatch(sample, [false, false, false, false, false, false])
  ) return { unavailable: true };

  if (sample.success === false && sample.enabled === true && sample.state === "failed" && sample.transitionAvailable === false && sample.transitionClass === null && sample.signatureChanged === false && sample.familyChanged === false) {
    const code = Array.isArray(sample.reasonCodes) && sample.reasonCodes.length === 1 ? sample.reasonCodes[0] : undefined;
    const expected = failedSamples[code as string];
    if (typeof code === "string" && expected && flagsMatch(sample, expected)) return { unavailable: true };
    return null;
  }

  if (
    sample.success !== true || sample.enabled !== true || sample.transitionAvailable !== true ||
    !flagsMatch(sample, [true, true, true, true, true, true]) || typeof sample.transitionClass !== "string" ||
    !transitionClasses.has(sample.transitionClass as SkillContextParityDriftSignatureTransitionClass)
  ) return null;

  const transitionClass = sample.transitionClass as SkillContextParityDriftSignatureTransitionClass;
  if (
    transitionClass === "same_signature" && sample.state === "signature_unchanged" && exact(sample.reasonCodes, ["signature_unchanged"]) &&
    sample.signatureChanged === false && sample.familyChanged === false
  ) return { transitionClass };

  const sameFamily = transitionClass === "stable_mismatch_variant_changed" || transitionClass === "observed_drift_variant_changed";
  const crossFamily = transitionClass !== "same_signature" && !sameFamily;
  if (
    (sameFamily || crossFamily) && sample.state === "signature_transition" && exact(sample.reasonCodes, ["signature_transition_observed"]) &&
    sample.signatureChanged === true && sample.familyChanged === crossFamily
  ) return { transitionClass };
  return null;
}

export function registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-signature-transition-stability-diagnostics", async (data: unknown) => {
    if (!loadSkillConfig().contextEnabled) {
      return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift signature transition stability diagnostics is disabled" });
    }
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift signature transition stability diagnostics input" });
    const request = () => buildSkillContextParityDriftSignatureTransitionStabilityRequest({ project: input.recall.project!, ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}), ...input.request });
    const unavailableReason = "skill context parity drift signature transition stability diagnostics could not compare two transition samples";

    let firstRaw: unknown;
    try { firstRaw = await sdk.trigger(request()); } catch {
      return result(false, true, "failed", ["first_transition_trigger_failure"], { reason: unavailableReason, firstTransitionTriggerAttempted: true });
    }
    const first = parse(firstRaw);
    const firstFlags = { firstTransitionTriggerAttempted: true, firstTransitionTriggerSucceeded: true, firstTransitionResultParsed: first !== null };
    if (!first) return result(false, true, "failed", ["invalid_first_transition_result"], { reason: unavailableReason, ...firstFlags });
    if ("unavailable" in first) return result(false, true, "failed", ["first_transition_classification_unavailable"], { reason: unavailableReason, ...firstFlags });

    let secondRaw: unknown;
    try { secondRaw = await sdk.trigger(request()); } catch {
      return result(false, true, "failed", ["second_transition_trigger_failure"], { reason: unavailableReason, ...firstFlags, secondTransitionTriggerAttempted: true });
    }
    const second = parse(secondRaw);
    const flags = { ...firstFlags, secondTransitionTriggerAttempted: true, secondTransitionTriggerSucceeded: true, secondTransitionResultParsed: second !== null };
    if (!second) return result(false, true, "failed", ["invalid_second_transition_result"], { reason: unavailableReason, ...flags });
    if ("unavailable" in second) return result(false, true, "failed", ["second_transition_classification_unavailable"], { reason: unavailableReason, ...flags });
    const evaluation = evaluateSkillContextParityDriftSignatureTransitionStability({ firstTransitionClass: first.transitionClass, secondTransitionClass: second.transitionClass });
    return result(true, true, evaluation.stableAcrossSamples ? "transition_stable" : "transition_drift", [evaluation.stableAcrossSamples ? "transition_stable" : "transition_drift_observed"], { ...flags, stabilityAvailable: true, ...evaluation });
  });
}
