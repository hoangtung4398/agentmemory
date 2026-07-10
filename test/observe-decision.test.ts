import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type { DecisionAudit, DecisionCandidateQueue, DecisionInput } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_PROVIDER",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_SHADOW_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE",
  "AGENTMEMORY_DECISION_ENFORCE_IGNORE",
  "AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE",
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
  const fns = new Map<string, (payload: unknown) => unknown>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: (payload: unknown) => unknown,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function observePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "ses_decision",
    project: "/repo/agentmemory",
    cwd: "/repo/agentmemory",
    hookType: "post_tool_use",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/functions/observe.ts" },
      tool_output: "file contents here",
    },
    ...overrides,
  };
}

async function setupObserve(options: {
  decisionMode?: string;
  autoCompress?: string;
  enforceIgnore?: string;
  enforceIgnoreMinConfidence?: string;
  registerDecision?: boolean;
  throwingDecision?: boolean;
} = {}) {
  if (options.decisionMode) {
    process.env["AGENTMEMORY_DECISION_MODE"] = options.decisionMode;
  }
  if (options.autoCompress) {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = options.autoCompress;
  }
  if (options.enforceIgnore) {
    process.env["AGENTMEMORY_DECISION_ENFORCE_IGNORE"] = options.enforceIgnore;
  }
  if (options.enforceIgnoreMinConfidence) {
    process.env["AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE"] =
      options.enforceIgnoreMinConfidence;
  }

  vi.resetModules();
  const [{ registerObserveFunction }, { registerDecisionEngineFunction }, search] =
    await Promise.all([
      import("../src/functions/observe.js"),
      import("../src/functions/decision-engine.js"),
      import("../src/functions/search.js"),
    ]);

  search.getSearchIndex().clear();
  search.setIndexPersistence(null);
  search.setVectorIndex(null);
  search.setEmbeddingProvider(null);

  const sdk = mockSdk();
  const kv = mockKV();
  if (options.throwingDecision) {
    sdk.registerFunction("mem::decide", () => {
      throw new Error("decision unavailable");
    });
  } else if (options.registerDecision !== false) {
    registerDecisionEngineFunction(sdk as never, kv as never);
  }
  registerObserveFunction(sdk as never, kv as never);
  return { sdk, kv, search };
}

function onlyDynamicId(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const clone = { ...(entry as Record<string, unknown>) };
  clone.id = "<obs>";
  return clone;
}

function storedObservation(kv: ReturnType<typeof mockKV>, sessionId = "ses_decision") {
  return Array.from(kv.store.get(KV.observations(sessionId))!.values())[0] as
    Record<string, unknown>;
}

function streamEvents(sdk: ReturnType<typeof mockSdk>, type: "raw" | "compressed") {
  return sdk.triggered.filter((t) => {
    if (t.id !== "stream::set" && t.id !== "stream::send") return false;
    const payload = t.data as { data?: { type?: string } };
    return payload.data?.type === type;
  });
}

