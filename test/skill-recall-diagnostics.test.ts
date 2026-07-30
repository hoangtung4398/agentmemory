import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillRecallDiagnosticsFunction } from "../src/functions/skill-recall-diagnostics.js";
import { registerSkillRecallExplainFunction } from "../src/functions/skill-recall-explain.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill } from "../src/types.js";

const ENV_KEYS = ["AGENTMEMORY_SKILLS", "AGENTMEMORY_SKILL_RECALL", "AGENTMEMORY_SKILL_RECALL_LIMIT"];
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
    const invalid = [null, [], "value", { state: "privacy_suppressed" }, { reasonCode: "privacy_suppressed" }, { itemLimit: 0 }, { itemLimit: -1 }, { itemLimit: 1.5 }, { itemLimit: Number.NaN }, { itemLimit: Infinity }, { itemLimit: -Infinity }, { itemLimit: 501 }, { files: "bad" }];
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

  it("defensively allocates diagnostics and preserves Phase 5A explanation output", async () => {
    enableRecall();
    kv = mockKV([skill(), skill({ id: "skill_second", name: "Release checklist" })]);
    registerSkillRecallDiagnosticsFunction(sdk as never, kv as never);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    const input = { project: "/repo/a", agentId: "agent_a", query: "release" };

    const first = await diagnostics(input);
    first.items[0]!.skillId = "mutated";
    first.items[0]!.reasonCodes.push("inactive");
    first.items[0]!.scoreBreakdown!.totalScore = -1;
    first.summary.stateCounts.selected = 99;
    first.summary.reasonCounts.selected = 99;
    const second = await diagnostics(input);
    expect(second.items[0]!.skillId).toBe("skill_release");
    expect(second.items[0]!.reasonCodes).toEqual(["selected"]);
    expect(second.items[0]!.scoreBreakdown!.totalScore).toBeGreaterThanOrEqual(0);
    expect(second.summary.stateCounts.selected).toBe(2);
    expect(second.summary.reasonCounts.selected).toBe(2);

    const explanation = await sdk.getFunction("mem::skill-recall-explain")!({ skillId: "skill_release", ...input });
    expect(explanation).toMatchObject({ success: true, state: "selected", reasonCodes: ["selected"] });
    expect(explanation).not.toHaveProperty("containsPrivateData");
    expect(kv.getScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });
});
