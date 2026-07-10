import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type {
  DecisionCandidateQueue,
  Memory,
  ProceduralMemory,
  SemanticMemory,
} from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
  "AGENTMEMORY_DECISION_CONSUME_CANDIDATES",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE",
  "CONSOLIDATION_ENABLED",
  "AGENTMEMORY_AUTO_COMPRESS",
];

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL: Record<string, string | undefined> = {};

let sandboxHome: string;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, (payload: unknown) => unknown>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: (payload: unknown) => unknown,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = functions.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

async function setupFlow() {
  vi.resetModules();
  const [
    { registerDecisionEngineFunction },
    { registerRememberFunction },
    { registerObserveFunction },
    { registerConsolidationPipelineFunction },
    search,
  ] = await Promise.all([
    import("../src/functions/decision-engine.js"),
    import("../src/functions/remember.js"),
    import("../src/functions/observe.js"),
    import("../src/functions/consolidation-pipeline.js"),
    import("../src/functions/search.js"),
  ]);

  search.getSearchIndex().clear();
  search.setIndexPersistence(null);
  search.setVectorIndex(null);
  search.setEmbeddingProvider(null);

  const sdk = mockSdk();
  const kv = mockKV();
  const provider = {
    name: "test",
    compress: vi.fn(),
    summarize: vi.fn(),
  };

  registerDecisionEngineFunction(sdk as never, kv as never);
  registerRememberFunction(sdk as never, kv as never);
  registerObserveFunction(sdk as never, kv as never);
  registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
  return { sdk, kv };
}

describe("Decision Engine end-to-end acceptance", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-decision-e2e-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
    process.env["AGENTMEMORY_DECISION_MODE"] = "advisory";
    process.env["AGENTMEMORY_DECISION_CANDIDATE_QUEUE"] = "true";
  });

  afterEach(async () => {
    const search = await import("../src/functions/search.js");
    search.getSearchIndex().clear();
    search.setIndexPersistence(null);
    search.setVectorIndex(null);
    search.setEmbeddingProvider(null);

    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("remember semantic candidates flow into consolidation without duplicate second-run output", async () => {
    const { sdk, kv } = await setupFlow();

    for (let i = 0; i < 2; i++) {
      await sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: "Always preserve existing REST and MCP payload shapes.",
          type: "preference",
          concepts: ["compatibility"],
          sourceObservationIds: [`obs_sem_${i}`],
          project: "agentmemory",
        },
      });
    }

    let candidates = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(candidates.filter((candidate) => candidate.status === "pending")).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.kind === "semantic")).toBe(true);

    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "true";
    await sdk.trigger("mem::consolidation-pipeline", {
      tier: "semantic",
      force: true,
    });

    const semantic = await kv.list<SemanticMemory>(KV.semantic);
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({
      fact: "Always preserve existing REST and MCP payload shapes.",
      accessCount: 1,
    });
    expect(semantic[0]).not.toHaveProperty("decisionId");
    candidates = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(candidates.every((candidate) => candidate.status === "consumed")).toBe(true);

    await sdk.trigger("mem::consolidation-pipeline", {
      tier: "semantic",
      force: true,
    });
    await expect(kv.list<SemanticMemory>(KV.semantic)).resolves.toHaveLength(1);
  });

  it("remember procedural candidates flow into consolidation without duplicate second-run output", async () => {
    const { sdk, kv } = await setupFlow();

    for (let i = 0; i < 2; i++) {
      await sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: "Successful procedure: first run npm test, then run npm run build.",
          type: "workflow",
          concepts: ["release workflow"],
          sourceObservationIds: [`obs_proc_${i}`],
          project: "agentmemory",
        },
      });
    }

    let candidates = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(candidates.filter((candidate) => candidate.status === "pending")).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.kind === "procedural")).toBe(true);

    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "true";
    await sdk.trigger("mem::consolidation-pipeline", {
      tier: "procedural",
      force: true,
    });

    const procedural = await kv.list<ProceduralMemory>(KV.procedural);
    expect(procedural).toHaveLength(1);
    expect(procedural[0]).toMatchObject({
      name: "release workflow",
      frequency: 2,
      sourceObservationIds: ["obs_proc_0", "obs_proc_1"],
    });
    expect(procedural[0].steps.length).toBeGreaterThanOrEqual(2);
    expect(procedural[0]).not.toHaveProperty("decisionId");
    candidates = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(candidates.every((candidate) => candidate.status === "consumed")).toBe(true);

    await sdk.trigger("mem::consolidation-pipeline", {
      tier: "procedural",
      force: true,
    });
    await expect(kv.list<ProceduralMemory>(KV.procedural)).resolves.toHaveLength(1);
  });

  it("observe may queue candidates while preserving observation storage and long-term tiers", async () => {
    const { sdk, kv } = await setupFlow();

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_observe_e2e",
      project: "/repo/agentmemory",
      cwd: "/repo/agentmemory",
      hookType: "prompt_submit",
      timestamp: "2026-07-09T00:00:00.000Z",
      data: { prompt: "Always keep current hook payload schemas unchanged." },
    })) as { observationId: string };

    const observations = await kv.list<Record<string, unknown>>(
      KV.observations("ses_observe_e2e"),
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toHaveProperty("title");
    expect(observations[0]).not.toHaveProperty("decisionId");

    const candidates = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: "semantic",
      status: "pending",
      sessionId: "ses_observe_e2e",
      evidenceRefs: [{
        kind: "observation",
        id: result.observationId,
        sessionId: "ses_observe_e2e",
      }],
    });
    await expect(kv.list<SemanticMemory>(KV.semantic)).resolves.toEqual([]);
    await expect(kv.list<ProceduralMemory>(KV.procedural)).resolves.toEqual([]);
    await expect(kv.list<Memory>(KV.memories)).resolves.toEqual([]);
  });
});
