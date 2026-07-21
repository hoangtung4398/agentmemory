import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillFeedbackFunction } from "../src/functions/skill-feedback.js";
import { fingerprintId, KV } from "../src/state/schema.js";
import type { AgentSkill, SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = ["AGENTMEMORY_SKILLS", "AGENTMEMORY_SKILL_FEEDBACK"];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const getCalls: Array<{ scope: string; key: string }> = [];
  const setCalls: Array<{ scope: string; key: string; value: unknown }> = [];
  const failGets = new Set<string>();
  const failSets = new Set<string>();

  return {
    getCalls,
    setCalls,
    failGet: (scope: string) => failGets.add(scope),
    failSet: (scope: string) => failSets.add(scope),
    clearCalls: () => {
      getCalls.length = 0;
      setCalls.length = 0;
    },
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      getCalls.push({ scope, key });
      if (failGets.has(scope)) throw new Error(`get failed: ${scope}`);
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (failSets.has(scope)) throw new Error(`set failed: ${scope}`);
      setCalls.push({ scope, key, value });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "skill_release",
    name: "Validate a release",
    triggerCondition: "Before releasing a change",
    steps: ["Run focused tests", "Run the full suite"],
    expectedOutcome: "Release checks are complete.",
    antiPatterns: [],
    files: ["package.json"],
    concepts: ["release"],
    confidence: 0.8,
    strength: 0.8,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    sourceProceduralMemoryIds: ["proc_release"],
    sourceCandidateIds: [],
    sourceObservationIds: ["obs_seed"],
    sourceSessionIds: ["session_seed"],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    status: "active",
    version: 2,
    ...overrides,
  };
}

