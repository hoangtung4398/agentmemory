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

  it("gates before validation and rejects invalid input without calling Phase 5K", async () => {
    await expect(handler()(Symbol("private"))).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"] }); expect(sdk.requests).toEqual([]);
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalid = [null, [], "x", 1, true, {}, { ...validInput, project: "   " }, { ...validInput, agentId: 1 }, { ...validInput, overallBudget: 0 }, { ...validInput, usedTokens: -1 }, { ...validInput, selectedBlockCount: 1.5 }, { ...validInput, overallBudget: Infinity }];
    for (const value of invalid) await expect(handler()(value)).resolves.toMatchObject({ state: "failed", reasonCodes: ["invalid_input"], firstSignatureTriggerAttempted: false });
    expect(sdk.requests).toEqual([]);
  });

  it("builds fresh equal requests, preserves supplied strings, omits blank agents, strips extras, and does not mutate input", () => {
    const input = { ...validInput, project: " /repo ", agentId: " agent ", query: "hidden", history: ["hidden"] }; const before = structuredClone(input);
    const first = buildSkillContextParityDriftSignatureStabilityRequest(input); const second = buildSkillContextParityDriftSignatureStabilityRequest(input);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-signature-diagnostics", payload: { project: " /repo ", agentId: " agent ", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 } });
    expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload); (first.payload as Record<string, unknown>).project = "mutated";
    expect(second.payload.project).toBe(" /repo "); expect(buildSkillContextParityDriftSignatureStabilityRequest({ ...validInput, agentId: "  " }).payload).not.toHaveProperty("agentId"); expect(input).toEqual(before);
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

  it("evaluates every equality and inequality pair purely with inverse flags", () => {
    for (const firstSignature of signatures) for (const secondSignature of signatures) {
      const input = { firstSignature, secondSignature }; const before = structuredClone(input); const output = evaluateSkillContextParityDriftSignatureStability(input);
      expect(output.stableAcrossSamples).toBe(firstSignature === secondSignature); expect(output.signatureChanged).toBe(firstSignature !== secondSignature); expect(output.signatureChanged).toBe(!output.stableAcrossSamples); expect(input).toEqual(before);
    }
  });

  it("fails fast for all first-sample failures and maps all second-sample failure positions", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const thrown of [new Error("private"), "private", { private: true }, null]) { sdk.setTrigger(async () => { throw thrown; }); await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["first_signature_trigger_failure"], firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: false, secondSignatureTriggerAttempted: false }); }
    let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : (() => { throw new Error("private"); })());
    await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["second_signature_trigger_failure"], firstSignatureResultParsed: true, secondSignatureTriggerAttempted: true, secondSignatureTriggerSucceeded: false });
    calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : { ...phase5K(), signature: "bad" });
    await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["invalid_second_signature_result"], secondSignatureTriggerSucceeded: true, secondSignatureResultParsed: false });
    calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5K() : unavailable("failed"));
    await expect(handler()(validInput)).resolves.toMatchObject({ reasonCodes: ["second_signature_classification_unavailable"], secondSignatureResultParsed: true });
  });

  it("reports aggregate stability only, detects same-state and cross-state drift, and never leaks private data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const outputFor = async (first: unknown, second: unknown) => { let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? first : second); return handler()({ ...validInput, project: "private-project", agentId: "private-agent" }); };
    await expect(outputFor(phase5K(signatures[1]), phase5K(signatures[2]))).resolves.toMatchObject({ state: "signature_drift", reasonCodes: ["signature_drift_observed"], stableAcrossSamples: false, signatureChanged: true });
    const output = await outputFor(phase5K(signatures[0]), phase5K(signatures[3], { reason: "private-reason" })); const serialized = JSON.stringify(output);
    for (const marker of ["v1:", "private", "stable_consistent", "observed_drift", "payload", "project", "agent"]) expect(serialized).not.toContain(marker);
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

  it("runs the real Phase 5D-5L chain at the no-budget and positive-budget boundaries without mutating KV fixtures", async () => {
    for (const [usedTokens, expectedTriggers, expectedLists] of [[10, 22, 0], [0, 26, 8]] as const) {
      loadSkillConfig.mockReturnValue(enabledConfig(1000)); const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
      registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureStabilityDiagnosticsFunction(integrated as never);
      await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-stability-diagnostics")!({ ...validInput, overallBudget: 10, usedTokens })).resolves.toMatchObject({ success: true, state: "signature_stable" });
      expect(integrated.requests).toHaveLength(expectedTriggers); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-diagnostics")).toHaveLength(2); expect(kv.lists).toHaveLength(expectedLists); expect(kv.lists.every((key) => key === KV.skills)).toBe(true); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
    }
  });
});
