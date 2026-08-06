import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));

vi.mock("../src/config.js", () => ({ loadSkillConfig, getEnvVar: () => undefined }));

import {
  buildSkillContextParityRequests,
  compareSkillContextParitySnapshots,
  registerSkillContextParityDiagnosticsFunction,
} from "../src/functions/skill-context-parity.js";
import { registerSkillContextAdmissionExplainFunction } from "../src/functions/skill-context-admission.js";
import { registerSkillContextRuntimeExplainFunction } from "../src/functions/skill-context-runtime.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  SkillContextParityDiagnosticsResult,
  SkillContextParitySnapshot,
} from "../src/types.js";

function enabledConfig(tokenBudget = 320) {
  return {
    enabled: true,
    diagnosticsEnabled: true,
    diagnosticsLimit: 50,
    recallEnabled: true,
    recallLimit: 3,
    recallMinConfidence: 0.7,
    contextEnabled: true,
    contextTokenBudget: tokenBudget,
    promotionEnabled: false,
    promotionMinStrength: 0.7,
    promotionMinEvidence: 2,
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release", name: "Release validation", triggerCondition: "Before release", steps: ["Run tests"],
    expectedOutcome: "Green", antiPatterns: ["Skip tests"], project: "/repo", agentId: "agent",
    files: [], concepts: [], confidence: 0.9, strength: 0.8, usageCount: 0, successCount: 0,
    failureCount: 0, sourceProceduralMemoryIds: ["proc"], sourceCandidateIds: [], sourceObservationIds: [],
    sourceSessionIds: [], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    status: "active", version: 1, ...overrides,
  };
}

