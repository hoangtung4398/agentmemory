import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { DecisionAudit, DecisionCandidateQueue } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
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
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) return triggerOverrides.get(id)!(payload);
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(
  body?: unknown,
  query_params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return { body, headers, query_params };
}

function audit(overrides: Partial<DecisionAudit> = {}): DecisionAudit {
  return {
    id: "da_1",
    decisionId: "md_1",
    inputId: "di_1",
    inputHash: "din_1",
    mode: "shadow",
    sourceFunction: "mem::observe",
    insertionPoint: "observe.after_sanitization.before_kv_write",
    action: "working_memory",
    project: "/repo/a",
    sessionId: "ses_1",
    agentId: "agent_a",
    observationId: "obs_1",
    confidence: 0.7,
    importance: 5,
    ttlDays: 7,
    reasonCodes: ["file_specific_short_term_context"],
    explanation: "File context stays short term.",
    evidenceRefs: [{ kind: "observation", id: "obs_1", sessionId: "ses_1" }],
    outcome: "observed",
    existingBehaviorPreserved: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<DecisionCandidateQueue> = {}): DecisionCandidateQueue {
  return {
    id: "dq_1",
    kind: "semantic",
    status: "pending",
    decisionId: "md_1",
    candidateId: "dc_1",
    project: "/repo/a",
    sessionId: "ses_1",
    agentId: "agent_a",
    content: "AgentMemory preserves hook payload shapes.",
    concepts: ["compatibility"],
    files: ["src/functions/observe.ts"],
    confidence: 0.82,
    importance: 8,
    ttlDays: 365,
    evidenceRefs: [{ kind: "observation", id: "obs_1", sessionId: "ses_1" }],
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

async function seedAudits(kv: ReturnType<typeof mockKV>): Promise<void> {
  await kv.set(KV.decisionAudit, "da_1", audit());
  await kv.set(KV.decisionAudit, "da_2", audit({
    id: "da_2",
    decisionId: "md_2",
    inputId: "di_2",
    mode: "shadow",
    action: "episodic_memory",
    project: "/repo/a",
    sessionId: "ses_2",
    agentId: "agent_b",
    observationId: "obs_2",
    createdAt: "2026-07-09T00:01:00.000Z",
  }));
  await kv.set(KV.decisionAudit, "da_3", audit({
    id: "da_3",
    decisionId: "md_3",
    inputId: "di_3",
    mode: "advisory",
    sourceFunction: "mem::remember",
    insertionPoint: "remember.after_validation.before_save",
    action: "semantic_memory_candidate",
    project: "/repo/b",
    sessionId: undefined,
    agentId: "agent_a",
    observationId: undefined,
    confidence: 0.8,
    importance: 8,
    reasonCodes: ["project_decision"],
    evidenceRefs: [{ kind: "observation", id: "obs_3", sessionId: "ses_evidence" }],
    outcome: "advised",
    createdAt: "2026-07-09T00:02:00.000Z",
  }));
}

async function seedCandidates(kv: ReturnType<typeof mockKV>): Promise<void> {
  await kv.set(KV.decisionCandidates, "dq_1", candidate());
  await kv.set(KV.decisionCandidates, "dq_2", candidate({
    id: "dq_2",
    kind: "procedural",
    status: "consumed",
    decisionId: "md_2",
    candidateId: "dc_2",
    project: "/repo/a",
    sessionId: "ses_2",
    agentId: "agent_b",
    content: "Successful procedure: first run npm test, then run npm run build.",
    concepts: ["release workflow"],
    files: [],
    evidenceRefs: [{ kind: "observation", id: "obs_2", sessionId: "ses_2" }],
    consumedAt: "2026-07-09T00:05:00.000Z",
    consumedBy: "mem::consolidation-pipeline",
    createdAt: "2026-07-09T00:01:00.000Z",
  }));
  await kv.set(KV.decisionCandidates, "dq_3", candidate({
    id: "dq_3",
    status: "rejected",
    decisionId: "md_3",
    candidateId: "dc_3",
    project: "/repo/b",
    sessionId: undefined,
    agentId: "agent_a",
    evidenceRefs: [{ kind: "observation", id: "obs_3", sessionId: "ses_evidence" }],
    createdAt: "2026-07-09T00:02:00.000Z",
  }));
  await kv.set(KV.decisionCandidates, "dq_4", candidate({
    id: "dq_4",
    status: "expired",
    decisionId: "md_4",
    candidateId: "dc_4",
    project: "/repo/c",
    sessionId: "ses_4",
    agentId: "agent_c",
    expiresAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-09T00:03:00.000Z",
  }));
}

describe("Decision diagnostics REST/MCP", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("registers an additive MCP diagnostics tool", () => {
    const names = getAllTools().map((tool) => tool.name);
    expect(names).toContain("memory_decision_audit");
    expect(new Set(names).size).toBe(names.length);
  });

  it("REST diagnostics endpoint returns filtered DecisionAudit rows", async () => {
    registerApiTriggers(sdk as never, kv as never);
    await seedAudits(kv);

    const fn = sdk.getFunction("api::decision-audit")!;
    const result = await fn(makeReq(undefined, {
      mode: "shadow",
      action: "working_memory",
      sourceFunction: "mem::observe",
      project: "/repo/a",
      agentId: "agent_a",
      sessionId: "ses_1",
      limit: "10",
    }));

    expect(result.status_code).toBe(200);
    expect(result.body).toMatchObject({ success: true, count: 1 });
    expect(result.body.audits.map((entry: DecisionAudit) => entry.id)).toEqual(["da_1"]);
  });

  it("REST diagnostics endpoint supports limit and evidence-ref session filtering", async () => {
    registerApiTriggers(sdk as never, kv as never);
    await seedAudits(kv);

    const fn = sdk.getFunction("api::decision-audit")!;
    const byLimit = await fn(makeReq(undefined, { project: "/repo/a", limit: "1" }));
    expect(byLimit.body.audits.map((entry: DecisionAudit) => entry.id)).toEqual(["da_2"]);

    const byEvidenceSession = await fn(makeReq(undefined, { sessionId: "ses_evidence" }));
    expect(byEvidenceSession.body.audits.map((entry: DecisionAudit) => entry.id)).toEqual(["da_3"]);
  });

  it("REST diagnostics endpoint respects auth when a secret is configured", async () => {
    registerApiTriggers(sdk as never, kv as never, "secret");
    await seedAudits(kv);

    const fn = sdk.getFunction("api::decision-audit")!;
    await expect(fn(makeReq())).resolves.toMatchObject({
      status_code: 401,
      body: { error: "unauthorized" },
    });

    await expect(fn(makeReq(undefined, {}, { authorization: "Bearer secret" }))).resolves.toMatchObject({
      status_code: 200,
      body: { success: true, count: 3 },
    });
  });

  it("MCP diagnostics tool returns compact filtered audit diagnostics", async () => {
    registerMcpEndpoints(sdk as never, kv as never);
    await seedAudits(kv);

    const fn = sdk.getFunction("mcp::tools::call")!;
    const result = await fn(makeReq({
      name: "memory_decision_audit",
      arguments: { action: "semantic_memory_candidate", project: "/repo/b", limit: 5 },
    }));
    const body = result.body;
    const parsed = JSON.parse(body.content[0].text);

    expect(result.status_code).toBe(200);
    expect(parsed).toMatchObject({ success: true, count: 1 });
    expect(parsed.audits[0]).toMatchObject({
      id: "da_3",
      mode: "advisory",
      action: "semantic_memory_candidate",
      sourceFunction: "mem::remember",
      project: "/repo/b",
      agentId: "agent_a",
    });
    expect(parsed.audits[0].inputHash).toBeUndefined();
  });

  it("REST candidate diagnostics returns filtered read-only queue rows", async () => {
    registerApiTriggers(sdk as never, kv as never);
    await seedCandidates(kv);

    const fn = sdk.getFunction("api::decision-candidates")!;
    const result = await fn(makeReq(undefined, {
      kind: "semantic",
      status: "pending",
      project: "/repo/a",
      agentId: "agent_a",
      sessionId: "ses_1",
      decisionId: "md_1",
      candidateId: "dc_1",
      limit: "10",
    }));

    expect(result.status_code).toBe(200);
    expect(result.body).toMatchObject({ success: true, count: 1 });
    expect(result.body.candidates.map((entry: DecisionCandidateQueue) => entry.id))
      .toEqual(["dq_1"]);
    await expect(kv.get<DecisionCandidateQueue>(KV.decisionCandidates, "dq_1"))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("REST candidate diagnostics filters consumed rows and evidence session IDs", async () => {
    registerApiTriggers(sdk as never, kv as never);
    await seedCandidates(kv);

    const fn = sdk.getFunction("api::decision-candidates")!;
    const consumed = await fn(makeReq(undefined, { status: "consumed" }));
    expect(consumed.body.candidates.map((entry: DecisionCandidateQueue) => entry.id))
      .toEqual(["dq_2"]);

    const byEvidenceSession = await fn(makeReq(undefined, { sessionId: "ses_evidence" }));
    expect(byEvidenceSession.body.candidates.map((entry: DecisionCandidateQueue) => entry.id))
      .toEqual(["dq_3"]);
  });

  it("REST candidate diagnostics respects auth when a secret is configured", async () => {
    registerApiTriggers(sdk as never, kv as never, "secret");
    await seedCandidates(kv);

    const fn = sdk.getFunction("api::decision-candidates")!;
    await expect(fn(makeReq())).resolves.toMatchObject({
      status_code: 401,
      body: { error: "unauthorized" },
    });

    await expect(fn(makeReq(undefined, {}, { authorization: "Bearer secret" }))).resolves.toMatchObject({
      status_code: 200,
      body: { success: true, count: 4 },
    });
  });

  it("MCP candidate diagnostics returns compact filtered queue rows", async () => {
    registerMcpEndpoints(sdk as never, kv as never);
    await seedCandidates(kv);

    const fn = sdk.getFunction("mcp::tools::call")!;
    const result = await fn(makeReq({
      name: "memory_decision_candidates",
      arguments: { status: "expired", limit: 5 },
    }));
    const parsed = JSON.parse(result.body.content[0].text);

    expect(result.status_code).toBe(200);
    expect(parsed).toMatchObject({ success: true, count: 1 });
    expect(parsed.candidates[0]).toMatchObject({
      id: "dq_4",
      status: "expired",
      kind: "semantic",
      project: "/repo/c",
    });
    expect(parsed.candidates[0].inputHash).toBeUndefined();
  });

  it("diagnostics surfaces return empty results for an empty audit scope", async () => {
    registerApiTriggers(sdk as never, kv as never);
    registerMcpEndpoints(sdk as never, kv as never);

    const rest = await sdk.getFunction("api::decision-audit")!(makeReq());
    expect(rest.body).toMatchObject({ success: true, count: 0, audits: [] });

    const mcp = await sdk.getFunction("mcp::tools::call")!(makeReq({
      name: "memory_decision_audit",
      arguments: {},
    }));
    expect(JSON.parse(mcp.body.content[0].text)).toMatchObject({
      success: true,
      count: 0,
      audits: [],
    });
  });

  it("keeps the existing operation audit endpoint behavior unchanged", async () => {
    registerApiTriggers(sdk as never, kv as never);
    sdk.overrideTrigger("mem::audit-query", async (payload: unknown) => ({
      payload,
      entries: [{ id: "audit_1" }],
    }));

    const fn = sdk.getFunction("api::audit")!;
    const result = await fn(makeReq(undefined, { operation: "memory.save", limit: "7" }));

    expect(result.status_code).toBe(200);
    expect(result.body).toEqual({
      success: true,
      entries: {
        payload: { operation: "memory.save", limit: 7 },
        entries: [{ id: "audit_1" }],
      },
    });
  });
});
