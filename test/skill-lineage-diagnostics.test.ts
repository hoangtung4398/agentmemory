import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillLineageDiagnosticsFunction } from "../src/functions/skill-lineage-diagnostics.js";
import { KV } from "../src/state/schema.js";
import type { AgentSkill } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_LIFECYCLE_REVIEW",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_FEEDBACK_REDUCER",
  "AGENTMEMORY_SKILL_PROMOTION",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_CONTEXT",
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

function mockKV(rows: unknown[] = []) {
  const getCalls: string[] = [];
  const listCalls: string[] = [];
  const setCalls: string[] = [];
  const updateCalls: string[] = [];
  const deleteCalls: string[] = [];
  let failList = false;
  return {
    getCalls,
    listCalls,
    setCalls,
    updateCalls,
    deleteCalls,
    setFailList: () => { failList = true; },
    get: async <T>(scope: string): Promise<T | null> => { getCalls.push(scope); return null; },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      if (failList) throw new Error("list failed");
      return (scope === KV.skills ? rows : []) as T[];
    },
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => { setCalls.push(scope); return value; },
    update: async <T>(scope: string, _key: string, value: T): Promise<T> => { updateCalls.push(scope); return value; },
    delete: async (scope: string): Promise<void> => { deleteCalls.push(scope); },
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
    version: 1,
    ...overrides,
  };
}

function minimal(id: string, status: AgentSkill["status"] = "active", overrides: Record<string, unknown> = {}) {
  return { id, version: 1, status, project: "project-a", agentId: "agent-a", ...overrides };
}