function mockKV(rows: unknown[] = []) {
  const lists: string[] = [];
  const gets: string[] = [];
  const writes: string[] = [];
  return {
    lists,
    gets,
    writes,
    list: async <T>(scope: string): Promise<T[]> => { lists.push(scope); return rows as T[]; },
    get: async <T>(scope: string): Promise<T | null> => { gets.push(scope); return null; },
    set: async () => { writes.push("set"); },
    update: async () => { writes.push("update"); },
    delete: async () => { writes.push("delete"); },
  };
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

function snapshot(overrides: Partial<SkillContextParitySnapshot> = {}): SkillContextParitySnapshot {
  return {
    success: true,
    enabled: true,
    state: "admitted",
    overallBudget: 1000,
    usedTokensBeforeSkill: 0,
    selectedBlockCountBeforeSkill: 0,
    configuredSkillTokenBudget: 320,
    separatorTokens: 0,
    remainingOverallBudget: 1000,
    effectiveSkillTokenBudget: 320,
    effectiveRecallLimit: 3,
    recallAttempted: true,
    recalledAdvisoryCount: 1,
    packedCount: 1,
    omittedCount: 0,
    packedTokens: 100,
    sectionCreated: true,
    sectionAdmitted: true,
    projectedUsedTokens: 100,
    projectedBlockCount: 1,
    ...overrides,
  };
}

function directResult(value: SkillContextParitySnapshot, extra: Record<string, unknown> = {}) {
  return { ...value, applied: false, recallReturnedCount: value.recalledAdvisoryCount, ...extra };
}

function runtimeResult(value: SkillContextParitySnapshot, extra: Record<string, unknown> = {}) {
  return { ...value, applied: false, parsedAdvisoryCount: value.recalledAdvisoryCount, ...extra };
}

const snapshotFields: Array<keyof SkillContextParitySnapshot> = [
  "success", "enabled", "state", "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill",
  "configuredSkillTokenBudget", "separatorTokens", "remainingOverallBudget", "effectiveSkillTokenBudget",
  "effectiveRecallLimit", "recallAttempted", "recalledAdvisoryCount", "packedCount", "omittedCount",
  "packedTokens", "sectionCreated", "sectionAdmitted", "projectedUsedTokens", "projectedBlockCount",
];

const sharedNumericFields = [
  "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill", "configuredSkillTokenBudget",
  "separatorTokens", "remainingOverallBudget", "effectiveSkillTokenBudget", "effectiveRecallLimit",
  "packedCount", "omittedCount", "packedTokens", "projectedUsedTokens", "projectedBlockCount",
] as const;

function validInput(overrides: Record<string, unknown> = {}) {
  return { project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0, ...overrides };
}

function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

describe("skill context path parity diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    loadSkillConfig.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    sdk = mockSdk();
    registerSkillContextParityDiagnosticsFunction(sdk as never);
  });

  afterEach(() => vi.restoreAllMocks());

  async function diagnose(input: unknown): Promise<SkillContextParityDiagnosticsResult> {
    return sdk.functions.get("mem::skill-context-parity-diagnostics")!(input) as Promise<SkillContextParityDiagnosticsResult>;
  }

  it("builds fresh exact path requests without forwarding ignored values", () => {
    const input = { project: " /repo ", agentId: " agent ", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 };
    const before = structuredClone(input);
    const first = buildSkillContextParityRequests(input);
    const second = buildSkillContextParityRequests(input);
    expect(first).toEqual({
      direct: { function_id: "mem::skill-context-admission-explain", payload: input },
      runtime: { function_id: "mem::skill-context-runtime-explain", payload: input },
    });
    expect(second).toEqual(first);
    expect(second.direct).not.toBe(first.direct);
    expect(second.direct.payload).not.toBe(first.direct.payload);
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.runtime.payload).not.toBe(first.runtime.payload);
    const mutable = first as unknown as { direct: { function_id: string; payload: Record<string, unknown> }; runtime: { function_id: string; payload: Record<string, unknown> } };
    mutable.direct.function_id = "changed";
    mutable.direct.payload.project = "changed";
    mutable.direct.payload.agentId = "changed";
    mutable.direct.payload.overallBudget = 99;
    mutable.direct.payload.usedTokens = 99;
    mutable.direct.payload.selectedBlockCount = 99;
    mutable.runtime.function_id = "changed";
    mutable.runtime.payload.project = "changed";
    mutable.runtime.payload.agentId = "changed";
    mutable.runtime.payload.overallBudget = 99;
    mutable.runtime.payload.usedTokens = 99;
    mutable.runtime.payload.selectedBlockCount = 99;
    expect(input).toEqual(before);
    expect(buildSkillContextParityRequests(input)).toEqual(second);
    for (const request of [first.direct, first.runtime]) {
      expect(request.payload).not.toHaveProperty("query");
      expect(request.payload).not.toHaveProperty("files");
      expect(request.payload).not.toHaveProperty("concepts");
      expect(request.payload).not.toHaveProperty("limit");
    }
    expect(buildSkillContextParityRequests({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 }))
      .toEqual({
        direct: { function_id: "mem::skill-context-admission-explain", payload: { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 } },
        runtime: { function_id: "mem::skill-context-runtime-explain", payload: { project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 } },
      });
    expect(buildSkillContextParityRequests({ project: "/repo", agentId: "   ", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: 0 }))
      .toEqual({
        direct: { function_id: "mem::skill-context-admission-explain", payload: { project: "/repo", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: 0 } },
        runtime: { function_id: "mem::skill-context-runtime-explain", payload: { project: "/repo", overallBudget: Number.MAX_SAFE_INTEGER, usedTokens: 0, selectedBlockCount: 0 } },
      });
  });

  it("registers internally, stays default-off, and preserves public counts", async () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const order = [
      "registerSkillRecallFunction(sdk, kv)",
      "registerSkillRecallExplainFunction(sdk, kv)",
      "registerSkillRecallDiagnosticsFunction(sdk, kv)",
      "registerSkillContextExplainFunction(sdk, kv)",
      "registerSkillContextAdmissionExplainFunction(sdk, kv)",
      "registerSkillContextRuntimeExplainFunction(sdk)",
      "registerSkillContextParityDiagnosticsFunction(sdk)",
    ].map((text) => index.indexOf(text));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(getAllTools()).toHaveLength(60);
    expect(getAllTools().some((tool) => tool.name.includes("parity"))).toBe(false);
    expect(index).toContain("REST API: 135 endpoints");
    await expect(diagnose(null)).resolves.toMatchObject({
      success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"],
      comparisonAvailable: false, consistent: false,
    });
    expect(sdk.requests).toEqual([]);
  });

  it("rejects the strict caller matrix before making either trigger", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalidNumbers = [undefined, null, "1", true, false, {}, [], Number.NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1];
    const invalid = [
      null, [], "x", 1, true, false, Symbol("invalid-input"), {}, { project: "", overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      { project: "/repo", agentId: 1, overallBudget: 1, usedTokens: 0, selectedBlockCount: 0 },
      ...invalidNumbers.map((overallBudget) => ({ project: "/repo", overallBudget, usedTokens: 0, selectedBlockCount: 0 })),
      ...invalidNumbers.map((usedTokens) => ({ project: "/repo", overallBudget: 1, usedTokens, selectedBlockCount: 0 })),
      ...invalidNumbers.map((selectedBlockCount) => ({ project: "/repo", overallBudget: 1, usedTokens: 0, selectedBlockCount })),
    ];
    for (const input of invalid) {
      sdk.requests.length = 0;
      await expect(diagnose(input)).resolves.toMatchObject({
        success: false, state: "failed", reason: "invalid skill context parity diagnostics input", reasonCodes: ["invalid_input"],
        comparisonAvailable: false, directTriggerAttempted: false, runtimeTriggerAttempted: false,
      });
      expect(sdk.requests).toEqual([]);
    }
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(snapshot()) : runtimeResult(snapshot()));
    await expect(diagnose(validInput({ overallBudget: 1, usedTokens: 2 }))).resolves.toMatchObject({ success: true, comparisonAvailable: true });
    expect(sdk.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
  });

  it("attempts direct then runtime independently and keeps failures private", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const raw = runtimeResult(snapshot());
    sdk.setTrigger(async (request) => {
      if (request.function_id === "mem::skill-context-admission-explain") throw new Error("direct-private-marker");
      return raw;
    });
    const result = await diagnose({ project: "private-project", agentId: "private-agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(sdk.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
    expect(result).toMatchObject({
      success: false, state: "failed", reasonCodes: ["direct_trigger_failure"], directTriggerAttempted: true,
      directTriggerSucceeded: false, runtimeTriggerAttempted: true, runtimeTriggerSucceeded: true, runtimeResultParsed: true,
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("direct-private-marker");
  });

  it("attempts both paths for every top-level trigger failure combination", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const validDirect = directResult(snapshot());
    const validRuntime = runtimeResult(snapshot());
    for (const current of [
      { label: "direct only", directThrows: true, runtimeThrows: false, codes: ["direct_trigger_failure"] },
      { label: "runtime only", directThrows: false, runtimeThrows: true, codes: ["runtime_trigger_failure"] },
      { label: "both", directThrows: true, runtimeThrows: true, codes: ["direct_trigger_failure", "runtime_trigger_failure"] },
    ]) {
      sdk.setTrigger(async (request) => {
        if (request.function_id === "mem::skill-context-admission-explain" && current.directThrows) throw { message: "direct-marker" };
        if (request.function_id === "mem::skill-context-runtime-explain" && current.runtimeThrows) throw { message: "runtime-marker" };
        return request.function_id === "mem::skill-context-admission-explain" ? validDirect : validRuntime;
      });
      const result = await diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result.reasonCodes, current.label).toEqual(current.codes);
      expect(result.directTriggerAttempted, current.label).toBe(true);
      expect(result.runtimeTriggerAttempted, current.label).toBe(true);
      expect(sdk.requests.slice(-2).map((request) => request.function_id), current.label)
        .toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
      expect(JSON.stringify(result), current.label).not.toContain("marker");
    }
  });

  it("strictly parses both nested path results and accepts comparable failed states", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const [label, direct, runtime] of [
      ["invalid direct", null, runtimeResult(snapshot())],
      ["invalid runtime", directResult(snapshot()), []],
      ["applied direct", directResult(snapshot(), { applied: true }), runtimeResult(snapshot())],
      ["unknown state", directResult(snapshot({ state: "unknown" as never })), runtimeResult(snapshot())],
      ["fraction", directResult(snapshot({ packedTokens: 1.5 })), runtimeResult(snapshot())],
      ["missing recalled count", directResult(snapshot(), { recallReturnedCount: undefined }), runtimeResult(snapshot())],
    ] as const) {
      sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : runtime);
      const result = await diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(result.state, label).toBe("failed");
      expect(result.reasonCodes, label).toContain(label.includes("runtime") ? "invalid_runtime_result" : "invalid_direct_result");
    }
    const failed = snapshot({ success: false, state: "failed", recalledAdvisoryCount: 0, packedCount: 0, packedTokens: 0, sectionCreated: false, sectionAdmitted: false, projectedUsedTokens: 0, projectedBlockCount: 0 });
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(failed) : runtimeResult(failed));
    await expect(diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }))
      .resolves.toMatchObject({ success: true, state: "consistent", comparisonAvailable: true, consistent: true, mismatchCodes: [] });
  });

  it("rejects every required direct snapshot boundary while still parsing runtime", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const validRuntime = runtimeResult(snapshot(), { reason: "runtime-nested-private", reasonCodes: ["runtime-nested-private"] });
    const directCases: Array<[string, unknown]> = [
      ["null", null], ["array", []], ["string", "raw"], ["number", 1], ["boolean", true],
      ["missing applied", without(directResult(snapshot()), "applied")],
      ["applied true", directResult(snapshot(), { applied: true })],
      ["missing state", without(directResult(snapshot()), "state")],
      ["unknown state", directResult(snapshot(), { state: "unknown" })],
      ["missing success", without(directResult(snapshot()), "success")],
      ["nonboolean success", directResult(snapshot(), { success: "true" })],
      ["missing enabled", without(directResult(snapshot()), "enabled")],
      ["nonboolean enabled", directResult(snapshot(), { enabled: 1 })],
      ["missing recall attempted", without(directResult(snapshot()), "recallAttempted")],
      ["nonboolean recall attempted", directResult(snapshot(), { recallAttempted: 1 })],
      ["missing section created", without(directResult(snapshot()), "sectionCreated")],
      ["nonboolean section created", directResult(snapshot(), { sectionCreated: 1 })],
      ["missing section admitted", without(directResult(snapshot()), "sectionAdmitted")],
      ["nonboolean section admitted", directResult(snapshot(), { sectionAdmitted: 1 })],
      ["missing recalled count", without(directResult(snapshot()), "recallReturnedCount")],
    ];
    for (const field of [...sharedNumericFields, "recallReturnedCount"] as const) {
      directCases.push([`missing ${field}`, without(directResult(snapshot()), field)]);
      for (const value of [1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, "1", true]) {
        directCases.push([`${field} ${String(value)}`, directResult(snapshot(), { [field]: value })]);
      }
    }
    for (const [label, direct] of directCases) {
      sdk.requests.length = 0;
      const before = direct && typeof direct === "object" ? structuredClone(direct) : direct;
      sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : validRuntime);
      const result = await diagnose(validInput());
      expect(result, label).toMatchObject({
        success: false, state: "failed", reasonCodes: ["invalid_direct_result"], directResultParsed: false,
        runtimeTriggerAttempted: true, runtimeTriggerSucceeded: true, runtimeResultParsed: true,
      });
      expect(sdk.requests.map((request) => request.function_id), label)
        .toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
      expect(JSON.stringify(result), label).not.toContain("private");
      expect(direct, label).toEqual(before);
    }
  });

  it("rejects every required runtime snapshot boundary while retaining a parsed direct snapshot", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const validDirect = directResult(snapshot(), { reason: "direct-nested-private", reasonCodes: ["direct-nested-private"] });
    const runtimeCases: Array<[string, unknown]> = [
      ["null", null], ["array", []], ["string", "raw"], ["number", 1], ["boolean", true],
      ["missing applied", without(runtimeResult(snapshot()), "applied")],
      ["applied true", runtimeResult(snapshot(), { applied: true })],
      ["missing state", without(runtimeResult(snapshot()), "state")],
      ["unknown state", runtimeResult(snapshot(), { state: "unknown" })],
      ["missing success", without(runtimeResult(snapshot()), "success")],
      ["nonboolean success", runtimeResult(snapshot(), { success: "true" })],
      ["missing enabled", without(runtimeResult(snapshot()), "enabled")],
      ["nonboolean enabled", runtimeResult(snapshot(), { enabled: 1 })],
      ["missing recall attempted", without(runtimeResult(snapshot()), "recallAttempted")],
      ["nonboolean recall attempted", runtimeResult(snapshot(), { recallAttempted: 1 })],
      ["missing section created", without(runtimeResult(snapshot()), "sectionCreated")],
      ["nonboolean section created", runtimeResult(snapshot(), { sectionCreated: 1 })],
      ["missing section admitted", without(runtimeResult(snapshot()), "sectionAdmitted")],
      ["nonboolean section admitted", runtimeResult(snapshot(), { sectionAdmitted: 1 })],
      ["missing recalled count", without(runtimeResult(snapshot()), "parsedAdvisoryCount")],
    ];
    for (const field of [...sharedNumericFields, "parsedAdvisoryCount"] as const) {
      runtimeCases.push([`missing ${field}`, without(runtimeResult(snapshot()), field)]);
      for (const value of [1.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, "1", true]) {
        runtimeCases.push([`${field} ${String(value)}`, runtimeResult(snapshot(), { [field]: value })]);
      }
    }
    for (const [label, runtime] of runtimeCases) {
      sdk.requests.length = 0;
      const before = runtime && typeof runtime === "object" ? structuredClone(runtime) : runtime;
      sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? validDirect : runtime);
      const result = await diagnose(validInput());
      expect(result, label).toMatchObject({
        success: false, state: "failed", reasonCodes: ["invalid_runtime_result"], directResultParsed: true,
        runtimeTriggerAttempted: true, runtimeTriggerSucceeded: true, runtimeResultParsed: false,
      });
      expect(sdk.requests.map((request) => request.function_id), label)
        .toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
      expect(JSON.stringify(result), label).not.toContain("private");
      expect(runtime, label).toEqual(before);
    }
  });

  it("keeps direct-before-runtime reason code order for combined invalid and thrown outcomes", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const cases: Array<[string, (request: { function_id: string }) => unknown, string[]]> = [
      ["both invalid", (request) => request.function_id === "mem::skill-context-admission-explain" ? null : [], ["invalid_direct_result", "invalid_runtime_result"]],
      ["invalid direct then thrown runtime", (request) => {
        if (request.function_id === "mem::skill-context-admission-explain") return null;
        throw { marker: "runtime-throw-private" };
      }, ["invalid_direct_result", "runtime_trigger_failure"]],
      ["thrown direct then invalid runtime", (request) => {
        if (request.function_id === "mem::skill-context-admission-explain") throw "direct-throw-private";
        return [];
      }, ["direct_trigger_failure", "invalid_runtime_result"]],
    ];
    for (const [label, behavior, codes] of cases) {
      sdk.requests.length = 0;
      sdk.setTrigger(async (request) => behavior(request));
      const result = await diagnose(validInput());
      expect(result.reasonCodes, label).toEqual(codes);
      expect(result).toMatchObject({ success: false, state: "failed", comparisonAvailable: false, consistent: false });
      expect(JSON.stringify(result), label).not.toContain("private");
    }
  });

  it("compares every shared field in canonical order without mutation", () => {
    const base = snapshot();
    const expected = [
      "path_success_mismatch", "path_enabled_mismatch", "path_state_mismatch", "overall_budget_mismatch", "used_tokens_mismatch",
      "selected_block_count_mismatch", "configured_skill_budget_mismatch", "separator_tokens_mismatch", "remaining_budget_mismatch",
      "effective_skill_budget_mismatch", "effective_recall_limit_mismatch", "recall_attempt_mismatch", "recalled_advisory_count_mismatch",
      "packed_count_mismatch", "omitted_count_mismatch", "packed_tokens_mismatch", "section_created_mismatch", "section_admitted_mismatch",
      "projected_used_tokens_mismatch", "projected_block_count_mismatch",
    ] as const;
    const fields: Array<keyof SkillContextParitySnapshot> = [
      "success", "enabled", "state", "overallBudget", "usedTokensBeforeSkill", "selectedBlockCountBeforeSkill", "configuredSkillTokenBudget",
      "separatorTokens", "remainingOverallBudget", "effectiveSkillTokenBudget", "effectiveRecallLimit", "recallAttempted", "recalledAdvisoryCount",
      "packedCount", "omittedCount", "packedTokens", "sectionCreated", "sectionAdmitted", "projectedUsedTokens", "projectedBlockCount",
    ];
    const before = structuredClone(base);
    expect(compareSkillContextParitySnapshots(base, base)).toEqual([]);
    for (const [index, field] of fields.entries()) {
      const changed = structuredClone(base) as Record<string, unknown>;
      changed[field] = typeof base[field] === "boolean" ? !base[field] : field === "state" ? "failed" : (base[field] as number) + 1;
      expect(compareSkillContextParitySnapshots(base, changed as SkillContextParitySnapshot)).toEqual([expected[index]]);
    }
    const all = structuredClone(base) as Record<string, unknown>;
    for (const field of fields) all[field] = typeof base[field] === "boolean" ? !base[field] : field === "state" ? "failed" : (base[field] as number) + 1;
    const first = compareSkillContextParitySnapshots(base, all as SkillContextParitySnapshot);
    first.push("path_success_mismatch");
    expect(compareSkillContextParitySnapshots(base, all as SkillContextParitySnapshot)).toEqual(expected);
    expect(base).toEqual(before);
  });

  it("reports successful consistent and mismatch comparisons without leaking path data", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const markers = {
      project: "project-private-marker", agent: "agent-private-marker", direct: "direct-private-marker", runtime: "runtime-private-marker",
      directCode: "direct-code-private-marker", runtimeCode: "runtime-code-private-marker", skill: "skill-private-marker",
      name: "name-private-marker", condition: "condition-private-marker", steps: "steps-private-marker", outcome: "outcome-private-marker",
      antiPatterns: "anti-private-marker", files: "files-private-marker", concepts: "concepts-private-marker", confidence: "confidence-private-marker",
      strength: "strength-private-marker", rank: "rank-private-marker", provenance: "provenance-private-marker",
    };
    const privateAdvisory = {
      skillId: markers.skill, name: markers.name, triggerCondition: markers.condition, steps: [markers.steps], expectedOutcome: markers.outcome,
      antiPatterns: [markers.antiPatterns], files: [markers.files], concepts: [markers.concepts], confidence: markers.confidence,
      strength: markers.strength, rank: markers.rank, provenance: markers.provenance,
    };
    const direct = directResult(snapshot(), { reason: markers.direct, reasonCodes: [markers.directCode], advisories: [privateAdvisory] });
    const runtime = runtimeResult(snapshot(), { reason: markers.runtime, reasonCodes: [markers.runtimeCode], advisories: [privateAdvisory] });
    const beforeDirect = structuredClone(direct);
    const beforeRuntime = structuredClone(runtime);
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : runtime);
    const consistent = await diagnose(validInput({ project: markers.project, agentId: markers.agent }));
    expect(consistent).toMatchObject({ success: true, state: "consistent", comparisonAvailable: true, consistent: true, mismatchCodes: [] });
    for (const marker of Object.values(markers)) expect(JSON.stringify(consistent)).not.toContain(marker);
    for (const path of [consistent.direct, consistent.runtime]) {
      for (const key of [
        "project", "agentId", "payload", "request", "reason", "reasonCodes", "error", "advisories", "skillId", "name", "triggerCondition",
        "steps", "expectedOutcome", "antiPatterns", "files", "concepts", "confidence", "strength", "rank", "provenance", "scannedCount",
        "validCount", "malformedCount", "privacySuppressedCount", "privateProtectedCount", "matchedCount", "recallTruncated",
        "duplicateSkillIdCount", "recallTriggerSucceeded", "recallResultParsed",
      ]) expect(path).not.toHaveProperty(key);
    }
    expect(direct).toEqual(beforeDirect);
    expect(runtime).toEqual(beforeRuntime);
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(snapshot({ state: "recall_empty", recalledAdvisoryCount: 0, packedCount: 0, packedTokens: 0, sectionCreated: false, sectionAdmitted: false, projectedUsedTokens: 0, projectedBlockCount: 0 })) : runtimeResult(snapshot()));
    const mismatch = await diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
    expect(mismatch).toMatchObject({ success: true, state: "mismatch", comparisonAvailable: true, consistent: false, reasonCodes: ["paths_mismatch"] });
    expect(mismatch.mismatchCodes).toContain("path_state_mismatch");
  });

  it("reports controlled mismatch orchestration with canonical aggregate codes", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const cases: Array<[string, Partial<SkillContextParitySnapshot>, string[]]> = [
      ["state", { state: "recall_empty" }, ["path_state_mismatch"]],
      ["recalled count", { recalledAdvisoryCount: 2 }, ["recalled_advisory_count_mismatch"]],
      ["packing counts", { packedCount: 2, omittedCount: 1 }, ["packed_count_mismatch", "omitted_count_mismatch"]],
      ["packing tokens", { packedTokens: 101 }, ["packed_tokens_mismatch"]],
      ["section created", { sectionCreated: false }, ["section_created_mismatch"]],
      ["section admitted", { sectionAdmitted: false }, ["section_admitted_mismatch"]],
      ["projected tokens", { projectedUsedTokens: 101 }, ["projected_used_tokens_mismatch"]],
      ["projected blocks", { projectedBlockCount: 2 }, ["projected_block_count_mismatch"]],
      [
        "multiple canonical", { success: false, state: "failed", overallBudget: 999, recalledAdvisoryCount: 2, packedTokens: 101, sectionAdmitted: false },
        ["path_success_mismatch", "path_state_mismatch", "overall_budget_mismatch", "recalled_advisory_count_mismatch", "packed_tokens_mismatch", "section_admitted_mismatch"],
      ],
    ];
    for (const [label, changes, codes] of cases) {
      sdk.requests.length = 0;
      const direct = directResult(snapshot());
      const runtime = runtimeResult(snapshot(changes));
      sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : runtime);
      const result = await diagnose(validInput());
      expect(result, label).toMatchObject({
        success: true, state: "mismatch", reasonCodes: ["paths_mismatch"], comparisonAvailable: true, consistent: false,
      });
      expect(result.mismatchCodes, label).toEqual(codes);
    }
  });

  it("completes all trigger-failure outcomes with accurate flags and private errors", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const validDirect = directResult(snapshot());
    const validRuntime = runtimeResult(snapshot());
    const cases: Array<[
      string,
      boolean,
      boolean,
      unknown,
      unknown,
      string[],
      boolean,
      boolean,
    ]> = [
      ["direct error", true, false, new Error("direct-error-private"), null, ["direct_trigger_failure"], false, true],
      ["runtime string", false, true, null, "runtime-string-private", ["runtime_trigger_failure"], true, false],
      ["both objects", true, true, { marker: "direct-object-private" }, { marker: "runtime-object-private" }, ["direct_trigger_failure", "runtime_trigger_failure"], false, false],
      ["direct null runtime error", true, true, null, new Error("runtime-error-private"), ["direct_trigger_failure", "runtime_trigger_failure"], false, false],
    ];
    for (const [label, directThrows, runtimeThrows, directThrown, runtimeThrown, codes, directSucceeded, runtimeSucceeded] of cases) {
      sdk.requests.length = 0;
      sdk.setTrigger(async (request) => {
        if (request.function_id === "mem::skill-context-admission-explain") {
          if (directThrows) throw directThrown;
          return validDirect;
        }
        if (runtimeThrows) throw runtimeThrown;
        return validRuntime;
      });
      const result = await diagnose(validInput());
      expect(result, label).toMatchObject({
        success: false, state: "failed", reasonCodes: codes, comparisonAvailable: false, consistent: false,
        directTriggerAttempted: true, directTriggerSucceeded: directSucceeded, directResultParsed: directSucceeded,
        runtimeTriggerAttempted: true, runtimeTriggerSucceeded: runtimeSucceeded, runtimeResultParsed: runtimeSucceeded,
      });
      expect(sdk.requests.map((request) => request.function_id), label)
        .toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
      expect(JSON.stringify(result), label).not.toContain("private");
    }
  });

  it("keeps diagnostic results independently allocated for every comparable state", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    for (const state of ["skipped_no_budget", "recall_empty", "packing_empty", "admitted", "rejected_outer_budget", "failed"] as const) {
      const value = snapshot({
        success: state !== "failed",
        state,
        recalledAdvisoryCount: state === "recall_empty" || state === "skipped_no_budget" ? 0 : 1,
        packedCount: state === "admitted" || state === "rejected_outer_budget" ? 1 : 0,
        packedTokens: state === "admitted" || state === "rejected_outer_budget" ? 100 : 0,
        sectionCreated: state === "admitted" || state === "rejected_outer_budget",
        sectionAdmitted: state === "admitted",
        projectedUsedTokens: state === "admitted" ? 100 : 0,
        projectedBlockCount: state === "admitted" ? 1 : 0,
      });
      sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(value) : runtimeResult(value));
      const first = await diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(first, state).toMatchObject({ success: true, state: "consistent", comparisonAvailable: true, consistent: true, mismatchCodes: [] });
      first.reasonCodes.push("paths_mismatch");
      first.mismatchCodes.push("path_state_mismatch");
      first.direct!.state = "failed";
      first.runtime!.packedTokens = -1;
      first.directTriggerSucceeded = false;
      first.consistent = false;
      const second = await diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 });
      expect(second, state).toMatchObject({ success: true, state: "consistent", reasonCodes: ["paths_consistent"], mismatchCodes: [], consistent: true });
    }
  });

  it("defensively allocates every result field for consistent, mismatch, unavailable, disabled, and invalid results", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig());
    const direct = directResult(snapshot());
    const runtime = runtimeResult(snapshot());
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : runtime);
    const consistent = await diagnose(validInput());
    const mutable = consistent as unknown as Record<string, unknown>;
    mutable.reasonCodes = ["tampered"];
    mutable.mismatchCodes = ["path_state_mismatch"];
    mutable.state = "tampered";
    mutable.comparisonMode = "tampered";
    mutable.comparisonAvailable = false;
    mutable.consistent = false;
    for (const field of [
      "directTriggerAttempted", "directTriggerSucceeded", "directResultParsed", "runtimeTriggerAttempted", "runtimeTriggerSucceeded", "runtimeResultParsed",
    ]) mutable[field] = false;
    for (const path of [consistent.direct!, consistent.runtime!]) {
      for (const field of snapshotFields) (path as unknown as Record<string, unknown>)[field] = "tampered";
    }
    const pristine = await diagnose(validInput());
    expect(pristine).toMatchObject({
      success: true, state: "consistent", reasonCodes: ["paths_consistent"], comparisonMode: "sequential_best_effort_non_atomic",
      comparisonAvailable: true, consistent: true, directTriggerAttempted: true, directTriggerSucceeded: true, directResultParsed: true,
      runtimeTriggerAttempted: true, runtimeTriggerSucceeded: true, runtimeResultParsed: true, mismatchCodes: [], direct: snapshot(), runtime: snapshot(),
    });

    sdk.setTrigger(async (request) => {
      if (request.function_id === "mem::skill-context-admission-explain") throw { marker: "unavailable-private" };
      return runtime;
    });
    const unavailable = await diagnose(validInput());
    unavailable.reasonCodes.push("paths_consistent");
    unavailable.mismatchCodes.push("path_state_mismatch");
    unavailable.state = "consistent";
    unavailable.comparisonAvailable = true;
    unavailable.consistent = true;
    expect(await diagnose(validInput())).toMatchObject({ success: false, state: "failed", reasonCodes: ["direct_trigger_failure"], comparisonAvailable: false, consistent: false });

    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(snapshot()) : runtimeResult(snapshot({ packedTokens: 101 })));
    const mismatch = await diagnose(validInput());
    mismatch.reasonCodes.push("paths_consistent");
    mismatch.mismatchCodes.length = 0;
    mismatch.direct!.packedTokens = -1;
    expect(await diagnose(validInput())).toMatchObject({ success: true, state: "mismatch", reasonCodes: ["paths_mismatch"], mismatchCodes: ["packed_tokens_mismatch"] });

    loadSkillConfig.mockReturnValue({ ...enabledConfig(), contextEnabled: false });
    const disabled = await diagnose(validInput());
    disabled.reasonCodes.push("paths_mismatch");
    disabled.state = "mismatch";
    expect(await diagnose(validInput())).toMatchObject({ success: true, enabled: false, state: "disabled", reasonCodes: ["context_disabled"] });

    loadSkillConfig.mockReturnValue(enabledConfig());
    const invalid = await diagnose(null);
    invalid.reasonCodes.push("paths_consistent");
    invalid.state = "consistent";
    expect(await diagnose(null)).toMatchObject({ success: false, enabled: true, state: "failed", reasonCodes: ["invalid_input"] });
  });

  it("does not mutate caller values, nested raw results, thrown objects, or integrated KV fixtures", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const caller = validInput({ project: "caller-private", agentId: "caller-agent-private" });
    const builderInput = { project: "builder-private", agentId: "builder-agent-private", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 };
    const direct = directResult(snapshot(), { reason: "direct-private", reasonCodes: ["direct-code-private"], nested: { value: ["direct-array-private"] } });
    const runtime = runtimeResult(snapshot(), { reason: "runtime-private", reasonCodes: ["runtime-code-private"], nested: { value: ["runtime-array-private"] } });
    const thrown = { marker: "throw-private", nested: ["throw-array-private"] };
    const before = structuredClone({ caller, builderInput, direct, runtime, thrown });
    buildSkillContextParityRequests(builderInput);
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : runtime);
    const consistent = await diagnose(caller);
    expect(JSON.stringify(consistent)).not.toContain("private");
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(snapshot({ packedTokens: 99 })) : runtime);
    await diagnose(caller);
    sdk.setTrigger(async (request) => {
      if (request.function_id === "mem::skill-context-admission-explain") throw thrown;
      return runtime;
    });
    await diagnose(caller);
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? null : runtime);
    await diagnose(caller);
    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? direct : null);
    await diagnose(caller);
    expect({ caller, builderInput, direct, runtime, thrown }).toEqual(before);

    const fixture = [skill({ id: "fixture-private", steps: ["fixture-step-private"], files: ["fixture-file-private"], concepts: ["fixture-concept-private"] })];
    const fixtureBefore = structuredClone(fixture);
    const integratedKV = mockKV(fixture);
    const integratedSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(integratedSdk as never, integratedKV as never);
    registerSkillRecallFunction(integratedSdk as never, integratedKV as never);
    registerSkillContextRuntimeExplainFunction(integratedSdk as never);
    registerSkillContextParityDiagnosticsFunction(integratedSdk as never);
    await integratedSdk.functions.get("mem::skill-context-parity-diagnostics")!(validInput({ agentId: "agent" }));
    expect(fixture).toEqual(fixtureBefore);
  });

  it("integrates real paths with zero reads for no budget and two lists for positive budget", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const noBudgetRows = [skill()];
    const noBudgetBefore = structuredClone(noBudgetRows);
    const noBudgetKV = mockKV(noBudgetRows);
    const noBudgetSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillRecallFunction(noBudgetSdk as never, noBudgetKV as never);
    registerSkillContextRuntimeExplainFunction(noBudgetSdk as never);
    registerSkillContextParityDiagnosticsFunction(noBudgetSdk as never);
    const noBudget = await noBudgetSdk.functions.get("mem::skill-context-parity-diagnostics")!({ project: "/repo", overallBudget: 10, usedTokens: 10, selectedBlockCount: 0 }) as SkillContextParityDiagnosticsResult;
    expect(noBudget).toMatchObject({ success: true, state: "consistent", consistent: true });
    expect(noBudgetSdk.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain"]);
    expect(noBudgetKV.lists).toEqual([]);
    expect(noBudgetKV.gets).toEqual([]);
    expect(noBudgetKV.writes).toEqual([]);
    expect(noBudgetRows).toEqual(noBudgetBefore);

    const positiveRows = [skill()];
    const positiveBefore = structuredClone(positiveRows);
    const positiveKV = mockKV(positiveRows);
    const positiveSdk = mockSdk();
    registerSkillContextAdmissionExplainFunction(positiveSdk as never, positiveKV as never);
    registerSkillRecallFunction(positiveSdk as never, positiveKV as never);
    registerSkillContextRuntimeExplainFunction(positiveSdk as never);
    registerSkillContextParityDiagnosticsFunction(positiveSdk as never);
    const positive = await positiveSdk.functions.get("mem::skill-context-parity-diagnostics")!({ project: "/repo", agentId: "agent", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }) as SkillContextParityDiagnosticsResult;
    expect(positive).toMatchObject({ success: true, state: "consistent", comparisonAvailable: true, consistent: true });
    expect(positiveSdk.requests.map((request) => request.function_id)).toEqual(["mem::skill-context-admission-explain", "mem::skill-context-runtime-explain", "mem::skill-recall"]);
    expect(positiveKV.lists).toEqual([KV.skills, KV.skills]);
    expect(positiveKV.gets).toEqual([]);
    expect(positiveKV.writes).toEqual([]);
    expect(positiveRows).toEqual(positiveBefore);
  });

  it("observes existing duplicate and non-atomic differences without repairing either path", async () => {
    loadSkillConfig.mockReturnValue(enabledConfig(1000));
    const duplicateRows = [skill(), skill({ id: "skill_release" })];
    const duplicateBefore = structuredClone(duplicateRows);
    const kv = mockKV(duplicateRows);
    const chain = mockSdk();
    registerSkillContextAdmissionExplainFunction(chain as never, kv as never);
    registerSkillRecallFunction(chain as never, kv as never);
    registerSkillContextRuntimeExplainFunction(chain as never);
    registerSkillContextParityDiagnosticsFunction(chain as never);
    const result = await chain.functions.get("mem::skill-context-parity-diagnostics")!({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }) as SkillContextParityDiagnosticsResult;
    expect(result).toMatchObject({ success: true, state: "mismatch", comparisonAvailable: true, consistent: false });
    expect(JSON.stringify(result)).not.toContain("skill_release");
    expect(kv.lists).toEqual([KV.skills, KV.skills]);
    expect(kv.gets).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(duplicateRows).toEqual(duplicateBefore);

    sdk.setTrigger(async (request) => request.function_id === "mem::skill-context-admission-explain" ? directResult(snapshot({ remainingOverallBudget: 900 })) : runtimeResult(snapshot({ remainingOverallBudget: 800 })));
    await expect(diagnose({ project: "/repo", overallBudget: 1000, usedTokens: 0, selectedBlockCount: 0 }))
      .resolves.toMatchObject({ success: true, state: "mismatch", comparisonMode: "sequential_best_effort_non_atomic", mismatchCodes: ["remaining_budget_mismatch"] });
  });
});
