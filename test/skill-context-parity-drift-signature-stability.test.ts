import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftSignatureStabilityRequest,
  evaluateSkillContextParityDriftSignatureStability,
  registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-signature-stability.js";
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
const validInput = { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 };

function enabledConfig(tokenBudget = 320) {
  return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 };
}

function phase5K(signature: Signature = signatures[0], overrides: Record<string, unknown> = {}) {
  const state = signature.startsWith("v1:stable_consistent") ? "stable_consistent" : signature.startsWith("v1:stable_mismatch") ? "stable_mismatch" : "observed_drift";
  return {
    success: true, enabled: true, applied: false, state,
    reasonCodes: [state === "stable_consistent" ? "stable_consistency_signed" : state === "stable_mismatch" ? "stable_mismatch_signed" : "observed_drift_signed"],
    sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: true,
    shapeTriggerAttempted: true, shapeTriggerSucceeded: true, shapeResultParsed: true, signature,
    ...overrides,
  };
}

function unavailable(kind: "disabled" | "failed", overrides: Record<string, unknown> = {}) {
  if (kind === "disabled") return { success: true, enabled: false, applied: false, state: "disabled", reasonCodes: ["context_disabled"], sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: false, shapeTriggerAttempted: false, shapeTriggerSucceeded: false, shapeResultParsed: false, signature: null, ...overrides };
  return { success: false, enabled: true, applied: false, state: "failed", reasonCodes: ["shape_trigger_failure"], sourceSamplingMode: "sequential_double_sample_non_atomic", signatureAvailable: false, shapeTriggerAttempted: true, shapeTriggerSucceeded: false, shapeResultParsed: false, signature: null, ...overrides };
}

function mockSdk() {
  const functions = new Map<string, (input: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let implementation: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | undefined;
  return {
    functions, requests,
    setTrigger: (next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) => { implementation = next; },
    registerFunction: (id: string, fn: (input: unknown) => Promise<unknown>) => functions.set(id, fn),
    trigger: async (request: { function_id: string; payload: unknown }) => { requests.push(request); return implementation ? implementation(request) : functions.get(request.function_id)!(request.payload); },
  };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = [];
  return { lists, gets, writes, list: async <T>(key: string): Promise<T[]> => { lists.push(key); return rows as T[]; }, get: async <T>(key: string): Promise<T | null> => { gets.push(key); return null; }, set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); } };
}