describe("mem::skill-feedback-record", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillFeedbackFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableFeedback(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_FEEDBACK"] = "true";
  }

  async function seedSkill(value = skill()): Promise<AgentSkill> {
    await kv.set(KV.skills, value.id, value);
    kv.clearCalls();
    return value;
  }

  async function record(overrides: Record<string, unknown> = {}) {
    return sdk.getFunction("mem::skill-feedback-record")!({
      idempotencyKey: "feedback-1",
      skillId: "skill_release",
      kind: "success",
      attribution: "user-confirmed",
      sourceObservationIds: [" obs_1 ", "obs_1", "obs_2"],
      sourceSessionIds: [" session_1 "],
      ...overrides,
    });
  }

  it("is disabled by default without any state access", async () => {
    const result = await record();

    expect(result).toEqual({
      success: true,
      recorded: false,
      duplicate: false,
      reason: "skill feedback is disabled",
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
  });

  it("validates malformed input before any state access", async () => {
    enableFeedback();
    const invalidInputs = [
      { idempotencyKey: undefined },
      { idempotencyKey: " " },
      { idempotencyKey: "a".repeat(201) },
      { skillId: " " },
      { kind: "unknown" },
      { attribution: "unknown" },
      { kind: "correction", attribution: "agent-observed" },
      { project: " " },
      { agentId: "a".repeat(501) },
      { sourceObservationIds: "obs_1" },
      { sourceSessionIds: [" "] },
      { sourceObservationIds: ["o".repeat(201)] },
      { sourceObservationIds: Array.from({ length: 21 }, (_, index) => `obs_${index}`) },
      { sourceSessionIds: [1] },
    ];

    for (const overrides of invalidInputs) {
      kv.clearCalls();
      await expect(record(overrides)).resolves.toEqual({
        success: false,
        recorded: false,
        duplicate: false,
        reason: "invalid skill feedback input",
      });
      expect(kv.getCalls).toEqual([]);
      expect(kv.setCalls).toEqual([]);
    }
  });

  it("records one normalized immutable event without mutating the skill", async () => {
    enableFeedback();
    const storedSkill = await seedSkill();
    const before = JSON.stringify(storedSkill);

    const result = await record({ project: " project-a ", agentId: " agent-a ", sessionId: " session-current " });
    const feedbackId = fingerprintId("skill-feedback", "skill_release\nfeedback-1");

    expect(result).toEqual({ success: true, recorded: true, duplicate: false, feedbackId });
    expect(kv.getCalls).toEqual([
      { scope: KV.skillFeedback, key: feedbackId },
      { scope: KV.skills, key: "skill_release" },
    ]);
    expect(kv.setCalls).toHaveLength(1);
    expect(kv.setCalls[0]!.scope).toBe(KV.skillFeedback);
    const event = kv.setCalls[0]!.value as SkillFeedbackEvent;
    expect(event).toMatchObject({
      id: feedbackId,
      skillId: "skill_release",
      skillVersion: 2,
      kind: "success",
      attribution: "user-confirmed",
      source: "explicit",
      project: "project-a",
      agentId: "agent-a",
      sessionId: "session-current",
      sourceObservationIds: ["obs_1", "obs_2"],
      sourceSessionIds: ["session_1"],
    });
    expect(event.createdAt).toEqual(expect.any(String));
    expect(JSON.stringify(await kv.get(KV.skills, "skill_release"))).toBe(before);
    expect(JSON.stringify(event)).not.toContain("feedback-1");
  });

  it("accepts each permitted feedback kind and attribution", async () => {
    enableFeedback();
    await seedSkill();
    const cases = [
      ["success", "user-confirmed"],
      ["success", "agent-observed"],
      ["failure", "user-confirmed"],
      ["failure", "agent-observed"],
      ["correction", "user-confirmed"],
      ["stale", "user-confirmed"],
      ["stale", "agent-observed"],
    ] as const;

    for (const [kind, attribution] of cases) {
      kv.clearCalls();
      await expect(record({ idempotencyKey: `${kind}-${attribution}`, kind, attribution })).resolves.toMatchObject({
        success: true,
        recorded: true,
        duplicate: false,
      });
      expect(kv.setCalls.filter((call) => call.scope === KV.skillFeedback)).toHaveLength(1);
    }
  });

  it("rejects missing and malformed target skills without writing feedback", async () => {
    enableFeedback();
    const invalidSkills: unknown[] = [
      null,
      "skill_release",
      [],
      skill({ id: "different" }),
      skill({ status: "retired" }),
      skill({ status: "superseded" }),
      skill({ project: " " }),
      skill({ confidence: Number.NaN }),
      skill({ strength: 2 }),
      skill({ usageCount: -1 }),
      skill({ successCount: 1.5 }),
      skill({ failureCount: Number.NaN }),
      skill({ version: 0 }),
      skill({ createdAt: "not-a-date" }),
      skill({ steps: ["Run tests", " "] }),
      skill({ antiPatterns: "not-an-array" as never }),
      skill({ files: ["package.json", 1] as never }),
      skill({ sourceSessionIds: null as never }),
    ];

    for (const invalidSkill of invalidSkills) {
      await kv.set(KV.skills, "skill_release", invalidSkill);
      kv.clearCalls();
      await expect(record()).resolves.toEqual({
        success: false,
        recorded: false,
        duplicate: false,
        reason: "agent skill is missing or invalid",
      });
      expect(kv.setCalls).toEqual([]);
    }
  });

  it("enforces exact project and agent scope without narrowing a global skill", async () => {
    enableFeedback();
    await seedSkill(skill({ project: "project-a", agentId: "agent-a" }));

    await expect(record({ project: "project-a", agentId: "agent-a" })).resolves.toMatchObject({ recorded: true });
    await expect(record({ idempotencyKey: "project-missing", agentId: "agent-a" })).resolves.toMatchObject({
      success: false,
      reason: "skill feedback scope does not match agent skill",
    });
    await expect(record({ idempotencyKey: "project-cross", project: "project-b", agentId: "agent-a" })).resolves.toMatchObject({
      success: false,
      reason: "skill feedback scope does not match agent skill",
    });
    await expect(record({ idempotencyKey: "agent-missing", project: "project-a" })).resolves.toMatchObject({
      success: false,
      reason: "skill feedback scope does not match agent skill",
    });
    await expect(record({ idempotencyKey: "agent-cross", project: "project-a", agentId: "agent-b" })).resolves.toMatchObject({
      success: false,
      reason: "skill feedback scope does not match agent skill",
    });

    await seedSkill(skill());
    await expect(record({ idempotencyKey: "global", project: "project-b", agentId: "agent-b" })).resolves.toMatchObject({ recorded: true });
    const globalEvent = kv.setCalls.at(-1)!.value as SkillFeedbackEvent;
    expect(globalEvent).toMatchObject({ project: "project-b", agentId: "agent-b" });
    expect(await kv.get<AgentSkill>(KV.skills, "skill_release")).toEqual(skill());
  });

  it("returns a duplicate without rereading the skill or writing again", async () => {
    enableFeedback();
    await seedSkill();

    const first = await record();
    kv.clearCalls();
    const second = await record();

    expect(second).toEqual({ success: true, recorded: false, duplicate: true, feedbackId: first.feedbackId });
    expect(kv.getCalls).toEqual([{ scope: KV.skillFeedback, key: first.feedbackId }]);
    expect(kv.setCalls).toEqual([]);
  });

  it("fails closed for idempotency conflicts and malformed existing events", async () => {
    enableFeedback();
    await seedSkill();
    const first = await record();

    kv.clearCalls();
    for (const overrides of [
      { kind: "failure" },
      { attribution: "agent-observed" },
      { project: "project-b" },
      { sourceObservationIds: ["obs_3"] },
    ]) {
      await expect(record(overrides)).resolves.toEqual({
        success: false,
        recorded: false,
        duplicate: false,
        reason: "skill feedback idempotency conflict",
      });
    }
    expect(kv.getCalls).toEqual([
      { scope: KV.skillFeedback, key: first.feedbackId },
      { scope: KV.skillFeedback, key: first.feedbackId },
      { scope: KV.skillFeedback, key: first.feedbackId },
      { scope: KV.skillFeedback, key: first.feedbackId },
    ]);
    expect(kv.setCalls).toEqual([]);

    const malformedId = fingerprintId("skill-feedback", "skill_release\nmalformed");
    await kv.set(KV.skillFeedback, malformedId, { id: malformedId });
    kv.clearCalls();
    await expect(record({ idempotencyKey: "malformed" })).resolves.toEqual({
      success: false,
      recorded: false,
      duplicate: false,
      reason: "existing skill feedback event is malformed",
    });
    expect(kv.setCalls).toEqual([]);
  });

  it("serializes concurrent identical requests into one write", async () => {
    enableFeedback();
    await seedSkill();

    const [first, second] = await Promise.all([record(), record()]);

    expect([first.recorded, second.recorded].filter(Boolean)).toHaveLength(1);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
    expect(kv.setCalls.filter((call) => call.scope === KV.skillFeedback)).toHaveLength(1);
  });

  it("returns stable failures for feedback lookup, skill lookup, and feedback writes", async () => {
    enableFeedback();
    kv.failGet(KV.skillFeedback);
    await expect(record()).resolves.toMatchObject({ success: false, reason: "failed to load skill feedback" });

    kv = mockKV();
    registerSkillFeedbackFunction(sdk as never, kv as never);
    await seedSkill();
    kv.failGet(KV.skills);
    await expect(record({ idempotencyKey: "skill-get-failure" })).resolves.toMatchObject({ success: false, reason: "failed to load agent skill" });

    kv = mockKV();
    registerSkillFeedbackFunction(sdk as never, kv as never);
    await seedSkill();
    kv.failSet(KV.skillFeedback);
    await expect(record({ idempotencyKey: "feedback-set-failure" })).resolves.toMatchObject({ success: false, reason: "failed to write skill feedback" });
    expect(await kv.get(KV.skillFeedback, fingerprintId("skill-feedback", "skill_release\nfeedback-set-failure"))).toBeNull();
  });
});
