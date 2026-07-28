import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillLifecycleReviewInventoryFunction } from "../src/functions/skill-lifecycle-review-inventory.js";
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

function mockKV(skillRows: unknown[] = [], feedbackRows: unknown[] = []) {
  const getCalls: string[] = [];
  const listCalls: string[] = [];
  const setCalls: string[] = [];
  const updateCalls: string[] = [];
  const deleteCalls: string[] = [];
  const failedScopes = new Set<string>();
  return {
    getCalls,
    listCalls,
    setCalls,
    updateCalls,
    deleteCalls,
    failList: (scope: string) => failedScopes.add(scope),
    get: async <T>(scope: string): Promise<T | null> => {
      getCalls.push(scope);
      return null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      if (failedScopes.has(scope)) throw new Error("list failed");
      return (scope === KV.skills ? skillRows : feedbackRows) as T[];
    },
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      setCalls.push(scope);
      return value;
    },
    update: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      updateCalls.push(scope);
      return value;
    },
    delete: async (scope: string): Promise<void> => { deleteCalls.push(scope); },
  };
}

function mockSingleReviewKV(currentSkill: unknown, feedbackRows: unknown[] = []) {
  const getCalls: string[] = [];
  const listCalls: string[] = [];
  const writes: string[] = [];
  return {
    getCalls,
    listCalls,
    writes,
    get: async <T>(scope: string): Promise<T | null> => {
      getCalls.push(scope);
      return currentSkill as T | null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      return feedbackRows as T[];
    },
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      writes.push(scope);
      return value;
    },
    update: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      writes.push(scope);
      return value;
    },
    delete: async (scope: string): Promise<void> => { writes.push(scope); },
  };
}

