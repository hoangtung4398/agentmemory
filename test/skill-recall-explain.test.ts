import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    name: "Validate release changes",
    triggerCondition: "Before releasing AgentMemory changes",
    steps: ["Run focused tests"],
    expectedOutcome: "Release validation is complete.",
    antiPatterns: ["Skip focused validation"],
    project: "/repo/a",
    agentId: "agent_a",
    files: ["src/functions/observe.ts"],
    concepts: ["release", "validation"],
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

describe("internal skill recall explanation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillRecallExplainFunction(sdk as never, kv as never);
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

  async function explain(input: Record<string, unknown>) {
    return sdk.getFunction("mem::skill-recall-explain")!(input);
  }

  it("is disabled by default and rejects invalid input before KV", async () => {
    await expect(explain({ skillId: "skill_release" })).resolves.toMatchObject({
      success: true,
      enabled: false,
      reason: "skill recall explanation is disabled",
      scannedCount: 0,
      reasonCodes: [],
    });
    enableRecall();
    await expect(explain({ skillId: " " })).resolves.toMatchObject({
      success: false,
      reason: "invalid skill recall explanation input",
      scannedCount: 0,
    });
    await expect(explain({ skillId: "x".repeat(201) })).resolves.toMatchObject({
      success: false,
      reason: "invalid skill recall explanation input",
      scannedCount: 0,
    });
    expect(kv.listScopes).toEqual([]);
    expect(kv.writes).toEqual([]);
  });

  it("uses one list and returns stable storage failures", async () => {
    enableRecall();
    kv = mockKV([skill()]);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    kv.failList();

    await expect(explain({ skillId: "skill_release" })).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill recall explanation",
      scannedCount: 0,
    });
    expect(kv.listScopes).toEqual([KV.skills]);
    expect(kv.writes).toEqual([]);
  });

  it("reports missing, malformed, and canonical exclusion reasons", async () => {
    enableRecall();
    kv = mockKV([
      { id: "broken", name: "broken" },
      skill(),
      skill({ id: "inactive", status: "retired", confidence: 0.6, project: "/repo/b", agentId: "agent_b" }),
    ]);
    registerSkillRecallExplainFunction(sdk as never, kv as never);

    await expect(explain({ skillId: "unknown" })).resolves.toMatchObject({ success: false, reason: "skill not found" });
    await expect(explain({ skillId: "broken" })).resolves.toMatchObject({
      state: "malformed", reasonCodes: ["malformed_skill"], selected: false,
      scannedCount: 3, validCount: 2, malformedCount: 1, privacySuppressedCount: 0,
    });
    await expect(explain({ skillId: "inactive", project: "/repo/a", agentId: "agent_a" })).resolves.toMatchObject({
      state: "excluded",
      reasonCodes: ["inactive", "below_min_confidence", "project_scope_mismatch", "agent_scope_mismatch"],
      selected: false,
    });
    expect(kv.writes).toEqual([]);
  });

  it("fails closed for every duplicate normalized target ID without leaking or using KV order", async () => {
    enableRecall();
    const privateMarker = "token=duplicate-private-marker-abcdefghijklmnopqrstuvwxyz123456";
    const valid = skill();
    const malformedSteps = { ...skill(), steps: undefined };
    const malformedOutcome = { ...skill(), expectedOutcome: undefined };
    const privateRow = skill({ name: privateMarker });

    async function expectDuplicate(rows: unknown[]) {
      const rowsBefore = JSON.parse(JSON.stringify(rows));
      sdk = mockSdk();
      kv = mockKV(rows);
      registerSkillRecallExplainFunction(sdk as never, kv as never);

      const result = await explain({ skillId: "skill_release", project: "/repo/a", agentId: "agent_a" });

      expect(result).toMatchObject({
        success: false,
        reason: "duplicate skill id",
        skillId: "skill_release",
        reasonCodes: [],
        selected: false,
      });
      expect(result).not.toHaveProperty("state");
      expect(result).not.toHaveProperty("rank");
      expect(result).not.toHaveProperty("scoreBreakdown");
      expect(result).not.toHaveProperty("advisory");
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      expect(rows).toEqual(rowsBefore);
      expect(kv.listScopes).toEqual([KV.skills]);
      expect(kv.getScopes).toEqual([]);
      expect(kv.writes).toEqual([]);
      expect(sdk.triggers).toEqual([]);
      return result;
    }

    const validMalformed = await expectDuplicate([valid, malformedSteps]);
    await expect(expectDuplicate([malformedSteps, valid])).resolves.toEqual(validMalformed);
    await expect(expectDuplicate([valid, skill({ name: "Duplicate release" })])).resolves.toMatchObject({
      reason: "duplicate skill id",
    });
    const malformedPair = await expectDuplicate([malformedSteps, malformedOutcome]);
    await expect(expectDuplicate([malformedOutcome, malformedSteps])).resolves.toEqual(malformedPair);
    await expect(expectDuplicate([valid, skill({ id: " skill_release " })])).resolves.toMatchObject({
      reason: "duplicate skill id",
    });
    await expect(expectDuplicate([privateRow, valid])).resolves.toMatchObject({
      reason: "duplicate skill id",
    });
  });

  it("reports no-context and private rows without leaking private instructions", async () => {
    enableRecall();
    const secret = "token=abcdefghijklmnopqrstuvwxyz1234567890";
    kv = mockKV([
      skill({ id: "no-context", concepts: ["other"], files: ["other.ts"] }),
      skill({ id: "private", name: secret }),
    ]);
    registerSkillRecallExplainFunction(sdk as never, kv as never);

    await expect(explain({
      skillId: "no-context",
      project: "/repo/a",
      agentId: "agent_a",
      query: "unrelated",
    })).resolves.toMatchObject({
      state: "excluded",
      reasonCodes: ["no_context_match"],
      scoreBreakdown: { projectScopeScore: 6, agentScopeScore: 8, totalScore: 14 },
    });
    const privateResult = await explain({ skillId: "private", project: "/repo/a", agentId: "agent_a" });
    expect(privateResult).toMatchObject({
      state: "privacy_suppressed", reasonCodes: ["privacy_suppressed"], selected: false,
      privacySuppressedCount: 1,
    });
    expect(JSON.stringify(privateResult)).not.toContain(secret);
    expect(privateResult).not.toHaveProperty("advisory");
    expect(kv.writes).toEqual([]);
  });

  it("returns deterministic selected and outside-limit explanations with recall-equivalent advisory", async () => {
    enableRecall();
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "1";
    const rows = [
      skill(),
      skill({ id: "skill_second", confidence: 0.8, strength: 0.7, updatedAt: "2026-07-15T00:00:00.000Z" }),
    ];
    kv = mockKV(rows);
    registerSkillRecallExplainFunction(sdk as never, kv as never);
    registerSkillRecallFunction(sdk as never, kv as never);
    const input = {
      project: "/repo/a", agentId: "agent_a", concepts: ["release"],
      files: ["src/functions/observe.ts"], query: "release validation",
    };

    const selected = await explain({ skillId: "skill_release", ...input });
    const outside = await explain({ skillId: "skill_second", ...input });
    const recall = await sdk.getFunction("mem::skill-recall")!(input);
    expect(selected).toMatchObject({
      state: "selected", reasonCodes: ["selected"], rank: 1, selected: true,
      scoreBreakdown: {
        projectScopeScore: 6, agentScopeScore: 8, conceptMatchCount: 1, conceptScore: 3,
        fileMatchCount: 1, fileScore: 2, queryTokenMatchCount: 2, queryScore: 2, totalScore: 21,
      },
      advisory: recall.advisories[0],
    });
    expect(outside).toMatchObject({
      state: "matched_not_returned", reasonCodes: ["outside_limit"], rank: 2, selected: false,
    });
    expect(await explain({ skillId: "skill_release", ...input })).toEqual(selected);
    expect(kv.writes).toEqual([]);
  });

  it("caps each contextual score component and leaves input fixtures unchanged", async () => {
    enableRecall();
    const row = skill({
      name: "q1 q2 q3 q4 q5 q6 q7 q8 q9",
      concepts: ["c1", "c2", "c3", "c4"],
      files: ["f1", "f2", "f3", "f4"],
    });
    const rows = [row];
    const input = {
      skillId: "skill_release",
      project: "/repo/a",
      agentId: "agent_a",
      concepts: ["c1", "c2", "c3", "c4"],
      files: ["f1", "f2", "f3", "f4"],
      query: "q1 q2 q3 q4 q5 q6 q7 q8 q9",
    };
    const rowsBefore = JSON.parse(JSON.stringify(rows));
    const inputBefore = JSON.parse(JSON.stringify(input));
    kv = mockKV(rows);
    registerSkillRecallExplainFunction(sdk as never, kv as never);

    await expect(explain(input)).resolves.toMatchObject({
      scoreBreakdown: {
        conceptMatchCount: 3,
        conceptScore: 9,
        fileMatchCount: 3,
        fileScore: 6,
        queryTokenMatchCount: 8,
        queryScore: 8,
        totalScore: 37,
      },
    });
    expect(rows).toEqual(rowsBefore);
    expect(input).toEqual(inputBefore);
    expect(kv.writes).toEqual([]);
  });
});
