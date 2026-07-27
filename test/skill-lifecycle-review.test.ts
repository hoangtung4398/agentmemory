import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillLifecycleReviewFunction } from "../src/functions/skill-lifecycle-review.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_LIFECYCLE_REVIEW",
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
    failureCount: 1,
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

describe("mem::skill-lifecycle-review", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableReview(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_LIFECYCLE_REVIEW"] = "true";
  }

  async function review(input: Record<string, unknown> = { skillId: "skill_release" }) {
    return sdk.getFunction("mem::skill-lifecycle-review")!(input);
  }

  it("registers only the internal lifecycle-review function", () => {
    expect([...sdk.functions.keys()]).toEqual(["mem::skill-lifecycle-review"]);
  });

  it("returns before state access while disabled", async () => {
    await expect(review()).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      reason: "skill lifecycle review is disabled",
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("rejects invalid input before accessing state", async () => {
    enableReview();
    await expect(review({ skillId: " " })).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "invalid skill lifecycle review input",
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
  });

  it("returns no review for positive current-version evidence", async () => {
    enableReview();
    kv = mockKV([event("feedback-2"), event("feedback-1", { createdAt: "2026-07-20T00:00:00.000Z" })], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: true,
      enabled: true,
      applied: false,
      recommendation: "no_review",
      reasons: ["feedback_within_expected_range"],
      feedback: { success: 2, failure: 0, correction: 0, stale: 0 },
      sourceEventIds: ["feedback-2", "feedback-1"],
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("recommends review for corrections, stale evidence, or failures exceeding successes", async () => {
    enableReview();
    kv = mockKV([
      event("success", { kind: "success" }),
      event("failure-1", { kind: "failure" }),
      event("failure-2", { kind: "failure" }),
      event("correction", { kind: "correction" }),
      event("stale", { kind: "stale" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      recommendation: "review",
      reasons: ["correction_feedback", "stale_feedback", "failures_exceed_successes"],
      feedback: { success: 1, failure: 2, correction: 1, stale: 1 },
    });
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("does not recommend review for inactive skills", async () => {
    enableReview();
    kv = mockKV([event("stale", { kind: "stale" })], skill({ status: "retired" }));
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      recommendation: "no_review",
      reasons: ["skill_not_active"],
      status: "retired",
    });
  });

  it("filters to the current skill version and compatible scope", async () => {
    enableReview();
    kv = mockKV([
      event("included"),
      event("old-version", { skillVersion: 1, kind: "stale" }),
      event("other-project", { project: "project-b", kind: "stale" }),
      event("other-agent", { agentId: "agent-b", kind: "correction" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      applicableCount: 1,
      ignoredCount: 3,
      feedback: { success: 1, failure: 0, correction: 0, stale: 0 },
      sourceEventIds: ["included"],
      recommendation: "no_review",
    });
  });

  it("counts malformed feedback without repairing it", async () => {
    enableReview();
    kv = mockKV([event("included"), { id: "malformed" }], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      scannedCount: 2,
      validCount: 1,
      malformedCount: 1,
      applicableCount: 1,
    });
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("reports state-read failures without writing", async () => {
    enableReview();
    kv = mockKV([], skill());
    kv.failList();
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "failed to load skill lifecycle review",
    });
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });
});