function skill() {
  return { id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"], expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1 };
}

describe("skill context parity drift signature stability diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  const handler = () => sdk.functions.get("mem::skill-context-parity-drift-signature-stability-diagnostics")!;

  beforeEach(() => {
    loadSkillConfig.mockReset(); loadSkillConfig.mockReturnValue({ contextEnabled: false });
    sdk = mockSdk(); registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(sdk as never);
  });

  it("is internal, follows Phase 5K, and preserves public counts", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tail = ["registerSkillContextParityDiagnosticsFunction(sdk)", "registerSkillContextParityStabilityDiagnosticsFunction(sdk)", "registerSkillContextParityDriftAttributionDiagnosticsFunction(sdk)", "registerSkillContextParityDriftScopeDiagnosticsFunction(sdk)", "registerSkillContextParityDriftShapeDiagnosticsFunction(sdk)", "registerSkillContextParityDriftSignatureDiagnosticsFunction(sdk)", "registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(sdk)"];
    expect(tail.map((entry) => index.indexOf(entry))).toEqual([...tail.map((entry) => index.indexOf(entry))].sort((a, b) => a - b));
    expect(getAllTools()).toHaveLength(60); expect(getAllTools().some((tool) => JSON.stringify(tool).includes("signature-stability"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints"); expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain("15 native skills");
  });

  it("gates before validation and exhaustively rejects enabled invalid input without calling Phase 5K", async () => {
    await expect(handler()(Symbol("private"))).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"] }); expect(sdk.requests).toEqual([]);
    loadSkillConfig.mockReturnValue(enabledConfig());
    const expectInvalid = async (input: unknown) => {
      sdk.requests.length = 0;
      await expect(handler()(input)).resolves.toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"], firstSignatureTriggerAttempted: false, secondSignatureTriggerAttempted: false });
      expect(sdk.requests).toEqual([]);
    };
    for (const input of [null, [], "x", 1, true, Symbol("x"), {}]) await expectInvalid(input);
    for (const project of [undefined, "   ", 1, false, {}, []]) await expectInvalid({ ...validInput, project });
    for (const agentId of [null, 1, false, {}, []]) await expectInvalid({ ...validInput, agentId });
    const invalidNumbers = [undefined, null, "1", false, true, {}, [], NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, -1];
    for (const field of ["overallBudget", "usedTokens", "selectedBlockCount"] as const) for (const value of invalidNumbers) await expectInvalid({ ...validInput, [field]: value });
    await expectInvalid({ ...validInput, overallBudget: 0 });
    sdk.setTrigger(async () => phase5K());
    for (const input of [{ ...validInput, overallBudget: 1 }, { ...validInput, usedTokens: 0 }, { ...validInput, selectedBlockCount: 0 }, { ...validInput, overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: Number.MAX_SAFE_INTEGER }, { ...validInput, overallBudget: 1, usedTokens: 2 }]) {
      sdk.requests.length = 0; await expect(handler()(input)).resolves.toMatchObject({ success: true }); expect(sdk.requests).toHaveLength(2);
    }
  });

  it("builds fresh equal requests, strips every ignored field, preserves boundaries, and does not mutate input", () => {
    const input = { ...validInput, project: " /repo ", agentId: " agent ", query: "hidden", files: ["x"], concepts: ["x"], limit: 1, sampleCount: 1, retryCount: 1, scopeMode: "x", shapeMode: "x", signatureMode: "x", stabilityMode: "x", severity: 1, confidence: 1, history: ["hidden"], baseline: "hidden", previousSignature: "hidden" }; const before = structuredClone(input);
    const first = buildSkillContextParityDriftSignatureStabilityRequest(input); const second = buildSkillContextParityDriftSignatureStabilityRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-signature-diagnostics", payload: { project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } });
    expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload);
    for (const key of Object.keys(first.payload)) (first.payload as Record<string, unknown>)[key] = "mutated";
    expect(second.payload).toEqual({ project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(buildSkillContextParityDriftSignatureStabilityRequest({ ...validInput, project: "/only" }).payload).toEqual({ ...validInput, project: "/only" });
    expect(buildSkillContextParityDriftSignatureStabilityRequest({ ...validInput, agentId: "  " }).payload).not.toHaveProperty("agentId");
    expect(buildSkillContextParityDriftSignatureStabilityRequest({ ...validInput, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 }).payload).toMatchObject({ overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 });
    expect(buildSkillContextParityDriftSignatureStabilityRequest({ ...validInput, overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER }).payload).toMatchObject({ overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER });
    expect(input).toEqual(before);
  });

  it("creates two identical but distinct Phase 5K requests from the real handler", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => phase5K());
    await expect(handler()({ ...validInput, project: " /repo ", agentId: " agent " })).resolves.toMatchObject({ success: true });
    expect(sdk.requests).toHaveLength(2); const [first, second] = sdk.requests;
    expect(first).toEqual(second); expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload);
    (first.payload as Record<string, unknown>).project = "mutated"; expect((second.payload as Record<string, unknown>).project).toBe("/repo");
  });

  it("strictly accepts all canonical Phase 5K signatures and rejects malformed, contradictory, and unavailable samples", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const signature of signatures) {
      sdk.setTrigger(async () => phase5K(signature));
      await expect(handler()(validInput)).resolves.toMatchObject({ success: true, stabilityAvailable: true, state: "signature_stable", stableAcrossSamples: true, signatureChanged: false });
    }
    const malformed = [null, [], 1, { ...phase5K(), extra: true }, { ...phase5K(), reason: 1 }, { ...phase5K(), applied: true }, { ...phase5K(), sourceSamplingMode: "wrong" }, { ...phase5K(), signature: "v2:bad" }, { ...phase5K(), signature: signatures[1] }, { ...phase5K(), state: "stable_mismatch" }, { ...phase5K(), reasonCodes: ["paths_consistent"] }];
    for (const raw of malformed) { sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"], firstSignatureResultParsed: false, secondSignatureTriggerAttempted: false }); }
    for (const raw of [unavailable("disabled"), unavailable("failed")]) { sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["first_signature_classification_unavailable"], firstSignatureResultParsed: true, secondSignatureTriggerAttempted: false }); }
    for (const raw of [unavailable("failed", { reasonCodes: ["invalid_input"] }), unavailable("failed", { shapeTriggerSucceeded: true })]) { sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"], firstSignatureResultParsed: false, secondSignatureTriggerAttempted: false }); }
  });

  it("fails closed for every required Phase 5K field, scalar boundary, and failed tuple contradiction", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const required = ["success", "enabled", "applied", "state", "reasonCodes", "sourceSamplingMode", "signatureAvailable", "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature"];
    for (const field of required) {
      const raw = phase5K() as Record<string, unknown>; delete raw[field]; sdk.setTrigger(async () => raw);
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"] });
    }
    for (const [field, values] of Object.entries({ success: [null, 1, "true"], enabled: [null, 1, "true"], signatureAvailable: [null, 1, "true"], shapeTriggerAttempted: [null, 1, "true"], shapeTriggerSucceeded: [null, 1, "true"], shapeResultParsed: [null, 1, "true"], reasonCodes: [null, "x", [], ["x", "y"]] })) {
      for (const value of values) { sdk.setTrigger(async () => ({ ...phase5K(), [field]: value })); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"] }); }
    }
    const tuples = [["shape_trigger_failure", true, false, false], ["invalid_shape_result", true, true, false], ["shape_classification_unavailable", true, true, true]] as const;
    for (const [code, attempted, succeeded, parsed] of tuples) {
      sdk.setTrigger(async () => unavailable("failed", { reasonCodes: [code], shapeTriggerAttempted: attempted, shapeTriggerSucceeded: succeeded, shapeResultParsed: parsed }));
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["first_signature_classification_unavailable"] });
      for (const field of ["shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed"] as const) {
        sdk.setTrigger(async () => unavailable("failed", { reasonCodes: [code], shapeTriggerAttempted: attempted, shapeTriggerSucceeded: succeeded, shapeResultParsed: parsed, [field]: !(field === "shapeTriggerAttempted" ? attempted : field === "shapeTriggerSucceeded" ? succeeded : parsed) }));
        await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"] });
      }
    }
  });

  it("enforces every Phase 5K state/signature, disabled, and failed invariant", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const expectMalformed = async (raw: unknown) => { sdk.setTrigger(async () => raw); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_first_signature_result"], firstSignatureResultParsed: false, secondSignatureTriggerAttempted: false }); };
    for (const raw of [
      { ...phase5K(), applied: null }, { ...phase5K(), applied: "false" }, { ...phase5K(), state: null }, { ...phase5K(), state: "unknown" }, { ...phase5K(), reasonCodes: null }, { ...phase5K(), reasonCodes: 1 }, { ...phase5K(), reasonCodes: [] }, { ...phase5K(), reasonCodes: ["x", "y"] }, { ...phase5K(), sourceSamplingMode: null }, { ...phase5K(), sourceSamplingMode: "wrong" }, { ...phase5K(), signature: null }, { ...phase5K(), signature: 1 }, { ...phase5K(), signature: "v1:unknown" }, { ...phase5K(), signature: "arbitrary" }, { ...phase5K(), signature: "v2:stable_consistent:none:none" },
      { ...phase5K(), state: "stable_consistent", signature: signatures[1] }, { ...phase5K(), state: "stable_consistent", signature: signatures[3] }, { ...phase5K(signatures[1]), signature: signatures[0] }, { ...phase5K(signatures[1]), signature: signatures[3] }, { ...phase5K(signatures[3]), signature: signatures[0] }, { ...phase5K(signatures[3]), signature: signatures[1] },
      { ...phase5K(), reasonCodes: ["stable_mismatch_signed"] }, { ...phase5K(signatures[1]), reasonCodes: ["observed_drift_signed"] }, { ...phase5K(signatures[3]), reasonCodes: ["stable_consistency_signed"] },
    ]) await expectMalformed(raw);
    const disabled = unavailable("disabled");
    for (const field of ["success", "enabled", "reasonCodes", "signatureAvailable", "shapeTriggerAttempted", "shapeTriggerSucceeded", "shapeResultParsed", "signature"] as const) {
      const value = field === "reasonCodes" ? ["wrong"] : field === "signature" ? "v1:stable_consistent:none:none" : !(disabled[field] as boolean);
      await expectMalformed({ ...disabled, [field]: value });
    }
    const tuples = [["shape_trigger_failure", true, false, false], ["invalid_shape_result", true, true, false], ["shape_classification_unavailable", true, true, true]] as const;
    for (const [code, attempted, succeeded, parsed] of tuples) {
      const valid = unavailable("failed", { reasonCodes: [code], shapeTriggerAttempted: attempted, shapeTriggerSucceeded: succeeded, shapeResultParsed: parsed }); sdk.setTrigger(async () => valid);
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["first_signature_classification_unavailable"], firstSignatureResultParsed: true });
      for (const raw of [{ ...valid, reasonCodes: ["invalid_input"] }, { ...valid, reasonCodes: ["unknown"] }, { ...valid, signature: "v1:stable_consistent:none:none" }, { ...valid, signatureAvailable: true }, { ...valid, success: true }, { ...valid, enabled: false }]) await expectMalformed(raw);
    }
  });

  it("evaluates every equality and inequality pair purely with inverse flags", () => {
    for (const firstSignature of signatures) for (const secondSignature of signatures) {
      const input = { firstSignature, secondSignature }; const before = structuredClone(input); const output = evaluateSkillContextParityDriftSignatureStability(input);
      expect(output.stableAcrossSamples).toBe(firstSignature === secondSignature); expect(output.signatureChanged).toBe(firstSignature !== secondSignature); expect(output.signatureChanged).toBe(!output.stableAcrossSamples); expect(input).toEqual(before);
    }
  });

  it("fails fast for every first-sample failure and maps every second-sample failure exactly", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const firstUnavailable = [unavailable("disabled"), unavailable("failed"), unavailable("failed", { reasonCodes: ["invalid_shape_result"], shapeTriggerSucceeded: true }), unavailable("failed", { reasonCodes: ["shape_classification_unavailable"], shapeTriggerSucceeded: true, shapeResultParsed: true })];
    for (const thrown of [new Error("private"), "private", { private: true }, null]) {
      sdk.requests.length = 0; sdk.setTrigger(async () => { throw thrown; });
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["first_signature_trigger_failure"], firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: false, firstSignatureResultParsed: false, secondSignatureTriggerAttempted: false, secondSignatureTriggerSucceeded: false, secondSignatureResultParsed: false }); expect(sdk.requests).toHaveLength(1);
    }
    for (const raw of [{ ...phase5K(), signature: "bad" }, ...firstUnavailable]) {
      sdk.requests.length = 0; sdk.setTrigger(async () => raw); const unavailableResult = raw === firstUnavailable[0] || firstUnavailable.includes(raw as never);
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: [unavailableResult ? "first_signature_classification_unavailable" : "invalid_first_signature_result"], firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: true, firstSignatureResultParsed: unavailableResult, secondSignatureTriggerAttempted: false, secondSignatureTriggerSucceeded: false, secondSignatureResultParsed: false }); expect(sdk.requests).toHaveLength(1);
    }
    const secondCases: Array<[unknown, string, boolean, boolean]> = [
      [new Error("private"), "second_signature_trigger_failure", false, false], ["private", "second_signature_trigger_failure", false, false], [{ private: true }, "second_signature_trigger_failure", false, false], [null, "second_signature_trigger_failure", false, false],
      [{ ...phase5K(), signature: "bad" }, "invalid_second_signature_result", true, false], [unavailable("disabled"), "second_signature_classification_unavailable", true, true], [unavailable("failed"), "second_signature_classification_unavailable", true, true], [unavailable("failed", { reasonCodes: ["invalid_shape_result"], shapeTriggerSucceeded: true }), "second_signature_classification_unavailable", true, true], [unavailable("failed", { reasonCodes: ["shape_classification_unavailable"], shapeTriggerSucceeded: true, shapeResultParsed: true }), "second_signature_classification_unavailable", true, true],
    ];
    for (const [second, reason, succeeded, parsed] of secondCases) {
      let calls = 0; sdk.requests.length = 0; sdk.setTrigger(async () => { if (++calls === 1) return phase5K(); if (second instanceof Error || second === null || typeof second === "string" || (typeof second === "object" && second && "private" in second)) throw second; return second; });
      await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: [reason], firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: true, firstSignatureResultParsed: true, secondSignatureTriggerAttempted: true, secondSignatureTriggerSucceeded: succeeded, secondSignatureResultParsed: parsed }); expect(sdk.requests).toHaveLength(2);
    }
  });

  it("reports aggregate stability only, detects same-state and cross-state drift, and never leaks private data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const outputFor = async (first: unknown, second: unknown) => { let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? first : second); return handler()({ ...validInput, project: "private-project", agentId: "private-agent" }); };
    for (const [first, second] of [[0, 1], [0, 3], [1, 0], [1, 2], [1, 3], [3, 0], [3, 1], [3, 5], [5, 7], [7, 9], [9, 10], [10, 12], [12, 14]] as const) {
      await expect(outputFor(phase5K(signatures[first]), phase5K(signatures[second]))).resolves.toMatchObject({ state: "signature_drift", reasonCodes: ["signature_drift_observed"], stabilityAvailable: true, stableAcrossSamples: false, signatureChanged: true });
    }
    const output = await outputFor(phase5K(signatures[0]), phase5K(signatures[3], { reason: "private-reason" })); const serialized = JSON.stringify(output);
    for (const marker of ["v1:", "private", "stable_consistent", "observed_drift", "payload", "project", "agent"]) expect(serialized).not.toContain(marker);
  });

  it("suppresses all nested and exception privacy markers in stable, drift, and every failure result", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const forbidden = ["v1:", "project-marker", "agent-marker", "first-reason-marker", "second-reason-marker", "extra-marker", "first-throw-marker", "second-throw-marker", "stable_consistent", "stable_mismatch", "observed_drift", "shape_trigger_failure", "payload", "laneShape", "stageSpan", "affectedStages", "activeLanes", "skill-marker"];
    const run = async (first: unknown, second?: unknown) => { let calls = 0; sdk.setTrigger(async () => { if (++calls === 1) { if (first instanceof Error || first === null || typeof first === "string" || (typeof first === "object" && first && "first-throw-marker" in first)) throw first; return first; } if (second instanceof Error || second === null || typeof second === "string" || (typeof second === "object" && second && "second-throw-marker" in second)) throw second; return second; }); return handler()({ ...validInput, project: "project-marker", agentId: "agent-marker" }); };
    const first = phase5K(signatures[0], { reason: "first-reason-marker" }); const second = phase5K(signatures[3], { reason: "second-reason-marker" });
    const results = [await run(first, phase5K(signatures[0], { reason: "second-reason-marker" })), await run(first, second), await run({ "first-throw-marker": true }), await run({ ...phase5K(), signature: "bad", extra: "extra-marker" }), await run(unavailable("disabled", { reason: "first-reason-marker" })), await run(phase5K(), { "second-throw-marker": true }), await run(phase5K(), { ...phase5K(), signature: "bad", extra: "extra-marker" }), await run(phase5K(), unavailable("disabled", { reason: "second-reason-marker" }))];
    for (const output of results) for (const marker of forbidden) expect(JSON.stringify(output)).not.toContain(marker);
  });

  it("returns defensive controls and fresh reason arrays without retaining caller or nested sample mutation", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = phase5K(); const input = { ...validInput, project: "private-project" }; const before = structuredClone({ raw, input });
    sdk.setTrigger(async () => raw); const first = await handler()(input);
    for (const key of ["success", "enabled", "applied", "state", "signatureSamplingMode", "stabilityAvailable", "firstSignatureTriggerAttempted", "firstSignatureTriggerSucceeded", "firstSignatureResultParsed", "secondSignatureTriggerAttempted", "secondSignatureTriggerSucceeded", "secondSignatureResultParsed", "stableAcrossSamples", "signatureChanged"] as const) (first as Record<string, unknown>)[key] = "mutated";
    first.reasonCodes.push("mutated" as never); const second = await handler()(input);
    expect(second).toMatchObject({ success: true, state: "signature_stable", reasonCodes: ["signature_stable"], stableAcrossSamples: true, signatureChanged: false });
    expect({ raw, input }).toEqual(before);
  });

  it("returns fresh defensive results for disabled, invalid, and every failure category without leaking sources", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["disabled", async () => handler()(Symbol("private"))],
      ["invalid", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); return handler()({}); }],
      ["first-trigger", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => { throw { private: true }; }); return handler()(validInput); }],
      ["first-malformed", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => ({ ...phase5K(), signature: "bad" })); return handler()(validInput); }],
      ["first-unavailable", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); sdk.setTrigger(async () => unavailable("disabled")); return handler()(validInput); }],
      ["second-trigger", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : Promise.reject({ private: true })); return handler()(validInput); }],
      ["second-malformed", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : ({ ...phase5K(), signature: "bad" })); return handler()(validInput); }],
      ["second-unavailable", async () => { loadSkillConfig.mockReturnValue(enabledConfig()); let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : unavailable("disabled")); return handler()(validInput); }],
    ];
    for (const [name, run] of cases) {
      const first = await run(); const serialized = JSON.stringify(first); expect(serialized, name).not.toContain("private");
      const mutable = first as Record<string, unknown>; for (const key of Object.keys(mutable)) if (key !== "reasonCodes") mutable[key] = "mutated"; (mutable.reasonCodes as unknown[]).push("mutated");
      const second = await run(); expect(JSON.stringify(second), name).not.toContain("mutated"); expect(second).toHaveProperty("applied", false);
    }
  });

  it("does not mutate independent caller, builder, raw, thrown, or nested KV fixture sources", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const caller = { ...validInput, project: " /caller " }; const builder = { ...validInput, project: " /builder ", agentId: " agent " };
    const firstRaw = phase5K(signatures[0], { reason: "first-reason" }); const secondRaw = phase5K(signatures[3], { reason: "second-reason" }); const firstThrown = { marker: "first-thrown" }; const secondThrown = { marker: "second-thrown" };
    const before = structuredClone({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown });
    let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? firstRaw : secondRaw); await expect(handler()(caller)).resolves.toMatchObject({ state: "signature_drift" });
    buildSkillContextParityDriftSignatureStabilityRequest(builder); buildSkillContextParityDriftSignatureStabilityRequest(builder);
    expect({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown }).toEqual(before);
    calls = 0; sdk.setTrigger(async () => { if (++calls === 1) throw firstThrown; throw secondThrown; }); await handler()(validInput); expect({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown }).toEqual(before);
    calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : Promise.reject(secondThrown)); await handler()(validInput); expect({ caller, builder, firstRaw, secondRaw, firstThrown, secondThrown }).toEqual(before);
    const rows = [skill(), { ...skill(), id: "skill_two", steps: ["Run nested"], files: ["nested"], concepts: ["nested"], sourceObservationIds: ["nested"] }]; const rowsBefore = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
    registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(integrated as never);
    await integrated.functions.get("mem::skill-context-parity-drift-signature-stability-diagnostics")!(validInput); expect(rows).toEqual(rowsBefore);
  });

  it("runs the real Phase 5D-5L chain in the exact authorized no-budget and positive-budget order", async () => {
    const noBudget = ["mem::skill-context-parity-drift-signature-diagnostics", "mem::skill-context-parity-drift-shape-diagnostics", "mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"];
    const positive = ["mem::skill-context-parity-drift-signature-diagnostics", "mem::skill-context-parity-drift-shape-diagnostics", "mem::skill-context-parity-drift-scope-diagnostics", "mem::skill-context-parity-drift-attribution-diagnostics", "mem::skill-context-parity-stability-diagnostics", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall", "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall"];
    for (const [usedTokens, expected] of [[10, noBudget], [0, positive]] as const) {
      loadSkillConfig.mockReturnValue(enabledConfig(1000)); const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
      registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(integrated as never);
      await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-stability-diagnostics")!({ ...validInput, overallBudget: 10, usedTokens })).resolves.toMatchObject({ success: true, state: "signature_stable" });
      expect(integrated.requests.map((request) => request.function_id)).toEqual([...expected, ...expected]); expect(integrated.requests).toHaveLength(usedTokens === 10 ? 22 : 26); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-diagnostics")).toHaveLength(2); expect(kv.lists).toEqual(usedTokens === 10 ? [] : Array(8).fill(KV.skills)); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
    }
  });
});
