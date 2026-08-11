import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftSignatureTransitionRequest,
  evaluateSkillContextParityDriftSignatureTransition,
  registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-signature-transition.js";
import { registerSkillContextParityDriftSignatureDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-signature.js";
import { registerSkillContextParityDriftShapeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-shape.js";
import { registerSkillContextParityDriftScopeDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-scope.js";
import { registerSkillContextParityDriftAttributionDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-attribution.js";
import { registerSkillContextParityStabilityDiagnosticsFunction } from "../src/functions/skill-context-parity-stability.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";

type Signature = "v1:stable_consistent:none:none" | "v1:stable_mismatch:repeatable_mismatch:single_stage" | "v1:stable_mismatch:repeatable_mismatch:cross_stage" | "v1:observed_drift:direct_drift:single_stage" | "v1:observed_drift:direct_drift:cross_stage" | "v1:observed_drift:runtime_drift:single_stage" | "v1:observed_drift:runtime_drift:cross_stage" | "v1:observed_drift:cross_path_drift:single_stage" | "v1:observed_drift:cross_path_drift:cross_stage" | "v1:observed_drift:parity_only:none" | "v1:observed_drift:parity_with_direct_drift:single_stage" | "v1:observed_drift:parity_with_direct_drift:cross_stage" | "v1:observed_drift:parity_with_runtime_drift:single_stage" | "v1:observed_drift:parity_with_runtime_drift:cross_stage" | "v1:observed_drift:parity_with_cross_path_drift:single_stage" | "v1:observed_drift:parity_with_cross_path_drift:cross_stage";

const signatures: Signature[] = [
  "v1:stable_consistent:none:none",
  "v1:stable_mismatch:repeatable_mismatch:single_stage", "v1:stable_mismatch:repeatable_mismatch:cross_stage",
  "v1:observed_drift:direct_drift:single_stage", "v1:observed_drift:direct_drift:cross_stage",
  "v1:observed_drift:runtime_drift:single_stage", "v1:observed_drift:runtime_drift:cross_stage",
  "v1:observed_drift:cross_path_drift:single_stage", "v1:observed_drift:cross_path_drift:cross_stage",
  "v1:observed_drift:parity_only:none",
  "v1:observed_drift:parity_with_direct_drift:single_stage", "v1:observed_drift:parity_with_direct_drift:cross_stage",
  "v1:observed_drift:parity_with_runtime_drift:single_stage", "v1:observed_drift:parity_with_runtime_drift:cross_stage",
  "v1:observed_drift:parity_with_cross_path_drift:single_stage", "v1:observed_drift:parity_with_cross_path_drift:cross_stage",
];
const input = { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 };

function config(tokenBudget = 320) {
  return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 };
}

function phase5K(signature: Signature = signatures[0], overrides: Record<string, unknown> = {}) {
  const state = signature.startsWith("v1:stable_consistent") ? "stable_consistent" : signature.startsWith("v1:stable_mismatch") ? "stable_mismatch" : "observed_drift";
  return { success: true, enabled: true, applied: false, state, reasonCodes: [state === "stable_consistent" ? "stable_consistency_signed" : state === "stable_mismatch" ? "stable_mismatch_signed" : "observed_drift_signed"], sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: true, shapeTriggerAttempted: true, shapeTriggerSucceeded: true, shapeResultParsed: true, signature, ...overrides };
}

function unavailable(code: "context_disabled" | "shape_trigger_failure" | "invalid_shape_result" | "shape_classification_unavailable") {
  if (code === "context_disabled") return { success: true, enabled: false, applied: false, state: "disabled", reasonCodes: [code], sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: false, shapeTriggerAttempted: false, shapeTriggerSucceeded: false, shapeResultParsed: false, signature: null };
  const flags = code === "shape_trigger_failure" ? [true, false, false] : code === "invalid_shape_result" ? [true, true, false] : [true, true, true];
  return { success: false, enabled: true, applied: false, state: "failed", reasonCodes: [code], sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: false, shapeTriggerAttempted: flags[0], shapeTriggerSucceeded: flags[1], shapeResultParsed: flags[2], signature: null };
}

function mockSdk() {
  const functions = new Map<string, (value: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let trigger: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | undefined;
  return { functions, requests, setTrigger(next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) { trigger = next; }, registerFunction(id: string, fn: (value: unknown) => Promise<unknown>) { functions.set(id, fn); }, async trigger(request: { function_id: string; payload: unknown }) { requests.push(request); return trigger ? trigger(request) : functions.get(request.function_id)!(request.payload); } };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = [];
  return { lists, gets, writes, list: async <T>(key: string): Promise<T[]> => { lists.push(key); return rows as T[]; }, get: async <T>(key: string): Promise<T | null> => { gets.push(key); return null; }, set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); } };
}

function skill() {
  return { id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"], expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1 };
}

describe("skill context parity drift signature transition diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  const handler = () => sdk.functions.get("mem::skill-context-parity-drift-signature-transition-diagnostics")!;

  beforeEach(() => { loadSkillConfig.mockReset(); loadSkillConfig.mockReturnValue({ contextEnabled: false }); sdk = mockSdk(); registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(sdk as never); });

  it("is internal, follows Phase 5L, and preserves public counts", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tail = ["registerSkillContextParityDiagnosticsFunction(sdk)", "registerSkillContextParityStabilityDiagnosticsFunction(sdk)", "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)", "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk)", "registerSkillContextParityDriftShapeDiagnosticsFunction(sdk)", "registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk)", "registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(sdk)", "registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(sdk)"];
    expect(tail.map((entry) => index.indexOf(entry))).toEqual([...tail.map((entry) => index.indexOf(entry))].sort((a, b) => a - b));
    expect(getAllTools()).toHaveLength(60); expect(getAllTools().some((tool) => JSON.stringify(tool).includes("signature-transition"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints"); expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain("15 native skills");
  });

  it("gates before validation, validates all boundaries, and never calls an unrecognized function", async () => {
    await expect(handler()(Symbol("private"))).resolves.toMatchObject({ success: true, enabled: false, reasonCodes: ["context_disabled"] }); expect(sdk.requests).toEqual([]);
    loadSkillConfig.mockReturnValue(config());
    for (const invalid of [null, [], "x", 1, true, Symbol("x"), {}, { ...input, project: undefined }, { ...input, project: "  " }, { ...input, project: 1 }, { ...input, project: false }, { ...input, project: {} }, { ...input, project: [] }, { ...input, agentId: null }, { ...input, agentId: 1 }, { ...input, agentId: false }, { ...input, agentId: {} }, { ...input, agentId: [] }]) {
      sdk.requests.length = 0; await expect(handler()(invalid)).resolves.toMatchObject({ reasonCodes: ["invalid_input"] }); expect(sdk.requests).toEqual([]);
    }
    for (const field of ["overallBudget", "usedTokens", "selectedBlockCount"] as const) for (const value of [undefined, null, "1", false, true, {}, [], NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -1]) {
      sdk.requests.length = 0; await expect(handler()({ ...input, [field]: value })).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"], firstSignatureTriggerAttempted: false, secondSignatureTriggerAttempted: false }); expect(sdk.requests).toEqual([]);
    }
    sdk.requests.length = 0; await expect(handler()({ ...input, overallBudget: 0 })).resolves.toMatchObject({ reasonCodes: ["invalid_input"] }); expect(sdk.requests).toEqual([]);
    sdk.setTrigger(async () => phase5K());
    await expect(handler()({ ...input, overallBudget: 1, usedTokens: 2, selectedBlockCount: Number.MAX_SAFE_INTEGER })).resolves.toMatchObject({ success: true });
    expect(sdk.requests.map((request) => request.function_id)).toEqual(Array(2).fill("mem::skill-context-parity-drift-signature-diagnostics"));
  });

  it("builds fresh equal request payloads, omits ignored fields, and preserves caller input", () => {
    const source = { ...input, project: " /repo ", agentId: " agent ", query: "private", files: ["x"], concepts: ["x"], limit: 1, sampleCount: 2, retryCount: 3, scopeMode: "x", shapeMode: "x", signatureMode: "x", stabilityMode: "x", transitionMode: "x", severity: 1, confidence: 1, history: ["x"], baseline: "x", previousSignature: "x", firstSignature: "x", secondSignature: "x" }; const before = structuredClone(source);
    const first = buildSkillContextParityDriftSignatureTransitionRequest(source); const second = buildSkillContextParityDriftSignatureTransitionRequest(source);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-signature-diagnostics", payload: { project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } });
    expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload); (first.payload as Record<string, unknown>).project = "mutated"; expect(second.payload.project).toBe(" /repo "); expect(source).toEqual(before);
    expect(buildSkillContextParityDriftSignatureTransitionRequest({ ...input, agentId: "  " }).payload).not.toHaveProperty("agentId");
    for (const field of ["project", "agentId", "overallBudget", "usedTokens", "selectedBlockCount"] as const) (first.payload as Record<string, unknown>)[field] = "mutated";
    expect(buildSkillContextParityDriftSignatureTransitionRequest(source)).toEqual(second); expect(source).toEqual(before);
  });

  it("strictly parses the complete Phase 5K contract and preserves first/second fail-fast semantics", async () => {
    loadSkillConfig.mockReturnValue(config());
    for (const signature of signatures) { sdk.setTrigger(async () => phase5K(signature)); await expect(handler()(input)).resolves.toMatchObject({ success: true, state: "signature_unchanged", transitionClass: "same_signature" }); }
    const malformed = [null, [], 1, { ...phase5K(), extra: true }, { ...phase5K(), reason: 1 }, { ...phase5K(), sourceSamplingMode: "wrong" }, { ...phase5K(), signature: "v2:stable_consistent:none:none" }, { ...phase5K(), signature: "v1:unknown" }, { ...phase5K(), state: "stable_mismatch" }, { ...phase5K(), reasonCodes: ["paths_consistent"] }];
    for (const raw of malformed) { sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"], secondSignatureTriggerAttempted: false }); }
    for (const raw of [unavailable("context_disabled"), unavailable("shape_trigger_failure"), unavailable("invalid_shape_result"), unavailable("shape_classification_unavailable")]) { sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["first_signature_classification_unavailable"], secondSignatureTriggerAttempted: false }); }
    let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : { ...phase5K(), signature: "bad" });
    await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_second_signature_result"], firstSignatureResultParsed: true, secondSignatureResultParsed: false });
  });

  it("rejects every required field, scalar boundary, state coupling, and unavailable tuple in either sample", async () => {
    loadSkillConfig.mockReturnValue(config());
    const required = ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "signatureAvailable", "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature"];
    const malformed: unknown[] = [];
    for (const field of required) { const raw = phase5K() as Record<string, unknown>; delete raw[field]; malformed.push(raw); }
    for (const [field, values] of Object.entries({ success: [null, 1, "true"], enabled: [null, 1, "true"], applied: [null, true, "false"], signatureAvailable: [null, 1, "true"], shapeTriggerAttempted: [null, 1, "true"], shapeTriggerSucceeded: [null, 1, "true"], shapeResultParsed: [null, 1, "true"], reasonCodes: [null, "x", [], ["x", "y"]] })) for (const value of values) malformed.push({ ...phase5K(), [field]: value });
    malformed.push(
      { ...phase5K(), state: "stable_consistent", signature: signatures[1] }, { ...phase5K(signatures[1]), signature: signatures[3] }, { ...phase5K(signatures[3]), signature: signatures[0] },
      { ...phase5K(), reasonCodes: ["stable_mismatch_signed"] }, { ...phase5K(signatures[1]), reasonCodes: ["observed_drift_signed"] }, { ...phase5K(signatures[3]), reasonCodes: ["stable_consistency_signed"] },
      { ...unavailable("context_disabled"), signature: signatures[0] }, { ...unavailable("context_disabled"), enabled: true },
      { ...unavailable("shape_trigger_failure"), reasonCodes: ["paths_consistent"] }, { ...unavailable("shape_trigger_failure"), signatureAvailable: true }, { ...unavailable("shape_trigger_failure"), shapeTriggerSucceeded: true },
    );
    for (const raw of malformed) {
      sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"], firstSignatureResultParsed: false, secondSignatureTriggerAttempted: false });
      let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_second_signature_result"], firstSignatureResultParsed: true, secondSignatureTriggerAttempted: true, secondSignatureResultParsed: false });
    }
    for (const code of ["shape_trigger_failure", "invalid_shape_result", "shape_classification_unavailable"] as const) {
      for (const position of [1, 2]) { let calls = 0; sdk.setTrigger(async () => ++calls === position ? unavailable(code) : phase5K()); const output = await handler()(input); expect(output.reasonCodes).toEqual([position === 1 ? "first_signature_classification_unavailable" : "second_signature_classification_unavailable"]); expect(output.firstSignatureResultParsed).toBe(true); expect(output.secondSignatureTriggerAttempted).toBe(position === 2); }
    }
  });

  it("enforces disabled and every failed Phase 5K invariant in both sample positions", async () => {
    loadSkillConfig.mockReturnValue(config());
    const positions = async (raw: unknown, reason: string) => {
      sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: [reason === "unavailable" ? "first_signature_classification_unavailable" : "invalid_first_signature_result"] });
      let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: [reason === "unavailable" ? "second_signature_classification_unavailable" : "invalid_second_signature_result"] });
    };
    const disabled = unavailable("context_disabled") as Record<string, unknown>;
    for (const field of ["success", "enabled", "reasonCodes", "signatureAvailable", "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature"] as const) {
      const value = field === "reasonCodes" ? ["wrong"] : field === "signature" ? signatures[0] : !(disabled[field] as boolean); await positions({ ...disabled, [field]: value }, "invalid");
    }
    const tuples = [["shape_trigger_failure", true, false, false], ["invalid_shape_result", true, true, false], ["shape_classification_unavailable", true, true, true]] as const;
    for (const [code, attempted, succeeded, parsed] of tuples) {
      const valid = unavailable(code) as Record<string, unknown>; await positions(valid, "unavailable");
      for (const field of ["shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed"] as const) await positions({ ...valid, [field]: !(field === "shapeTriggerAttempted" ? attempted : field === "shapeTriggerSucceeded" ? succeeded : parsed) }, "invalid");
      for (const raw of [{ ...valid, reasonCodes: ["invalid_input"] }, { ...valid, reasonCodes: ["unknown"] }, { ...valid, reasonCodes: [] }, { ...valid, reasonCodes: [code, code] }, { ...valid, success: true }, { ...valid, enabled: false }, { ...valid, signatureAvailable: true }, { ...valid, signature: signatures[0] }]) await positions(raw, "invalid");
    }
  });

  it("classifies all 256 signature pairs with the exact canonical distribution and pure flags", () => {
    const distribution = new Map<string, number>();
    for (const firstSignature of signatures) for (const secondSignature of signatures) {
      const value = { firstSignature, secondSignature }; const before = structuredClone(value); const evaluation = evaluateSkillContextParityDriftSignatureTransition(value);
      distribution.set(evaluation.transitionClass, (distribution.get(evaluation.transitionClass) ?? 0) + 1);
      expect(evaluation.signatureChanged).toBe(firstSignature !== secondSignature); expect(evaluation.familyChanged).toBe(evaluation.transitionClass.includes("_to_")); expect(value).toEqual(before);
    }
    expect(Object.fromEntries(distribution)).toEqual({ same_signature: 16, stable_mismatch_variant_changed: 2, observed_drift_variant_changed: 156, stable_consistent_to_stable_mismatch: 2, stable_consistent_to_observed_drift: 13, stable_mismatch_to_stable_consistent: 2, stable_mismatch_to_observed_drift: 26, observed_drift_to_stable_consistent: 13, observed_drift_to_stable_mismatch: 26 });
    for (const invalid of [undefined, null, "", "arbitrary", "v1:unknown", "v2:stable_consistent:none:none", {}, []]) {
      expect(() => evaluateSkillContextParityDriftSignatureTransition({ firstSignature: invalid as Signature, secondSignature: signatures[0] })).toThrow();
      expect(() => evaluateSkillContextParityDriftSignatureTransition({ firstSignature: signatures[0], secondSignature: invalid as Signature })).toThrow();
    }
  });

  it("returns relation-only unchanged, variants, and every cross-family transition without signatures", async () => {
    loadSkillConfig.mockReturnValue(config());
    const cases: Array<[Signature, Signature, string]> = [
      [signatures[0], signatures[1], "stable_consistent_to_stable_mismatch"], [signatures[0], signatures[3], "stable_consistent_to_observed_drift"], [signatures[1], signatures[0], "stable_mismatch_to_stable_consistent"], [signatures[1], signatures[3], "stable_mismatch_to_observed_drift"], [signatures[3], signatures[0], "observed_drift_to_stable_consistent"], [signatures[3], signatures[1], "observed_drift_to_stable_mismatch"], [signatures[1], signatures[2], "stable_mismatch_variant_changed"], [signatures[3], signatures[4], "observed_drift_variant_changed"],
    ];
    for (const [first, second, transitionClass] of cases) { let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K(first) : phase5K(second)); const output = await handler()(input); expect(output).toMatchObject({ success: true, state: "signature_transition", transitionClass, signatureChanged: true }); const serialized = JSON.stringify(output); expect(serialized).not.toContain("v1:"); expect(serialized).not.toContain("firstFamily"); expect(serialized).not.toContain("secondFamily"); }
    for (const [first, second] of [[signatures[3], signatures[4]], [signatures[3], signatures[5]], [signatures[5], signatures[7]], [signatures[7], signatures[9]], [signatures[9], signatures[10]], [signatures[10], signatures[12]], [signatures[12], signatures[14]], [signatures[14], signatures[12]]] as Array<[Signature, Signature]>) { let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K(first) : phase5K(second)); await expect(handler()(input)).resolves.toMatchObject({ transitionClass: "observed_drift_variant_changed", signatureChanged: true, familyChanged: false }); }
  });

  it("builds distinct identical requests from the handler and returns every control in the public result contract", async () => {
    loadSkillConfig.mockReturnValue(config()); let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K(signatures[0]) : phase5K(signatures[1]));
    const output = await handler()({ ...input, project: " /repo ", agentId: " agent " });
    expect(output).toEqual({ success: true, enabled: true, applied: false, state: "signature_transition", reasonCodes: ["signature_transition_observed"], transitionSamplingMode: "sequential_double_signature_transition_sample_non_atomic", transitionAvailable: true, firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: true, firstSignatureResultParsed: true, secondSignatureTriggerAttempted: true, secondSignatureTriggerSucceeded: true, secondSignatureResultParsed: true, transitionClass: "stable_consistent_to_stable_mismatch", signatureChanged: true, familyChanged: true });
    expect(sdk.requests).toHaveLength(2); expect(sdk.requests[0]).toEqual(sdk.requests[1]); expect(sdk.requests[0]).not.toBe(sdk.requests[1]); expect(sdk.requests[0].payload).not.toBe(sdk.requests[1].payload); (sdk.requests[0].payload as Record<string, unknown>).project = "mutated"; expect((sdk.requests[1].payload as Record<string, unknown>).project).toBe("/repo");
  });

  it("maps every first and second failure without leaking thrown or nested data", async () => {
    loadSkillConfig.mockReturnValue(config());
    for (const thrown of [new Error("private"), "private", { private: true }, null]) { sdk.setTrigger(async () => { throw thrown; }); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["first_signature_trigger_failure"], firstSignatureTriggerAttempted: true, secondSignatureTriggerAttempted: false }); }
    for (const second of [new Error("private"), "private", { private: true }, null, { ...phase5K(), signature: "bad" }, unavailable("context_disabled"), unavailable("shape_trigger_failure"), unavailable("invalid_shape_result"), unavailable("shape_classification_unavailable")]) { let calls = 0; sdk.setTrigger(async () => { if (++calls === 1) return phase5K(); if (second instanceof Error || second === null || typeof second === "string" || (typeof second === "object" && second && "private" in second)) throw second; return second; }); const output = await handler()(input); expect(output.firstSignatureResultParsed).toBe(true); expect(output.secondSignatureTriggerAttempted).toBe(true); expect(JSON.stringify(output)).not.toContain("private"); }
  });

  it("uses exact flags and generic reasons for every failure category without retaining source markers", async () => {
    loadSkillConfig.mockReturnValue(config());
    const cases: Array<[string, (call: number) => Promise<unknown> | unknown, string, [boolean, boolean, boolean, boolean, boolean, boolean]]> = [
      ["first-trigger", async () => { throw { firstMarker: "private" }; }, "first_signature_trigger_failure", [true, false, false, false, false, false]],
      ["first-invalid", () => ({ ...phase5K(), signature: "bad", firstMarker: "private" }), "invalid_first_signature_result", [true, true, false, false, false, false]],
      ["first-unavailable", () => ({ ...unavailable("context_disabled"), reason: "private" }), "first_signature_classification_unavailable", [true, true, true, false, false, false]],
      ["second-trigger", async (call) => call === 1 ? phase5K() : Promise.reject({ secondMarker: "private" }), "second_signature_trigger_failure", [true, true, true, true, false, false]],
      ["second-invalid", (call) => call === 1 ? phase5K() : ({ ...phase5K(), signature: "bad", secondMarker: "private" }), "invalid_second_signature_result", [true, true, true, true, true, false]],
      ["second-unavailable", (call) => call === 1 ? phase5K() : ({ ...unavailable("context_disabled"), reason: "private" }), "second_signature_classification_unavailable", [true, true, true, true, true, true]],
    ];
    for (const [, run, reason, flags] of cases) {
      let calls = 0; sdk.setTrigger(async () => run(++calls)); const output = await handler()(input);
      expect(output.reasonCodes).toEqual([reason]); expect(output.reason).toBe("skill context parity drift signature transition diagnostics could not classify two signature samples"); expect([output.firstSignatureTriggerAttempted, output.firstSignatureTriggerSucceeded, output.firstSignatureResultParsed, output.secondSignatureTriggerAttempted, output.secondSignatureTriggerSucceeded, output.secondSignatureResultParsed]).toEqual(flags); expect(JSON.stringify(output)).not.toContain("private");
    }
  });

  it("returns fresh defensive result controls and does not mutate raw values", async () => {
    loadSkillConfig.mockReturnValue(config()); const raw = phase5K(); const caller = { ...input, project: " private-project " }; const before = structuredClone({ raw, caller }); sdk.setTrigger(async () => raw);
    const first = await handler()(caller); first.reasonCodes.push("mutated" as never); (first as Record<string, unknown>).transitionClass = "mutated"; const second = await handler()(caller);
    expect(second).toMatchObject({ reasonCodes: ["signature_unchanged"], transitionClass: "same_signature" }); expect({ raw, caller }).toEqual(before);
  });

  it("does not mutate separate raw, thrown, builder, caller, or nested KV fixture objects", async () => {
    loadSkillConfig.mockReturnValue(config()); const caller = { ...input, project: " /caller ", agentId: " agent " }; const builder = { ...input, project: " /builder ", agentId: " agent " }; const firstRaw = phase5K(signatures[0], { reason: "first-private" }); const secondRaw = phase5K(signatures[3], { reason: "second-private" }); const firstThrown = { marker: "first-thrown" }; const secondThrown = { marker: "second-thrown" }; const before = structuredClone({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown });
    let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? firstRaw : secondRaw); await handler()(caller); buildSkillContextParityDriftSignatureTransitionRequest(builder); buildSkillContextParityDriftSignatureTransitionRequest(builder); calls = 0; sdk.setTrigger(async () => { if (++calls === 1) throw firstThrown; throw secondThrown; }); await handler()(input); expect({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown }).toEqual(before);
    const rows = [skill(), { ...skill(), id: "skill_two", steps: ["Nested"], files: ["nested"], concepts: ["nested"], sourceObservationIds: ["nested"] }]; const rowsBefore = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(integrated as never); await integrated.functions.get("mem::skill-context-parity-drift-signature-transition-diagnostics")!(input); expect(rows).toEqual(rowsBefore);
  });

  it("uses the real Phase 5D-5M chain in the exact no-budget and positive-budget orders", async () => {
    const noBudget = ["mem::skill-context-parity-drift-signature-diagnostics", "mem::skill-context-parity-drift-shape-diagnostics", "mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"];
    const positive = [...noBudget.slice(0, 8), "mem::skill-recall", ...noBudget.slice(8), "mem::skill-recall"];
    for (const [usedTokens, expected] of [[10, noBudget], [0, positive]] as const) {
      loadSkillConfig.mockReturnValue(config(1000)); const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
      registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(integrated as never);
      await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-transition-diagnostics")!({ ...input, overallBudget: 10, usedTokens })).resolves.toMatchObject({ success: true });
      expect(integrated.requests.map((request) => request.function_id)).toEqual([...expected, ...expected]); expect(integrated.requests).toHaveLength(usedTokens === 10 ? 22 : 26); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-diagnostics")).toHaveLength(2); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-stability-diagnostics")).toHaveLength(0); expect(kv.lists).toEqual(usedTokens === 10 ? [] : Array(8).fill(KV.skills)); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
    }
  });
});
