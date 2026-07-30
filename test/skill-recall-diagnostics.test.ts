import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillRecallDiagnosticsFunction } from "../src/functions/skill-recall-diagnostics.js";
import { registerSkillRecallExplainFunction } from "../src/functions/skill-recall-explain.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_RECALL_LIMIT",
  "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggers: string[] = [];
  return {
    functions,
    triggers,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: async (input: { function_id: string; payload: unknown }) => {
      triggers.push(input.function_id);
      const handler = functions.get(input.function_id);
      if (!handler) throw new Error(`No function: ${input.function_id}`);
      return handler(input.payload);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV(rows: unknown[] = []) {
  const getScopes: string[] = [];
  const listScopes: string[] = [];
  const writes: string[] = [];
  let failure = false;
  return {
    getScopes,
    listScopes,
    writes,
    failList: () => { failure = true; },
    list: async <T>(scope: string): Promise<T[]> => {
      listScopes.push(scope);
      if (failure) throw new Error("storage unavailable");
      return rows as T[];
    },
    get: async <T>(scope: string): Promise<T | null> => {
      getScopes.push(scope);
      return null;
    },
    set: async () => { writes.push("set"); },
    update: async () => { writes.push("update"); },
    delete: async () => { writes.push("delete"); },
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Release validation",
    triggerCondition: "Before releasing changes",
    steps: ["Run focused tests"],
    expectedOutcome: "Validation is complete",
    antiPatterns: ["Skip tests"],
    project: "/repo/a",
    agentId: "agent_a",
    files: ["src/functions/observe.ts"],
    concepts: ["release"],
    confidence: 0.9,
    strength: 0.8,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    sourceProceduralMemoryIds: ["proc_release"],
    sourceCandidateIds: [],
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
    status: "active",
    version: 1,
    ...overrides,
  };
}

describe("internal skill recall population diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableRecall(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_RECALL"] = "true";
  }

  async function diagnostics(input: Record<string, unknown>) {
    return sdk.getFunction("mem::skill-recall-diagnostics")!(input);
  }

  it("registers internally and gates before validation or storage", async () => {
    expect(sdk.functions.has("mem::skill-recall-diagnostics")).toBe(true);
    await expect(diagnostics({ itemLimit: 0 })).resolves.toMatchObject({
      success: true,
      enabled: false,
      reason: "skill recall diagnostics is disabled",
      items: [],
    });
    expect(kv.listScopes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("rejects invalid diagnostic input before storage", async () => {
    enableRecall();
    const invalid = [
      null,
      [],
      "value",
      { state: "privacy_suppressed" },
      { reasonCode: "privacy_suppressed" },
      { state: true },
      { reasonCode: false },
      { state: "" },
      { reasonCode: "" },
      { state: "unknown" },
      { reasonCode: "unknown" },
      { itemLimit: "1" },
      { itemLimit: "50" },
      { itemLimit: true },
      { itemLimit: false },
      { itemLimit: {} },
      { itemLimit: 0 },
      { itemLimit: -1 },
      { itemLimit: 1.5 },
      { itemLimit: Number.NaN },
      { itemLimit: Infinity },
      { itemLimit: -Infinity },
      { itemLimit: 501 },
      { files: "bad" },
    ];
    for (const input of invalid) {
      await expect(diagnostics(input as Record<string, unknown>)).resolves.toMatchObject({
        success: false,
        reason: "invalid skill recall diagnostics input",
        items: [],
      });
    }
    expect(kv.listScopes).toEqual([]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("uses exactly one skills list and returns a stable list failure without partial data", async () => {
    enableRecall();
    kv = mockKV([skill()]);
    kv.failList();
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);

    await expect(diagnostics({})).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill recall diagnostics",
      scannedCount: 0,
      items: [],
    });
    expect(kv.listScopes).toEqual([KV.skills]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("maps safe population states, preserves full summaries, filters exactly, and orders deterministically", async () => {
    enableRecall();
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "1";
    const privateMarkers = [
      "token=diagnostics-private-name-abcdefghijklmnopqrstuvwxyz",
      "token=diagnostics-private-trigger-abcdefghijklmnopqrstuvwxyz",
      "token=diagnostics-private-step-abcdefghijklmnopqrstuvwxyz",
      "token=diagnostics-private-outcome-abcdefghijklmnopqrstuvwxyz",
      "token=diagnostics-private-antipattern-abcdefghijklmnopqrstuvwxyz",
    ];
    const rows = [
      skill(),
      skill({ id: "skill_second", name: "Release checklist", updatedAt: "2026-07-15T00:00:00.000Z" }),
      skill({ id: "inactive", status: "retired" }),
      skill({ id: "no-context", name: "Different workflow", concepts: ["other"], files: ["other.ts"] }),
      { id: "broken", name: "Broken" },
      { name: "Anonymous broken" },
      skill({
        id: "private",
        name: privateMarkers[0],
        triggerCondition: privateMarkers[1],
        steps: [privateMarkers[2]],
        expectedOutcome: privateMarkers[3],
        antiPatterns: [privateMarkers[4]],
      }),
    ];
    const rowsBefore = JSON.parse(JSON.stringify(rows));
    kv = mockKV(rows);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release", itemLimit: 50 };

    const result = await diagnostics(input);
    expect(result).toMatchObject({
      success: true,
      scannedCount: 7,
      validCount: 5,
      malformedCount: 2,
      privacySuppressedCount: 1,
      privateProtectedCount: 1,
      anonymousMalformedCount: 1,
      matchedCount: 2,
      recallReturnedCount: 1,
      effectiveLimit: 1,
      recallTruncated: true,
      duplicateSkillIdCount: 0,
      diagnosticMatchedCount: 5,
      diagnosticReturnedCount: 5,
      diagnosticTruncated: false,
      summary: {
        stateCounts: { selected: 1, matched_not_returned: 1, excluded: 2, malformed: 1 },
        reasonCounts: { selected: 1, outside_limit: 1, inactive: 1, no_context_match: 1, malformed_skill: 1 },
      },
    });
    expect(result.items.map((item: { state: string; skillId: string }) => [item.state, item.skillId])).toEqual([
      ["selected", "skill_release"],
      ["matched_not_returned", "skill_second"],
      ["excluded", "inactive"],
      ["excluded", "no-context"],
      ["malformed", "broken"],
    ]);
    for (const marker of privateMarkers) expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.items.some((item: { skillId: string }) => item.skillId === "private")).toBe(false);

    const filtered = await diagnostics({ ...input, state: "excluded", reasonCode: "inactive", itemLimit: 1 });
    expect(filtered.items).toMatchObject([{ skillId: "inactive", state: "excluded", reasonCodes: ["inactive"] }]);
    expect(filtered.diagnosticMatchedCount).toBe(1);
    expect(filtered.summary).toEqual(result.summary);
    for (const [state, reasonCode, skillId] of [
      ["selected", "selected", "skill_release"],
      ["matched_not_returned", "outside_limit", "skill_second"],
      ["excluded", "no_context_match", "no-context"],
      ["malformed", "malformed_skill", "broken"],
    ] as const) {
      const exact = await diagnostics({ ...input, state, reasonCode });
      expect(exact.items).toMatchObject([{ skillId, state, reasonCodes: [reasonCode] }]);
      expect(exact.summary).toEqual(result.summary);
    }
    const reorderedSdk = mockSdk();
    const reorderedKV = mockKV([...rows].reverse());
    registerSkillRecallDiagnosticsFunction(reorderedSdk as never, reorderedKV as never);
    await expect(reorderedSdk.getFunction("mem::skill-recall-diagnostics")!(input)).resolves.toEqual(result);
    expect(rows).toEqual(rowsBefore);
    expect(kv.listScopes).toEqual(Array(6).fill(KV.skills));
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("is recall-equivalent without invoking diagnostics from ordinary recall", async () => {
    enableRecall();
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "1";
    const rows = [skill(), skill({ id: "skill_second", name: "Release checklist" })];
    kv = mockKV(rows);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    registerSkillRecallFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release" };

    const result = await diagnostics(input);
    const recall = await sdk.getFunction("mem::skill-recall")!(input);
    expect(result).toMatchObject({
      scannedCount: recall.scannedCount,
      matchedCount: recall.matchedCount,
      recallReturnedCount: recall.returnedCount,
      recallTruncated: recall.truncated,
      privacySuppressedCount: recall.privacySuppressedCount,
    });
    expect(result.items.filter((item: { state: string }) => item.state === "selected").map((item: { skillId: string }) => item.skillId)).toEqual(
      recall.advisories.map((advisory: { skillId: string }) => advisory.skillId),
    );
    expect(sdk.triggers).not.toContain("mem::skill-recall-diagnostics");
  });

  it("matches ordinary recall across scopes, context sources, suppression, limits, score caps, and ranking ties", async () => {
    enableRecall();
    type Scenario = { name: string; rows: unknown[]; input: Record<string, unknown>; limit?: string; minConfidence?: string };
    const capSkill = skill({
      id: "score-caps",
      concepts: ["one", "two", "three", "four"],
      files: ["one.ts", "two.ts", "three.ts", "four.ts"],
      name: "one two three four five six seven eight nine release",
    });
    const tie = (id: string, overrides: Partial<AgentSkill> = {}) => skill({ id, name: "Tie release", ...overrides });
    const scenarios: Scenario[] = [
      { name: "no context", rows: [skill(), skill({ id: "unscoped", project: undefined, agentId: undefined })], input: {} },
      { name: "matching project", rows: [skill()], input: { project: "/repo/a" } },
      { name: "mismatching project", rows: [skill({ project: "/repo/b" })], input: { project: "/repo/a" } },
      { name: "matching agent", rows: [skill()], input: { agentId: "agent_a" } },
      { name: "mismatching agent", rows: [skill({ agentId: "agent_b" })], input: { agentId: "agent_a" } },
      { name: "query only", rows: [skill()], input: { query: "release" } },
      { name: "file only", rows: [skill()], input: { files: ["src/functions/observe.ts"] } },
      { name: "concept only", rows: [skill()], input: { concepts: ["release"] } },
      { name: "combined context", rows: [skill()], input: { query: "release", files: ["src/functions/observe.ts"], concepts: ["release"] } },
      { name: "below minimum confidence", rows: [skill({ confidence: 0.6 })], input: {}, minConfidence: "0.7" },
      { name: "inactive", rows: [skill({ status: "retired" })], input: {} },
      { name: "malformed", rows: [{ id: "malformed", name: "broken" }], input: {} },
      { name: "private", rows: [skill({ id: "private", name: "token=equivalence-private-marker-abcdefghijklmnopqrstuvwxyz" })], input: {} },
      { name: "effective limit and truncation", rows: [skill(), skill({ id: "second" }), skill({ id: "third" })], input: {}, limit: "1" },
      { name: "confidence tie", rows: [tie("confidence-low", { confidence: 0.8 }), tie("confidence-high", { confidence: 0.9 })], input: { query: "release" } },
      { name: "strength tie", rows: [tie("strength-low", { strength: 0.7 }), tie("strength-high", { strength: 0.9 })], input: { query: "release" } },
      { name: "updatedAt tie", rows: [tie("updated-old", { updatedAt: "2026-07-15T00:00:00.000Z" }), tie("updated-new", { updatedAt: "2026-07-17T00:00:00.000Z" })], input: { query: "release" } },
      { name: "skill ID tie", rows: [tie("tie-b"), tie("tie-a")], input: { query: "release" } },
      { name: "context score caps", rows: [capSkill], input: { query: "one two three four five six seven eight nine", files: ["one.ts", "two.ts", "three.ts", "four.ts"], concepts: ["one", "two", "three", "four"] } },
    ];

    for (const scenario of scenarios) {
      delete process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"];
      delete process.env["AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"];
      if (scenario.limit) process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = scenario.limit;
      if (scenario.minConfidence) process.env["AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"] = scenario.minConfidence;
      sdk = mockSdk();
      kv = mockKV(scenario.rows);
      registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
      registerSkillRecallFunction(sdk as never, kv as never);
      const diagnosticResult = await diagnostics(scenario.input);
      const recall = await sdk.getFunction("mem::skill-recall")!(scenario.input);
      expect(diagnosticResult, scenario.name).toMatchObject({
        scannedCount: recall.scannedCount,
        matchedCount: recall.matchedCount,
        recallReturnedCount: recall.returnedCount,
        recallTruncated: recall.truncated,
        privacySuppressedCount: recall.privacySuppressedCount,
      });
      expect(
        diagnosticResult.items.filter((item: { state: string }) => item.state === "selected").map((item: { skillId: string }) => item.skillId),
        scenario.name,
      ).toEqual(recall.advisories.map((advisory: { skillId: string }) => advisory.skillId));
      expect(kv.listScopes, scenario.name).toEqual([KV.skills, KV.skills]);
      expect(kv.getScopes, scenario.name).toEqual([]);
      expect(kv.writes, scenario.name).toEqual([]);
      expect(sdk.triggers, scenario.name).toEqual([]);
    }
  });

  it("covers every safe state and reason filter, stable summaries, limits, ordering, and physical row order", async () => {
    enableRecall();
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "2";
    process.env["AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"] = "0.7";
    const rows = [
      skill({ id: "selected-two", updatedAt: "2026-07-15T00:00:00.000Z" }),
      skill({ id: "selected-one", confidence: 0.95 }),
      skill({ id: "outside", confidence: 0.8 }),
      skill({ id: "inactive", status: "retired" }),
      skill({ id: "low-confidence", confidence: 0.6 }),
      skill({ id: "project-mismatch", project: "/repo/b" }),
      skill({ id: "agent-mismatch", agentId: "agent_b" }),
      skill({ id: "no-context", name: "unrelated", triggerCondition: "unrelated", expectedOutcome: "unrelated", concepts: ["other"], files: ["other.ts"] }),
      skill({ id: "multi", status: "retired", confidence: 0.6, project: "/repo/b", agentId: "agent_b" }),
      { id: "malformed-z", name: "broken" },
      { id: "malformed-a", name: "broken" },
    ];
    const input = { project: "/repo/a", agentId: "agent_a", query: "release", itemLimit: 500 };
    const run = async (physicalRows: unknown[], request = input) => {
      sdk = mockSdk();
      kv = mockKV(physicalRows);
      registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
      const value = await diagnostics(request);
      expect(kv.listScopes).toEqual([KV.skills]);
      expect(kv.getScopes).toEqual([]);
      expect(kv.writes).toEqual([]);
      expect(sdk.triggers).toEqual([]);
      return value;
    };
    const full = await run(rows);
    expect(full.items.map((item: { state: string; skillId: string }) => `${item.state}:${item.skillId}`)).toEqual([
      "selected:selected-one",
      "selected:selected-two",
      "matched_not_returned:outside",
      "excluded:agent-mismatch",
      "excluded:inactive",
      "excluded:low-confidence",
      "excluded:multi",
      "excluded:no-context",
      "excluded:project-mismatch",
      "malformed:malformed-a",
      "malformed:malformed-z",
    ]);
    expect(full.items.find((item: { skillId: string }) => item.skillId === "multi")).toMatchObject({
      state: "excluded",
      reasonCodes: ["inactive", "below_min_confidence", "project_scope_mismatch", "agent_scope_mismatch"],
    });
    const aggregate = {
      summary: full.summary,
      scannedCount: full.scannedCount,
      validCount: full.validCount,
      malformedCount: full.malformedCount,
      matchedCount: full.matchedCount,
      recallReturnedCount: full.recallReturnedCount,
      recallTruncated: full.recallTruncated,
      privacySuppressedCount: full.privacySuppressedCount,
      privateProtectedCount: full.privateProtectedCount,
      anonymousMalformedCount: full.anonymousMalformedCount,
    };
    const expectedFilters: Array<[string, string, string[]]> = [
      ["malformed", "malformed_skill", ["malformed-a", "malformed-z"]],
      ["excluded", "inactive", ["inactive", "multi"]],
      ["excluded", "below_min_confidence", ["low-confidence", "multi"]],
      ["excluded", "project_scope_mismatch", ["multi", "project-mismatch"]],
      ["excluded", "agent_scope_mismatch", ["agent-mismatch", "multi"]],
      ["excluded", "no_context_match", ["no-context"]],
      ["matched_not_returned", "outside_limit", ["outside"]],
      ["selected", "selected", ["selected-one", "selected-two"]],
    ];
    const expectedStates: Array<[string, string[]]> = [
      ["malformed", ["malformed-a", "malformed-z"]],
      ["excluded", ["agent-mismatch", "inactive", "low-confidence", "multi", "no-context", "project-mismatch"]],
      ["matched_not_returned", ["outside"]],
      ["selected", ["selected-one", "selected-two"]],
    ];
    for (const [state, ids] of expectedStates) {
      const filtered = await run(rows, { ...input, state });
      expect(filtered.items.map((item: { skillId: string }) => item.skillId)).toEqual(ids);
      expect(filtered.diagnosticMatchedCount).toBe(ids.length);
      expect(filtered.summary).toEqual(full.summary);
    }
    for (const [state, reasonCode, ids] of expectedFilters) {
      const filtered = await run(rows, { ...input, state, reasonCode });
      expect(filtered.items.map((item: { skillId: string }) => item.skillId)).toEqual(ids);
      expect(filtered.diagnosticMatchedCount).toBe(ids.length);
      expect({
        summary: filtered.summary,
        scannedCount: filtered.scannedCount,
        validCount: filtered.validCount,
        malformedCount: filtered.malformedCount,
        matchedCount: filtered.matchedCount,
        recallReturnedCount: filtered.recallReturnedCount,
        recallTruncated: filtered.recallTruncated,
        privacySuppressedCount: filtered.privacySuppressedCount,
        privateProtectedCount: filtered.privateProtectedCount,
        anonymousMalformedCount: filtered.anonymousMalformedCount,
      }).toEqual(aggregate);
    }
    const impossible = await run(rows, { ...input, state: "selected", reasonCode: "inactive" });
    expect(impossible).toMatchObject({ diagnosticMatchedCount: 0, diagnosticReturnedCount: 0, diagnosticTruncated: false, items: [], ...aggregate });
    for (const itemLimit of [1, 2, 500]) {
      const limited = await run(rows, { ...input, itemLimit });
      expect({
        summary: limited.summary,
        scannedCount: limited.scannedCount,
        validCount: limited.validCount,
        malformedCount: limited.malformedCount,
        matchedCount: limited.matchedCount,
        recallReturnedCount: limited.recallReturnedCount,
        recallTruncated: limited.recallTruncated,
        privacySuppressedCount: limited.privacySuppressedCount,
        privateProtectedCount: limited.privateProtectedCount,
        anonymousMalformedCount: limited.anonymousMalformedCount,
      }).toEqual(aggregate);
      expect(limited.diagnosticMatchedCount).toBe(full.diagnosticMatchedCount);
      expect(limited.diagnosticReturnedCount).toBe(Math.min(itemLimit, full.diagnosticMatchedCount));
      expect(limited.diagnosticTruncated).toBe(itemLimit < full.diagnosticMatchedCount);
    }
    const shuffled = [rows[4], rows[9], rows[1], rows[7], rows[3], rows[10], rows[2], rows[8], rows[5], rows[0], rows[6]];
    await expect(run([...rows].reverse())).resolves.toEqual(full);
    await expect(run(shuffled)).resolves.toEqual(full);
  });

  it("fails closed for all duplicate normalized IDs without exposing private rows or KV order", async () => {
    enableRecall();
    const secret = "token=duplicate-diagnostics-private-marker-abcdefghijklmnopqrstuvwxyz";
    const valid = skill();
    const malformed = { ...skill(), steps: undefined };
    const privateRow = skill({ id: " skill_release ", name: secret });

    async function expectDuplicate(rows: unknown[]) {
      const before = JSON.parse(JSON.stringify(rows));
      sdk = mockSdk();
      kv = mockKV(rows);
      registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
      const result = await diagnostics({ project: "/repo/a", agentId: "agent_a" });
      expect(result).toMatchObject({ success: false, reason: "duplicate skill id", items: [], duplicateSkillIdCount: 1 });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(rows).toEqual(before);
      expect(kv.listScopes).toEqual([KV.skills]);
      expect(kv.getScopes).toEqual([]);
      expect(kv.writes).toEqual([]);
      expect(sdk.triggers).toEqual([]);
      return result;
    }

    const validMalformed = await expectDuplicate([valid, malformed]);
    await expect(expectDuplicate([malformed, valid])).resolves.toEqual(validMalformed);
    await expect(expectDuplicate([valid, skill({ name: "Duplicate release" })])).resolves.toMatchObject({ reason: "duplicate skill id" });
    const malformedPair = await expectDuplicate([malformed, { ...skill(), expectedOutcome: undefined }]);
    await expect(expectDuplicate([{ ...skill(), expectedOutcome: undefined }, malformed])).resolves.toEqual(malformedPair);
    const publicPrivate = await expectDuplicate([valid, privateRow]);
    await expect(expectDuplicate([privateRow, valid])).resolves.toEqual(publicPrivate);
    await expect(expectDuplicate([privateRow, skill({ id: "skill_release", name: "<private> other marker" })])).resolves.toMatchObject({ reason: "duplicate skill id" });
  });

  it("suppresses each private instruction field independently and keeps private malformed and excluded rows out of summaries", async () => {
    enableRecall();
    const fields = ["name", "triggerCondition", "steps", "expectedOutcome", "antiPatterns"] as const;
    const markers = fields.map((field) => `token=private-${field}-diagnostics-abcdefghijklmnopqrstuvwxyz`);
    const visiblePrivateRows = fields.map((field, index) => skill({
      id: `private-${field}`,
      ...(field === "steps" ? { steps: [markers[index]!] } : {}),
      ...(field === "antiPatterns" ? { antiPatterns: [markers[index]!] } : {}),
      ...(field !== "steps" && field !== "antiPatterns" ? { [field]: markers[index]! } : {}),
    }));
    const hiddenPrivateRows = [
      { id: "private-malformed", name: markers[0] },
      skill({ id: "private-inactive", name: markers[1], status: "retired" }),
      skill({ id: "private-low", name: markers[2], confidence: 0.6 }),
      skill({ id: "private-project", name: markers[3], project: "/repo/b" }),
      skill({ id: "private-agent", name: markers[4], agentId: "agent_b" }),
    ];
    const rows = [...visiblePrivateRows, ...hiddenPrivateRows];
    const before = JSON.parse(JSON.stringify(rows));
    kv = mockKV(rows);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    registerSkillRecallFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release", itemLimit: 500 };
    const result = await diagnostics(input);
    const recall = await sdk.getFunction("mem::skill-recall")!(input);
    expect(result).toMatchObject({
      privateProtectedCount: 10,
      privacySuppressedCount: 5,
      diagnosticMatchedCount: 0,
      diagnosticReturnedCount: 0,
      items: [],
      summary: { stateCounts: { malformed: 0, excluded: 0, matched_not_returned: 0, selected: 0 }, reasonCounts: {} },
    });
    expect(result.privacySuppressedCount).toBe(recall.privacySuppressedCount);
    const serialized = JSON.stringify(result);
    for (const marker of markers) expect(serialized).not.toContain(marker);
    for (const row of rows as Array<{ id?: string }>) expect(serialized).not.toContain(row.id!);
    expect(rows).toEqual(before);
    expect(kv.listScopes).toEqual([KV.skills, KV.skills]);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("preserves every Phase 5A explanation state without exposing policy internals or private content", async () => {
    enableRecall();
    const secret = "token=explanation-private-marker-abcdefghijklmnopqrstuvwxyz";
    const rows = [
      { id: "malformed", name: "broken" },
      skill({ id: "private", name: secret }),
      skill({ id: "excluded", status: "retired" }),
      skill({ id: "outside", confidence: 0.8 }),
      skill({ id: "selected", confidence: 0.9 }),
    ];
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "1";
    kv = mockKV(rows);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release" };
    const expectations: Array<[string, string, string[]]> = [
      ["malformed", "malformed", ["malformed_skill"]],
      ["private", "privacy_suppressed", ["privacy_suppressed"]],
      ["excluded", "excluded", ["inactive"]],
      ["outside", "matched_not_returned", ["outside_limit"]],
      ["selected", "selected", ["selected"]],
    ];
    for (const [skillId, state, reasonCodes] of expectations) {
      const explanation = await sdk.getFunction("mem::skill-recall-explain")!({ skillId, ...input });
      expect(explanation).toMatchObject({ success: true, state, reasonCodes });
      expect(explanation).not.toHaveProperty("containsPrivateData");
      expect(JSON.stringify(explanation)).not.toContain("containsPrivateData");
    }
    const privateExplanation = await sdk.getFunction("mem::skill-recall-explain")!({ skillId: "private", ...input });
    expect(JSON.stringify(privateExplanation)).not.toContain(secret);

    kv = mockKV([skill({ id: " duplicate ", name: "Duplicate one" }), skill({ id: "duplicate", name: "Duplicate two" })]);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    const duplicate = await sdk.getFunction("mem::skill-recall-explain")!({ skillId: "duplicate", ...input });
    expect(duplicate).toMatchObject({ success: false, reason: "duplicate skill id" });
    expect(duplicate).not.toHaveProperty("state");
    expect(duplicate).not.toHaveProperty("rank");
    expect(duplicate).not.toHaveProperty("scoreBreakdown");
    expect(duplicate).not.toHaveProperty("advisory");
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("keeps diagnostics out of the MCP registry and performs no mutation or non-skills reads", () => {
    expect(getAllTools().some((tool) => tool.name === "memory_skill_recall_diagnostics")).toBe(false);
    expect(getAllTools()).toHaveLength(60);
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
    expect(sdk.triggers).toEqual([]);
  });

  it("defensively allocates diagnostics and preserves Phase 5A explanation output", async () => {
    enableRecall();
    const rows = [skill(), skill({ id: "skill_second", name: "Release checklist" })];
    const rowsBefore = JSON.parse(JSON.stringify(rows));
    kv = mockKV(rows);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release" };

    const first = await diagnostics(input);
    const firstItem = first.items[0]!;
    const firstSummary = first.summary;
    firstItem.skillId = "mutated";
    firstItem.reasonCodes.push("inactive");
    firstItem.scoreBreakdown!.totalScore = -1;
    firstSummary.stateCounts.selected = 99;
    firstSummary.reasonCounts.selected = 99;
    first.items.push({ skillId: "added", state: "selected", reasonCodes: ["selected"], selected: true });
    first.items[0] = { skillId: "replaced", state: "selected", reasonCodes: ["selected"], selected: true };
    first.summary = { stateCounts: { malformed: 99, excluded: 99, matched_not_returned: 99, selected: 99 }, reasonCounts: { selected: 99 } };
    const second = await diagnostics(input);
    expect(second.items[0]!.skillId).toBe("skill_release");
    expect(second.items[0]!.reasonCodes).toEqual(["selected"]);
    expect(second.items[0]!.scoreBreakdown!.totalScore).toBeGreaterThanOrEqual(0);
    expect(second.summary.stateCounts.selected).toBe(2);
    expect(second.summary.reasonCounts.selected).toBe(2);
    expect(rows).toEqual(rowsBefore);

    const explanation = await sdk.getFunction("mem::skill-recall-explain")!({ skillId: "skill_release", ...input });
    expect(explanation).toMatchObject({ success: true, state: "selected", reasonCodes: ["selected"] });
    expect(explanation).not.toHaveProperty("containsPrivateData");
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });
});
