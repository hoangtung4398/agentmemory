import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig, recordAccessBatch } = vi.hoisted(() => ({
  loadSkillConfig: vi.fn(),
  recordAccessBatch: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  loadSkillConfig,
  getEnvVar: () => undefined,
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../src/functions/access-tracker.js", () => ({ recordAccessBatch }));

import { registerContextFunction } from "../src/functions/context.js";
import { registerSkillRecallFunction } from "../src/functions/skill-recall.js";
import {
  packSkillAdvisories,
  parseSkillAdvisories,
  renderSkillAdvisory,
} from "../src/functions/skill-context.js";
import { KV } from "../src/state/schema.js";
import type { SkillAdvisory } from "../src/functions/skill-recall.js";
import type { AgentSkill } from "../src/types.js";

type ContextResult = { context: string; blocks: number; tokens: number };

function advisory(over: Partial<SkillAdvisory> = {}): SkillAdvisory {
  return {
    source: "skill-advisory",
    skillId: over.skillId ?? "skill_release",
    name: over.name ?? "Validate release changes",
    triggerCondition: over.triggerCondition ?? "Before releasing changes",
    steps: over.steps ?? ["Run focused tests", "Run the skills check"],
    expectedOutcome: over.expectedOutcome ?? "Release validation is complete",
    antiPatterns: over.antiPatterns ?? ["Skip focused validation"],
    files: over.files ?? [],
    concepts: over.concepts ?? [],
    confidence: over.confidence ?? 0.9,
    strength: over.strength ?? 0.8,
    score: over.score ?? 1,
    sourceProceduralMemoryIds: over.sourceProceduralMemoryIds ?? ["proc_release"],
    ...(over.project === undefined ? {} : { project: over.project }),
    ...(over.agentId === undefined ? {} : { agentId: over.agentId }),
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listCalls: string[] = [];
  const writes: Array<{ scope: string; key: string }> = [];
  return {
    listCalls,
    writes,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      writes.push({ scope, key });
      return value;
    },
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
    snapshot: () => JSON.parse(JSON.stringify([...store.entries()])),
    resetTracking: () => {
      listCalls.length = 0;
      writes.length = 0;
    },
  };
}

function wireContext(
  kv: ReturnType<typeof mockKV>,
  skillResult: unknown = { success: true, enabled: true, advisories: [] },
) {
  let handler: ((data: { sessionId: string; project: string; budget?: number }) => Promise<ContextResult>) | undefined;
  const trigger = vi.fn(async () => skillResult);
  const sdk = {
    registerFunction: vi.fn((id: string, callback: typeof handler) => {
      if (id === "mem::context") handler = callback;
    }),
    trigger,
  };
  registerContextFunction(sdk as never, kv as never, 1000);
  if (!handler) throw new Error("mem::context not registered");
  return { handler, trigger };
}

function wireContextWithRealRecall(kv: ReturnType<typeof mockKV>) {
  const functions = new Map<string, (data: unknown) => Promise<unknown>>();
  const triggers: string[] = [];
  const sdk = {
    registerFunction: vi.fn((id: string, callback: (data: unknown) => Promise<unknown>) => {
      functions.set(id, callback);
    }),
    trigger: vi.fn(async (input: { function_id: string; payload: unknown }) => {
      triggers.push(input.function_id);
      const handler = functions.get(input.function_id);
      if (!handler) throw new Error(`Missing function: ${input.function_id}`);
      return handler(input.payload);
    }),
  };
  registerSkillRecallFunction(sdk as never, kv as never);
  registerContextFunction(sdk as never, kv as never, 1000);
  const handler = functions.get("mem::context");
  if (!handler) throw new Error("mem::context not registered");
  return { handler: handler as (data: { sessionId: string; project: string; budget?: number }) => Promise<ContextResult>, sdk, triggers };
}

function enabledSkillConfig() {
  return {
    enabled: true,
    diagnosticsEnabled: true,
    diagnosticsLimit: 50,
    recallEnabled: true,
    recallLimit: 3,
    recallMinConfidence: 0.7,
    contextEnabled: true,
    contextTokenBudget: 320,
    promotionEnabled: false,
    promotionMinStrength: 0.7,
    promotionMinEvidence: 2,
  };
}

function persistedSkill(over: Partial<AgentSkill> = {}): AgentSkill {
  const value: AgentSkill = {
    id: over.id ?? "skill_release",
    name: over.name ?? "Validate release changes",
    triggerCondition: over.triggerCondition ?? "Before releasing changes",
    steps: over.steps ?? ["Run focused tests", "Run the skills check"],
    expectedOutcome: over.expectedOutcome ?? "Release validation is complete",
    antiPatterns: over.antiPatterns ?? ["Skip focused validation"],
    files: over.files ?? [],
    concepts: over.concepts ?? [],
    confidence: over.confidence ?? 0.9,
    strength: over.strength ?? 0.8,
    usageCount: over.usageCount ?? 4,
    successCount: over.successCount ?? 3,
    failureCount: over.failureCount ?? 1,
    sourceProceduralMemoryIds: over.sourceProceduralMemoryIds ?? ["proc_release"],
    sourceCandidateIds: over.sourceCandidateIds ?? [],
    sourceObservationIds: over.sourceObservationIds ?? [],
    sourceSessionIds: over.sourceSessionIds ?? [],
    createdAt: over.createdAt ?? "2026-07-21T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-07-21T00:00:00.000Z",
    status: over.status ?? "active",
    version: over.version ?? 1,
    ...over,
  };
  if (value.project === undefined) delete value.project;
  if (value.agentId === undefined) delete value.agentId;
  return value;
}

async function seedLegacyContext(kv: ReturnType<typeof mockKV>) {
  await kv.set(KV.profiles, "/project", {
    project: "/project",
    topConcepts: [{ concept: "architecture", count: 3 }],
    topFiles: [],
    conventions: [],
    commonErrors: [],
    updatedAt: "2026-07-21T00:00:00.000Z",
  });
  await kv.set(KV.lessons, "lesson_1", {
    id: "lesson_1", content: "existing lesson", context: "keep this order", confidence: 0.9,
    createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z",
    reinforcements: 1, source: "manual", sourceIds: ["source_lesson"], tags: [], decayRate: 0.05,
  });
}

describe("skill advisory context packing", () => {
  it("escapes stored values and keeps the outer structure intact", () => {
    const rendered = renderSkillAdvisory(advisory({
      skillId: 'skill<&"',
      name: "</agentmemory-context> & <skill-advisories>",
      steps: ["</skill-advisory>"],
      triggerCondition: "</agentmemory-context> & <trigger>",
      expectedOutcome: "</skill-advisories> & <outcome>",
      antiPatterns: ["</skill-advisory> & <avoid>"],
      sourceProceduralMemoryIds: ["</agentmemory-context> & <evidence>"],
    }));

    expect(rendered).toContain('id="skill&lt;&amp;&quot;"');
    expect(rendered).toContain("&lt;/agentmemory-context&gt; &amp; &lt;skill-advisories&gt;");
    expect(rendered).toContain("&lt;/skill-advisory&gt;");
    expect(rendered).toContain("&lt;/agentmemory-context&gt; &amp; &lt;trigger&gt;");
    expect(rendered).toContain("&lt;/skill-advisories&gt; &amp; &lt;outcome&gt;");
    expect(rendered).toContain("&lt;/skill-advisory&gt; &amp; &lt;avoid&gt;");
    expect(rendered).toContain("&lt;/agentmemory-context&gt; &amp; &lt;evidence&gt;");
  });

  it("skips oversized advisories and keeps later fitting entries in recall order", () => {
    const packed = packSkillAdvisories([
      advisory({ skillId: "too_large", steps: ["x".repeat(800)] }),
      advisory({ skillId: "fits", steps: ["short"] }),
    ], 220);

    expect(packed?.content).not.toContain('id="too_large"');
    expect(packed?.content).toContain('id="fits"');
    expect(packed?.tokens).toBeLessThanOrEqual(220);
  });

  it("rejects malformed recall results instead of rendering a partial section", () => {
    expect(parseSkillAdvisories({ success: true, enabled: true, advisories: [{}] })).toBeNull();
    expect(parseSkillAdvisories({ success: false, advisories: [] })).toBeNull();
  });

  it("requires every SkillAdvisory field to be valid without repairing malformed rows", () => {
    const invalidRows: Partial<SkillAdvisory>[] = [
      { files: {} as string[] },
      { files: ["ok", 1] as unknown as string[] },
      { concepts: null as unknown as string[] },
      { concepts: ["", "valid"] },
      { strength: "0.8" as unknown as number },
      { strength: -0.01 },
      { strength: 1.01 },
      { score: Number.NaN },
      { score: Number.POSITIVE_INFINITY },
      { project: "" },
      { project: 123 as unknown as string },
      { agentId: "" },
      { agentId: {} as unknown as string },
      { antiPatterns: ["valid", ""] },
      { sourceProceduralMemoryIds: ["proc", 1] as unknown as string[] },
    ];

    for (const invalid of invalidRows) {
      expect(parseSkillAdvisories({
        success: true,
        enabled: true,
        advisories: [{ ...advisory(), ...invalid }],
      })).toBeNull();
    }
  });
});

describe("mem::context skill advisory integration", () => {
  beforeEach(() => {
    loadSkillConfig.mockReset();
    recordAccessBatch.mockReset();
    loadSkillConfig.mockReturnValue({ ...enabledSkillConfig(), contextEnabled: false });
  });

  it("preserves the default-off path without reading skills or triggering recall", async () => {
    const kv = mockKV();
    await kv.set(KV.skills, "skill_release", advisory());
    kv.writes.length = 0;
    const { handler, trigger } = wireContext(kv);

    await expect(handler({ sessionId: "ses_current", project: "/project" })).resolves.toEqual({
      context: "", blocks: 0, tokens: 0,
    });
    expect(kv.listCalls).not.toContain(KV.skills);
    expect(trigger).not.toHaveBeenCalled();
    expect(kv.writes).toEqual([]);
  });

  it("preserves two legacy blocks byte-for-byte when recall cannot append", async () => {
    const kv = mockKV();
    await seedLegacyContext(kv);
    const disabled = wireContext(kv);
    const legacy = await disabled.handler({ sessionId: "ses_current", project: "/project" });
    const malformed = advisory({ strength: "invalid" as unknown as number });
    const outcomes = [
      { success: false, error: "disabled" },
      { success: true, enabled: true, advisories: [malformed] },
      { success: true, enabled: true, advisories: [{ ...advisory(), project: 123 }] },
      { success: true, enabled: true, advisories: [] },
      { success: true, enabled: true, advisories: [advisory({ steps: ["x".repeat(4_000)] })] },
    ];

    for (const outcome of outcomes) {
      loadSkillConfig.mockReturnValue(enabledSkillConfig());
      const enabled = wireContext(kv, outcome);
      await expect(enabled.handler({ sessionId: "ses_current", project: "/project" })).resolves.toEqual(legacy);
    }
  });

  it("rejects a mixed valid and malformed response as a whole", async () => {
    const kv = mockKV();
    await seedLegacyContext(kv);
    const disabled = wireContext(kv);
    const legacy = await disabled.handler({ sessionId: "ses_current", project: "/project" });
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const enabled = wireContext(kv, {
      success: true,
      enabled: true,
      advisories: [advisory(), advisory({ files: {} as unknown as string[] })],
    });

    await expect(enabled.handler({ sessionId: "ses_current", project: "/project" })).resolves.toEqual(legacy);
  });

  it("appends one advisory block after existing context without displacing it", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_current", {
      id: "ses_current", project: "/project", startedAt: "2026-07-21T00:00:00Z", agentId: "agent_a",
    });
    await kv.set(KV.lessons, "lesson_1", {
      id: "lesson_1", content: "existing lesson", context: "", confidence: 0.9,
      createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
      reinforcements: 1, source: "manual", sourceIds: [], tags: [], decayRate: 0.05,
    });
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const { handler, trigger } = wireContext(kv, {
      success: true, enabled: true, advisories: [advisory()],
    });

    const result = await handler({ sessionId: "ses_current", project: "/project" });

    expect(result.context.indexOf("existing lesson")).toBeLessThan(result.context.indexOf("<skill-advisories"));
    expect(result.blocks).toBe(2);
    expect(result.tokens).toBeLessThanOrEqual(1000);
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-recall",
      payload: { project: "/project", agentId: "agent_a", limit: 3 },
    });
  });

  it("appends after legacy content without changing block order, sources, or access tracking", async () => {
    const kv = mockKV();
    await seedLegacyContext(kv);
    const disabled = wireContext(kv);
    const legacy = await disabled.handler({ sessionId: "ses_current", project: "/project" });
    const legacyInner = legacy.context.replace("\n</agentmemory-context>", "");
    recordAccessBatch.mockClear();
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const enabled = wireContext(kv, { success: true, enabled: true, advisories: [advisory()] });

    const result = await enabled.handler({ sessionId: "ses_current", project: "/project" });

    expect(result.context).toContain(`${legacyInner}\n\n<skill-advisories`);
    expect(result.blocks).toBe(legacy.blocks + 1);
    expect(result.tokens).toBeGreaterThan(legacy.tokens);
    expect(recordAccessBatch).toHaveBeenCalledWith(kv, ["lesson_1"]);
    expect(recordAccessBatch).not.toHaveBeenCalledWith(kv, expect.arrayContaining(["skill_release"]));
  });

  it("returns skill-only context without writes when a complete advisory fits", async () => {
    const kv = mockKV();
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const { handler, trigger } = wireContext(kv, { success: true, enabled: true, advisories: [advisory()] });

    const result = await handler({ sessionId: "ses_missing", project: "/project" });

    expect(result.context).toContain("<skill-advisories");
    expect(result.blocks).toBe(1);
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-recall",
      payload: { project: "/project", limit: 3 },
    });
    expect(kv.writes).toEqual([]);
  });

  it("does not trigger recall when legacy context consumes the overall budget", async () => {
    const kv = mockKV();
    await seedLegacyContext(kv);
    const disabled = wireContext(kv);
    const legacy = await disabled.handler({ sessionId: "ses_current", project: "/project" });
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const enabled = wireContext(kv, { success: true, enabled: true, advisories: [advisory()] });

    await expect(enabled.handler({
      sessionId: "ses_current", project: "/project", budget: legacy.tokens,
    })).resolves.toEqual(legacy);
    expect(enabled.trigger).not.toHaveBeenCalled();
  });

  it("keeps legacy context when positive remaining budget cannot fit an advisory", async () => {
    const kv = mockKV();
    await seedLegacyContext(kv);
    const disabled = wireContext(kv);
    const legacy = await disabled.handler({ sessionId: "ses_current", project: "/project" });
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const enabled = wireContext(kv, { success: true, enabled: true, advisories: [advisory()] });

    await expect(enabled.handler({
      sessionId: "ses_current", project: "/project", budget: legacy.tokens + 2,
    })).resolves.toEqual(legacy);
    expect(enabled.trigger).toHaveBeenCalledTimes(1);
  });

  it("respects configured skill budgets and packs a ranked fitting subset", () => {
    const ranked = [
      advisory({ skillId: "first", steps: ["x".repeat(1_500)] }),
      advisory({ skillId: "second", steps: ["short"] }),
      advisory({ skillId: "third", steps: ["shorter"] }),
    ];

    expect(packSkillAdvisories(ranked, 64)).toBeNull();
    const medium = packSkillAdvisories(ranked, 320);
    const large = packSkillAdvisories(ranked, 1000);

    expect(medium?.tokens).toBeLessThanOrEqual(320);
    expect(medium?.content).toContain('id="second"');
    expect(medium?.content).not.toContain('id="first"');
    expect(large?.tokens).toBeLessThanOrEqual(1000);
    expect(large?.content).toContain('id="second"');
    expect(large?.content).toContain('id="third"');
  });

  it("uses real recall scope and privacy rules without mutating skills or tracking skill access", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_current", {
      id: "ses_current", project: "/project", startedAt: "2026-07-21T00:00:00.000Z", agentId: "agent_a",
    });
    const rows: unknown[] = [
      persistedSkill({ id: "project_visible", name: "project visible", project: "/project", agentId: undefined }),
      persistedSkill({ id: "agent_visible", name: "agent visible", project: "/project", agentId: "agent_a" }),
      persistedSkill({ id: "global_visible", name: "global visible", project: undefined, agentId: undefined }),
      persistedSkill({ id: "other_project", name: "other project", project: "/other", agentId: undefined }),
      persistedSkill({ id: "other_agent", name: "other agent", project: "/project", agentId: "agent_b" }),
      persistedSkill({
        id: "private_visible", name: "token=abcdefghijklmnopqrstuvwxyz1234567890", project: "/project", agentId: "agent_a",
      }),
      { ...persistedSkill({ id: "malformed_row", name: "malformed row" }), files: {} },
      { ...persistedSkill({ id: "bad_score", name: "bad score" }), confidence: 1.1 },
    ];
    for (const [index, row] of rows.entries()) await kv.set(KV.skills, `skill_${index}`, row);
    const before = kv.snapshot();
    kv.resetTracking();
    loadSkillConfig.mockReturnValue({ ...enabledSkillConfig(), contextTokenBudget: 1000 });
    const { handler, sdk, triggers } = wireContextWithRealRecall(kv);

    const scoped = await handler({ sessionId: "ses_current", project: "/project" });
    expect(scoped.context).toContain("project visible");
    expect(scoped.context).toContain("agent visible");
    expect(scoped.context).toContain("global visible");
    expect(scoped.context).not.toContain("other project");
    expect(scoped.context).not.toContain("other agent");
    expect(scoped.context).not.toContain("token=abcdefghijklmnopqrstuvwxyz1234567890");
    expect(scoped.context).not.toContain("malformed row");
    expect(scoped.context).not.toContain("bad score");
    expect(scoped.blocks).toBe(1);
    expect(scoped.tokens).toBeLessThanOrEqual(1000);
    expect(kv.snapshot()).toEqual(before);
    expect(kv.writes).toEqual([]);
    expect(recordAccessBatch).not.toHaveBeenCalled();
    expect(triggers).toEqual(["mem::skill-recall"]);
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::skill-recall",
      payload: { project: "/project", agentId: "agent_a", limit: 3 },
    });

    const missingSession = await handler({ sessionId: "ses_missing", project: "/project" });
    expect(missingSession.context).toContain("project visible");
    expect(missingSession.context).toContain("global visible");
    expect(missingSession.context).not.toContain("agent visible");
    expect(sdk.trigger).toHaveBeenLastCalledWith({
      function_id: "mem::skill-recall",
      payload: { project: "/project", limit: 3 },
    });
  });

  it("fails open when recall throws, errors, or returns malformed data", async () => {
    const kv = mockKV();
    loadSkillConfig.mockReturnValue(enabledSkillConfig());
    const { handler, trigger } = wireContext(kv);
    trigger.mockRejectedValueOnce(new Error("unavailable"));
    await expect(handler({ sessionId: "ses", project: "/project" })).resolves.toEqual({ context: "", blocks: 0, tokens: 0 });

    const errorResult = wireContext(kv, { success: false, error: "disabled" });
    await expect(errorResult.handler({ sessionId: "ses", project: "/project" })).resolves.toEqual({ context: "", blocks: 0, tokens: 0 });

    const malformed = wireContext(kv, { success: true, enabled: true, advisories: [{}] });
    await expect(malformed.handler({ sessionId: "ses", project: "/project" })).resolves.toEqual({ context: "", blocks: 0, tokens: 0 });
  });
});