describe("mem::observe Decision Engine audit integration", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-observe-decision-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("does not build or call mem::decide when decision mode is disabled", async () => {
    const { sdk, kv } = await setupObserve({ decisionMode: "disabled" });

    const result = (await sdk.trigger("mem::observe", observePayload())) as {
      observationId: string;
    };

    expect(result.observationId).toBeTruthy();
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(0);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
  });

  it("calls mem::decide in enforce mode but does not suppress when flag is false", async () => {
    const { sdk, kv } = await setupObserve({ decisionMode: "enforce" });

    const result = (await sdk.trigger("mem::observe", observePayload())) as {
      observationId: string;
    };

    expect(result.observationId).toBeTruthy();
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(1);
    expect(storedObservation(kv)).toHaveProperty("title");
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toHaveLength(1);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({ mode: "enforce", outcome: "advised" });
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it.each([
    ["shadow", "observed"],
    ["advisory", "advised"],
  ] as const)(
    "writes DecisionAudit in %s mode without writing candidate queue rows",
    async (mode, outcome) => {
      const { sdk, kv } = await setupObserve({ decisionMode: mode });

      await sdk.trigger("mem::observe", observePayload());

      const decideCalls = sdk.triggered.filter((t) => t.id === "mem::decide");
      expect(decideCalls).toHaveLength(1);
      const input = decideCalls[0].data as DecisionInput;
      expect(input).toMatchObject({
        mode,
        sourceFunction: "mem::observe",
        insertionPoint: "observe.after_sanitization.before_kv_write",
        observationState: "raw",
        sessionId: "ses_decision",
        project: "/repo/agentmemory",
        cwd: "/repo/agentmemory",
        hookType: "post_tool_use",
        toolName: "Read",
      });

      const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        mode,
        sourceFunction: "mem::observe",
        insertionPoint: "observe.after_sanitization.before_kv_write",
        outcome,
        existingBehaviorPreserved: true,
      });
      expect(audits[0]).toMatchObject({
        project: "/repo/agentmemory",
        sessionId: "ses_decision",
      });
      await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
    },
  );

  it("enforce ignore preserves raw capture but skips compression and indexing for high-confidence safe noise", async () => {
    const { sdk, kv, search } = await setupObserve({
      decisionMode: "enforce",
      enforceIgnore: "true",
    });

    const result = (await sdk.trigger("mem::observe", observePayload({
      hookType: "notification",
      data: "progress update token=abcdefghijklmnopqrstuvwxyz password=abcdefghijklmnopqrstuvwxyz",
    }))) as { observationId: string };

    const stored = storedObservation(kv);
    expect(stored).toHaveProperty("raw");
    expect(stored).not.toHaveProperty("title");
    expect(kv.store.get(KV.sessions)!.get("ses_decision")).toMatchObject({
      observationCount: 1,
    });
    expect(streamEvents(sdk, "raw").length).toBeGreaterThan(0);
    expect(streamEvents(sdk, "compressed")).toHaveLength(0);
    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(0);
    expect(search.getSearchIndex().search("redacted secret", 5)).toEqual([]);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      mode: "enforce",
      action: "ignore",
      outcome: "enforced",
      existingBehaviorPreserved: false,
      observationId: result.observationId,
    });
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it("queues advisory semantic candidates without changing observe persistence", async () => {
    const { sdk, kv } = await setupObserve({ decisionMode: "advisory" });

    const result = (await sdk.trigger("mem::observe", observePayload({
      hookType: "prompt_submit",
      data: { prompt: "Always preserve hook payload shapes in AgentMemory." },
    }))) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    expect(storedObservation(kv)).toHaveProperty("title");
    expect(storedObservation(kv)).not.toHaveProperty("decisionId");
    const rows = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "semantic",
      status: "pending",
      project: "/repo/agentmemory",
      sessionId: "ses_decision",
      content: "Always preserve hook payload shapes in AgentMemory.",
      evidenceRefs: [{
        kind: "observation",
        id: result.observationId,
        sessionId: "ses_decision",
      }],
    });
    await expect(kv.list(KV.semantic)).resolves.toEqual([]);
    await expect(kv.list(KV.procedural)).resolves.toEqual([]);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({
      action: "semantic_memory_candidate",
      candidateQueued: true,
      outcome: "advised",
    });
  });

  it("does not suppress low-confidence notification noise in enforce mode", async () => {
    const { sdk, kv } = await setupObserve({
      decisionMode: "enforce",
      enforceIgnore: "true",
    });

    await sdk.trigger("mem::observe", observePayload({
      hookType: "notification",
      data: { message: "ok" },
    }));

    expect(storedObservation(kv)).toHaveProperty("title");
    expect(streamEvents(sdk, "compressed").length).toBeGreaterThan(0);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({
      mode: "enforce",
      action: "ignore",
      outcome: "advised",
    });
  });

  it("downgrades unsupported enforce actions to advisory behavior", async () => {
    const { sdk, kv } = await setupObserve({
      decisionMode: "enforce",
      enforceIgnore: "true",
    });

    await sdk.trigger("mem::observe", observePayload({
      hookType: "post_tool_use",
      data: {
        tool_name: "Read",
        tool_input: { file_path: "src/functions/observe.ts" },
        tool_output: "file contents here",
      },
    }));

    expect(storedObservation(kv)).toHaveProperty("title");
    expect(streamEvents(sdk, "compressed").length).toBeGreaterThan(0);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0].action).not.toBe("ignore");
    expect(audits[0]).toMatchObject({
      mode: "enforce",
      outcome: "advised",
    });
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it.each([
    ["prompt_submit", { prompt: "remember this token=abcdefghijklmnopqrstuvwxyz password=abcdefghijklmnopqrstuvwxyz" }],
    ["post_tool_failure", { tool_name: "Bash", error: "token=abcdefghijklmnopqrstuvwxyz password=abcdefghijklmnopqrstuvwxyz" }],
    ["post_tool_use", {
      tool_name: "Write",
      tool_input: { file_path: "src/functions/observe.ts" },
      tool_output: "token=abcdefghijklmnopqrstuvwxyz password=abcdefghijklmnopqrstuvwxyz",
    }],
    ["post_tool_use", {
      tool_name: "Bash",
      tool_output: "TypeError: failed at line 42 token=abcdefghijklmnopqrstuvwxyz password=abcdefghijklmnopqrstuvwxyz",
    }],
  ])(
    "does not suppress protected %s evidence in enforce mode",
    async (hookType, data) => {
      const { sdk, kv } = await setupObserve({
        decisionMode: "enforce",
        enforceIgnore: "true",
      });

      await sdk.trigger("mem::observe", observePayload({ hookType, data }));

      expect(storedObservation(kv)).toHaveProperty("title");
      expect(streamEvents(sdk, "compressed").length).toBeGreaterThan(0);
      await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
    },
  );

  it.each(["shadow", "advisory", "enforce"])(
    "keeps the stored observation shape identical to disabled mode in %s mode",
    async (mode) => {
    const disabled = await setupObserve({ decisionMode: "disabled" });
    await disabled.sdk.trigger("mem::observe", observePayload());
    const disabledStored = Array.from(
      disabled.kv.store.get(KV.observations("ses_decision"))!.values(),
    )[0];

    const active = await setupObserve({ decisionMode: mode });
    await active.sdk.trigger("mem::observe", observePayload());
    const activeStored = Array.from(
      active.kv.store.get(KV.observations("ses_decision"))!.values(),
    )[0];

    expect(onlyDynamicId(activeStored)).toEqual(onlyDynamicId(disabledStored));
    expect(activeStored).not.toHaveProperty("decisionId");
    },
  );

  it.each(["shadow", "advisory", "enforce"])(
    "keeps auto-compress behavior unchanged in %s mode",
    async (mode) => {
    const { sdk, kv } = await setupObserve({
      decisionMode: mode,
      autoCompress: "true",
    });

    await sdk.trigger("mem::observe", observePayload());

    expect(sdk.triggered.filter((t) => t.id === "mem::compress")).toHaveLength(1);
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(1);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toHaveLength(1);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
    },
  );

  it.each(["shadow", "advisory", "enforce"])(
    "keeps implicit session creation unchanged in %s mode",
    async (mode) => {
    const { kv, sdk } = await setupObserve({ decisionMode: mode });

    await sdk.trigger("mem::observe", observePayload({
      sessionId: "ses_implicit",
      hookType: "prompt_submit",
      data: { prompt: "ship the helm chart" },
    }));

    const session = kv.store.get(KV.sessions)!.get("ses_implicit") as Record<string, unknown>;
    expect(session).toMatchObject({
      id: "ses_implicit",
      project: "/repo/agentmemory",
      cwd: "/repo/agentmemory",
      status: "active",
      observationCount: 1,
      firstPrompt: "ship the helm chart",
    });
    },
  );

  it.each(["shadow", "advisory", "enforce"])(
    "does not block observe when mem::decide throws in %s mode",
    async (mode) => {
    const { sdk, kv } = await setupObserve({
      decisionMode: mode,
      throwingDecision: true,
    });

    const result = (await sdk.trigger("mem::observe", observePayload())) as {
      observationId: string;
    };

    expect(result.observationId).toBeTruthy();
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(1);
    expect(kv.store.get(KV.observations("ses_decision"))!.size).toBe(1);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
    },
  );
});