function skill(id: string, overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id,
    name: id,
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
    usageCount: 1,
    successCount: 1,
    failureCount: 0,
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

function event(id: string, skillId = "skill-a", overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId,
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

describe("mem::skill-lifecycle-review-inventory", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
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

  async function inventory(data: Record<string, unknown> = {}) {
    return sdk.getFunction("mem::skill-lifecycle-review-inventory")!(data);
  }

  function expectNoWrites(): void {
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.updateCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  }

  it("registers only the internal inventory function", () => {
    expect([...sdk.functions.keys()]).toEqual(["mem::skill-lifecycle-review-inventory"]);
  });

  it.each([{}, { AGENTMEMORY_SKILLS: "true" }, {
    AGENTMEMORY_SKILLS: "false",
    AGENTMEMORY_SKILL_LIFECYCLE_REVIEW: "true",
  }])("returns before validation and KV access while disabled: %o", async (environment) => {
    Object.assign(process.env, environment);
    await expect(inventory({ scanLimit: 0 })).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      reason: "skill lifecycle review inventory is disabled",
    });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("only requires the existing skills and lifecycle-review flags", async () => {
    enableReview();
    kv = mockKV([skill("skill-a")], [event("one"), event("two", "skill-a", {
      createdAt: "2026-07-22T00:00:00.000Z",
    })]);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    await expect(inventory()).resolves.toMatchObject({
      success: true,
      enabled: true,
      summary: { recommendationCounts: { keep_active: 1 } },
    });
    expect(kv.listCalls).toEqual([KV.skills, KV.skillFeedback]);
    expectNoWrites();
  });

  it.each([
    { project: " " }, { agentId: 1 }, { status: "ACTIVE" }, { recommendation: "retire" },
    { reasonCode: "unknown" }, { scanLimit: 0 }, { scanLimit: -1 }, { scanLimit: 1.5 },
    { scanLimit: Number.POSITIVE_INFINITY }, { scanLimit: "2" }, { scanLimit: 5001 },
    { limit: 0 }, { limit: 500.5 }, { limit: "2" }, { limit: 501 },
  ])("rejects invalid input before all KV access: %o", async (data) => {
    enableReview();
    await expect(inventory(data)).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "invalid skill lifecycle review inventory input",
    });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("uses one skills list, counts malformed rows, filters exactly, and scans deterministically", async () => {
    enableReview();
    const rows: unknown[] = [
      skill("z", { project: "project-b" }),
      { id: "malformed" },
      skill("b"),
      skill("a"),
      skill("unscoped", { project: undefined, agentId: undefined }),
    ];
    const before = JSON.stringify(rows);
    kv = mockKV(rows, []);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const result = await inventory({ project: "project-a", scanLimit: 1 });
    expect(result).toMatchObject({
      skillRowCount: 5,
      validSkillCount: 4,
      malformedSkillCount: 1,
      candidateCount: 2,
      ignoredSkillCount: 2,
      scannedCount: 1,
      scanTruncated: true,
      items: [{ skillId: "a" }],
    });
    expect(kv.listCalls).toEqual([KV.skills, KV.skillFeedback]);
    expect(JSON.stringify(rows)).toBe(before);
    expectNoWrites();
  });

  it("fails closed for sorted duplicate valid skill IDs before filtering or feedback reads", async () => {
    enableReview();
    kv = mockKV([skill("z"), skill("a"), skill("z", { version: 3 }), skill("a", { version: 3 })]);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    await expect(inventory({ project: "no-match" })).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "duplicate skill id",
      skillRowCount: 4,
      validSkillCount: 4,
      duplicateSkillIds: ["a", "z"],
      scannedCount: 0,
    });
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it("does not read feedback when all scanned skills are inactive", async () => {
    enableReview();
    kv = mockKV([skill("retired", { status: "retired" }), skill("superseded", { status: "superseded" })]);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    await expect(inventory()).resolves.toMatchObject({
      feedbackScannedCount: 0,
      validFeedbackCount: 0,
      items: [
        { skillId: "retired", recommendation: "none", reasonCodes: ["skill_not_active"] },
        { skillId: "superseded", recommendation: "none", reasonCodes: ["skill_not_active"] },
      ],
    });
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it("returns stable failures for skills and required feedback loads", async () => {
    enableReview();
    kv.failList(KV.skills);
    await expect(inventory()).resolves.toMatchObject({ reason: "failed to load skill lifecycle review inventory" });
    expect(kv.listCalls).toEqual([KV.skills]);

    kv = mockKV([skill("skill-a")]);
    kv.failList(KV.skillFeedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    await expect(inventory()).resolves.toMatchObject({
      success: false,
      reason: "failed to load skill lifecycle review inventory",
      scannedCount: 1,
      items: [],
    });
    expect(kv.listCalls).toEqual([KV.skills, KV.skillFeedback]);
    expectNoWrites();
  });

  it("uses shared policy results, isolates duplicate feedback failures, and ignores unrelated duplicates", async () => {
    enableReview();
    const rows = [skill("skill-a"), skill("skill-b"), skill("skill-c")];
    const feedback = [
      event("stale-new", "skill-a", { kind: "stale", createdAt: "2026-07-23T00:00:00.000Z" }),
      event("stale-old", "skill-a", { kind: "stale", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("duplicate", "skill-b"), event("duplicate", "skill-b", { kind: "failure" }),
      event("outside", "other"), event("outside", "other", { kind: "failure" }),
    ];
    kv = mockKV(rows, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const result = await inventory();
    expect(result).toMatchObject({
      success: true,
      summary: {
        failedItemCount: 1,
        recommendationCounts: { review_for_retirement: 1, none: 2 },
      },
      items: [
        { skillId: "skill-b", success: false, duplicateEventIds: ["duplicate"], reason: "duplicate feedback event id" },
        { skillId: "skill-a", recommendation: "review_for_retirement" },
        { skillId: "skill-c", recommendation: "none", reasonCodes: ["no_applicable_feedback"] },
      ],
    });
    expectNoWrites();
  });

  it("applies post-evaluation filters, result limit ordering, and summaries over scanned items", async () => {
    enableReview();
    const rows = [skill("skill-a"), skill("skill-b"), skill("skill-c")];
    const feedback = [
      event("a-new", "skill-a", { kind: "stale", createdAt: "2026-07-23T00:00:00.000Z" }),
      event("a-old", "skill-a", { kind: "stale", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("b-new", "skill-b", { kind: "failure", createdAt: "2026-07-21T00:00:00.000Z" }),
      event("b-old", "skill-b", { kind: "failure", createdAt: "2026-07-20T00:00:00.000Z" }),
    ];
    kv = mockKV(rows, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const result = await inventory({ limit: 1 });
    expect(result).toMatchObject({
      scannedCount: 3,
      matchedCount: 3,
      returnedCount: 1,
      resultTruncated: true,
      truncated: true,
      items: [{ skillId: "skill-a", recommendation: "review_for_retirement" }],
      summary: {
        recommendationCounts: { review_for_retirement: 1, review_for_revision: 1, none: 1 },
        reasonCounts: {
          repeated_user_confirmed_stale: 1,
          repeated_user_confirmed_failure: 1,
          no_applicable_feedback: 1,
        },
      },
    });

    await expect(inventory({ reasonCode: "repeated_user_confirmed_failure" })).resolves.toMatchObject({
      matchedCount: 1,
      items: [{ skillId: "skill-b", recommendation: "review_for_revision" }],
    });
    expectNoWrites();
  });

  it("returns defensively allocated inventory data independent of physical row order and metrics", async () => {
    enableReview();
    const firstRows = [skill("b", { usageCount: 0, confidence: 0 }), skill("a", { usageCount: 99, confidence: 1 })];
    const feedback = [event("two", "a", { createdAt: "2026-07-22T00:00:00.000Z" }), event("one", "a")];
    kv = mockKV(firstRows, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const first = await inventory();

    kv = mockKV([...firstRows].reverse(), [...feedback].reverse());
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const second = await inventory();
    expect(second).toEqual(first);
    first.items[0]!.reasonCodes.push("no_applicable_feedback");
    first.items[0]!.evidenceCounts.total = 999;
    expect(second.items[0]!.reasonCodes).not.toContain("no_applicable_feedback");
    expect(second.items[0]!.evidenceCounts.total).not.toBe(999);
    expectNoWrites();
  });

  it("accepts minimal persisted skill rows and evaluates inactive rows without repairing them", async () => {
    enableReview();
    const rows: unknown[] = [
      { id: "minimal-active", version: 1, status: "active", project: "project-a", agentId: "agent-a" },
      { id: "minimal-retired", version: 1, status: "retired", project: "project-a", agentId: "agent-a" },
      { id: "minimal-superseded", version: 1, status: "superseded", project: "project-a", agentId: "agent-a" },
    ];
    const before = JSON.stringify(rows);
    kv = mockKV(rows, [event("active", "minimal-active", { skillVersion: 1 })]);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const result = await inventory();
    expect(result).toMatchObject({
      validSkillCount: 3,
      malformedSkillCount: 0,
      items: [
        { skillId: "minimal-active", recommendation: "none", reasonCodes: ["latest_user_confirmed_success"] },
        { skillId: "minimal-retired", reasonCodes: ["skill_not_active"] },
        { skillId: "minimal-superseded", reasonCodes: ["skill_not_active"] },
      ],
    });
    expect(JSON.stringify(rows)).toBe(before);
    expectNoWrites();
  });

  it("applies exact agent, status, and combined scope filters before scanning", async () => {
    enableReview();
    const rows = [
      skill("agent-a", { agentId: "agent-a", status: "active" }),
      skill("agent-b", { agentId: "agent-b", status: "retired" }),
      skill("unscoped", { agentId: undefined, project: undefined, status: "superseded" }),
      skill("same-agent-other-project", { agentId: "agent-a", project: "project-b", status: "active" }),
    ];
    kv = mockKV(rows);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    await expect(inventory({ agentId: "agent-a" })).resolves.toMatchObject({
      candidateCount: 2,
      ignoredSkillCount: 2,
      scannedCount: 2,
    });
    await expect(inventory({ status: "active" })).resolves.toMatchObject({ candidateCount: 2, ignoredSkillCount: 2, scannedCount: 2 });
    await expect(inventory({ status: "retired" })).resolves.toMatchObject({ candidateCount: 1, ignoredSkillCount: 3, scannedCount: 1 });
    await expect(inventory({ status: "superseded" })).resolves.toMatchObject({ candidateCount: 1, ignoredSkillCount: 3, scannedCount: 1 });
    await expect(inventory({ project: "project-a", agentId: "agent-a" })).resolves.toMatchObject({
      candidateCount: 1,
      items: [{ skillId: "agent-a" }],
    });
    expectNoWrites();
  });

  it("applies every recommendation filter after evaluation while preserving full summary", async () => {
    enableReview();
    const rows = [skill("retire"), skill("revise"), skill("keep"), skill("none")];
    const feedback = [
      event("retire-1", "retire", { kind: "stale", createdAt: "2026-07-24T00:00:00.000Z" }),
      event("retire-2", "retire", { kind: "stale", createdAt: "2026-07-23T00:00:00.000Z" }),
      event("revise", "revise", { kind: "correction" }),
      event("keep-1", "keep", { createdAt: "2026-07-23T00:00:00.000Z" }),
      event("keep-2", "keep", { createdAt: "2026-07-22T00:00:00.000Z" }),
    ];
    kv = mockKV(rows, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    for (const [recommendation, skillId] of [
      ["review_for_retirement", "retire"], ["review_for_revision", "revise"],
      ["keep_active", "keep"], ["none", "none"],
    ]) {
      const result = await inventory({ recommendation });
      expect(result.matchedCount).toBe(1);
      expect(result.items).toMatchObject([{ skillId, recommendation }]);
      expect(result.summary.recommendationCounts).toEqual({
        none: 1, keep_active: 1, review_for_revision: 1, review_for_retirement: 1,
      });
    }
    expectNoWrites();
  });

  it("matches single-review policy across every recommendation class and item failures", async () => {
    enableReview();
    const cases: Array<{ name: string; persisted: AgentSkill; feedback: SkillFeedbackEvent[] }> = [
      { name: "retirement", persisted: skill("target"), feedback: [event("s1", "target", { kind: "stale", createdAt: "2026-07-23T00:00:00.000Z" }), event("s2", "target", { kind: "stale" })] },
      { name: "correction", persisted: skill("target"), feedback: [event("c", "target", { kind: "correction" })] },
      { name: "failure", persisted: skill("target"), feedback: [event("f1", "target", { kind: "failure" }), event("f2", "target", { kind: "failure", createdAt: "2026-07-20T00:00:00.000Z" })] },
      { name: "success", persisted: skill("target"), feedback: [event("ok1", "target"), event("ok2", "target", { createdAt: "2026-07-20T00:00:00.000Z" })] },
      { name: "latest success", persisted: skill("target"), feedback: [event("ok", "target", { createdAt: "2026-07-23T00:00:00.000Z" }), event("old", "target", { kind: "failure" })] },
      { name: "weak", persisted: skill("target"), feedback: [event("agent", "target", { attribution: "agent-observed" })] },
      { name: "empty", persisted: skill("target"), feedback: [] },
      { name: "retired", persisted: skill("target", { status: "retired" }), feedback: [] },
      { name: "superseded", persisted: skill("target", { status: "superseded" }), feedback: [] },
      { name: "duplicate", persisted: skill("target"), feedback: [event("dupe", "target"), event("dupe", "target", { kind: "failure" })] },
    ];
    for (const testCase of cases) {
      const singleSdk = mockSdk();
      const singleKV = mockSingleReviewKV(testCase.persisted, testCase.feedback);
      registerSkillLifecycleReviewFunction(singleSdk as never, singleKV as never);
      const single = await singleSdk.getFunction("mem::skill-lifecycle-review")!({
        skillId: "target", project: "project-a", agentId: "agent-a",
      });
      kv = mockKV([testCase.persisted], testCase.feedback);
      registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
      const item = (await inventory()).items[0]!;
      for (const field of ["success", "recommendation", "reasonCodes", "applicableCount", "evidenceCounts", "duplicateEventIds", "latestEvidenceAt", "latestUserConfirmedKind", "reason"] as const) {
        expect(item[field], `${testCase.name}: ${field}`).toEqual(single[field]);
      }
      expect(singleKV.writes).toEqual([]);
      expectNoWrites();
    }
  });

  it("orders all priorities deterministically and accounts for malformed feedback", async () => {
    enableReview();
    const rows = [skill("failed"), skill("retire"), skill("revise"), skill("keep"), skill("none-late"), skill("none-empty")];
    const feedback: unknown[] = [
      event("dupe", "failed"), event("dupe", "failed", { kind: "failure" }),
      event("s1", "retire", { kind: "stale", createdAt: "2026-07-25T00:00:00.000Z" }), event("s2", "retire", { kind: "stale", createdAt: "2026-07-24T00:00:00.000Z" }),
      event("c", "revise", { kind: "correction" }),
      event("k1", "keep", { createdAt: "2026-07-23T00:00:00.000Z" }), event("k2", "keep", { createdAt: "2026-07-22T00:00:00.000Z" }),
      event("weak", "none-late", { attribution: "agent-observed", createdAt: "2026-07-21T00:00:00.000Z" }),
      event("ignored", "other"), { id: "malformed" }, { nope: true },
    ];
    kv = mockKV([...rows].reverse(), [...feedback].reverse());
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const result = await inventory();
    expect(result.items.map((item) => item.skillId)).toEqual(["failed", "retire", "revise", "keep", "none-late", "none-empty"]);
    expect(result).toMatchObject({ feedbackScannedCount: 11, validFeedbackCount: 9, malformedFeedbackCount: 2 });
    expect(result.items.find((item) => item.skillId === "retire")!.evidenceCounts.total).toBe(2);
    expect(result.summary).toEqual({
      statusCounts: { active: 6, retired: 0, superseded: 0 },
      recommendationCounts: { none: 3, keep_active: 1, review_for_revision: 1, review_for_retirement: 1 },
      reasonCounts: {
        repeated_user_confirmed_stale: 1,
        user_confirmed_correction: 1,
        stable_user_confirmed_success: 1,
        insufficient_user_confirmed_evidence: 1,
        no_applicable_feedback: 1,
      },
      failedItemCount: 1,
    });
    expect(kv.listCalls).toEqual([KV.skills, KV.skillFeedback]);
    expectNoWrites();
  });

  it("keeps summaries and returned objects independent of filters, limits, metrics, and mutations", async () => {
    enableReview();
    const logical = [skill("active"), skill("retired", { status: "retired" }), skill("superseded", { status: "superseded" })];
    const changedMetrics = logical.map((value) => ({
      ...value,
      name: "changed", triggerCondition: "changed", steps: ["changed"], expectedOutcome: "changed", antiPatterns: ["changed"], files: ["changed"], concepts: ["changed"],
      usageCount: 999, successCount: 888, failureCount: 777, confidence: 0, strength: 0,
      lastUsedAt: "2027-01-01T00:00:00.000Z", lastReinforcedAt: "2027-01-01T00:00:00.000Z", createdAt: "2027-01-01T00:00:00.000Z", updatedAt: "2027-01-01T00:00:00.000Z",
      sourceProceduralMemoryIds: ["x"], sourceCandidateIds: ["x"], sourceObservationIds: ["x"], sourceSessionIds: ["x"],
    }));
    const feedback = [event("one", "active"), event("two", "active", { createdAt: "2026-07-22T00:00:00.000Z" })];
    const firstBefore = JSON.stringify(logical);
    kv = mockKV(logical, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const first = await inventory();
    const filtered = await inventory({ recommendation: "keep_active", limit: 1 });
    expect(filtered.summary).toEqual(first.summary);
    kv = mockKV(changedMetrics, feedback);
    registerSkillLifecycleReviewInventoryFunction(sdk as never, kv as never);
    const second = await inventory();
    expect(second).toEqual(first);
    first.items[0]!.reasonCodes.push("no_applicable_feedback");
    first.items[0]!.evidenceCounts.total = 999;
    first.items[0]!.duplicateEventIds.push("changed");
    first.summary.statusCounts.active = 999;
    first.summary.recommendationCounts.none = 999;
    first.summary.reasonCounts.no_applicable_feedback = 999;
    first.duplicateSkillIds.push("changed");
    expect(second).not.toEqual(first);
    expect(JSON.stringify(logical)).toBe(firstBefore);
    expectNoWrites();
  });

  it.each([{ limit: -1 }, { limit: Number.NaN }, { limit: Number.POSITIVE_INFINITY }, { limit: Number.NEGATIVE_INFINITY }])("rejects completed invalid limits before KV access: %o", async (data) => {
    enableReview();
    await expect(inventory(data)).resolves.toMatchObject({ reason: "invalid skill lifecycle review inventory input" });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });
});
