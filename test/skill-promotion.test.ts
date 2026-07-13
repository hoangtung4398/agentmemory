import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillPromotionFunction } from "../src/functions/skill-promotion.js";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { KV } from "../src/state/schema.js";
import type {
  AgentSkill,
  DecisionCandidateQueue,
  ProceduralMemory,
} from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_PROMOTION",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_STRENGTH",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_EVIDENCE",
  "AGENTMEMORY_DECISION_CONSUME_CANDIDATES",
  "CONSOLIDATION_ENABLED",
];
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
  const setCalls: Array<{ scope: string; key: string }> = [];
  let failSkillWrites = false;

  return {
    setCalls,
    setFailSkillWrites: (value: boolean) => { failSkillWrites = value; },
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (failSkillWrites && scope === KV.skills) throw new Error("skill write failed");
      setCalls.push({ scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      (Array.from(store.get(scope)?.values() ?? []) as T[]),
  };
}

function procedure(overrides: Partial<ProceduralMemory> = {}): ProceduralMemory {
  return {
    id: "proc_release_validation",
    name: "Validate a release",
    triggerCondition: "Before releasing a change",
    steps: ["Run focused tests", "Run the skills consistency check"],
    expectedOutcome: "Release checks are complete.",
    frequency: 2,
    sourceSessionIds: ["session_1", "session_2"],
    sourceObservationIds: ["obs_1"],
    tags: ["release"],
    concepts: ["release", "validation"],
    strength: 0.8,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("mem::skill-promote", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    sdk = mockSdk();
    kv = mockKV();
    registerSkillPromotionFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  async function promote(proceduralMemoryId = "proc_release_validation") {
    return sdk.getFunction("mem::skill-promote")!({ proceduralMemoryId });
  }

  async function seedProcedure(value = procedure()): Promise<ProceduralMemory> {
    await kv.set(KV.procedural, value.id, value);
    return value;
  }

  function enablePromotion(): void {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_PROMOTION"] = "true";
  }

  it("is direct-only and writes no skill while disabled", async () => {
    await seedProcedure();

    const result = await promote();

    expect(result).toEqual({
      success: true,
      promoted: false,
      reason: "skill promotion is disabled",
    });
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });

  it("returns a safe not-found result without writing a skill", async () => {
    enablePromotion();

    const result = await promote("missing");

    expect(result).toEqual({
      success: false,
      promoted: false,
      reason: "procedural memory not found",
    });
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });

  it("rejects weak, under-evidenced, and incomplete procedures without writing", async () => {
    enablePromotion();
    await seedProcedure(procedure({ id: "weak", strength: 0.6 }));
    await seedProcedure(procedure({
      id: "under_evidenced",
      sourceSessionIds: ["session_1"],
      sourceObservationIds: [],
    }));
    await seedProcedure(procedure({ id: "one_step", steps: ["Run focused tests"] }));

    await expect(promote("weak")).resolves.toMatchObject({ promoted: false, reason: "procedural memory strength is below the promotion threshold" });
    await expect(promote("under_evidenced")).resolves.toMatchObject({ promoted: false, reason: "procedural memory has insufficient independent evidence" });
    await expect(promote("one_step")).resolves.toMatchObject({ promoted: false, reason: "procedural memory requires at least two meaningful steps" });
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });

  it("does not add different provenance categories together as independent evidence", async () => {
    enablePromotion();
    await seedProcedure(procedure({
      id: "same_execution",
      sourceSessionIds: ["session_1"],
      sourceObservationIds: ["obs_1", "obs_2", "obs_3"],
    }));

    await expect(promote("same_execution")).resolves.toMatchObject({
      promoted: false,
      reason: "procedural memory has insufficient independent evidence",
    });
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });

  it("rejects secret-heavy procedure content without writing", async () => {
    enablePromotion();
    await seedProcedure(procedure({
      id: "secret_heavy",
      expectedOutcome: "Store <private>token=secret-value</private> safely.",
    }));

    await expect(promote("secret_heavy")).resolves.toEqual({
      success: true,
      promoted: false,
      reason: "procedural memory contains secret-heavy content",
    });
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });

  it("creates one AgentSkill without mutating the source procedure", async () => {
    enablePromotion();
    const source = await seedProcedure();
    const before = JSON.parse(JSON.stringify(source));

    const result = await promote();

    expect(result).toMatchObject({ success: true, promoted: true });
    const skill = result.skill as AgentSkill;
    expect(skill).toMatchObject({
      name: source.name,
      triggerCondition: source.triggerCondition,
      steps: source.steps,
      expectedOutcome: source.expectedOutcome,
      files: [],
      concepts: ["release", "validation"],
      strength: 0.8,
      confidence: 0.5,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      sourceProceduralMemoryIds: [source.id],
      sourceCandidateIds: [],
      sourceObservationIds: ["obs_1"],
      sourceSessionIds: ["session_1", "session_2"],
      status: "active",
      version: 1,
    });
    expect(skill.antiPatterns).toEqual([]);
    expect(skill).not.toHaveProperty("project");
    expect(skill).not.toHaveProperty("agentId");
    expect(await kv.get(KV.procedural, source.id)).toEqual(before);
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([skill]);
    expect(kv.setCalls.filter((call) => call.scope === KV.procedural)).toHaveLength(1);
  });

  it("returns the existing skill when the same source changes after promotion", async () => {
    enablePromotion();
    const source = await seedProcedure();

    const first = await promote();
    await kv.set(KV.procedural, source.id, procedure({
      ...source,
      name: "Changed release validation",
      triggerCondition: "After changing the procedure",
      steps: ["Inspect the change", "Run the full test suite"],
    }));
    const second = await promote();

    expect(first).toMatchObject({ promoted: true });
    expect(second).toMatchObject({
      success: true,
      promoted: false,
      existingSkillId: first.skill.id,
      reason: "an active skill already exists for this procedural memory",
    });
    expect(kv.setCalls.filter((call) => call.scope === KV.skills)).toHaveLength(1);
  });

  it("allows a different valid source procedure to create a different skill", async () => {
    enablePromotion();
    await seedProcedure();
    await seedProcedure(procedure({
      id: "proc_deploy_validation",
      name: "Validate deployment",
      triggerCondition: "Before deployment",
      steps: ["Build the release", "Run deployment smoke tests"],
      expectedOutcome: "Deployment validation is complete.",
      sourceSessionIds: ["session_3", "session_4"],
      sourceObservationIds: ["obs_3", "obs_4"],
    }));

    await expect(promote()).resolves.toMatchObject({ promoted: true });
    await expect(promote("proc_deploy_validation")).resolves.toMatchObject({ promoted: true });
    expect(await kv.list<AgentSkill>(KV.skills)).toHaveLength(2);
  });

  it("does not copy arbitrary fields outside the ProceduralMemory schema", async () => {
    enablePromotion();
    const source = {
      ...procedure({ id: "unknown_fields" }),
      project: "/repo/agentmemory",
      agentId: "codex",
      files: ["src/index.ts"],
      sourceCandidateIds: ["candidate_1"],
    } as ProceduralMemory;
    await seedProcedure(source);

    const result = await promote("unknown_fields");
    const skill = result.skill as AgentSkill;

    expect(result).toMatchObject({ promoted: true });
    expect(skill).not.toHaveProperty("project");
    expect(skill).not.toHaveProperty("agentId");
    expect(skill.files).toEqual([]);
    expect(skill.sourceCandidateIds).toEqual([]);
  });

  it("serializes concurrent promotion for the same source procedure", async () => {
    enablePromotion();
    const source = await seedProcedure();
    const before = JSON.parse(JSON.stringify(source));

    const results = await Promise.all([promote(), promote()]);

    expect(results.filter((result) => result.promoted)).toHaveLength(1);
    expect(results.filter((result) => !result.promoted)).toMatchObject([{
      success: true,
      existingSkillId: expect.any(String),
    }]);
    expect(await kv.list<AgentSkill>(KV.skills)).toHaveLength(1);
    expect(kv.setCalls.filter((call) => call.scope === KV.skills)).toHaveLength(1);
    expect(await kv.get(KV.procedural, source.id)).toEqual(before);
  });

  it("promotes an eligible procedure created by the consolidation pipeline", async () => {
    enablePromotion();
    process.env["CONSOLIDATION_ENABLED"] = "true";
    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "true";
    registerConsolidationPipelineFunction(sdk as never, kv as never, {
      name: "test",
      compress: async () => "",
      summarize: async () => "",
    } as never);
    const candidates: DecisionCandidateQueue[] = [
      {
        id: "candidate_1",
        kind: "procedural",
        status: "pending",
        decisionId: "decision_1",
        candidateId: "candidate_1",
        sessionId: "session_1",
        content: "Successful procedure: first run npm test, then run npm run build.",
        concepts: ["release workflow"],
        files: [],
        confidence: 0.82,
        importance: 8,
        evidenceRefs: [{ kind: "observation", id: "obs_1", sessionId: "session_1" }],
        createdAt: "2026-07-13T00:00:00.000Z",
      },
      {
        id: "candidate_2",
        kind: "procedural",
        status: "pending",
        decisionId: "decision_2",
        candidateId: "candidate_2",
        sessionId: "session_2",
        content: "Successful procedure: first run npm test, then run npm run build.",
        concepts: ["release workflow"],
        files: [],
        confidence: 0.82,
        importance: 8,
        evidenceRefs: [{ kind: "observation", id: "obs_2", sessionId: "session_2" }],
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    ];
    for (const candidate of candidates) {
      await kv.set(KV.decisionCandidates, candidate.id, candidate);
    }

    await sdk.getFunction("mem::consolidate-pipeline")!({ tier: "procedural" });
    const [created] = await kv.list<ProceduralMemory>(KV.procedural);
    expect(created.strength).toBeGreaterThanOrEqual(0);
    expect(created.strength).toBeLessThanOrEqual(1);

    const eligible: ProceduralMemory = {
      ...created,
      expectedOutcome: "Release validation is complete.",
    };
    await kv.set(KV.procedural, eligible.id, eligible);
    const before = JSON.parse(JSON.stringify(eligible));

    const result = await promote(eligible.id);

    expect(result).toMatchObject({ success: true, promoted: true });
    expect(await kv.get(KV.procedural, eligible.id)).toEqual(before);
  });

  it("does not mutate the source procedure when the skill write fails", async () => {
    enablePromotion();
    const source = await seedProcedure();
    const before = JSON.parse(JSON.stringify(source));
    kv.setFailSkillWrites(true);

    const result = await promote();

    expect(result).toEqual({
      success: false,
      promoted: false,
      reason: "failed to write agent skill",
    });
    expect(await kv.get(KV.procedural, source.id)).toEqual(before);
    expect(await kv.list<AgentSkill>(KV.skills)).toEqual([]);
  });
});
