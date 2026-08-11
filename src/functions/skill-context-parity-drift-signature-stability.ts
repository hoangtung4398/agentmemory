import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityDriftSignature,
  SkillContextParityDriftSignatureStabilityDiagnosticsInput,
  SkillContextParityDriftSignatureStabilityDiagnosticsReasonCode,
  SkillContextParityDriftSignatureStabilityDiagnosticsResult,
  SkillContextParityDriftSignatureStabilityEvaluation,
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

type ParsedSample = { signature: SkillContextParityDriftSignature } | { unavailable: true };

const stableSignature: SkillContextParityDriftSignature = "v1:stable_consistent:none:none";
const mismatchSignatures = new Set<SkillContextParityDriftSignature>([
  "v1:stable_mismatch:repeatable_mismatch:single_stage",
  "v1:stable_mismatch:repeatable_mismatch:cross_stage",
]);
const observedSignatures = new Set<SkillContextParityDriftSignature>([
  "v1:observed_drift:direct_drift:single_stage",
  "v1:observed_drift:direct_drift:cross_stage",
  "v1:observed_drift:runtime_drift:single_stage",
  "v1:observed_drift:runtime_drift:cross_stage",
  "v1:observed_drift:cross_path_drift:single_stage",
  "v1:observed_drift:cross_path_drift:cross_stage",
  "v1:observed_drift:parity_only:none",
  "v1:observed_drift:parity_with_direct_drift:single_stage",
  "v1:observed_drift:parity_with_direct_drift:cross_stage",
  "v1:observed_drift:parity_with_runtime_drift:single_stage",
  "v1:observed_drift:parity_with_runtime_drift:cross_stage",
  "v1:observed_drift:parity_with_cross_path_drift:single_stage",
  "v1:observed_drift:parity_with_cross_path_drift:cross_stage",
]);

function exact(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function buildSkillContextParityDriftSignatureStabilityRequest(input: RequestInput): {
  function_id: "mem::skill-context-parity-drift-signature-diagnostics";
  payload: RequestInput;
} {
  return {
    function_id: "mem::skill-context-parity-drift-signature-diagnostics",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    },
  };
}

export function evaluateSkillContextParityDriftSignatureStability(input: {
  firstSignature: SkillContextParityDriftSignature;
  secondSignature: SkillContextParityDriftSignature;
}): SkillContextParityDriftSignatureStabilityEvaluation {
  const stableAcrossSamples = input.firstSignature === input.secondSignature;
  return { stableAcrossSamples, signatureChanged: !stableAcrossSamples };
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDriftSignatureStabilityDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDriftSignatureStabilityDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDriftSignatureStabilityDiagnosticsResult> = {},
): SkillContextParityDriftSignatureStabilityDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    state,
    reasonCodes: [...reasonCodes],
    signatureSamplingMode: "sequential_double_signature_sample_non_atomic",
    stabilityAvailable: false,
    firstSignatureTriggerAttempted: false,
    firstSignatureTriggerSucceeded: false,
    firstSignatureResultParsed: false,
    secondSignatureTriggerAttempted: false,
    secondSignatureTriggerSucceeded: false,
    secondSignatureResultParsed: false,
    stableAcrossSamples: false,
    signatureChanged: false,
    ...values,
  };
}

function normalizeInput(value: unknown): { recall: SkillRecallInput; request: Omit<RequestInput, "project" | "agentId"> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftSignatureStabilityDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (
    !recall.success || !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0
  ) return null;
  return { recall: recall.input, request: { overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount } };
}

