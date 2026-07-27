import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillLifecycleReviewFunction } from "../src/functions/skill-lifecycle-review.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill, SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_FEEDBACK_REDUCER",
  "AGENTMEMORY_SKILL_LIFECYCLE_REVIEW",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_CONTEXT",
  "AGENTMEMORY_SKILL_PROMOTION",
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
  const setCalls: string[] = [];
  const updateCalls: string[] = [];
  const deleteCalls: string[] = [];
  let shouldFailGet = false;
  let shouldFailList = false;
  return {
    getCalls,
    listCalls,
    setCalls,
    updateCalls,
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
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      setCalls.push(scope);
      return value;
    },
    update: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      updateCalls.push(scope);
      return value;
    },
    delete: async (scope: string): Promise<void> => {
      deleteCalls.push(scope);
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
    usageCount: 999,
    successCount: 999,
    failureCount: 999,
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

  function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { skillId: "skill_release", project: "project-a", agentId: "agent-a", ...overrides };
  }

  async function review(data: Record<string, unknown> = input()) {
    return sdk.getFunction("mem::skill-lifecycle-review")!(data);
  }

  function expectNoWrites(): void {
    expect(kv.setCalls).toEqual([]);
    expect(kv.updateCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  }

  it("registers only the internal lifecycle-review function", () => {
    expect([...sdk.functions.keys()]).toEqual(["mem::skill-lifecycle-review"]);
  });

  it.each([
    {},
    { AGENTMEMORY_SKILLS: "true" },
    { AGENTMEMORY_SKILLS: "false", AGENTMEMORY_SKILL_LIFECYCLE_REVIEW: "true" },
  ])("returns before state access while disabled: %o", async (environment) => {
    Object.assign(process.env, environment);

    await expect(review()).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      recommendation: "none",
      reason: "skill lifecycle review is disabled",
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("works while feedback, diagnostics, reducer, recall, context, and promotion remain disabled", async () => {
    enableReview();
    kv = mockKV([event("one"), event("two", { createdAt: "2026-07-22T00:00:00.000Z" })], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      recommendation: "keep_active",
      reasonCodes: ["stable_user_confirmed_success"],
    });
    expectNoWrites();
  });

  it.each([
    {},
    { skillId: " " },
    { skillId: "s".repeat(201) },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: 0 },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: -1 },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: 1.5 },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: Number.NaN },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: Number.POSITIVE_INFINITY },
    { skillId: "skill_release", project: "project-a", agentId: "agent-a", skillVersion: "2" },
    { skillId: "skill_release", project: " ", agentId: "agent-a" },
    { skillId: "skill_release", project: "project-a", agentId: {} },
  ])("rejects invalid input before state access: %o", async (data) => {
    enableReview();
    await expect(review(data)).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "invalid skill lifecycle review input",
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("performs one skill get and stops for failed, missing, malformed, or version-mismatched skills", async () => {
    enableReview();
    kv.failGet();
    await expect(review()).resolves.toMatchObject({ reason: "failed to load skill lifecycle review" });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([]);

    kv = mockKV([], null);
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    await expect(review()).resolves.toMatchObject({ reason: "skill not found" });

    kv = mockKV([], { ...skill(), status: "unknown" });
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    await expect(review()).resolves.toMatchObject({ reason: "skill not found" });

    kv = mockKV([], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    await expect(review(input({ skillVersion: 1 }))).resolves.toMatchObject({ reason: "skill version mismatch" });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it.each([
    ["persisted id differs", skill({ id: "skill_other" })],
    ["zero version", { ...skill(), version: 0 }],
    ["negative version", { ...skill(), version: -1 }],
    ["decimal version", { ...skill(), version: 1.5 }],
    ["string version", { ...skill(), version: "2" }],
    ["unknown status", { ...skill(), status: "unknown" }],
    ["blank project", { ...skill(), project: " " }],
    ["oversized project", { ...skill(), project: "p".repeat(501) }],
    ["non-string project", { ...skill(), project: 1 }],
    ["blank agent", { ...skill(), agentId: " " }],
    ["oversized agent", { ...skill(), agentId: "a".repeat(501) }],
    ["non-string agent", { ...skill(), agentId: false }],
  ])("rejects malformed persisted skill: %s", async (_name, malformedSkill) => {
    enableReview();
    kv = mockKV([], malformedSkill);
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: false,
      enabled: true,
      recommendation: "none",
      reason: "skill not found",
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("treats scope as an assertion and rejects missing, mismatched, or unscoped assertions", async () => {
    enableReview();
    kv = mockKV([], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    for (const data of [
      { skillId: "skill_release", agentId: "agent-a" },
      { skillId: "skill_release", project: "project-b", agentId: "agent-a" },
      { skillId: "skill_release", project: "project-a" },
      { skillId: "skill_release", project: "project-a", agentId: "agent-b" },
    ]) {
      await expect(review(data)).resolves.toMatchObject({ reason: "skill scope mismatch" });
    }
    expect(kv.listCalls).toEqual([]);

    kv = mockKV([], skill({ project: undefined, agentId: undefined }));
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    for (const data of [
      { skillId: "skill_release", project: "project-a" },
      { skillId: "skill_release", agentId: "agent-a" },
      { skillId: "skill_release", project: "project-a", agentId: "agent-a" },
    ]) {
      await expect(review(data)).resolves.toMatchObject({ reason: "skill scope mismatch" });
    }
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it.each(["retired", "superseded"] as const)("does not list feedback for a %s skill", async (status) => {
    enableReview();
    kv = mockKV([event("stale", { kind: "stale" })], skill({ status }));
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: true,
      currentStatus: status,
      recommendation: "none",
      reasonCodes: ["skill_not_active"],
      scannedCount: 0,
      applicableCount: 0,
    });
    expect(kv.getCalls).toEqual([{ scope: KV.skills, key: "skill_release" }]);
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("counts valid and malformed rows, filters scoped evidence, and never mutates stored rows", async () => {
    enableReview();
    const storedRows: unknown[] = [
      event("included", { createdAt: "2026-07-23T00:00:00.000Z" }),
      event("old", { skillVersion: 1 }),
      event("future", { skillVersion: 3 }),
      event("other-skill", { skillId: "other" }),
      event("other-project", { project: "project-b" }),
      event("other-agent", { agentId: "agent-b" }),
      { id: "malformed" },
    ];
    const storedSkill = skill();
    const beforeRows = JSON.stringify(storedRows);
    const beforeSkill = JSON.stringify(storedSkill);
    kv = mockKV(storedRows, storedSkill);
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      scannedCount: 7,
      validCount: 6,
      malformedCount: 1,
      applicableCount: 1,
      ignoredCount: 5,
      sourceEventIds: ["included"],
    });
    expect(JSON.stringify(storedRows)).toBe(beforeRows);
    expect(JSON.stringify(storedSkill)).toBe(beforeSkill);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expectNoWrites();
  });

  it("includes contextual current-version evidence for unscoped skills", async () => {
    enableReview();
    kv = mockKV([
      event("project-a"),
      event("project-b", { project: "project-b", agentId: "agent-b" }),
    ], skill({ project: undefined, agentId: undefined }));
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review({ skillId: "skill_release" })).resolves.toMatchObject({
      applicableCount: 2,
      ignoredCount: 0,
      sourceEventIds: ["project-a", "project-b"],
    });
  });

  it("orders evidence deterministically and returns defensive count objects", async () => {
    enableReview();
    const rows = [
      event("b", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("a", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("newer", { kind: "failure", attribution: "agent-observed", createdAt: "2026-07-23T00:00:00.000Z" }),
    ];
    kv = mockKV([...rows].reverse(), skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    const first = await review();

    kv = mockKV(rows, skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    const second = await review();

    expect(first.sourceEventIds).toEqual(["newer", "a", "b"]);
    expect(first.latestEvidenceAt).toBe("2026-07-23T00:00:00.000Z");
    expect(first.latestUserConfirmedKind).toBe("success");
    expect(second).toEqual(first);
    first.sourceEventIds.push("changed");
    first.evidenceCounts.total = 999;
    expect(second.sourceEventIds).toEqual(["newer", "a", "b"]);
    expect(second.evidenceCounts.total).toBe(3);
  });

  it("fails closed for duplicate applicable IDs but ignores duplicates outside the target review", async () => {
    enableReview();
    kv = mockKV([
      event("duplicate", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("duplicate", { kind: "failure", createdAt: "2026-07-21T00:00:00.000Z" }),
      event("outside", { skillId: "other" }),
      event("outside", { skillId: "other", kind: "failure" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: false,
      recommendation: "none",
      reason: "duplicate feedback event id",
      duplicateEventIds: ["duplicate"],
      sourceEventIds: ["duplicate", "duplicate"],
      applicableCount: 2,
      ignoredCount: 2,
    });
    expectNoWrites();
  });

  it("returns every duplicate occurrence while sorting unique duplicate IDs", async () => {
    enableReview();
    kv = mockKV([
      event("z", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("a", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("m", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("z", { kind: "failure", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("a", { kind: "failure", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("m", { kind: "failure", createdAt: "2026-07-22T00:00:00.000Z" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: false,
      recommendation: "none",
      reason: "duplicate feedback event id",
      duplicateEventIds: ["a", "m", "z"],
      sourceEventIds: ["a", "a", "m", "m", "z", "z"],
    });
    expectNoWrites();
  });

  it("returns a stable read failure when the active skill ledger cannot be listed", async () => {
    enableReview();
    kv = mockKV([], skill());
    kv.failList();
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    await expect(review()).resolves.toMatchObject({
      success: false,
      enabled: true,
      skillId: "skill_release",
      reason: "failed to load skill lifecycle review",
    });
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expectNoWrites();
  });

  it("applies the exact recommendation precedence and evidence rules", async () => {
    enableReview();
    const cases: Array<{
      name: string;
      rows: SkillFeedbackEvent[];
      recommendation: string;
      reasonCodes: string[];
    }> = [
      {
        name: "retirement after repeated current stale evidence",
        rows: [
          event("stale-new", { kind: "stale", createdAt: "2026-07-23T00:00:00.000Z" }),
          event("stale-old", { kind: "stale", createdAt: "2026-07-22T00:00:00.000Z" }),
        ],
        recommendation: "review_for_retirement",
        reasonCodes: ["repeated_user_confirmed_stale"],
      },
      {
        name: "revision from correction and repeated failure",
        rows: [
          event("correction", { kind: "correction", createdAt: "2026-07-23T00:00:00.000Z" }),
          event("failure-1", { kind: "failure" }),
          event("failure-2", { kind: "failure", createdAt: "2026-07-20T00:00:00.000Z" }),
        ],
        recommendation: "review_for_revision",
        reasonCodes: ["user_confirmed_correction", "repeated_user_confirmed_failure"],
      },
      {
        name: "revision from repeated failures",
        rows: [event("failure-1", { kind: "failure" }), event("failure-2", { kind: "failure", createdAt: "2026-07-20T00:00:00.000Z" })],
        recommendation: "review_for_revision",
        reasonCodes: ["repeated_user_confirmed_failure"],
      },
      {
        name: "keep active requires user-confirmed success and no negative event",
        rows: [event("success-1"), event("success-2", { createdAt: "2026-07-20T00:00:00.000Z" })],
        recommendation: "keep_active",
        reasonCodes: ["stable_user_confirmed_success"],
      },
      {
        name: "no applicable evidence",
        rows: [],
        recommendation: "none",
        reasonCodes: ["no_applicable_feedback"],
      },
      {
        name: "latest confirmed success preserves mixed evidence without recommendation",
        rows: [
          event("success", { createdAt: "2026-07-23T00:00:00.000Z" }),
          event("failure", { kind: "failure", createdAt: "2026-07-22T00:00:00.000Z" }),
        ],
        recommendation: "none",
        reasonCodes: ["latest_user_confirmed_success", "negative_feedback_present"],
      },
      {
        name: "agent-observed evidence alone is insufficient",
        rows: [
          event("success-1", { attribution: "agent-observed" }),
          event("success-2", { attribution: "agent-observed", createdAt: "2026-07-20T00:00:00.000Z" }),
        ],
        recommendation: "none",
        reasonCodes: ["insufficient_user_confirmed_evidence"],
      },
    ];

    for (const testCase of cases) {
      kv = mockKV(testCase.rows, skill());
      registerSkillLifecycleReviewFunction(sdk as never, kv as never);
      const result = await review();
      expect(result, testCase.name).toMatchObject({
        recommendation: testCase.recommendation,
        reasonCodes: testCase.reasonCodes,
      });
      expectNoWrites();
    }
  });

  it("does not recommend retirement when newer confirmed success follows stale evidence", async () => {
    enableReview();
    kv = mockKV([
      event("success", { createdAt: "2026-07-23T00:00:00.000Z" }),
      event("stale-1", { kind: "stale", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("stale-2", { kind: "stale", createdAt: "2026-07-21T00:00:00.000Z" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    const result = await review();
    expect(result).toMatchObject({
      recommendation: "none",
      reasonCodes: ["latest_user_confirmed_success", "negative_feedback_present"],
      latestUserConfirmedKind: "success",
    });
    expect(result.recommendation).not.toBe("review_for_retirement");
    expectNoWrites();
  });

  it("does not keep active when agent-observed negative evidence is present", async () => {
    enableReview();
    kv = mockKV([
      event("success-new", { createdAt: "2026-07-23T00:00:00.000Z" }),
      event("agent-failure", { kind: "failure", attribution: "agent-observed", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("success-old", { createdAt: "2026-07-21T00:00:00.000Z" }),
    ], skill());
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);

    const result = await review();
    expect(result).toMatchObject({
      recommendation: "none",
      reasonCodes: ["latest_user_confirmed_success", "negative_feedback_present"],
    });
    expect(result.recommendation).not.toBe("keep_active");
    expectNoWrites();
  });

  it("does not let persisted quality metrics affect lifecycle review output", async () => {
    enableReview();
    const rows = [
      event("success-new", { createdAt: "2026-07-23T00:00:00.000Z" }),
      event("success-old", { createdAt: "2026-07-21T00:00:00.000Z" }),
    ];
    const lowEvidenceSkill = skill({
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      confidence: 0,
      strength: 0,
    });
    const highEvidenceSkill = {
      ...skill({
        usageCount: 999999,
        successCount: 999999,
        failureCount: 999999,
        confidence: 1,
        strength: 1,
      }),
      lastUsedAt: "2026-07-23T00:00:00.000Z",
      lastReinforcedAt: "2026-07-23T00:00:00.000Z",
    };
    const beforeLow = JSON.stringify(lowEvidenceSkill);
    const beforeHigh = JSON.stringify(highEvidenceSkill);

    kv = mockKV(rows, lowEvidenceSkill);
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    const lowResult = await review();
    expectNoWrites();

    kv = mockKV(rows, highEvidenceSkill);
    registerSkillLifecycleReviewFunction(sdk as never, kv as never);
    const highResult = await review();
    expectNoWrites();

    expect(highResult).toEqual(lowResult);
    expect(JSON.stringify(lowEvidenceSkill)).toBe(beforeLow);
    expect(JSON.stringify(highEvidenceSkill)).toBe(beforeHigh);
  });
});
