import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));

vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityStabilityRequests,
  evaluateSkillContextParityStability,
  registerSkillContextParityStabilityDiagnosticsFunction,
} from "../src/functions/skill-context-parity-stability.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillContextParityDiagnosticsFunction } from "../src/functions/skill-context-parity.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillContextParityDiagnosticsResult,
  SkillContextParityMismatchCode,
  SkillContextParitySnapshot,
  SkillContextParityStabilityDiagnosticsResult,
} from "../src/types.js";

function enabledConfig(tokenBudget = 320) {
  return {
    enabled: true, diagnosticsEnabled: true, diagnosticsLimit: 50, recallEnabled: true, recallLimit: 3,
    recallMinConfidence: 0.7, contextEnabled: true, contextTokenBudget: tokenBudget,
    promotionEnabled: false, promotionMinStrength: 0.7, promotionMinEvidence: 2,
  };
}

function snapshot(overrides: Partial<SkillContextParitySnapshot> = {}): SkillContextParitySnapshot {
  return {
    success: true, enabled: true, state: "admitted", overallBudget: 1000, usedTokensBeforeSkill: 0,
    selectedBlockCountBeforeSkill: 0, configuredSkillTokenBudget: 320, separatorTokens: 0,
    remainingOverallBudget: 1000, effectiveSkillTokenBudget: 320, effectiveRecallLimit: 3,
    recallAttempted: true, recalledAdvisoryCount: 1, packedCount: 1, omittedCount: 0, packedTokens: 100,
    sectionCreated: true, sectionAdmitted: true, projectedUsedTokens: 100, projectedBlockCount: 1, ...overrides,
  };
}

function parityResult(
  direct = snapshot(),
  runtime = snapshot(),
  overrides: Record<string, unknown> = {},
): SkillContextParityDiagnosticsResult {
  const mismatchCodes: SkillContextParityMismatchCode[] = [];
  const consistent = true;
  return {
    success: true, enabled: true, applied: false, state: "consistent", reasonCodes: ["paths_consistent"],
    comparisonMode: "sequential_best_effort_non_atomic", comparisonAvailable: true, consistent,
    directTriggerAttempted: true, directTriggerSucceeded: true, directResultParsed: true,
    runtimeTriggerAttempted: true, runtimeTriggerSucceeded: true, runtimeResultParsed: true,
    mismatchCodes, direct, runtime, ...overrides,
  } as SkillContextParityDiagnosticsResult;
}

function mismatchResult(
  direct = snapshot(),
  runtime = snapshot({ packedTokens: 101 }),
): SkillContextParityDiagnosticsResult {
  return parityResult(direct, runtime, {
    state: "mismatch", reasonCodes: ["paths_mismatch"], consistent: false, mismatchCodes: ["packed_tokens_mismatch"],
  });
}

type UnavailableFailure = "direct_trigger_failure" | "invalid_direct_result" | "runtime_trigger_failure" | "invalid_runtime_result";

function unavailableResult(directFailure?: Extract<UnavailableFailure, `direct_${string}`>, runtimeFailure?: Extract<UnavailableFailure, `runtime_${string}`>): SkillContextParityDiagnosticsResult {
  const direct = directFailure ? null : snapshot();
  const runtime = runtimeFailure ? null : snapshot();
  return parityResult(snapshot(), snapshot(), {
    success: false, enabled: true, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [],
    reasonCodes: [directFailure, runtimeFailure].filter((code): code is UnavailableFailure => Boolean(code)),
    directTriggerAttempted: true,
    directTriggerSucceeded: directFailure !== "direct_trigger_failure",
    directResultParsed: !directFailure,
    runtimeTriggerAttempted: true,
    runtimeTriggerSucceeded: runtimeFailure !== "runtime_trigger_failure",
    runtimeResultParsed: !runtimeFailure,
    direct,
    runtime,
  });
}

