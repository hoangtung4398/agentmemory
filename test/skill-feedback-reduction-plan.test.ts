import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillFeedbackReductionPlanFunction } from "../src/functions/skill-feedback-reduction-plan.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_FEEDBACK_REDUCER",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV(rows: unknown[] = [], currentSkill: unknown = null) {
  const getCalls: Array<{ scope: string; key: string }> = [];
  const listCalls: string[] = [];
  const setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  const deleteCalls: Array<{ scope: string; key: string }> = [];
  let shouldFailGet = false;
  let shouldFailList = false;
  return {
    rows,
    currentSkill,
    getCalls,
    listCalls,
    setCalls,
    deleteCalls,
    failGet: () => { shouldFailGet = true; },
    failList: () => { shouldFailList = true; },
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      getCalls.push({ scope, key });
      if (shouldFailGet) throw new Error("get failed");
      return currentSkill as T | null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      if (shouldFailList) throw new Error("list failed");
      return rows as T[];
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      setCalls.push({ scope, key, value });
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      deleteCalls.push({ scope, key });
    },
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Release safely",
    triggerCondition: "before release",
    steps: ["run tests"],
    expectedOutcome: "safe release",
    antiPatterns: [],
    project: "project-a",
    agentId: "agent-a",
    files: [],
    concepts: [],
    confidence: 0.8,
    strength: 0.9,
    usageCount: 10,
    successCount: 3,
    failureCount: 4,
    sourceProceduralMemoryIds: [],
    sourceCandidateIds: [],
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    status: "active",
    version: 2,
    ...overrides,
  };
}