function parse(value: unknown): ParsedSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  const required = [
    "success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "signatureAvailable",
    "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature",
  ];
  if (
    !exactKeys(sample, required, ["reason"]) ||
    (Object.hasOwn(sample, "reason") && typeof sample.reason !== "string") ||
    typeof sample.success !== "boolean" || typeof sample.enabled !== "boolean" || sample.applied !== false ||
    sample.sourceSamplingMode !== "sequential_double_sample_non_atomic" || typeof sample.signatureAvailable !== "boolean" ||
    typeof sample.shapeTriggerAttempted !== "boolean" || typeof sample.shapeTriggerSucceeded !== "boolean" ||
    typeof sample.shapeResultParsed !== "boolean"
  ) return null;

  if (
    sample.state === "disabled" && sample.success === true && sample.enabled === false &&
    exact(sample.reasonCodes, ["context_disabled"]) && sample.signatureAvailable === false && sample.signature === null &&
    sample.shapeTriggerAttempted === false && sample.shapeTriggerSucceeded === false && sample.shapeResultParsed === false
  ) return { unavailable: true };

  if (sample.state === "failed" && sample.success === false && sample.enabled === true && sample.signatureAvailable === false && sample.signature === null) {
    const flagSets: Record<string, [boolean, boolean, boolean]> = {
      shape_trigger_failure: [true, false, false],
      invalid_shape_result: [true, true, false],
      shape_classification_unavailable: [true, true, true],
    };
    const code = Array.isArray(sample.reasonCodes) && sample.reasonCodes.length === 1 ? sample.reasonCodes[0] : undefined;
    const flags = flagSets[code as string];
    if (flags && sample.shapeTriggerAttempted === flags[0] && sample.shapeTriggerSucceeded === flags[1] && sample.shapeResultParsed === flags[2]) return { unavailable: true };
    return null;
  }

  const successful = sample.success === true && sample.enabled === true && sample.signatureAvailable === true &&
    sample.shapeTriggerAttempted === true && sample.shapeTriggerSucceeded === true && sample.shapeResultParsed === true &&
    typeof sample.signature === "string";
  if (!successful) return null;
  const signature = sample.signature as SkillContextParityDriftSignature;
  if (sample.state === "stable_consistent" && exact(sample.reasonCodes, ["stable_consistency_signed"]) && signature === stableSignature) return { signature };
  if (sample.state === "stable_mismatch" && exact(sample.reasonCodes, ["stable_mismatch_signed"]) && mismatchSignatures.has(signature)) return { signature };
  if (sample.state === "observed_drift" && exact(sample.reasonCodes, ["observed_drift_signed"]) && observedSignatures.has(signature)) return { signature };
  return null;
}

export function registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-signature-stability-diagnostics", async (data: unknown) => {
    if (!loadSkillConfig().contextEnabled) {
      return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift signature stability diagnostics is disabled" });
    }
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift signature stability diagnostics input" });
    const request = () => buildSkillContextParityDriftSignatureStabilityRequest({ project: input.recall.project!, ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}), ...input.request });

    let firstRaw: unknown;
    try { firstRaw = await sdk.trigger(request()); } catch {
      return result(false, true, "failed", ["first_signature_trigger_failure"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", firstSignatureTriggerAttempted: true });
    }
    const first = parse(firstRaw);
    const firstFlags = { firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: true, firstSignatureResultParsed: first !== null };
    if (!first) return result(false, true, "failed", ["invalid_first_signature_result"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", ...firstFlags });
    if ("unavailable" in first) return result(false, true, "failed", ["first_signature_classification_unavailable"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", ...firstFlags });

    let secondRaw: unknown;
    try { secondRaw = await sdk.trigger(request()); } catch {
      return result(false, true, "failed", ["second_signature_trigger_failure"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", ...firstFlags, secondSignatureTriggerAttempted: true });
    }
    const second = parse(secondRaw);
    const flags = { ...firstFlags, secondSignatureTriggerAttempted: true, secondSignatureTriggerSucceeded: true, secondSignatureResultParsed: second !== null };
    if (!second) return result(false, true, "failed", ["invalid_second_signature_result"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", ...flags });
    if ("unavailable" in second) return result(false, true, "failed", ["second_signature_classification_unavailable"], { reason: "skill context parity drift signature stability diagnostics could not compare two signature samples", ...flags });
    const evaluation = evaluateSkillContextParityDriftSignatureStability({ firstSignature: first.signature, secondSignature: second.signature });
    return result(true, true, evaluation.stableAcrossSamples ? "signature_stable" : "signature_drift", [evaluation.stableAcrossSamples ? "signature_stable" : "signature_drift_observed"], { ...flags, stabilityAvailable: true, ...evaluation });
  });
}
