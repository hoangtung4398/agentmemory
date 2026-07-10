import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type {
  DecisionAudit,
  DecisionCandidateQueue,
  DecisionInput,
  Memory,
} from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_PROVIDER",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_SHADOW_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE",
  "AGENT_ID",
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
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, (payload: unknown) => unknown>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    functions,
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

async function setupRemember(options: {
  decisionMode?: string;
  registerDecision?: boolean;
  throwingDecision?: boolean;
  agentId?: string;
} = {}) {
  if (options.decisionMode) {
    process.env["AGENTMEMORY_DECISION_MODE"] = options.decisionMode;
  }
  if (options.agentId) {
    process.env["AGENT_ID"] = options.agentId;
  }

  vi.resetModules();
  const [{ registerRememberFunction }, { registerDecisionEngineFunction }, search] =
    await Promise.all([
      import("../src/functions/remember.js"),
      import("../src/functions/decision-engine.js"),
      import("../src/functions/search.js"),
    ]);

  search.getSearchIndex().clear();
  search.setIndexPersistence(null);

  const sdk = mockSdk();
  const kv = mockKV();
  if (options.throwingDecision) {
    sdk.registerFunction("mem::decide", () => {
      throw new Error("decision unavailable");
    });
  } else if (options.registerDecision !== false) {
    registerDecisionEngineFunction(sdk as never, kv as never);
  }
  registerRememberFunction(sdk as never, kv as never);
  return { sdk, kv, search };
}

function rememberPayload(overrides: Record<string, unknown> = {}) {
  return {
    content: "Always run npm test after changing memory functions.",
    type: "workflow",
    concepts: ["testing", "memory"],
    files: ["src/functions/remember.ts"],
    sourceObservationIds: ["obs_1"],
    project: "agentmemory",
    ...overrides,
  };
}

function normalizeMemory(memory: Memory): Record<string, unknown> {
  return {
    ...memory,
    id: "<mem>",
    createdAt: "<created>",
    updatedAt: "<updated>",
  };
}