function event(id: string, overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId: "skill_release",
    skillVersion: 2,
    kind: "success",
    attribution: "user-confirmed",
    source: "explicit",
    project: "project-a",
    agentId: "agent-a",
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("mem::skill-feedback-reduction-plan", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableReducer(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_FEEDBACK_REDUCER"] = "true";
  }

  async function plan(input: Record<string, unknown> = { skillId: "skill_release" }) {
    return sdk.getFunction("mem::skill-feedback-reduction-plan")!(input);
  }

  it("registers only the internal reduction-plan function", () => {
    expect([...sdk.functions.keys()]).toEqual(["mem::skill-feedback-reduction-plan"]);
  });

  it.each([
    {},
    { AGENTMEMORY_SKILLS: "true" },
    { AGENTMEMORY_SKILLS: "true", AGENTMEMORY_SKILL_FEEDBACK_REDUCER: "false" },
    { AGENTMEMORY_SKILLS: "true", AGENTMEMORY_SKILL_FEEDBACK: "true" },
  ])("returns before state access while disabled: %o", async (environment) => {
    Object.assign(process.env, environment);

    await expect(plan()).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      reason: "skill feedback reducer is disabled",
      duplicateEventIds: [],
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("plans historical feedback while feedback recording remains disabled", async () => {
    enableReducer();
    kv = mockKV([event("feedback-1")], skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    await expect(plan()).resolves.toMatchObject({
      success: true,
      enabled: true,
      applicableCount: 1,
      proposedDelta: { success: 1, failure: 0 },
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
  });

  it("rejects invalid input before accessing state", async () => {
    enableReducer();
    const invalidInputs = [
      {},
      { skillId: " " },
      { skillId: [] },
      { skillId: {} },
      { skillId: 1 },
      { skillId: true },
      { skillId: "skill_release", skillVersion: 0 },
      { skillId: "skill_release", skillVersion: -1 },
      { skillId: "skill_release", skillVersion: 1.5 },
      { skillId: "skill_release", project: " " },
      { skillId: "skill_release", project: {} },
      { skillId: "skill_release", agentId: " " },
      { skillId: "skill_release", agentId: false },
    ];

    for (const input of invalidInputs) {
      await expect(plan(input)).resolves.toMatchObject({
        success: false,
        enabled: true,
        reason: "invalid skill feedback reduction plan input",
        duplicateEventIds: [],
      });
    }
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("stops after the direct skill lookup when the skill is missing or the version differs", async () => {
    enableReducer();

    await expect(plan()).resolves.toMatchObject({ reason: "skill not found", duplicateEventIds: [] });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([]);

    kv = mockKV([], skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
    await expect(plan({ skillId: "skill_release", skillVersion: 1 })).resolves.toMatchObject({
      reason: "skill version mismatch",
      duplicateEventIds: [],
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("returns a deterministic read-only plan for valid current-version evidence", async () => {
    enableReducer();
    const storedSkill = skill();
    const rows: unknown[] = [
      event("success-b", { createdAt: "2026-07-21T00:00:02.000Z" }),
      event("success-a", { createdAt: "2026-07-21T00:00:02.000Z" }),
      event("failure", { kind: "failure", createdAt: "2026-07-21T00:00:03.000Z" }),
      event("correction", { kind: "correction", createdAt: "2026-07-21T00:00:04.000Z" }),
      event("stale", { kind: "stale", createdAt: "2026-07-21T00:00:01.000Z" }),
      event("old-version", { skillVersion: 1 }),
      event("other-skill", { skillId: "skill_other" }),
      {},
      { id: "malformed", skillId: "skill_release" },
    ];
    kv = mockKV(rows, storedSkill);
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
    const beforeSkill = JSON.stringify(storedSkill);
    const beforeRows = JSON.stringify(rows);

    const result = await plan();

    expect(result).toMatchObject({
      success: true,
      enabled: true,
      applied: false,
      skillId: "skill_release",
      skillVersion: 2,
      scannedCount: 9,
      validCount: 7,
      malformedCount: 2,
      applicableCount: 5,
      ignoredCount: 2,
      proposedDelta: { success: 2, failure: 2 },
      currentCounters: { success: 3, failure: 4 },
      proposedCounters: { success: 5, failure: 6 },
      sourceEventIds: ["correction", "failure", "success-a", "success-b", "stale"],
      duplicateEventIds: [],
    });
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
    expect(JSON.stringify(storedSkill)).toBe(beforeSkill);
    expect(JSON.stringify(rows)).toBe(beforeRows);
  });

  it("uses exact project and agent filters without case folding or substring matching", async () => {
    enableReducer();
    const unscopedSkill = skill({ project: undefined, agentId: undefined });
    kv = mockKV([
      event("exact", { project: "project-a", agentId: "agent-a" }),
      event("other-project", { project: "project-a-long", agentId: "agent-a" }),
      event("other-agent", { project: "project-a", agentId: "agent-a-long" }),
      event("case-variant", { project: "Project-A", agentId: "agent-a" }),
    ], unscopedSkill);
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    await expect(plan({ skillId: "skill_release", project: "project-a", agentId: "agent-a" })).resolves.toMatchObject({
      applicableCount: 1,
      ignoredCount: 3,
      sourceEventIds: ["exact"],
      proposedDelta: { success: 1, failure: 0 },
    });
  });

  it("fails closed for duplicate applicable event IDs without writing state", async () => {
    enableReducer();
    const storedSkill = skill();
    const rows = [event("duplicate"), event("duplicate")];
    kv = mockKV(rows, storedSkill);
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    const beforeSkill = JSON.stringify(storedSkill);
    const beforeRows = JSON.stringify(rows);
    const result = await plan();

    expect(result).toMatchObject({
      success: false,
      enabled: true,
      applied: false,
      reason: "duplicate feedback event id",
      skillId: "skill_release",
      skillVersion: 2,
      scannedCount: 2,
      validCount: 2,
      malformedCount: 0,
      duplicateEventIds: ["duplicate"],
      applicableCount: 2,
      ignoredCount: 0,
      proposedDelta: { success: 0, failure: 0 },
      sourceEventIds: [],
    });
    expect("evidenceHash" in result).toBe(false);
    expect("currentCounters" in result).toBe(false);
    expect("proposedCounters" in result).toBe(false);
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
    expect(JSON.stringify(storedSkill)).toBe(beforeSkill);
    expect(JSON.stringify(rows)).toBe(beforeRows);
  });

  it("returns stable failures without writes when either required read fails", async () => {
    enableReducer();
    kv.failGet();
    await expect(plan()).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill feedback reduction plan",
      duplicateEventIds: [],
    });
    expect(kv.listCalls).toEqual([]);

    kv = mockKV([], skill());
    kv.failList();
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
    await expect(plan()).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill feedback reduction plan",
      duplicateEventIds: [],
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("returns defensive result values", async () => {
    enableReducer();
    const storedSkill = skill();
    const rows = [event("feedback-1")];
    kv = mockKV(rows, storedSkill);
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    const result = await plan();
    result.sourceEventIds.push("changed");
    result.duplicateEventIds.push("changed");
    result.proposedDelta.success = 99;
    result.currentCounters!.success = 99;
    result.proposedCounters!.failure = 99;

    expect(storedSkill.successCount).toBe(3);
    expect(storedSkill.failureCount).toBe(4);
    expect(rows[0]!.id).toBe("feedback-1");
    expect(rows[0]!.sourceObservationIds).toEqual([]);
  });

  it("returns the approved exact evidence hash for the canonical event vector", async () => {
    enableReducer();
    kv = mockKV([
      event("evt-1", {
        skillId: "skill-1",
        project: undefined,
        agentId: undefined,
        sourceObservationIds: ["obs-2", "obs-1"],
      }),
    ], skill({ id: "skill-1", project: undefined, agentId: undefined }));
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    await expect(plan({ skillId: "skill-1" })).resolves.toMatchObject({
      applicableCount: 1,
      duplicateEventIds: [],
      evidenceHash: "60594b2e3280f6f3e151a39c45c4cd229177d99886469bf0466fc0036ed1680c",
    });
  });

  it("hashes empty applicable evidence deterministically", async () => {
    enableReducer();
    kv = mockKV([event("old-version", { skillVersion: 1 })], skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    const result = await plan();

    expect(result).toMatchObject({
      applicableCount: 0,
      proposedDelta: { success: 0, failure: 0 },
      currentCounters: { success: 3, failure: 4 },
      proposedCounters: { success: 3, failure: 4 },
      sourceEventIds: [],
      duplicateEventIds: [],
      evidenceHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    });
  });

  it("keeps the hash and canonical source IDs stable across ledger insertion order and ignored evidence", async () => {
    enableReducer();
    const applicable = [
      event("later", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("earlier", { createdAt: "2026-07-21T00:00:00.000Z" }),
    ];
    const ignored = [
      {},
      event("old", { skillVersion: 1 }),
      event("other", { skillId: "other-skill" }),
      event("other-project", { project: "other-project" }),
      event("other-agent", { agentId: "other-agent" }),
    ];
    kv = mockKV([...applicable, ...ignored], skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
    const first = await plan();

    kv = mockKV([...ignored, ...[...applicable].reverse()], skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);
    const second = await plan();

    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.sourceEventIds).toEqual(["later", "earlier"]);
    expect(second.sourceEventIds).toEqual(["later", "earlier"]);
    expect(first.duplicateEventIds).toEqual([]);
    expect(second.duplicateEventIds).toEqual([]);
  });

  it.each([
    ["old-version", [event("duplicate", { skillVersion: 1 }), event("duplicate", { skillVersion: 1 })]],
    ["other skill", [event("duplicate", { skillId: "other-skill" }), event("duplicate", { skillId: "other-skill" })]],
    ["other project", [event("duplicate", { project: "other-project" }), event("duplicate", { project: "other-project" })]],
    ["other agent", [event("duplicate", { agentId: "other-agent" }), event("duplicate", { agentId: "other-agent" })]],
  ])("does not fail for duplicate IDs in ignored %s evidence", async (_name, rows) => {
    enableReducer();
    kv = mockKV(rows, skill());
    registerSkillFeedbackReductionPlanFunction(sdk as never, kv as never);

    await expect(plan()).resolves.toMatchObject({
      success: true,
      applicableCount: 0,
      duplicateEventIds: [],
      evidenceHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    });
  });
});
