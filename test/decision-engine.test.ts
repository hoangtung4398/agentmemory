import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type {
  DecisionAudit,
  DecisionCandidateQueue,
  DecisionInput,
  MemoryDecision,
} from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_PROVIDER",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_SHADOW_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE",
];

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL: Record<string, string | undefined> = {};

let sandboxHome: string;

interface DecideResult {
  success: true;
  disabled: boolean;
  mode: string;
  provider: string;
  decision: MemoryDecision | null;
  audited: boolean;
  candidateQueued: boolean;
  candidateQueueId?: string;
  auditId?: string;
  fallbackReason?: string;
}

function mockKV(options: { failDecisionCandidateWrite?: boolean } = {}) {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (options.failDecisionCandidateWrite && scope === KV.decisionCandidates) {
        throw new Error("candidate queue unavailable");
      }
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
  return {
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: (payload: unknown) => unknown,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    id: "di_test",
    inputHash: "hash_test",
    mode: "shadow",
    sourceFunction: "mem::observe",
    insertionPoint: "direct_test",
    timestamp: "2026-01-01T00:00:00.000Z",
    evidenceRefs: [],
    constraints: {
      preserveDefaultBehavior: true,
      mayWriteExistingKvShape: false,
      mayChangeHookPayload: false,
      mayChangeSearchRanking: false,
    },
    ...overrides,
  };
}

async function setupDecision(
  mode = "shadow",
  extraEnv: Record<string, string> = {},
  kvOptions: { failDecisionCandidateWrite?: boolean } = {},
) {
  process.env["AGENTMEMORY_DECISION_MODE"] = mode;
  for (const [key, value] of Object.entries(extraEnv)) {
    process.env[key] = value;
  }
  vi.resetModules();
  const { registerDecisionEngineFunction } = await import(
    "../src/functions/decision-engine.js"
  );
  const sdk = mockSdk();
  const kv = mockKV(kvOptions);
  registerDecisionEngineFunction(sdk as never, kv as never);
  return { sdk, kv };
}

