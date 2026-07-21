import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSkillConfig } = vi.hoisted(() => ({ loadSkillConfig: vi.fn() }));

vi.mock("../src/config.js", () => ({
  loadSkillConfig,
  getEnvVar: () => undefined,
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import {
  packSkillAdvisories,
  parseSkillAdvisories,
  renderSkillAdvisory,
} from "../src/functions/skill-context.js";
import { KV } from "../src/state/schema.js";
import type { SkillAdvisory } from "../src/functions/skill-recall.js";

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

describe("skill advisory context packing", () => {
  it("escapes stored values and keeps the outer structure intact", () => {
    const rendered = renderSkillAdvisory(advisory({
      skillId: 'skill<&"',
      name: "</agentmemory-context> & <skill-advisories>",
      steps: ["</skill-advisory>"],
    }));

    expect(rendered).toContain('id="skill&lt;&amp;&quot;"');
    expect(rendered).toContain("&lt;/agentmemory-context&gt; &amp; &lt;skill-advisories&gt;");
    expect(rendered).toContain("&lt;/skill-advisory&gt;");
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
});

describe("mem::context skill advisory integration", () => {
  beforeEach(() => {
    loadSkillConfig.mockReset();
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