function mockSdk() {
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  const requests: Array<{ function_id: string; payload: unknown }> = [];
  let implementation: ((request: { function_id: string; payload: unknown }) => Promise<unknown>) | null = null;
  return {
    functions,
    requests,
    setTrigger: (next: (request: { function_id: string; payload: unknown }) => Promise<unknown>) => { implementation = next; },
    registerFunction: (id: string, handler: (data: unknown) => Promise<unknown>) => functions.set(id, handler),
    trigger: async (request: { function_id: string; payload: unknown }): Promise<unknown> => {
      requests.push(request);
      if (implementation) return implementation(request);
      const handler = functions.get(request.function_id);
      if (!handler) throw new Error("missing handler");
      return handler(request.payload);
    },
  };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = [];
  const gets: string[] = [];
  const writes: string[] = [];
  return {
    lists, gets, writes,
    list: async <T>(scope: string): Promise<T[]> => { lists.push(scope); return rows as T[]; },
    get: async <T>(scope: string): Promise<T | null> => { gets.push(scope); return null; },
    set: async () => { writes.push("set"); }, update: async () => { writes.push("update"); }, delete: async () => { writes.push("delete"); },
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"],
    expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent", files: [], concepts: [],
    confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0, failureCount: 0,
    sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [], sourceSessionIds: [],
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", status: "active", version: 1, ...overrides,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, ...overrides };
}

describe("skill context parity stability diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityStabilityDiagnosticsFunction(sdk as never);
  });

  afterEach(() => vi.restoreAllMocks());

  async function diagnose(input: unknown): Promise<SkillContextParityStabilityDiagnosticsResult> {
    return sdk.functions.get("mem::skill-context-parity-stability-diagnostics")!(input) as Promise<SkillContextParityStabilityDiagnosticsResult>;
  }

  it("registers after Phase 5F, remains internal, and preserves public counts", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const names = [
      "registerSkillRecallFunction(sdk, kv)", "registerSkillRecallExplainFunction(sdk, kv)",
      "registerSkillRecallDiagnosticsFunction(sdk, kv)", "registerSkillContextExplainFunction(sdk, kv)",
      "registerSkillContextAdmissionExplainFunction(sdk, kv)", "registerSkillContextRuntimeExplainFunction(sdk)",
      "registerSkillContextParityDiagnosticsFunction(sdk)", "registerSkillContextParityStabilityDiagnosticsFunction(sdk)",
    ];
    const positions = names.map((name) => index.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("stability"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(diagnose(null)).resolves.toMatchObject({
      success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"], sampleCount: 2,
      firstTriggerAttempted: false, secondTriggerAttempted: false, first: null, second: null,
      stableAcrossSamples: false, repeatableMismatch: false,
    });
    expect(sdk.requests).toEqual([]);
  });

  it("builds two fresh identical parity requests without forwarding ignored values", () => {
    const input = { project: " /repo ", agentId: " agent ", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 };
    const before = structuredClone(input);
    const first = buildSkillContextParityStabilityRequests(input);
    const second = buildSkillContextParityStabilityRequests(input);
    expect(first).toEqual({
      first: { function_id: "mem::skill-context-parity-diagnostics", payload: input },
      second: { function_id: "mem::skill-context-parity-diagnostics", payload: input },
    });
    expect(second).toEqual(first);
    expect(first.first).not.toBe(first.second);
    expect(first.first.payload).not.toBe(first.second.payload);
    expect(second.first).not.toBe(first.first);
    expect(second.second.payload).not.toBe(first.second.payload);
    const mutable = first as unknown as { first: { function_id: string; payload: Record<string, unknown> }; second: { function_id: string; payload: Record<string, unknown> } };
    for (const request of [mutable.first, mutable.second]) {
      request.function_id = "tampered";
      request.payload.project = "tampered";
      request.payload.agentId = "tampered";
      request.payload.overallBudget = 2;
      request.payload.usedTokens = 2;
      request.payload.selectedBlockCount = 2;
    }
    expect(input).toEqual(before);
    expect(buildSkillContextParityStabilityRequests(input)).toEqual(second);
    const withoutAgent = buildSkillContextParityStabilityRequests({ project: "/repo", agentId: "   ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: 0 });
    for (const request of [withoutAgent.first, withoutAgent.second]) {
      expect(request.payload).not.toHaveProperty("agentId");
      for (const ignored of ["query", "files", "concepts", "limit", "sampleCount", "retryCount"]) expect(request.payload).not.toHaveProperty(ignored);
    }
  });

  it("gates before validation and rejects the complete caller matrix without triggers", async () => {
    await expect(diagnose(Symbol("private"))).resolves.toMatchObject({ success: true, state: "disabled" });
    expect(sdk.requests).toEqual([]);
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [undefined, null, "1", true, false, {}, [], Number.NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1];
    const invalid = [
      null, [], "x", 1, true, false, Symbol("input"), {}, { project: "", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", agentId: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      ...invalidNumbers.map((overallBudget) => ({ project: "/repo", overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ project: "/repo", overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount })),
    ];
    for (const input of invalid) {
      sdk.requests.length = 0;
      await expect(diagnose(input)).resolves.toMatchObject({
        success: false, state: "failed", reason: "invalid skill context parity stability diagnostics input", reasonCodes: ["invalid_input"],
        firstTriggerAttempted: false, secondTriggerAttempted: false,
      });
      expect(sdk.requests).toEqual([]);
    }
  });

  it("samples exactly twice in sequence and independently classifies stable consistency", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    sdk.setTrigger(async () => parityResult());
    const result = await diagnose(validInput({ project: "private-project", agentId: "private-agent", usedTokens: 1001 }));
    expect(sdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-diagnostics", "mem::skill-context-parity-diagnostics",
    ]);
    expect(sdk.requests[0].payload).toEqual(sdk.requests[1].payload);
    expect(sdk.requests[0].payload).not.toBe(sdk.requests[1].payload);
    expect(result).toMatchObject({
      success: true, state: "stable_consistent", reasonCodes: ["stable_consistency_observed"],
      samplingMode: "sequential_double_sample_non_atomic", sampleCount: 2,
      stableAcrossSamples: true, repeatableMismatch: false,
      first: { comparisonAvailable: true, consistent: true, mismatchCodes: [] },
      second: { comparisonAvailable: true, consistent: true, mismatchCodes: [] },
      directDriftCodes: [], runtimeDriftCodes: [],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("attempts the second sample after every first-sample failure and preserves canonical failure order", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const cases: Array<[string, unknown, unknown, string[]]> = [
      ["first throw", new Error("first-private"), parityResult(), ["first_trigger_failure"]],
      ["first malformed", null, parityResult(), ["invalid_first_result"]],
      ["first unavailable", parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure"], direct: null, runtime: snapshot(), directTriggerSucceeded: false, directResultParsed: false }), parityResult(), ["first_comparison_unavailable"]],
      ["both failures", "first-private", [], ["first_trigger_failure", "invalid_second_result"]],
    ];
    for (const [label, first, second, reasonCodes] of cases) {
      let call = 0;
      sdk.requests.length = 0;
      sdk.setTrigger(async () => {
        const value = call++ === 0 ? first : second;
        if (value instanceof Error || label === "both failures" && call === 1) throw value;
        return value;
      });
      const result = await diagnose(validInput());
      expect(result.reasonCodes, label).toEqual(reasonCodes);
      expect(sdk.requests, label).toHaveLength(2);
      expect(result.firstTriggerAttempted, label).toBe(true);
      expect(result.secondTriggerAttempted, label).toBe(true);
      expect(JSON.stringify(result), label).not.toContain("private");
    }
  });

  it("classifies thrown and unavailable sample permutations without leaking raw values", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const failures: Array<[string, unknown, string]> = [
      ["error", new Error("error-private"), "first_trigger_failure"], ["string", "string-private", "first_trigger_failure"],
      ["object", { error: "object-private" }, "invalid_first_result"], ["null", null, "invalid_first_result"],
      ["unavailable", unavailableResult("invalid_direct_result"), "first_comparison_unavailable"],
    ];
    for (const [label, value, expected] of failures) {
      for (const position of ["first", "second"] as const) {
        let call = 0;
        sdk.setTrigger(async () => {
          const selected = call++ === 0 ? (position === "first" ? value : parityResult()) : (position === "second" ? value : parityResult());
          if (selected instanceof Error || selected === "string-private") throw selected;
          return selected;
        });
        const result = await diagnose(validInput());
        expect(result.reasonCodes, `${label}/${position}`).toEqual([position === "first" ? expected : expected.replace("first_", "second_")]);
        expect(result.firstTriggerAttempted, `${label}/${position}`).toBe(true);
        expect(result.secondTriggerAttempted, `${label}/${position}`).toBe(true);
        expect(JSON.stringify(result), `${label}/${position}`).not.toContain("private");
      }
    }
    let call = 0;
    sdk.setTrigger(async () => {
      const selected = call++ === 0 ? new Error("first-private") : unavailableResult(undefined, "runtime_trigger_failure");
      if (selected instanceof Error) throw selected;
      return selected;
    });
    await expect(diagnose(validInput())).resolves.toMatchObject({
      success: false, state: "failed", reasonCodes: ["first_trigger_failure", "second_comparison_unavailable"],
      firstTriggerSucceeded: false, firstResultParsed: false, secondTriggerSucceeded: true, secondResultParsed: true,
    });
  });

  it("strictly rejects malformed Phase 5F results while accepting valid unavailable results", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const malformed = [
      null, [], "x", 1, true, { ...parityResult(), applied: true }, { ...parityResult(), state: "unknown" },
      { ...parityResult(), comparisonMode: "wrong" }, { ...parityResult(), mismatchCodes: ["packed_tokens_mismatch", "path_state_mismatch"] },
      { ...parityResult(), mismatchCodes: ["packed_tokens_mismatch", "packed_tokens_mismatch"] },
      { ...parityResult(), directTriggerAttempted: "true" }, { ...parityResult(), direct: { ...snapshot(), packedTokens: Number.NaN } },
      { ...parityResult(), runtime: { ...snapshot(), projectedBlockCount: 1.5 } },
      { ...parityResult(), state: "consistent", consistent: false }, { ...parityResult(), state: "mismatch", consistent: false, mismatchCodes: [] },
    ];
    for (const value of malformed) {
      sdk.requests.length = 0;
      sdk.setTrigger(async () => value);
      const result = await diagnose(validInput());
      expect(result).toMatchObject({ success: false, state: "failed", reasonCodes: ["invalid_first_result", "invalid_second_result"] });
      expect(sdk.requests).toHaveLength(2);
    }
    const unavailable = unavailableResult("direct_trigger_failure");
    sdk.setTrigger(async () => unavailable);
    await expect(diagnose(validInput())).resolves.toMatchObject({
      success: false, state: "failed", reasonCodes: ["first_comparison_unavailable", "second_comparison_unavailable"],
    });
  });

  it("enforces every unavailable Phase 5F path invariant and rejects malformed samples independently", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const validUnavailable = [
      unavailableResult("direct_trigger_failure"), unavailableResult("invalid_direct_result"),
      unavailableResult(undefined, "runtime_trigger_failure"), unavailableResult(undefined, "invalid_runtime_result"),
      unavailableResult("direct_trigger_failure", "invalid_runtime_result"),
    ];
    for (const value of validUnavailable) {
      sdk.setTrigger(async () => value);
      await expect(diagnose(validInput())).resolves.toMatchObject({
        success: false, state: "failed", reasonCodes: ["first_comparison_unavailable", "second_comparison_unavailable"],
        firstResultParsed: true, secondResultParsed: true,
      });
    }
    const invalid = [
      parityResult(snapshot(), snapshot(), { success: true, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure"], direct: null, directTriggerSucceeded: false, directResultParsed: false }),
      parityResult(snapshot(), snapshot(), { success: false, enabled: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure"], direct: null, directTriggerSucceeded: false, directResultParsed: false }),
      parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["paths_consistent"], direct: null, directTriggerSucceeded: false, directResultParsed: false }),
      parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure", "invalid_direct_result"], direct: null, directTriggerSucceeded: false, directResultParsed: false }),
      parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure"], direct: snapshot(), directTriggerSucceeded: false, directResultParsed: true }),
      parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["invalid_runtime_result"], runtime: null, runtimeTriggerAttempted: true, runtimeTriggerSucceeded: false, runtimeResultParsed: false }),
      parityResult(snapshot(), snapshot(), { success: false, state: "failed", comparisonAvailable: false, consistent: false, mismatchCodes: [], reasonCodes: ["direct_trigger_failure"], direct: null, directTriggerAttempted: false, directTriggerSucceeded: false, directResultParsed: false }),
    ];
    for (const value of invalid) {
      for (const [position, valid] of [["first", parityResult()], ["second", parityResult()]] as const) {
        sdk.requests.length = 0;
        sdk.setTrigger(async () => sdk.requests.length === 1 ? (position === "first" ? value : valid) : (position === "second" ? value : valid));
        const result = await diagnose(validInput());
        expect(result.reasonCodes).toEqual(position === "first" ? ["invalid_first_result"] : ["invalid_second_result"]);
        expect(result.firstTriggerAttempted).toBe(true);
        expect(result.secondTriggerAttempted).toBe(true);
      }
    }
  });

  it("strictly parses every Phase 5F top-level field and both aggregate snapshots", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const topLevelMutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.applied = true; }, (value) => { delete value.applied; },
      (value) => { value.state = "unknown"; }, (value) => { value.comparisonMode = "atomic"; },
      (value) => { value.success = "true"; }, (value) => { value.enabled = "true"; },
      (value) => { value.comparisonAvailable = "true"; }, (value) => { value.consistent = "true"; },
      (value) => { value.directTriggerAttempted = "true"; }, (value) => { value.directTriggerSucceeded = "true"; },
      (value) => { value.directResultParsed = "true"; }, (value) => { value.runtimeTriggerAttempted = "true"; },
      (value) => { value.runtimeTriggerSucceeded = "true"; }, (value) => { value.runtimeResultParsed = "true"; },
      (value) => { value.reasonCodes = ["paths_mismatch", "paths_consistent"]; },
      (value) => { value.reasonCodes = ["paths_consistent", "paths_consistent"]; },
      (value) => { value.reasonCodes = ["unknown_code"]; }, (value) => { value.mismatchCodes = "bad"; },
      (value) => { value.direct = []; }, (value) => { value.runtime = []; },
    ];
    const requiredTopLevel = [
      "applied", "state", "comparisonMode", "success", "enabled", "comparisonAvailable", "consistent",
      "directTriggerAttempted", "directTriggerSucceeded", "directResultParsed", "runtimeTriggerAttempted",
      "runtimeTriggerSucceeded", "runtimeResultParsed", "reasonCodes", "mismatchCodes", "direct", "runtime",
    ];
    const integerFields = [
      "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill", "configuredSkillTokenBudget", "separatorTokens",
      "remainingOverallBudget", "effectiveSkillTokenBudget", "effectiveRecallLimit", "recalledAdvisoryCount", "packedCount",
      "omittedCount", "packedTokens", "projectedUsedTokens", "projectedBlockCount",
    ] as const;
    const invalidNumbers = [undefined, null, [], 1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, "1", true];
    for (const mutate of topLevelMutations) {
      for (const position of ["first", "second"] as const) {
        const malformed = parityResult() as unknown as Record<string, unknown>;
        mutate(malformed);
        let call = 0;
        sdk.setTrigger(async () => call++ === 0 ? (position === "first" ? malformed : parityResult()) : (position === "second" ? malformed : parityResult()));
        await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: position === "first" ? ["invalid_first_result"] : ["invalid_second_result"] });
      }
    }
    for (const field of requiredTopLevel) {
      const malformed = parityResult() as unknown as Record<string, unknown>;
      delete malformed[field];
      sdk.setTrigger(async () => malformed);
      await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_first_result", "invalid_second_result"] });
    }
    for (const path of ["direct", "runtime"] as const) {
      for (const field of integerFields) {
        for (const invalid of invalidNumbers) {
          const malformed = parityResult() as unknown as Record<string, unknown>;
          (malformed[path] as Record<string, unknown>)[field] = invalid;
          sdk.setTrigger(async () => malformed);
          await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_first_result", "invalid_second_result"] });
        }
      }
      for (const field of ["success", "enabled", "recallAttempted", "sectionCreated", "sectionAdmitted"] as const) {
        for (const invalid of [undefined, null, [], "true", 1]) {
          const malformed = parityResult() as unknown as Record<string, unknown>;
          (malformed[path] as Record<string, unknown>)[field] = invalid;
          sdk.setTrigger(async () => malformed);
          await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_first_result", "invalid_second_result"] });
        }
      }
      for (const invalid of [undefined, null, [], "unknown"]) {
        const unknownState = parityResult() as unknown as Record<string, unknown>;
        (unknownState[path] as Record<string, unknown>).state = invalid;
        sdk.setTrigger(async () => unknownState);
        await expect(diagnose(validInput())).resolves.toMatchObject({ reasonCodes: ["invalid_first_result", "invalid_second_result"] });
      }
    }
  });

  it("evaluates stable mismatch and every observed-drift category without mutation", () => {
    const consistent = { summary: { success: true, enabled: true, state: "consistent" as const, comparisonAvailable: true, consistent: true, mismatchCodes: [] }, direct: snapshot(), runtime: snapshot() };
    const mismatch = { summary: { success: true, enabled: true, state: "mismatch" as const, comparisonAvailable: true, consistent: false, mismatchCodes: ["packed_tokens_mismatch" as const] }, direct: snapshot(), runtime: snapshot({ packedTokens: 101 }) };
    const before = structuredClone({ consistent, mismatch });
    expect(evaluateSkillContextParityStability(consistent, consistent)).toMatchObject({ state: "stable_consistent", stableAcrossSamples: true, repeatableMismatch: false });
    expect(evaluateSkillContextParityStability(mismatch, mismatch)).toMatchObject({ state: "stable_mismatch", stableAcrossSamples: true, repeatableMismatch: true });
    const directDrift = { ...consistent, direct: snapshot({ packedTokens: 99 }) };
    const runtimeDrift = { ...consistent, runtime: snapshot({ packedTokens: 98 }) };
    const dualDrift = { ...consistent, direct: snapshot({ packedTokens: 97 }), runtime: snapshot({ packedTokens: 96 }) };
    for (const sample of [directDrift, runtimeDrift, dualDrift, mismatch, { ...mismatch, summary: consistent.summary }]) {
      expect(evaluateSkillContextParityStability(consistent, sample).state).toBe("observed_drift");
    }
    expect({ consistent, mismatch }).toEqual(before);
  });

  it("reports exact direct and runtime drift codes for every parity snapshot field", () => {
    const consistent = { summary: { success: true, enabled: true, state: "consistent" as const, comparisonAvailable: true, consistent: true, mismatchCodes: [] }, direct: snapshot(), runtime: snapshot() };
    const fields: Array<[keyof SkillContextParitySnapshot, SkillContextParityMismatchCode]> = [
      ["success", "path_success_mismatch"], ["enabled", "path_enabled_mismatch"], ["state", "path_state_mismatch"],
      ["overallBudget", "overall_budget_mismatch"], ["usedTokensBeforeSkill", "used_tokens_mismatch"], ["selectedBlockCountBeforeSkill", "selected_block_count_mismatch"],
      ["configuredSkillTokenBudget", "configured_skill_budget_mismatch"], ["separatorTokens", "separator_tokens_mismatch"], ["remainingOverallBudget", "remaining_budget_mismatch"],
      ["effectiveSkillTokenBudget", "effective_skill_budget_mismatch"], ["effectiveRecallLimit", "effective_recall_limit_mismatch"], ["recallAttempted", "recall_attempt_mismatch"],
      ["recalledAdvisoryCount", "recalled_advisory_count_mismatch"], ["packedCount", "packed_count_mismatch"], ["omittedCount", "omitted_count_mismatch"],
      ["packedTokens", "packed_tokens_mismatch"], ["sectionCreated", "section_created_mismatch"], ["sectionAdmitted", "section_admitted_mismatch"],
      ["projectedUsedTokens", "projected_used_tokens_mismatch"], ["projectedBlockCount", "projected_block_count_mismatch"],
    ];
    for (const [field, expected] of fields) {
      const original = consistent.direct[field];
      const changed = typeof original === "boolean" ? !original : field === "state" ? "rejected_outer_budget" : original + 1;
      const direct = { ...consistent, direct: snapshot({ [field]: changed } as Partial<SkillContextParitySnapshot>) };
      const runtime = { ...consistent, runtime: snapshot({ [field]: changed } as Partial<SkillContextParitySnapshot>) };
      expect(evaluateSkillContextParityStability(consistent, direct)).toMatchObject({
        state: "observed_drift", directDriftCodes: [expected], runtimeDriftCodes: [], stableAcrossSamples: false, repeatableMismatch: false,
      });
      expect(evaluateSkillContextParityStability(consistent, runtime)).toMatchObject({
        state: "observed_drift", directDriftCodes: [], runtimeDriftCodes: [expected], stableAcrossSamples: false, repeatableMismatch: false,
      });
    }
    const changed = { ...consistent, direct: snapshot({ packedTokens: 101, projectedBlockCount: 2 }), runtime: snapshot({ enabled: false, packedTokens: 102 }) };
    expect(evaluateSkillContextParityStability(consistent, changed)).toEqual({
      state: "observed_drift", directDriftCodes: ["packed_tokens_mismatch", "projected_block_count_mismatch"],
      runtimeDriftCodes: ["path_enabled_mismatch", "packed_tokens_mismatch"], stableAcrossSamples: false, repeatableMismatch: false,
    });
    const changedMismatchCodes = { summary: { success: true, enabled: true, state: "mismatch" as const, comparisonAvailable: true, consistent: false, mismatchCodes: ["packed_tokens_mismatch" as const] }, direct: snapshot(), runtime: snapshot({ packedTokens: 101 }) };
    expect(evaluateSkillContextParityStability(changedMismatchCodes, { ...changedMismatchCodes, summary: { ...changedMismatchCodes.summary, mismatchCodes: ["path_state_mismatch" as const] } })).toMatchObject({
      state: "observed_drift", stableAcrossSamples: true, repeatableMismatch: false,
    });
  });

  it("returns stable mismatch and drift results with only bounded aggregate data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    let call = 0;
    sdk.setTrigger(async () => call++ < 2 ? mismatchResult() : parityResult());
    const stableMismatch = await diagnose(validInput());
    expect(stableMismatch).toMatchObject({
      success: true, state: "stable_mismatch", reasonCodes: ["stable_mismatch_observed"], stableAcrossSamples: true,
      repeatableMismatch: true, directDriftCodes: [], runtimeDriftCodes: [],
    });
    call = 0;
    sdk.setTrigger(async () => call++ === 0 ? parityResult() : mismatchResult());
    const outcomeDrift = await diagnose(validInput());
    expect(outcomeDrift).toMatchObject({ success: true, state: "observed_drift", reasonCodes: ["sample_drift_observed"], repeatableMismatch: false });
    const privateResult = parityResult(snapshot(), snapshot(), { reason: "private-reason", reasonCodes: ["paths_consistent"], advisories: [{ skillId: "private-id", steps: ["private-step"] }] });
    sdk.setTrigger(async () => privateResult);
    const privacy = await diagnose(validInput({ project: "private-project", agentId: "private-agent" }));
    for (const marker of ["private-reason", "private-id", "private-step", "private-project", "private-agent"]) expect(JSON.stringify(privacy)).not.toContain(marker);
    for (const sample of [privacy.first, privacy.second]) {
      for (const key of ["direct", "runtime", "reason", "reasonCodes", "advisories", "project", "agentId", "payload"]) expect(sample).not.toHaveProperty(key);
    }
  });

  it("defensively allocates results and does not mutate caller or raw nested results", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = parityResult();
    const caller = validInput({ project: "caller-private", agentId: "agent-private" });
    const before = structuredClone({ raw, caller });
    sdk.setTrigger(async () => raw);
    const first = await diagnose(caller);
    first.reasonCodes.push("sample_drift_observed");
    first.first!.mismatchCodes.push("path_state_mismatch");
    first.directDriftCodes.push("packed_tokens_mismatch");
    first.state = "observed_drift";
    const second = await diagnose(caller);
    expect(second).toMatchObject({ state: "stable_consistent", reasonCodes: ["stable_consistency_observed"], directDriftCodes: [], runtimeDriftCodes: [] });
    expect({ raw, caller }).toEqual(before);
  });

  it("uses only the sampled Phase 5F chain with no direct reads in no-budget and four skills lists when positive", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const noBudgetKV = mockKV([skill()]);
    const noBudgetSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillRecallFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillContextRuntimeExplainFunction(noBudgetSdk as never);
    registerSkillContextParityDiagnosticsFunction(noBudgetSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(noBudgetSdk as never);
    const noBudget = await noBudgetSdk.functions.get("mem::skill-context-parity-stability-diagnostics")!(validInput({ overallBudget: 10, usedTokens: 10 }));
    expect(noBudget).toMatchObject({ success: true, state: "stable_consistent" });
    expect(noBudgetSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain",
    ]);
    expect(noBudgetKV.lists).toEqual([]);
    expect(noBudgetKV.gets).toEqual([]);
    expect(noBudgetKV.writes).toEqual([]);

    const positiveKV = mockKV([skill()]);
    const positiveSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(positiveSdk as never, positiveKV as never);
    registerSkillRecallFunction(positiveSdk as never, positiveKV as never);
    registerSkillContextRuntimeExplainFunction(positiveSdk as never);
    registerSkillContextParityDiagnosticsFunction(positiveSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(positiveSdk as never);
    const positive = await positiveSdk.functions.get("mem::skill-context-parity-stability-diagnostics")!(validInput());
    expect(positive).toMatchObject({ success: true, state: "stable_consistent" });
    expect(positiveSdk.requests.map((request) => request.function_id)).toEqual([
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
      "mem::skill-context-parity-diagnostics", "mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall",
    ]);
    expect(positiveKV.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]);
    expect(positiveKV.gets).toEqual([]);
    expect(positiveKV.writes).toEqual([]);

    const duplicateRows = [skill(), skill({ id: "skill_release" })];
    const duplicateBefore = structuredClone(duplicateRows);
    const duplicateKV = mockKV(duplicateRows);
    const duplicateSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(duplicateSdk as never, duplicateKV as never);
    registerSkillRecallFunction(duplicateSdk as never, duplicateKV as never);
    registerSkillContextRuntimeExplainFunction(duplicateSdk as never);
    registerSkillContextParityDiagnosticsFunction(duplicateSdk as never);
    registerSkillContextParityStabilityDiagnosticsFunction(duplicateSdk as never);
    const duplicate = await duplicateSdk.functions.get("mem::skill-context-parity-stability-diagnostics")!(validInput());
    expect(duplicate).toMatchObject({
      success: true, state: "stable_mismatch", repeatableMismatch: true, stableAcrossSamples: true,
      directDriftCodes: [], runtimeDriftCodes: [],
    });
    expect(duplicateSdk.requests).toHaveLength(8);
    expect(duplicateKV.lists).toEqual([KV.skills, KV.skills, KV.skills, KV.skills]);
    expect(duplicateKV.gets).toEqual([]);
    expect(duplicateKV.writes).toEqual([]);
    expect(duplicateRows).toEqual(duplicateBefore);
    expect(JSON.stringify(duplicate)).not.toContain("skill_release");
  });
});
