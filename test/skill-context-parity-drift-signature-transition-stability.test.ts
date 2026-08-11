import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityDriftSignatureTransitionStabilityRequest,
  evaluateSkillContextParityDriftSignatureTransitionStability,
  registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction,
} from "../src/functions/skill-context-parity-drift-signature-transition-stability.js";
import { registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction } from "../src/functions/skill-context-parity-drift-signature-transition.js";
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

type TransitionClass = "same_signature" | "stable_mismatch_variant_changed" | "observed_drift_variant_changed" | "stable_consistent_to_stable_mismatch" | "stable_consistent_to_observed_drift" | "stable_mismatch_to_stable_consistent" | "stable_mismatch_to_observed_drift" | "observed_drift_to_stable_consistent" | "observed_drift_to_stable_mismatch";

const transitionClasses: TransitionClass[] = [
  "same_signature", "stable_mismatch_variant_changed", "observed_drift_variant_changed",
  "stable_consistent_to_stable_mismatch", "stable_consistent_to_observed_drift",
  "stable_mismatch_to_stable_consistent", "stable_mismatch_to_observed_drift",
  "observed_drift_to_stable_consistent", "observed_drift_to_stable_mismatch",
];
const input = { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 };

function config(tokenBudget = 320) {
  return { enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3, recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget, promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2 };
}

function phase5M(transitionClass: TransitionClass = "same_signature", overrides: Record<string, unknown> = {}) {
  const same = transitionClass === "same_signature";
  const sameFamily = transitionClass === "stable_mismatch_variant_changed" || transitionClass === "observed_drift_variant_changed";
  return {
    success: true, enabled: true, applied: false,
    state: same ? "signature_unchanged" : "signature_transition",
    reasonCodes: [same ? "signature_unchanged" : "signature_transition_observed"],
    transitionSamplingMode: "sequential_double_signature_transition_sample_non_atomic",
    transitionAvailable: true,
    firstSignatureTriggerAttempted: true, firstSignatureTriggerSucceeded: true, firstSignatureResultParsed: true,
    secondSignatureTriggerAttempted: true, secondSignatureTriggerSucceeded: true, secondSignatureResultParsed: true,
    transitionClass, signatureChanged: !same, familyChanged: !same && !sameFamily,
    ...overrides,
  };
}

function unavailable(code: "context_disabled" | "invalid_input" | "first_signature_trigger_failure" | "invalid_first_signature_result" | "first_signature_classification_unavailable" | "second_signature_trigger_failure" | "invalid_second_signature_result" | "second_signature_classification_unavailable") {
  if (code === "context_disabled") return {
    success: true, enabled: false, applied: false, state: "disabled", reasonCodes: [code], transitionSamplingMode: "sequential_double_signature_transition_sample_non_atomic", transitionAvailable: false,
    firstSignatureTriggerAttempted: false, firstSignatureTriggerSucceeded: false, firstSignatureResultParsed: false,
    secondSignatureTriggerAttempted: false, secondSignatureTriggerSucceeded: false, secondSignatureResultParsed: false,
    transitionClass: null, signatureChanged: false, familyChanged: false,
  };
  const flags = code === "invalid_input" ? [false, false, false, false, false, false] :
    code === "first_signature_trigger_failure" ? [true, false, false, false, false, false] :
    code === "invalid_first_signature_result" ? [true, true, false, false, false, false] :
    code === "first_signature_classification_unavailable" ? [true, true, true, false, false, false] :
    code === "second_signature_trigger_failure" ? [true, true, true, true, false, false] :
    code === "invalid_second_signature_result" ? [true, true, true, true, true, false] : [true, true, true, true, true, true];
  return {
    success: false, enabled: true, applied: false, state: "failed", reasonCodes: [code], transitionSamplingMode: "sequential_double_signature_transition_sample_non_atomic", transitionAvailable: false,
    firstSignatureTriggerAttempted: flags[0], firstSignatureTriggerSucceeded: flags[1], firstSignatureResultParsed: flags[2],
    secondSignatureTriggerAttempted: flags[3], secondSignatureTriggerSucceeded: flags[4], secondSignatureResultParsed: flags[5],
    transitionClass: null, signatureChanged: false, familyChanged: false,
  };
}

