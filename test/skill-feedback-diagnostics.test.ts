import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillFeedbackDiagnosticsFunction } from "../src/functions/skill-feedback-diagnostics.js";
import { KV } from "../src/state/schema.js";
import type { SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS_LIMIT",
  "AGENTMEMORY_SKILL_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_CONTEXT",
  "AGENTMEMORY_SKILL_PROMOTION",
];
const ORIGINAL: Record<string, string | undefined> = {};

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    getFunction: (id: string) => functions.get(id),
  };
}

function mockKV(rows: unknown[] = []) {
  const listCalls: string[] = [];
  const getCalls: string[] = [];
  const setCalls: string[] = [];
  let shouldFailList = false;
  return {
    rows,
    listCalls,
    getCalls,
    setCalls,
    failList: () => { shouldFailList = true; },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      if (shouldFailList) throw new Error("list failed");
      return rows as T[];
    },
    get: async <T>(scope: string): Promise<T | null> => {
      getCalls.push(scope);
      return null;
    },
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      setCalls.push(scope);
      return value;
    },
  };
}

function event(id: string, overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId: "skill_release",
    skillVersion: 1,
    kind: "success",
    attribution: "user-confirmed",
    source: "explicit",
    project: "project-a",
    agentId: "agent-a",
    sessionId: "session-a",
    sourceObservationIds: ["obs-1"],
    sourceSessionIds: ["session-1"],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("mem::skill-feedback-diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillFeedbackDiagnosticsFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enableDiagnostics(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS"] = "true";
  }

  async function diagnose(input: Record<string, unknown> = { skillId: "skill_release" }) {
    return sdk.getFunction("mem::skill-feedback-diagnostics")!(input);
  }

  it("returns before state access when disabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    const result = await diagnose();

    expect(result).toMatchObject({
      success: true,
      enabled: false,
      scannedCount: 0,
      reason: "skill feedback diagnostics are disabled",
    });
    expect(kv.listCalls).toEqual([]);
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
  });

  it("works while feedback recording and other skill features remain disabled", async () => {
    enableDiagnostics();
    kv.rows.push(event("feedback-1"));

    await expect(diagnose()).resolves.toMatchObject({
      success: true,
      enabled: true,
      matchedCount: 1,
      returnedCount: 1,
    });
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
  });

  it("rejects malformed filters before listing the ledger", async () => {
    enableDiagnostics();
    const invalidInputs = [
      {},
      { skillId: " " },
      { skillId: "s".repeat(201) },
      { skillId: "skill_release", skillVersion: "1" },
      { skillId: "skill_release", skillVersion: 0 },
      { skillId: "skill_release", skillVersion: 1.5 },
      { skillId: "skill_release", kind: "unknown" },
      { skillId: "skill_release", attribution: [] },
      { skillId: "skill_release", project: " " },
      { skillId: "skill_release", agentId: {} },
      { skillId: "skill_release", limit: Number.POSITIVE_INFINITY },
      { skillId: "skill_release", limit: 0 },
      { skillId: "skill_release", limit: 1.5 },
      { skillId: "skill_release", limit: 501 },
    ];

    for (const input of invalidInputs) {
      kv.listCalls.length = 0;
      await expect(diagnose(input)).resolves.toMatchObject({
        success: false,
        enabled: true,
        reason: "invalid skill feedback diagnostics input",
      });
      expect(kv.listCalls).toEqual([]);
    }
  });

  it("counts malformed rows, skips them, and preserves valid events", async () => {
    enableDiagnostics();
    kv.rows.push(
      event("valid"),
      null,
      "event",
      [],
      { ...event("missing-id"), id: undefined },
      { ...event("bad-source"), source: "inferred" },
      { ...event("bad-kind"), kind: "unknown" },
      { ...event("bad-correction"), kind: "correction", attribution: "agent-observed" },
      { ...event("bad-version"), skillVersion: 0 },
      { ...event("bad-scope"), project: " " },
      { ...event("bad-evidence"), sourceObservationIds: ["obs-1", "obs-1"] },
      { ...event("blank-evidence"), sourceSessionIds: [" "] },
      { ...event("bad-array"), sourceSessionIds: Array.from({ length: 21 }, (_, index) => `session-${index}`) },
      { ...event("bad-timestamp"), createdAt: "not-a-date" },
    );

    const result = await diagnose();
    expect(result).toMatchObject({
      success: true,
      scannedCount: 14,
      validCount: 1,
      malformedCount: 13,
      matchedCount: 1,
      returnedCount: 1,
      aggregate: { total: 1 },
    });
    expect(result.events.map((item: SkillFeedbackEvent) => item.id)).toEqual(["valid"]);
    expect(kv.setCalls).toEqual([]);
  });

  it("filters exact event fields without loading current skills", async () => {
    enableDiagnostics();
    kv.rows.push(
      event("matching", { skillVersion: 2, kind: "failure", attribution: "agent-observed" }),
      event("other-project", { skillVersion: 2, kind: "failure", attribution: "agent-observed", project: "project-b" }),
      event("missing-session", { skillVersion: 2, kind: "failure", attribution: "agent-observed", sessionId: undefined }),
      event("other-skill", { skillId: "skill_other", skillVersion: 2, kind: "failure", attribution: "agent-observed" }),
    );

    const result = await diagnose({
      skillId: "skill_release",
      skillVersion: 2,
      kind: "failure",
      attribution: "agent-observed",
      project: "project-a",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    expect(result).toMatchObject({ matchedCount: 1, returnedCount: 1 });
    expect(result.events.map((item: SkillFeedbackEvent) => item.id)).toEqual(["matching"]);
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.getCalls).toEqual([]);
  });

  it("orders deterministically, limits returned rows, and aggregates all matches", async () => {
    enableDiagnostics();
    const storedEvents = [
      event("b", { skillVersion: 2, kind: "failure", attribution: "agent-observed", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("a", { skillVersion: 1, kind: "success", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("B", { skillVersion: 1, kind: "success", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("_", { skillVersion: 2, kind: "stale", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("ä", { skillVersion: 1, kind: "correction", createdAt: "2026-07-22T00:00:00.000Z" }),
      event("newer", { skillVersion: 2, kind: "failure", attribution: "agent-observed", createdAt: "2026-07-23T00:00:00.000Z" }),
      event("old", { skillVersion: 1, kind: "correction", createdAt: "2026-07-20T00:00:00.000Z" }),
    ];
    const before = JSON.stringify(storedEvents);
    kv.rows.push(...storedEvents);

    const limited = await diagnose({ skillId: "skill_release", limit: 3 });
    expect(limited.events.map((item: SkillFeedbackEvent) => item.id)).toEqual(["newer", "B", "_"]);
    expect(limited).toMatchObject({ matchedCount: 7, returnedCount: 3, truncated: true });
    expect(limited.aggregate).toEqual({
      total: 7,
      byKind: { success: 2, failure: 2, correction: 2, stale: 1 },
      byAttribution: { "user-confirmed": 5, "agent-observed": 2 },
      byVersion: [
        { skillVersion: 1, total: 4, success: 2, failure: 0, correction: 2, stale: 0 },
        { skillVersion: 2, total: 3, success: 0, failure: 2, correction: 0, stale: 1 },
      ],
      earliestCreatedAt: "2026-07-20T00:00:00.000Z",
      latestCreatedAt: "2026-07-23T00:00:00.000Z",
    });

    const allEvents = await diagnose({ skillId: "skill_release", limit: 500 });
    expect(allEvents.events.map((item: SkillFeedbackEvent) => item.id)).toEqual(["newer", "B", "_", "a", "b", "ä", "old"]);
    expect(JSON.stringify(storedEvents)).toBe(before);
    expect(JSON.stringify(kv.rows)).toBe(before);
  });

  it("uses the configured default limit and returns zero aggregates for an empty ledger", async () => {
    enableDiagnostics();
    process.env["AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS_LIMIT"] = "2";
    kv.rows.push(event("one"), event("two", { createdAt: "2026-07-22T00:00:00.000Z" }), event("three", { createdAt: "2026-07-23T00:00:00.000Z" }));

    await expect(diagnose()).resolves.toMatchObject({
      filters: { limit: 2 },
      matchedCount: 3,
      returnedCount: 2,
      truncated: true,
    });

    kv = mockKV();
    registerSkillFeedbackDiagnosticsFunction(sdk as never, kv as never);
    await expect(diagnose()).resolves.toMatchObject({
      scannedCount: 0,
      validCount: 0,
      malformedCount: 0,
      matchedCount: 0,
      returnedCount: 0,
      aggregate: {
        total: 0,
        byVersion: [],
      },
      events: [],
    });
  });

  it("returns defensive event copies and does not mutate KV rows", async () => {
    enableDiagnostics();
    const stored = event("copy");
    const before = JSON.stringify(stored);
    kv.rows.push(stored);

    const result = await diagnose();
    result.events[0]!.sourceObservationIds.push("mutated");
    result.events[0]!.sourceSessionIds.push("mutated");
    expect(JSON.stringify(stored)).toBe(before);
    expect(kv.setCalls).toEqual([]);
  });

  it("returns a stable failure when the ledger cannot be listed", async () => {
    enableDiagnostics();
    kv.failList();

    await expect(diagnose()).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "failed to load skill feedback diagnostics",
      scannedCount: 0,
      events: [],
    });
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
  });
});