describe("mem::remember Decision Engine audit integration", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-remember-decision-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
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
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("does not build or call mem::decide when decision mode is disabled", async () => {
    const { sdk, kv } = await setupRemember({ decisionMode: "disabled" });

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload(),
    })) as { success: boolean; memory: Memory };

    expect(result.success).toBe(true);
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(0);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
  });

  it("does not call mem::decide in enforce mode during PR6", async () => {
    const { sdk, kv } = await setupRemember({ decisionMode: "enforce" });

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload(),
    })) as { success: boolean; memory: Memory };

    expect(result.success).toBe(true);
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(0);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it.each([
    ["shadow", "observed"],
    ["advisory", "advised"],
  ] as const)(
    "writes DecisionAudit in %s mode with mode-specific candidate queue behavior",
    async (mode, outcome) => {
      const { sdk, kv } = await setupRemember({ decisionMode: mode });

      await sdk.trigger({
        function_id: "mem::remember",
        payload: rememberPayload(),
      });

      const decideCalls = sdk.triggered.filter((t) => t.id === "mem::decide");
      expect(decideCalls).toHaveLength(1);
      const input = decideCalls[0].data as DecisionInput;
      expect(input).toMatchObject({
        mode,
        sourceFunction: "mem::remember",
        insertionPoint: "remember.after_validation.before_save",
        project: "agentmemory",
        memoryDraft: {
          type: "workflow",
          title: "Always run npm test after changing memory functions.",
          content: "Always run npm test after changing memory functions.",
          concepts: ["testing", "memory"],
          files: ["src/functions/remember.ts"],
          project: "agentmemory",
        },
        evidenceRefs: [{ kind: "observation", id: "obs_1" }],
      });

      const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        mode,
        sourceFunction: "mem::remember",
        insertionPoint: "remember.after_validation.before_save",
        outcome,
        existingBehaviorPreserved: true,
        project: "agentmemory",
      });
      const rows = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
      if (mode === "advisory") {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: "semantic",
          status: "pending",
          project: "agentmemory",
          content: "Always run npm test after changing memory functions.",
          evidenceRefs: [{ kind: "observation", id: "obs_1" }],
        });
        expect(audits[0]).toMatchObject({
          action: "semantic_memory_candidate",
          candidateQueued: true,
          candidateQueueId: rows[0].id,
        });
        await expect(kv.list(KV.semantic)).resolves.toEqual([]);
        await expect(kv.list(KV.procedural)).resolves.toEqual([]);
      } else {
        expect(rows).toEqual([]);
        expect(audits[0]).toMatchObject({ candidateQueued: false });
      }
    },
  );

  it.each(["shadow", "advisory"])(
    "keeps the saved Memory row identical to disabled mode except dynamic fields in %s mode",
    async (mode) => {
    const disabled = await setupRemember({ decisionMode: "disabled" });
    const disabledResult = (await disabled.sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload(),
    })) as { memory: Memory };

    const active = await setupRemember({ decisionMode: mode });
    const activeResult = (await active.sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload(),
    })) as { memory: Memory };

    expect(normalizeMemory(activeResult.memory)).toEqual(
      normalizeMemory(disabledResult.memory),
    );
    expect(activeResult.memory).not.toHaveProperty("decisionId");
    },
  );

  it.each(["shadow", "advisory"])(
    "keeps supersede/version behavior unchanged in %s mode",
    async (mode) => {
    const { sdk, kv } = await setupRemember({ decisionMode: mode });

    const first = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({
        content: "Use express-jwt middleware for token validation in this project.",
        type: "pattern",
        project: "api",
      }),
    })) as { memory: Memory };

    const second = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({
        content: "Use express-jwt middleware for token validation in this project.",
        type: "pattern",
        project: "api",
      }),
    })) as { memory: Memory };

    expect(second.memory.version).toBe(first.memory.version + 1);
    expect(second.memory.supersedes).toContain(first.memory.id);
    const old = await kv.get<Memory>(KV.memories, first.memory.id);
    expect(old?.isLatest).toBe(false);
    },
  );

  it.each(["shadow", "advisory"])(
    "keeps project-scope dedup isolation unchanged in %s mode",
    async (mode) => {
    const { sdk, kv } = await setupRemember({ decisionMode: mode });

    const first = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({
        content: "Use express-jwt middleware for token validation in this project.",
        type: "pattern",
        project: "api",
      }),
    })) as { memory: Memory };

    const second = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({
        content: "Use express-jwt middleware for token validation in this project.",
        type: "pattern",
        project: "web",
      }),
    })) as { memory: Memory };

    expect(second.memory.supersedes).toEqual([]);
    const apiMemory = await kv.get<Memory>(KV.memories, first.memory.id);
    expect(apiMemory?.isLatest).toBe(true);
    },
  );

  it.each(["shadow", "advisory"])(
    "keeps agentId stamping unchanged in %s mode",
    async (mode) => {
    const { sdk } = await setupRemember({ decisionMode: mode });

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({ agentId: "  reviewer  " }),
    })) as { memory: Memory };

    expect(result.memory.agentId).toBe("reviewer");
    },
  );

  it.each(["shadow", "advisory"])(
    "keeps saved memories searchable in %s mode",
    async (mode) => {
    const { sdk, search } = await setupRemember({ decisionMode: mode });

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload({
        content: "Unique pineapple bm25 marker for decision shadow remember.",
        type: "fact",
        concepts: ["pineapple-bm25"],
      }),
    })) as { memory: Memory };

    const hits = search.getSearchIndex().search("pineapple bm25 marker", 5);
    expect(hits.some((hit) => hit.obsId === result.memory.id)).toBe(true);
    },
  );

  it.each(["shadow", "advisory"])(
    "does not block memory save when mem::decide throws in %s mode",
    async (mode) => {
    const { sdk, kv } = await setupRemember({
      decisionMode: mode,
      throwingDecision: true,
    });

    const result = (await sdk.trigger({
      function_id: "mem::remember",
      payload: rememberPayload(),
    })) as { success: boolean; memory: Memory };

    expect(result.success).toBe(true);
    expect(result.memory.id).toMatch(/^mem_/);
    expect(sdk.triggered.filter((t) => t.id === "mem::decide")).toHaveLength(1);
    await expect(kv.list<Memory>(KV.memories)).resolves.toHaveLength(1);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
    },
  );
});