function mockSdk() {
  const functions = new Map<string, (value: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let trigger: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | undefined;
  return { functions, requests, setTrigger(next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) { trigger = next; }, registerFunction(id: string, fn: (value: unknown) => Promise<unknown>) { functions.set(id, fn); }, async trigger(request: { function_id: string; payload: unknown }) { requests.push(request); return trigger ? trigger(request) : functions.get(request.function_id)!(request.payload); } };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = []; const gets: string[] = []; const writes: string[] = [];
  return { lists, gets, writes, list: async <T>(key: string): Promise<T[]> => { lists.push(key); return rows as T[]; }, get: async <T>(key: string): Promise<T | null> => { gets.push(key); return null; }, set: async () => { writes.push("set"); } };
}

function skill() {
  return { id: "skill_one", agentId: "default", project: "/repo", name: "Build", description: "Build safely", steps: ["Inspect"], files: ["src/a.ts"], concepts: ["testing"], sourceObservationIds: ["obs_one"], confidence: 0.9, evidenceCount: 2, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("skill context parity drift signature transition stability diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  beforeEach(() => { sdk = mockSdk(); loadSkillConfig.mockReset(); registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction(sdk as never); });
  const handler = () => sdk.functions.get("mem::skill-context-parity-drift-signature-transition-stability-diagnostics")!;

  it("registers immediately after Phase 5M without public registration or count changes", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source.indexOf("registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(sdk)")).toBeLessThan(source.indexOf("registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction(sdk)"));
    expect(source).not.toContain("api::skill-context-parity-drift-signature-transition-stability");
    expect(getAllTools()).toHaveLength(60);
    expect(source).toContain("REST API: 135 endpoints");
  });

  it("gates disabled execution before input handling or triggers", async () => {
    loadSkillConfig.mockReturnValue({ contextEnabled: false });
    await expect(handler()({ project: Symbol("bad") })).resolves.toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"], stabilityAvailable: false });
    expect(sdk.requests).toHaveLength(0);
  });

  it("validates the complete input boundary without triggering", async () => {
    loadSkillConfig.mockReturnValue(config());
    const invalid = [null, [], {}, { ...input, project: " " }, { ...input, agentId: {} }, { ...input, overallBudget: 0 }, { ...input, overallBudget: NaN }, { ...input, overallBudget: 1.5 }, { ...input, overallBudget: Infinity }, { ...input, usedTokens: -1 }, { ...input, usedTokens: Number.MAX_SAFE_INTEGER + 1 }, { ...input, selectedBlockCount: -1 }];
    for (const value of invalid) await expect(handler()(value)).resolves.toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_input"] });
    expect(sdk.requests).toHaveLength(0);
  });

  it("accepts max-safe numeric inputs and preserves normalized request boundaries", async () => {
    loadSkillConfig.mockReturnValue(config()); sdk.setTrigger(async () => phase5M());
    const source = { project: " /repo ", agentId: " agent ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER, ignored: "never" };
    await expect(handler()(source)).resolves.toMatchObject({ success: true, state: "transition_stable" });
    expect(sdk.requests).toHaveLength(2); expect(sdk.requests[0]).toEqual({ function_id: "mem::skill-context-parity-drift-signature-transition-diagnostics", payload: { project: "/repo", agentId: "agent", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: Number.MAX_SAFE_INTEGER, selectedBlockCount: Number.MAX_SAFE_INTEGER } });
    expect(sdk.requests[0]).not.toBe(sdk.requests[1]); expect(sdk.requests[0].payload).not.toBe(sdk.requests[1].payload); expect(source).toMatchObject({ project: " /repo ", agentId: " agent ", ignored: "never" });
  });

  it("builds fresh exact Phase 5M requests and omits blank agents", () => {
    const source = { ...input, agentId: " " }; const first = buildSkillContextParityDriftSignatureTransitionStabilityRequest(source); const second = buildSkillContextParityDriftSignatureTransitionStabilityRequest(source);
    expect(first).toEqual({ function_id: "mem::skill-context-parity-drift-signature-transition-diagnostics", payload: input }); expect(first).not.toBe(second); expect(first.payload).not.toBe(second.payload);
    (first.payload as Record<string, unknown>).project = "mutated"; expect(second.payload.project).toBe("/repo"); expect(source.agentId).toBe(" ");
  });

  it("strictly accepts all nine canonical Phase 5M transition classes", async () => {
    loadSkillConfig.mockReturnValue(config());
    for (const transitionClass of transitionClasses) { sdk.requests.length = 0; sdk.setTrigger(async () => phase5M(transitionClass)); const output = await handler()(input); expect(output).toMatchObject({ success: true, stabilityAvailable: true, state: "transition_stable", reasonCodes: ["transition_stable"], stableAcrossSamples: true, transitionChanged: false }); expect(sdk.requests).toHaveLength(2); }
  });

  it("evaluates all 81 ordered transition-class pairs", () => {
    let stable = 0; let drift = 0;
    for (const firstTransitionClass of transitionClasses) for (const secondTransitionClass of transitionClasses) {
      const output = evaluateSkillContextParityDriftSignatureTransitionStability({ firstTransitionClass, secondTransitionClass });
      if (firstTransitionClass === secondTransitionClass) { stable++; expect(output).toEqual({ stableAcrossSamples: true, transitionChanged: false }); } else { drift++; expect(output).toEqual({ stableAcrossSamples: false, transitionChanged: true }); }
    }
    expect({ stable, drift }).toEqual({ stable: 9, drift: 72 });
    expect(() => evaluateSkillContextParityDriftSignatureTransitionStability({ firstTransitionClass: "bad" as never, secondTransitionClass: "same_signature" })).toThrow();
    expect(() => evaluateSkillContextParityDriftSignatureTransitionStability({ firstTransitionClass: "same_signature", secondTransitionClass: "bad" as never })).toThrow();
  });

  it("returns transition drift only for unequal canonical samples", async () => {
    loadSkillConfig.mockReturnValue(config()); let calls = 0; sdk.setTrigger(async () => phase5M(transitionClasses[calls++ % transitionClasses.length]!));
    await expect(handler()(input)).resolves.toMatchObject({ success: true, state: "transition_drift", reasonCodes: ["transition_drift_observed"], stableAcrossSamples: false, transitionChanged: true });
  });

  it("fails closed for malformed, disabled, and every canonical failed Phase 5M sample in either position", async () => {
    loadSkillConfig.mockReturnValue(config());
    const unavailableCodes = ["context_disabled", "invalid_input", "first_signature_trigger_failure", "invalid_first_signature_result", "first_signature_classification_unavailable", "second_signature_trigger_failure", "invalid_second_signature_result", "second_signature_classification_unavailable"] as const;
    for (const raw of [{ ...phase5M(), extra: true }, { ...phase5M(), transitionSamplingMode: "bad" }, { ...phase5M(), transitionClass: "bad" }, ...unavailableCodes.map(unavailable)]) {
      sdk.requests.length = 0; sdk.setTrigger(async () => raw); const first = await handler()(input); expect(first.reasonCodes[0]).toMatch(/first_transition/); expect(sdk.requests).toHaveLength(1);
      let calls = 0; sdk.requests.length = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5M() : raw); const second = await handler()(input); expect(second.reasonCodes[0]).toMatch(/second_transition/); expect(sdk.requests).toHaveLength(2);
    }
  });

  it("maps every trigger failure without leaking the thrown value", async () => {
    loadSkillConfig.mockReturnValue(config());
    for (const thrown of [new Error("secret"), "secret", { secret: true }, null]) {
      sdk.setTrigger(async () => { throw thrown; }); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["first_transition_trigger_failure"], firstTransitionTriggerAttempted: true, secondTransitionTriggerAttempted: false });
      let calls = 0; sdk.setTrigger(async () => ++calls === 1 ? phase5M() : Promise.reject(thrown)); const output = await handler()(input); expect(output).toMatchObject({ reasonCodes: ["second_transition_trigger_failure"], secondTransitionTriggerAttempted: true }); expect(JSON.stringify(output)).not.toContain("secret");
    }
  });

  it("rejects every missing or extra Phase 5M field, scalar mismatch, and canonical contradiction", async () => {
    loadSkillConfig.mockReturnValue(config());
    const required = ["success", "enabled", "applied", "state", "reasonCodes", "transitionSamplingMode", "transitionAvailable", "firstSignatureTriggerAttempted", "firstSignatureTriggerSucceeded", "firstSignatureResultParsed", "secondSignatureTriggerAttempted", "secondSignatureTriggerSucceeded", "secondSignatureResultParsed", "transitionClass", "signatureChanged", "familyChanged"];
    const malformed: unknown[] = required.map((key) => { const value = phase5M(); delete (value as Record<string, unknown>)[key]; return value; });
    malformed.push(
      { ...phase5M(), unexpected: true },
      { ...phase5M(), reason: null },
      { ...phase5M(), success: "true" },
      { ...phase5M(), enabled: 1 },
      { ...phase5M(), applied: true },
      { ...phase5M(), state: "unknown" },
      { ...phase5M(), reasonCodes: [] },
      { ...phase5M(), reasonCodes: ["signature_unchanged", "extra"] },
      { ...phase5M(), reasonCodes: ["unknown"] },
      { ...phase5M(), transitionSamplingMode: "wrong" },
      { ...phase5M(), transitionAvailable: "true" },
      { ...phase5M(), firstSignatureTriggerAttempted: false },
      { ...phase5M(), transitionClass: null },
      { ...phase5M(), signatureChanged: true },
      { ...phase5M(), familyChanged: true },
      { ...phase5M("stable_mismatch_variant_changed"), familyChanged: true },
      { ...phase5M("stable_consistent_to_stable_mismatch"), familyChanged: false },
      { ...phase5M("stable_consistent_to_stable_mismatch"), state: "signature_unchanged" },
      { ...phase5M("stable_consistent_to_stable_mismatch"), reasonCodes: ["signature_unchanged"] },
    );
    for (const raw of malformed) { sdk.requests.length = 0; sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_first_transition_result"] }); expect(sdk.requests).toHaveLength(1); }
  });

  it("rejects every canonical failed-result flag or reason contradiction", async () => {
    loadSkillConfig.mockReturnValue(config());
    const codes = ["invalid_input", "first_signature_trigger_failure", "invalid_first_signature_result", "first_signature_classification_unavailable", "second_signature_trigger_failure", "invalid_second_signature_result", "second_signature_classification_unavailable"] as const;
    const flags = ["firstSignatureTriggerAttempted", "firstSignatureTriggerSucceeded", "firstSignatureResultParsed", "secondSignatureTriggerAttempted", "secondSignatureTriggerSucceeded", "secondSignatureResultParsed"] as const;
    for (const code of codes) {
      const canonical = unavailable(code);
      for (const flag of flags) {
        const raw = { ...canonical, [flag]: !(canonical as Record<string, boolean>)[flag] };
        sdk.requests.length = 0; sdk.setTrigger(async () => raw); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_first_transition_result"] }); expect(sdk.requests).toHaveLength(1);
      }
      for (const reasonCodes of [[], [code, code], ["unknown"]]) {
        sdk.requests.length = 0; sdk.setTrigger(async () => ({ ...canonical, reasonCodes })); await expect(handler()(input)).resolves.toMatchObject({ reasonCodes: ["invalid_first_transition_result"] }); expect(sdk.requests).toHaveLength(1);
      }
    }
  });

  it("uses the real existing Phase 5D-5N chain with exact exhausted and positive budget counts", async () => {
    for (const [usedTokens, expectedTriggers, expectedLists] of [[10, 46, 0], [0, 54, 16]] as const) {
      loadSkillConfig.mockReturnValue(config(1000)); const rows = [skill()]; const before = structuredClone(rows); const kv = mockKV(rows); const integrated = mockSdk();
      registerSkillContextAdmissionExplainFunction(integrated as never, kv as never); registerSkillRecallFunction(integrated as never, kv as never); registerSkillContextRuntimeExplainFunction(integrated as never); registerSkillContextParityDiagnosticsFunction(integrated as never); registerSkillContextParityStabilityDiagnosticsFunction(integrated as never); registerSkillContextParityDriftAttributionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftScopeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftShapeDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureTransitionDiagnosticsFunction(integrated as never); registerSkillContextParityDriftSignatureTransitionStabilityDiagnosticsFunction(integrated as never);
      await expect(integrated.functions.get("mem::skill-context-parity-drift-signature-transition-stability-diagnostics")!({ ...input, overallBudget: 10, usedTokens })).resolves.toMatchObject({ success: true });
      expect(integrated.requests).toHaveLength(expectedTriggers); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-transition-diagnostics")).toHaveLength(2); expect(integrated.requests.filter((request) => request.function_id === "mem::skill-context-parity-drift-signature-stability-diagnostics")).toHaveLength(0); expect(kv.lists).toEqual(Array(expectedLists).fill(KV.skills)); expect(kv.gets).toEqual([]); expect(kv.writes).toEqual([]); expect(rows).toEqual(before);
    }
  });

  it("returns defensive aggregate-only values without leaking classes, inputs, or raw samples", async () => {
    loadSkillConfig.mockReturnValue(config()); const raw = phase5M("stable_consistent_to_stable_mismatch", { reason: "private" }); sdk.setTrigger(async () => raw);
    const caller = { ...input, project: "private-project", agentId: "private-agent" }; const first = await handler()(caller); const pristine = structuredClone(first); first.reasonCodes.push("mutated" as never); (first as Record<string, unknown>).state = "mutated"; const second = await handler()(caller);
    expect(second).toEqual(pristine); expect(second.reasonCodes).not.toBe(first.reasonCodes); const serialized = JSON.stringify(second); for (const forbidden of ["stable_consistent_to_stable_mismatch", "v1:", "private-project", "private-agent", "private"]) expect(serialized).not.toContain(forbidden); expect(raw.reason).toBe("private");
  });
});
