import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import type {
  SkillContextParityDriftLaneShape,
  SkillContextParityDriftSignature,
  SkillContextParityDriftSignatureDiagnosticsInput,
  SkillContextParityDriftSignatureDiagnosticsReasonCode,
  SkillContextParityDriftSignatureDiagnosticsResult,
  SkillContextParityDriftStageSpan,
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

type ParsedShape = {
  state: "disabled" | "failed" | "stable_consistent" | "stable_mismatch" | "observed_drift";
  signature?: SkillContextParityDriftSignature;
};

const shapes = [
  "none",
  "repeatable_mismatch",
  "direct_drift",
  "runtime_drift",
  "cross_path_drift",
  "parity_only",
  "parity_with_direct_drift",
  "parity_with_runtime_drift",
  "parity_with_cross_path_drift",
] as const;
const spans = ["none", "single_stage", "cross_stage"] as const;

const signatures: Record<string, SkillContextParityDriftSignature> = {
  "stable_consistent|none|none|false|false": "v1:stable_consistent:none:none",
  "stable_mismatch|repeatable_mismatch|single_stage|true|false": "v1:stable_mismatch:repeatable_mismatch:single_stage",
  "stable_mismatch|repeatable_mismatch|cross_stage|true|false": "v1:stable_mismatch:repeatable_mismatch:cross_stage",
  "observed_drift|direct_drift|single_stage|true|false": "v1:observed_drift:direct_drift:single_stage",
  "observed_drift|direct_drift|cross_stage|true|false": "v1:observed_drift:direct_drift:cross_stage",
  "observed_drift|runtime_drift|single_stage|true|false": "v1:observed_drift:runtime_drift:single_stage",
  "observed_drift|runtime_drift|cross_stage|true|false": "v1:observed_drift:runtime_drift:cross_stage",
  "observed_drift|cross_path_drift|single_stage|true|false": "v1:observed_drift:cross_path_drift:single_stage",
  "observed_drift|cross_path_drift|cross_stage|true|false": "v1:observed_drift:cross_path_drift:cross_stage",
  "observed_drift|parity_only|none|false|true": "v1:observed_drift:parity_only:none",
  "observed_drift|parity_with_direct_drift|single_stage|true|true": "v1:observed_drift:parity_with_direct_drift:single_stage",
  "observed_drift|parity_with_direct_drift|cross_stage|true|true": "v1:observed_drift:parity_with_direct_drift:cross_stage",
  "observed_drift|parity_with_runtime_drift|single_stage|true|true": "v1:observed_drift:parity_with_runtime_drift:single_stage",
  "observed_drift|parity_with_runtime_drift|cross_stage|true|true": "v1:observed_drift:parity_with_runtime_drift:cross_stage",
  "observed_drift|parity_with_cross_path_drift|single_stage|true|true": "v1:observed_drift:parity_with_cross_path_drift:single_stage",
  "observed_drift|parity_with_cross_path_drift|cross_stage|true|true": "v1:observed_drift:parity_with_cross_path_drift:cross_stage",
};

function exact(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function buildSkillContextParityDriftSignatureRequest(input: RequestInput): {
  function_id: "mem::skill-context-parity-drift-shape-diagnostics";
  payload: RequestInput;
} {
  return {
    function_id: "mem::skill-context-parity-drift-shape-diagnostics",
    payload: {
      project: input.project,
      ...(input.agentId?.trim() ? { agentId: input.agentId } : {}),
      overallBudget: input.overallBudget,
      usedTokens: input.usedTokens,
      selectedBlockCount: input.selectedBlockCount,
    },
  };
}

export function evaluateSkillContextParityDriftSignature(input: {
  state: "stable_consistent" | "stable_mismatch" | "observed_drift";
  laneShape: SkillContextParityDriftLaneShape;
  stageSpan: SkillContextParityDriftStageSpan;
  stageAttributionPresent: boolean;
  parityOutcomePresent: boolean;
}): SkillContextParityDriftSignature {
  const signature = signatures[`${input.state}|${input.laneShape}|${input.stageSpan}|${input.stageAttributionPresent}|${input.parityOutcomePresent}`];
  if (!signature) throw new Error("invalid signature tuple");
  return signature;
}

function result(
  success: boolean,
  enabled: boolean,
  state: SkillContextParityDriftSignatureDiagnosticsResult["state"],
  reasonCodes: SkillContextParityDriftSignatureDiagnosticsReasonCode[],
  values: Partial<SkillContextParityDriftSignatureDiagnosticsResult> = {},
): SkillContextParityDriftSignatureDiagnosticsResult {
  return {
    success,
    enabled,
    applied: false,
    state,
    reasonCodes: [...reasonCodes],
    sourceSamplingMode: "sequential_double_sample_non_atomic",
    signatureAvailable: false,
    shapeTriggerAttempted: false,
    shapeTriggerSucceeded: false,
    shapeResultParsed: false,
    signature: null,
    ...values,
  };
}

function normalizeInput(value: unknown): {
  recall: SkillRecallInput;
  overallBudget: number;
  usedTokens: number;
  selectedBlockCount: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as SkillContextParityDriftSignatureDiagnosticsInput;
  const recall = normalizeSkillRecallInput({ project: input.project, agentId: input.agentId });
  if (
    !recall.success ||
    !recall.input.project ||
    typeof input.overallBudget !== "number" || !Number.isSafeInteger(input.overallBudget) || input.overallBudget <= 0 ||
    typeof input.usedTokens !== "number" || !Number.isSafeInteger(input.usedTokens) || input.usedTokens < 0 ||
    typeof input.selectedBlockCount !== "number" || !Number.isSafeInteger(input.selectedBlockCount) || input.selectedBlockCount < 0
  ) return null;
  return { recall: recall.input, overallBudget: input.overallBudget, usedTokens: input.usedTokens, selectedBlockCount: input.selectedBlockCount };
}

function parse(value: unknown): ParsedShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const shape = value as Record<string, unknown>;
  const required = [
    "success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "shapeAvailable",
    "scopeTriggerAttempted", "scopeTriggerSucceeded", "scopeResultParsed", "laneShape", "stageSpan",
    "stageAttributionPresent", "parityOutcomePresent",
  ];
  if (
    !exactKeys(shape, required, ["reason"]) ||
    (Object.hasOwn(shape, "reason") && typeof shape.reason !== "string") ||
    shape.applied !== false ||
    shape.sourceSamplingMode !== "sequential_double_sample_non_atomic" ||
    typeof shape.success !== "boolean" ||
    typeof shape.enabled !== "boolean" ||
    typeof shape.shapeAvailable !== "boolean" ||
    typeof shape.scopeTriggerAttempted !== "boolean" ||
    typeof shape.scopeTriggerSucceeded !== "boolean" ||
    typeof shape.scopeResultParsed !== "boolean" ||
    typeof shape.stageAttributionPresent !== "boolean" ||
    typeof shape.parityOutcomePresent !== "boolean" ||
    !shapes.includes(shape.laneShape as never) ||
    !spans.includes(shape.stageSpan as never)
  ) return null;

  const unavailable = shape.shapeAvailable === false && shape.laneShape === "none" && shape.stageSpan === "none" &&
    shape.stageAttributionPresent === false && shape.parityOutcomePresent === false;
  if (
    shape.state === "disabled" && shape.success === true && shape.enabled === false && unavailable &&
    shape.scopeTriggerAttempted === false && shape.scopeTriggerSucceeded === false && shape.scopeResultParsed === false &&
    exact(shape.reasonCodes, ["context_disabled"])
  ) return { state: "disabled" };

  if (shape.state === "failed" && shape.success === false && shape.enabled === true && unavailable) {
    const failureFlags: Record<string, [boolean, boolean, boolean]> = {
      scope_trigger_failure: [true, false, false],
      invalid_scope_result: [true, true, false],
      scope_classification_unavailable: [true, true, true],
    };
    const code = Array.isArray(shape.reasonCodes) && shape.reasonCodes.length === 1 ? shape.reasonCodes[0] : undefined;
    const flags = failureFlags[code as string];
    if (flags && shape.scopeTriggerAttempted === flags[0] && shape.scopeTriggerSucceeded === flags[1] && shape.scopeResultParsed === flags[2]) return { state: "failed" };
    return null;
  }

  const successFlags = shape.success === true && shape.enabled === true && shape.shapeAvailable === true &&
    shape.scopeTriggerAttempted === true && shape.scopeTriggerSucceeded === true && shape.scopeResultParsed === true;
  if (!successFlags) return null;
  if (shape.state === "stable_consistent") {
    return exact(shape.reasonCodes, ["stable_consistency_shaped"]) && shape.laneShape === "none" && shape.stageSpan === "none" &&
      shape.stageAttributionPresent === false && shape.parityOutcomePresent === false
      ? { state: "stable_consistent", signature: evaluateSkillContextParityDriftSignature({ state: "stable_consistent", laneShape: "none", stageSpan: "none", stageAttributionPresent: false, parityOutcomePresent: false }) }
      : null;
  }
  if (shape.state === "stable_mismatch") {
    if (!exact(shape.reasonCodes, ["stable_mismatch_shaped"]) || shape.laneShape !== "repeatable_mismatch" || !["single_stage", "cross_stage"].includes(shape.stageSpan as string) || shape.stageAttributionPresent !== true || shape.parityOutcomePresent !== false) return null;
    return { state: "stable_mismatch", signature: evaluateSkillContextParityDriftSignature({ state: "stable_mismatch", laneShape: shape.laneShape, stageSpan: shape.stageSpan as SkillContextParityDriftStageSpan, stageAttributionPresent: true, parityOutcomePresent: false }) };
  }
  if (shape.state === "observed_drift" && exact(shape.reasonCodes, ["observed_drift_shaped"])) {
    try {
      return {
        state: "observed_drift",
        signature: evaluateSkillContextParityDriftSignature({
          state: "observed_drift",
          laneShape: shape.laneShape as SkillContextParityDriftLaneShape,
          stageSpan: shape.stageSpan as SkillContextParityDriftStageSpan,
          stageAttributionPresent: shape.stageAttributionPresent,
          parityOutcomePresent: shape.parityOutcomePresent,
        }),
      };
    } catch { return null; }
  }
  return null;
}

export function registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::skill-context-parity-drift-signature-diagnostics", async (data: unknown) => {
    if (!loadSkillConfig().contextEnabled) {
      return result(true, false, "disabled", ["context_disabled"], { reason: "skill context parity drift signature diagnostics is disabled" });
    }
    const input = normalizeInput(data);
    if (!input) return result(false, true, "failed", ["invalid_input"], { reason: "invalid skill context parity drift signature diagnostics input" });
    let raw: unknown;
    try {
      raw = await sdk.trigger(buildSkillContextParityDriftSignatureRequest({
        project: input.recall.project!,
        ...(input.recall.agentId ? { agentId: input.recall.agentId } : {}),
        overallBudget: input.overallBudget,
        usedTokens: input.usedTokens,
        selectedBlockCount: input.selectedBlockCount,
      }));
    } catch {
      return result(false, true, "failed", ["shape_trigger_failure"], {
        reason: "skill context parity drift signature diagnostics could not derive a shape signature",
        shapeTriggerAttempted: true,
      });
    }
    const shape = parse(raw);
    const flags = { shapeTriggerAttempted: true, shapeTriggerSucceeded: true, shapeResultParsed: shape !== null };
    if (!shape) return result(false, true, "failed", ["invalid_shape_result"], { reason: "skill context parity drift signature diagnostics could not derive a shape signature", ...flags });
    if (shape.state === "disabled" || shape.state === "failed") return result(false, true, "failed", ["shape_classification_unavailable"], { reason: "skill context parity drift signature diagnostics could not derive a shape signature", ...flags });
    return result(true, true, shape.state, [
      shape.state === "stable_consistent" ? "stable_consistency_signed" :
      shape.state === "stable_mismatch" ? "stable_mismatch_signed" : "observed_drift_signed",
    ], { ...flags, signatureAvailable: true, signature: shape.signature! });
  });
}