describe("Decision Engine PR2 mem::decide", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-decision-engine-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
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

  it("returns a disabled no-op and writes no audit rows when mode is disabled", async () => {
    const { sdk, kv } = await setupDecision("disabled");

    const result = (await sdk.trigger("mem::decide", baseInput())) as DecideResult;

    expect(result.success).toBe(true);
    expect(result.disabled).toBe(true);
    expect(result.decision).toBeNull();
    expect(result.audited).toBe(false);
    expect(result.candidateQueued).toBe(false);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
  });

  it("writes DecisionAudit in shadow mode and does not write candidate queues by default", async () => {
    const { sdk, kv } = await setupDecision("shadow");

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        hookType: "pre_tool_use",
        toolName: "Read",
        rawSignals: { file: "src/functions/observe.ts", action: "read" },
      }),
    )) as DecideResult;

    expect(result.disabled).toBe(false);
    expect(result.decision?.action).toBe("working_memory");
    expect(result.audited).toBe(true);
    expect(result.auditId).toBeDefined();
    expect(result.candidateQueued).toBe(false);

    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      inputId: "di_test",
      inputHash: "hash_test",
      mode: "shadow",
      action: "working_memory",
      outcome: "observed",
      existingBehaviorPreserved: true,
    });
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it("writes a pending semantic candidate queue row in advisory mode", async () => {
    const { sdk, kv } = await setupDecision("advisory");

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_semantic_queue",
        project: "agentmemory",
        hookType: "prompt_submit",
        rawSignals: {
          userPrompt: "Always use apply_patch for manual edits in this repo.",
        },
        evidenceRefs: [{ kind: "observation", id: "obs_1", sessionId: "ses_1" }],
      }),
    )) as DecideResult;

    expect(result.success).toBe(true);
    expect(result.decision?.action).toBe("semantic_memory_candidate");
    expect(result.decision?.effects.enqueueCandidate).toBe(true);
    expect(result.candidateQueued).toBe(true);
    expect(result.candidateQueueId).toBeDefined();

    const rows = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.candidateQueueId,
      kind: "semantic",
      status: "pending",
      decisionId: result.decision?.id,
      candidateId: result.decision?.selectedCandidateId,
      project: "agentmemory",
      content: "Always use apply_patch for manual edits in this repo.",
      confidence: 0.8,
      importance: 8,
      ttlDays: 365,
      evidenceRefs: [{ kind: "observation", id: "obs_1", sessionId: "ses_1" }],
    });
    expect(rows[0].expiresAt).toBeDefined();

    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({
      candidateQueued: true,
      candidateQueueId: result.candidateQueueId,
      outcome: "advised",
    });
  });

  it("writes a pending procedural candidate queue row in advisory mode", async () => {
    const { sdk, kv } = await setupDecision("advisory");

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_procedural_queue",
        sourceFunction: "mem::remember",
        project: "agentmemory",
        memoryDraft: {
          type: "workflow",
          title: "Release workflow",
          content:
            "Successful procedure: first run npm test, then run npm run build.",
          concepts: ["release workflow"],
          files: [],
        },
      }),
    )) as DecideResult;

    expect(result.decision?.action).toBe("procedural_memory_candidate");
    expect(result.candidateQueued).toBe(true);

    const rows = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "procedural",
      status: "pending",
      content: "Successful procedure: first run npm test, then run npm run build.",
      concepts: ["release workflow"],
    });
  });

  it("does not write shadow candidate queue rows unless the experimental flag is set", async () => {
    const input = baseInput({
      id: "di_shadow_semantic",
      hookType: "prompt_submit",
      rawSignals: {
        userPrompt: "Always keep hook payload shapes unchanged.",
      },
    });
    const plain = await setupDecision("shadow");

    const plainResult = (await plain.sdk.trigger("mem::decide", input)) as DecideResult;

    expect(plainResult.decision?.action).toBe("semantic_memory_candidate");
    expect(plainResult.candidateQueued).toBe(false);
    await expect(plain.kv.list(KV.decisionCandidates)).resolves.toEqual([]);

    const flagged = await setupDecision("shadow", {
      AGENTMEMORY_DECISION_SHADOW_QUEUE: "true",
    });

    const flaggedResult = (await flagged.sdk.trigger(
      "mem::decide",
      input,
    )) as DecideResult;

    expect(flaggedResult.candidateQueued).toBe(true);
    await expect(
      flagged.kv.list<DecisionCandidateQueue>(KV.decisionCandidates),
    ).resolves.toHaveLength(1);
  });

  it("does not queue non-candidate actions", async () => {
    const { sdk, kv } = await setupDecision("advisory");

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_working_advisory",
        hookType: "pre_tool_use",
        toolName: "Read",
        rawSignals: { file: "src/config.ts" },
      }),
    )) as DecideResult;

    expect(result.decision?.action).toBe("working_memory");
    expect(result.candidateQueued).toBe(false);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it("does not queue candidates below the configured confidence threshold", async () => {
    const { sdk, kv } = await setupDecision("advisory", {
      AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE: "0.9",
    });

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_low_confidence_semantic",
        hookType: "prompt_submit",
        rawSignals: {
          userPrompt: "Always use the existing iii-engine KV path.",
        },
      }),
    )) as DecideResult;

    expect(result.decision?.action).toBe("semantic_memory_candidate");
    expect(result.candidateQueued).toBe(false);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
  });

  it("does not queue candidates with invalid content", async () => {
    const { sdk, kv } = await setupDecision("advisory");

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_invalid_content",
        project: "agentmemory architecture",
      }),
    )) as DecideResult;

    expect(result.decision?.action).toBe("semantic_memory_candidate");
    expect(result.candidateQueued).toBe(false);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({
      candidateQueued: false,
      candidateQueueError: "invalid_content",
    });
  });

  it("does not fail mem::decide when candidate queue write fails", async () => {
    const { sdk, kv } = await setupDecision(
      "advisory",
      {},
      { failDecisionCandidateWrite: true },
    );

    const result = (await sdk.trigger(
      "mem::decide",
      baseInput({
        id: "di_queue_write_failure",
        hookType: "prompt_submit",
        rawSignals: {
          userPrompt: "Always preserve current REST endpoint payload shapes.",
        },
      }),
    )) as DecideResult;

    expect(result.success).toBe(true);
    expect(result.decision?.action).toBe("semantic_memory_candidate");
    expect(result.decision?.effects.enqueueCandidate).toBe(false);
    expect(result.candidateQueued).toBe(false);
    await expect(kv.list(KV.decisionCandidates)).resolves.toEqual([]);
    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0]).toMatchObject({
      candidateQueued: false,
      candidateQueueError: "queue_write_failed",
    });
  });

  it.each([
    [
      "ignore",
      baseInput({
        id: "di_ignore",
        hookType: "notification",
        rawSignals: { message: "Command completed" },
      }),
    ],
    [
      "working_memory",
      baseInput({
        id: "di_working",
        hookType: "pre_tool_use",
        toolName: "Read",
        rawSignals: { file: "src/config.ts" },
      }),
    ],
    [
      "episodic_memory",
      baseInput({
        id: "di_episodic",
        observationState: "compressed",
        compressedSignals: {
          type: "error",
          title: "Test failure",
          narrative: "npm test failed with TypeError in src/functions/observe.ts line 12",
          facts: ["TypeError in observe path"],
          concepts: ["test failure"],
          files: ["src/functions/observe.ts"],
          importance: 7,
          confidence: 0.8,
        },
      }),
    ],
    [
      "semantic_memory_candidate",
      baseInput({
        id: "di_semantic",
        hookType: "prompt_submit",
        rawSignals: {
          userPrompt: "Always use apply_patch for manual edits in this repo.",
        },
      }),
    ],
    [
      "procedural_memory_candidate",
      baseInput({
        id: "di_procedural",
        sourceFunction: "mem::remember",
        memoryDraft: {
          type: "workflow",
          title: "Release workflow",
          content:
            "Successful procedure: first run npm test, then run npm run build. This workflow worked after changing manifests.",
          concepts: ["release workflow"],
          files: [],
        },
      }),
    ],
  ] as Array<[MemoryDecision["action"], DecisionInput]>)(
    "classifies %s with the heuristic classifier",
    async (expectedAction, input) => {
      const { sdk } = await setupDecision("shadow");

      const result = (await sdk.trigger("mem::decide", input)) as DecideResult;

      expect(result.success).toBe(true);
      expect(result.decision?.action).toBe(expectedAction);
      expect(result.decision?.effects.alterIndexing).toBe(false);
      expect(result.decision?.effects.alterExistingFlow).toBe(false);
      expect(result.decision?.effects.enqueueCandidate).toBe(false);
      expect(result.decision?.reasonCodes.length).toBeGreaterThan(0);
    },
  );

  it("falls back to working_memory and records fallback reason for invalid input", async () => {
    const { sdk, kv } = await setupDecision("shadow");

    const result = (await sdk.trigger("mem::decide", {
      rawSignals: { note: "ambiguous signal without source metadata" },
    })) as DecideResult;

    expect(result.decision?.action).toBe("working_memory");
    expect(result.fallbackReason).toContain("invalid DecisionInput");

    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe("fallback");
    expect(audits[0].fallbackReason).toContain("sourceFunction");
  });

  it("uses ignore fallback for invalid secret-heavy input", async () => {
    const { sdk, kv } = await setupDecision("shadow");

    const result = (await sdk.trigger("mem::decide", {
      rawSignals: {
        token: "Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
      },
    })) as DecideResult;

    expect(result.decision?.action).toBe("ignore");
    expect(result.decision?.reasonCodes).toContain("fallback_secret_or_noise_ignore");

    const audits = await kv.list<DecisionAudit>(KV.decisionAudit);
    expect(audits[0].outcome).toBe("fallback");
  });

  it("honors AGENTMEMORY_DECISION_AUDIT=false in active modes", async () => {
    const { sdk, kv } = await setupDecision("advisory", {
      AGENTMEMORY_DECISION_AUDIT: "false",
    });

    const result = (await sdk.trigger("mem::decide", baseInput({
      sourceFunction: "mem::remember",
      memoryDraft: {
        type: "fact",
        title: "Architecture fact",
        content: "AgentMemory storage goes through iii-engine KV state.",
        concepts: ["storage", "architecture"],
        files: [],
      },
    }))) as DecideResult;

    expect(result.mode).toBe("advisory");
    expect(result.audited).toBe(false);
    expect(result.candidateQueued).toBe(true);
    await expect(kv.list<DecisionAudit>(KV.decisionAudit)).resolves.toEqual([]);
    await expect(kv.list(KV.decisionCandidates)).resolves.toHaveLength(1);
  });
});
