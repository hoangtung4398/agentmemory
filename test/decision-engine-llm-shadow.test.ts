import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type { DecisionCandidateQueue, DecisionInput, MemoryDecision, MemoryProvider } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_PROVIDER",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_SHADOW_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
];

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL: Record<string, string | undefined> = {};

let sandboxHome: string;

function mockSdk() {
  const functions = new Map<string, (payload: unknown) => unknown>();
  return {
    registerFunction: (id: string, handler: (payload: unknown) => unknown) => functions.set(id, handler),
    trigger: async (id: string, payload: unknown) => {
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(payload);
    },
  };
}

function mockKv() {
  const store = new Map<string, Map<string, unknown>>();
  const writes: Array<{ scope: string; key: string }> = [];
  return {
    writes,
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      writes.push({ scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function provider(response: string | Error) {
  return {
    name: "test-provider",
    compress: vi.fn(async () => ""),
    summarize: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  } satisfies MemoryProvider;
}

function llmResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: "episodic_memory",
    confidence: 0.62,
    importance: 6,
    ttlDays: 30,
    reasonCodes: ["llm_shadow_test"],
    explanation: "A bounded safe shadow explanation.",
    concepts: ["shadow testing"],
    files: ["src/functions/decision-engine.ts"],
    privacy: { containsSensitiveData: false, redactionRequired: false },
    candidate: { kind: "none", content: "" },
    ...overrides,
  });
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    id: "di_llm_shadow",
    inputHash: "hash_llm_shadow",
    mode: "shadow",
    sourceFunction: "mem::remember",
    insertionPoint: "remember_before_save",
    timestamp: "2026-08-19T00:00:00.000Z",
    memoryDraft: {
      type: "fact",
      title: "Ambiguous note",
      content: "This note has no durable classifier signal.",
      concepts: [],
      files: [],
    },
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

async function setup(
  mode = "shadow",
  decisionProvider = "llm",
  suppliedProvider?: MemoryProvider,
  extraEnv: Record<string, string> = {},
) {
  process.env.AGENTMEMORY_DECISION_MODE = mode;
  process.env.AGENTMEMORY_DECISION_PROVIDER = decisionProvider;
  Object.assign(process.env, extraEnv);
  vi.resetModules();
  const { registerDecisionEngineFunction } = await import("../src/functions/decision-engine.js");
  const sdk = mockSdk();
  const kv = mockKv();
  registerDecisionEngineFunction(sdk as never, kv as never, suppliedProvider);
  return { sdk, kv };
}

async function decide(sdk: ReturnType<typeof mockSdk>, payload: DecisionInput) {
  return await sdk.trigger("mem::decide", payload) as {
    decision: MemoryDecision | null;
    fallbackReason?: string;
  };
}

describe("Decision Engine LLM1 shadow-only classification", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-decision-llm-shadow-"));
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("keeps heuristic-only registration and all non-shadow modes free of LLM calls", async () => {
    const response = llmResponse();
    const heuristicProvider = provider(response);
    const heuristicOnly = await setup("shadow", "heuristic", heuristicProvider);
    await decide(heuristicOnly.sdk, input());
    expect(heuristicProvider.summarize).not.toHaveBeenCalled();

    const noProvider = await setup("shadow", "llm");
    const noProviderResult = await decide(noProvider.sdk, input());
    expect(noProviderResult.decision?.candidates.every((candidate) => candidate.source === "heuristic")).toBe(true);

    for (const mode of ["disabled", "advisory", "enforce"]) {
      const llm = provider(response);
      const current = await setup(mode, "hybrid", llm);
      await decide(current.sdk, input());
      expect(llm.summarize).not.toHaveBeenCalled();
    }
  });

  it("calls exactly once for eligible remember and prompt-submit observation inputs", async () => {
    const rememberProvider = provider(llmResponse());
    const remember = await setup("shadow", "llm", rememberProvider);
    await decide(remember.sdk, input());
    expect(rememberProvider.summarize).toHaveBeenCalledTimes(1);

    const observeProvider = provider(llmResponse());
    const observe = await setup("shadow", "hybrid", observeProvider);
    await decide(observe.sdk, input({
      sourceFunction: "mem::observe",
      hookType: "prompt_submit",
      memoryDraft: undefined,
      rawSignals: { userPrompt: "Please keep this ambiguous project context." },
    }));
    expect(observeProvider.summarize).toHaveBeenCalledTimes(1);
  });

  it("skips non-prompt observe, high-confidence, and secret-heavy inputs", async () => {
    const nonPromptProvider = provider(llmResponse());
    const nonPrompt = await setup("shadow", "llm", nonPromptProvider);
    await decide(nonPrompt.sdk, input({ sourceFunction: "mem::observe", hookType: "post_tool_use" }));
    expect(nonPromptProvider.summarize).not.toHaveBeenCalled();

    const sensitiveProvider = provider(llmResponse());
    const sensitive = await setup("shadow", "llm", sensitiveProvider);
    const result = await decide(sensitive.sdk, input({
      rawSignals: { userPrompt: "api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890" },
    }));
    expect(sensitiveProvider.summarize).not.toHaveBeenCalled();
    expect(result.decision?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(sensitive.kv.writes.map((write) => write.scope)).toEqual([KV.decisionAudit]);
  });

  it("sends a bounded redacted allowlist prompt without tool, identity, or image data", async () => {
    const llm = provider(llmResponse());
    const { sdk } = await setup("shadow", "llm", llm);
    await decide(sdk, input({
      sessionId: "session-secret",
      agentId: "agent-secret",
      cwd: "C:/private",
      rawSignals: {
        userPrompt: "Use token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij safely.",
        toolInput: "must never leave this process",
        toolOutput: "also forbidden",
        sanitizedRaw: "forbidden raw observation",
        imageData: "base64-secret",
      },
      compressedSignals: {
        title: "Known signal",
        facts: ["a fact"],
        narrative: "A safe narrative",
        concepts: ["safe concept"],
        files: ["src/file.ts"],
      },
    }));
    const [, prompt] = vi.mocked(llm.summarize).mock.calls[0];
    expect(prompt.length).toBeLessThanOrEqual(6000);
    expect(prompt).toContain("[REDACTED_SECRET]");
    for (const forbidden of ["toolInput", "toolOutput", "sanitizedRaw", "session-secret", "agent-secret", "base64-secret", "C:/private"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("adds a valid LLM candidate without changing the heuristic decision or candidate queue ownership", async () => {
    const llm = provider(llmResponse({ action: "procedural_memory_candidate", candidate: { kind: "procedural", content: "Run the documented workflow." } }));
    const { sdk, kv } = await setup("shadow", "llm", llm, {
      AGENTMEMORY_DECISION_SHADOW_QUEUE: "true",
      AGENTMEMORY_DECISION_CANDIDATE_QUEUE: "true",
    });
    const result = await decide(sdk, input({
      sourceFunction: "mem::observe",
      hookType: "prompt_submit",
      rawSignals: { userPrompt: "Always preserve existing hook payload shapes." },
      memoryDraft: undefined,
    }));

    const selected = result.decision!.candidates.find((candidate) => candidate.id === result.decision!.selectedCandidateId);
    const llmCandidate = result.decision!.candidates.find((candidate) => candidate.source === "llm");
    expect(selected?.source).toBe("heuristic");
    expect(result.decision).toMatchObject({ action: "semantic_memory_candidate", confidence: 0.8, importance: 8, ttlDays: 365 });
    expect(llmCandidate).toMatchObject({ action: "procedural_memory_candidate", source: "llm" });
    const rows = await kv.list<DecisionCandidateQueue>(KV.decisionCandidates);
    expect(rows).toHaveLength(1);
    expect(rows[0].candidateId).toBe(result.decision!.selectedCandidateId);
    expect(rows[0].candidateId).not.toBe(llmCandidate?.id);
  });

  it.each([
    ["malformed JSON", "not json", "llm_shadow_invalid_json"],
    ["invalid schema", llmResponse({ confidence: 2 }), "llm_shadow_invalid_schema"],
    ["provider failure", new Error("provider key and response must not leak"), "llm_shadow_provider_error"],
    ["sensitive output", llmResponse({ explanation: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" }), "llm_shadow_sensitive_output"],
  ])("retains the heuristic result for %s", async (name, response, expectedFallback) => {
    const llm = provider(response as string | Error);
    const { sdk, kv } = await setup("shadow", "llm", llm);
    const result = await decide(sdk, input());
    expect(result.decision).toMatchObject({ action: "working_memory", selectedCandidateId: expect.any(String) });
    expect(result.decision?.candidates).toHaveLength(1);
    expect(result.fallbackReason).toBe(expectedFallback);
    const audits = await kv.list<{ fallbackReason?: string; reasonCodes: string[] }>(KV.decisionAudit);
    expect(audits[0].fallbackReason).toBe(expectedFallback);
    expect(audits[0].reasonCodes).toContain(
      name === "provider failure" ? "llm_shadow_unavailable" : "llm_shadow_invalid",
    );
    expect(JSON.stringify(audits[0])).not.toContain("provider key");
  });
});