describe("mem::skill-lineage-diagnostics", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  function enable(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "true";
  }

  async function diagnostics(data: Record<string, unknown> = {}) {
    return sdk.getFunction("mem::skill-lineage-diagnostics")!(data);
  }

  function expectNoWrites(): void {
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.updateCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  }

  it("registers only the internal lineage diagnostics function", () => {
    expect([...sdk.functions.keys()]).toEqual(["mem::skill-lineage-diagnostics"]);
  });

  it.each([{}, {
    AGENTMEMORY_SKILLS: "false", AGENTMEMORY_SKILL_DIAGNOSTICS: "true",
  }, {
    AGENTMEMORY_SKILLS: "true", AGENTMEMORY_SKILL_DIAGNOSTICS: "false",
  }])("returns before validation and KV access while disabled: %o", async (environment) => {
    Object.assign(process.env, environment);
    await expect(diagnostics({ limit: 0 })).resolves.toMatchObject({
      success: true,
      enabled: false,
      applied: false,
      reason: "skill lineage diagnostics is disabled",
    });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("requires only the existing skills and diagnostics flags", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    kv = mockKV([minimal("a")]);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    await expect(diagnostics()).resolves.toMatchObject({ success: true, enabled: true, matchedCount: 1 });
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it.each([
    { project: " " }, { project: "x".repeat(501) }, { project: 1 },
    { agentId: " " }, { agentId: "x".repeat(501) }, { agentId: false },
    { status: "ACTIVE" }, { relationState: "bad" }, { findingCode: "bad" }, { scopeRelation: "bad" },
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "2" },
    { limit: Number.NaN }, { limit: Number.POSITIVE_INFINITY }, { limit: 501 },
  ])("rejects invalid input before KV access: %o", async (data) => {
    enable();
    await expect(diagnostics(data)).resolves.toMatchObject({
      success: false,
      reason: "invalid skill lineage diagnostics input",
    });
    expect(kv.listCalls).toEqual([]);
    expectNoWrites();
  });

  it("uses one skills list, accepts minimal rows, counts malformed rows, and does not mutate fixtures", async () => {
    enable();
    const rows: unknown[] = [minimal("active"), minimal("retired", "retired"), minimal("old", "superseded"), { id: "bad" }];
    const before = JSON.stringify(rows);
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const result = await diagnostics();
    expect(result).toMatchObject({
      skillRowCount: 4,
      validSkillCount: 3,
      malformedSkillCount: 1,
      summary: { statusCounts: { active: 1, retired: 1, superseded: 1 }, relationStateCounts: { root: 3 } },
    });
    expect(result.items.map((item: { skillId: string }) => item.skillId)).toEqual(["active", "old", "retired"]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it("fails closed for sorted duplicate valid IDs before topology and filtering", async () => {
    enable();
    kv = mockKV([minimal("z"), minimal("a"), minimal("z", "retired"), minimal("a", "superseded")]);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    await expect(diagnostics({ project: "no-match" })).resolves.toMatchObject({
      success: false,
      reason: "duplicate skill id",
      duplicateSkillIds: ["a", "z"],
      items: [],
      summary: { statusCounts: { active: 0, retired: 0, superseded: 0 } },
    });
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it("classifies root, resolved, malformed, self, and missing references without rewriting raw rows", async () => {
    enable();
    const rows = [
      skill("root"), skill("resolved", { supersedes: "root" }), skill("blank", { supersedes: " " }),
      skill("non-string", { supersedes: 3 as never }), skill("self", { supersedes: "self" }),
      skill("missing", { supersedes: "gone" }), skill("space-target", { supersedes: " root " }),
    ];
    const before = JSON.stringify(rows);
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const result = await diagnostics();
    const byId = new Map(result.items.map((item: { skillId: string }) => [item.skillId, item]));
    expect(byId.get("root")).toMatchObject({ relationState: "root", scopeRelation: "not_applicable" });
    expect(byId.get("resolved")).toMatchObject({ relationState: "resolved", supersedes: "root", targetStatus: "active", scopeRelation: "same" });
    expect(byId.get("blank")).toMatchObject({ relationState: "malformed_reference", findingCodes: ["malformed_supersedes"] });
    expect(byId.get("blank")).not.toHaveProperty("supersedes");
    expect(byId.get("non-string")).toMatchObject({ relationState: "malformed_reference" });
    expect(byId.get("self")).toMatchObject({ relationState: "self_reference", findingCodes: ["self_supersedes"] });
    expect(byId.get("missing")).toMatchObject({ relationState: "missing_target", supersedes: "gone", findingCodes: ["missing_superseded_skill"] });
    expect(byId.get("space-target")).toMatchObject({ relationState: "missing_target", supersedes: " root " });
    expect(result.summary).toMatchObject({ declaredReferenceCount: 3, resolvedReferenceCount: 1, missingReferenceCount: 2 });
    expect(JSON.stringify(rows)).toBe(before);
    expectNoWrites();
  });

  it("reports direct scope relations descriptively and ignores status and version combinations", async () => {
    enable();
    kv = mockKV([
      skill("same-target", { status: "retired", version: 99 }),
      skill("same", { supersedes: "same-target", status: "active", version: 1 }),
      skill("project", { supersedes: "same-target", project: "project-b", status: "superseded" }),
      skill("agent", { supersedes: "same-target", agentId: "agent-b" }),
      skill("unscoped", { supersedes: "same-target", project: undefined, agentId: undefined }),
    ]);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const result = await diagnostics();
    const byId = new Map(result.items.map((item: { skillId: string }) => [item.skillId, item]));
    expect(byId.get("same")).toMatchObject({ scopeRelation: "same", findingCodes: [] });
    expect(byId.get("project")).toMatchObject({ scopeRelation: "different", findingCodes: [] });
    expect(byId.get("agent")).toMatchObject({ scopeRelation: "different", findingCodes: [] });
    expect(byId.get("unscoped")).toMatchObject({ scopeRelation: "different", findingCodes: [] });
    expect(byId.get("same-target")).toMatchObject({ incomingSupersederIds: ["agent", "project", "same", "unscoped"], findingCodes: ["multiple_superseders"] });
    expect(result.summary).toMatchObject({ branchingTargetCount: 1 });
    expectNoWrites();
  });

  it("detects deterministic cycle components while excluding a chain leading into a cycle", async () => {
    enable();
    const rows = [
      skill("a", { supersedes: "b" }), skill("b", { supersedes: "a" }), skill("lead", { supersedes: "a" }),
      skill("c", { supersedes: "d" }), skill("d", { supersedes: "e" }), skill("e", { supersedes: "c" }),
    ];
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const result = await diagnostics();
    const byId = new Map(result.items.map((item: { skillId: string }) => [item.skillId, item]));
    expect(byId.get("a")).toMatchObject({ relationState: "cycle", cycleMemberIds: ["a", "b"] });
    expect(byId.get("a").findingCodes).toEqual(["cycle_detected", "multiple_superseders"]);
    expect(byId.get("b")).toMatchObject({ relationState: "cycle", cycleMemberIds: ["a", "b"] });
    expect(byId.get("lead")).toMatchObject({ relationState: "resolved", cycleMemberIds: [], findingCodes: [] });
    expect(byId.get("c")).toMatchObject({ relationState: "cycle", cycleMemberIds: ["c", "d", "e"] });
    expect(result.summary).toMatchObject({ cycleComponentCount: 2, cycleSkillCount: 5, resolvedReferenceCount: 6 });
    expectNoWrites();
  });

  it("builds summaries before exact AND filters and limits with deterministic output ordering", async () => {
    enable();
    const rows = [
      skill("root"), skill("z-resolved", { supersedes: "root" }), skill("a-resolved", { supersedes: "root" }),
      skill("self", { supersedes: "self" }), skill("missing", { supersedes: "gone" }), skill("malformed", { supersedes: " " }),
    ];
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const all = await diagnostics();
    const filtered = await diagnostics({ project: "project-a", status: "active", relationState: "resolved", scopeRelation: "same", limit: 1 });
    expect(all.items.map((item: { skillId: string }) => item.skillId)).toEqual(["malformed", "self", "missing", "root", "a-resolved", "z-resolved"]);
    expect(filtered).toMatchObject({ matchedCount: 2, returnedCount: 1, resultTruncated: true, truncated: true });
    expect(filtered.items.map((item: { skillId: string }) => item.skillId)).toEqual(["a-resolved"]);
    expect(filtered.summary).toEqual(all.summary);
    const finding = await diagnostics({ findingCode: "multiple_superseders" });
    expect(finding.items.map((item: { skillId: string }) => item.skillId)).toEqual(["root"]);
    expectNoWrites();
  });

  it("uses exact project, agent, status, relation, finding, and scope filters independent of physical row order", async () => {
    enable();
    const rows = [
      skill("target"),
      skill("matching", { supersedes: "target" }),
      skill("other-agent", { supersedes: "target", agentId: "agent-b" }),
      skill("retired", { status: "retired", supersedes: "target" }),
      skill("unscoped", { project: undefined, agentId: undefined, supersedes: "target" }),
    ];
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const exact = await diagnostics({
      project: "project-a",
      agentId: "agent-a",
      status: "active",
      relationState: "resolved",
      scopeRelation: "same",
    });
    expect(exact.items.map((item: { skillId: string }) => item.skillId)).toEqual(["matching"]);
    const original = await diagnostics({ findingCode: "multiple_superseders" });
    kv = mockKV([...rows].reverse());
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const reversed = await diagnostics({ findingCode: "multiple_superseders" });
    expect(reversed).toEqual(original);
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });

  it("returns defensively allocated results and leaves stored fixtures untouched", async () => {
    enable();
    const rows = [skill("a", { supersedes: "b" }), skill("b", { supersedes: "a" })];
    const before = JSON.stringify(rows);
    kv = mockKV(rows);
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    const first = await diagnostics();
    first.items[0].findingCodes.push("multiple_superseders");
    first.items[0].incomingSupersederIds.push("changed");
    first.items[0].cycleMemberIds.push("changed");
    first.summary.statusCounts.active = 99;
    first.summary.relationStateCounts.cycle = 99;
    first.summary.findingCounts.cycle_detected = 99;
    const second = await diagnostics();
    expect(second.summary.statusCounts.active).toBe(2);
    expect(second.summary.relationStateCounts.cycle).toBe(2);
    expect(second.items[0].cycleMemberIds).toEqual(["a", "b"]);
    expect(JSON.stringify(rows)).toBe(before);
    expectNoWrites();
  });

  it("returns stable load failures without partial data or writes", async () => {
    enable();
    kv.setFailList();
    registerSkillLineageDiagnosticsFunction(sdk as never, kv as never);
    await expect(diagnostics()).resolves.toMatchObject({
      success: false,
      enabled: true,
      reason: "failed to load skill lineage diagnostics",
      items: [],
      summary: { statusCounts: { active: 0, retired: 0, superseded: 0 } },
    });
    expect(kv.listCalls).toEqual([KV.skills]);
    expectNoWrites();
  });
});
