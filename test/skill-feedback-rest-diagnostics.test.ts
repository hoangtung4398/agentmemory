import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerSkillFeedbackDiagnosticsFunction } from "../src/functions/skill-feedback-diagnostics.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { KV } from "../src/state/schema.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { SkillFeedbackEvent } from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS_LIMIT",
];
const ORIGINAL: Record<string, string | undefined> = {};
const TEST_SECRET = "diagnostics-secret";

type HttpResponse = { status_code: number; body: unknown };
type ApiHandler = (request: { headers?: Record<string, unknown>; query_params?: Record<string, unknown> }) => Promise<HttpResponse>;
type McpHandler = (request: { body?: unknown }) => Promise<HttpResponse>;

function createSdk(options?: { routeRegisteredFunctions?: boolean }) {
  const functions = new Map<string, Function>();
  const triggers: unknown[] = [];
  const trigger = vi.fn(async (input: { function_id: string; payload: unknown }) => {
    if (!options?.routeRegisteredFunctions) throw new Error("No mocked trigger result");
    const handler = functions.get(input.function_id);
    if (!handler) throw new Error(`No function: ${input.function_id}`);
    return handler(input.payload);
  });
  return {
    functions,
    triggers,
    trigger,
    sdk: {
      registerFunction: (idOrOptions: string | { id: string }, handler: Function) => {
        const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
        functions.set(id, handler);
      },
      registerTrigger: (config: unknown) => triggers.push(config),
      trigger,
    },
  };
}

function createForbiddenKv() {
  const reject = (operation: string) => vi.fn(async () => { throw new Error(`unexpected KV ${operation}`); });
  return { list: reject("list"), get: reject("get"), set: reject("set"), delete: reject("delete") };
}

function createCountedKv(rows: unknown[] = []) {
  const listCalls: string[] = [];
  const getCalls: string[] = [];
  const setCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    rows,
    listCalls,
    getCalls,
    setCalls,
    deleteCalls,
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.push(scope);
      return rows as T[];
    },
    get: async <T>(scope: string): Promise<T | null> => {
      getCalls.push(scope);
      return null;
    },
    set: async <T>(scope: string, _key: string, value: T): Promise<T> => {
      setCalls.push(scope);
      return value;
    },
    delete: async (scope: string): Promise<void> => {
      deleteCalls.push(scope);
    },
  };
}

function feedbackEvent(id: string, overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId: "skill_release",
    skillVersion: 1,
    kind: "success",
    attribution: "user-confirmed",
    source: "explicit",
    project: "project-a",
    agentId: "agent-a",
    sessionId: "session-a",
    sourceObservationIds: ["obs-1"],
    sourceSessionIds: ["session-1"],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function enableDiagnostics(): void {
  process.env["AGENTMEMORY_SKILLS"] = "true";
  process.env["AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS"] = "true";
}

function setupAdapter(secret?: string) {
  const routed = createSdk();
  const kv = createForbiddenKv();
  registerApiTriggers(routed.sdk as never, kv as never, secret);
  return { ...routed, kv, handler: routed.functions.get("api::skill-feedback-diagnostics")! as ApiHandler };
}

function setupMcpAdapter() {
  const routed = createSdk();
  const kv = createForbiddenKv();
  registerMcpEndpoints(routed.sdk as never, kv as never);
  return { ...routed, kv, handler: routed.functions.get("mcp::tools::call")! as McpHandler };
}

function request(query_params: Record<string, unknown> = { skillId: "skill_release" }, secret?: string) {
  return {
    headers: secret === undefined ? {} : { authorization: `Bearer ${secret}` },
    query_params,
  };
}

function mcpRequest(arguments_: Record<string, unknown> = { skillId: "skill_release" }) {
  return { body: { name: "memory_skill_feedback_diagnostics", arguments: arguments_ } };
}

function expectNoKvAccess(kv: ReturnType<typeof createForbiddenKv>): void {
  expect(kv.list).not.toHaveBeenCalled();
  expect(kv.get).not.toHaveBeenCalled();
  expect(kv.set).not.toHaveBeenCalled();
  expect(kv.delete).not.toHaveBeenCalled();
}

describe("api::skill-feedback-diagnostics", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  it("registers exactly one authenticated GET endpoint and no other method", () => {
    const { functions, triggers } = setupAdapter();
    expect(functions.has("api::skill-feedback-diagnostics")).toBe(true);
    const registrations = (triggers as Array<{ function_id?: string; config?: { api_path?: string; http_method?: string; middleware_function_ids?: string[] } }>)
      .filter((trigger) => trigger.config?.api_path === "/agentmemory/skill-feedback/diagnostics");
    expect(registrations).toEqual([{
      type: "http",
      function_id: "api::skill-feedback-diagnostics",
      config: {
        api_path: "/agentmemory/skill-feedback/diagnostics",
        http_method: "GET",
        middleware_function_ids: ["middleware::api-auth"],
      },
    }]);
    expect(registrations.some((trigger) => trigger.config?.http_method !== "GET")).toBe(false);
  });

  it("authenticates before the disabled gate and malformed query handling", async () => {
    const { handler, trigger, kv } = setupAdapter(TEST_SECRET);
    for (const unauthorizedRequest of [
      request({}, undefined),
      request({ skillId: [] }, "wrong-secret"),
    ]) {
      trigger.mockClear();
      const response = await handler(unauthorizedRequest);
      expect(response).toEqual({ status_code: 401, body: { error: "unauthorized" } });
      expect(trigger).not.toHaveBeenCalled();
      expectNoKvAccess(kv);
    }
  });

  it("returns the standardized disabled response before parsing any query", async () => {
    for (const flags of [
      {},
      { AGENTMEMORY_SKILLS: "true" },
      { AGENTMEMORY_SKILLS: "true", AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS: "false" },
    ]) {
      Object.assign(process.env, flags);
      const { handler, trigger, kv } = setupAdapter(TEST_SECRET);
      const response = await handler(request({ skillId: [] }, TEST_SECRET));
      expect(response).toMatchObject({
        status_code: 503,
        body: {
          error: "Skill feedback diagnostics not enabled",
          flag: "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
        },
      });
      expect(trigger).not.toHaveBeenCalled();
      expectNoKvAccess(kv);
      for (const key of ENV_KEYS) delete process.env[key];
    }
  });

  it("works with feedback recording disabled after valid authentication", async () => {
    enableDiagnostics();
    process.env["AGENTMEMORY_SKILL_FEEDBACK"] = "false";
    const { handler, trigger, kv } = setupAdapter(TEST_SECRET);
    const internalResult = { success: true, enabled: true, scannedCount: 0, events: [] };
    trigger.mockResolvedValue(internalResult);
    const response = await handler(request({ skillId: " skill_1 " }, TEST_SECRET));
    expect(response).toEqual({ status_code: 200, body: internalResult });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith({ function_id: "mem::skill-feedback-diagnostics", payload: { skillId: "skill_1" } });
    expectNoKvAccess(kv);
  });

  it("rejects malformed skillId representations before delegation", async () => {
    enableDiagnostics();
    const invalidValues = [undefined, "", "   ", [], {}, 1, true];
    for (const value of invalidValues) {
      const { handler, trigger, kv } = setupAdapter();
      const query = value === undefined ? {} : { skillId: value };
      const response = await handler(request(query));
      expect(response).toEqual({ status_code: 400, body: { error: "invalid skill feedback diagnostics query" } });
      expect(trigger).not.toHaveBeenCalled();
      expectNoKvAccess(kv);
    }
  });

  it("parses canonical numeric query strings and rejects malformed representations", async () => {
    enableDiagnostics();
    const { handler, trigger, kv } = setupAdapter();
    trigger.mockResolvedValue({ success: true, enabled: true, events: [] });
    for (const value of ["1", "20", "500"]) {
      trigger.mockClear();
      await expect(handler(request({ skillId: "skill_1", skillVersion: value, limit: value }))).resolves.toMatchObject({ status_code: 200 });
      expect(trigger).toHaveBeenCalledWith({
        function_id: "mem::skill-feedback-diagnostics",
        payload: { skillId: "skill_1", skillVersion: Number(value), limit: Number(value) },
      });
    }

    for (const field of ["skillVersion", "limit"]) {
      for (const value of ["0", "-1", "1.5", "1e2", "01", "+1", "Infinity", "NaN", "", "   ", [], {}, 1]) {
        trigger.mockClear();
        const response = await handler(request({ skillId: "skill_1", [field]: value }));
        expect(response).toEqual({ status_code: 400, body: { error: "invalid skill feedback diagnostics query" } });
        expect(trigger).not.toHaveBeenCalled();
      }
    }
    expectNoKvAccess(kv);
  });

  it("rejects non-string optional filters before delegation", async () => {
    enableDiagnostics();
    for (const field of ["kind", "attribution", "project", "agentId", "sessionId"]) {
      for (const value of [[], {}, 1, true]) {
        const { handler, trigger, kv } = setupAdapter();
        const response = await handler(request({ skillId: "skill_1", [field]: value }));
        expect(response).toEqual({ status_code: 400, body: { error: "invalid skill feedback diagnostics query" } });
        expect(trigger).not.toHaveBeenCalled();
        expectNoKvAccess(kv);
      }
    }
  });

  it("trims and forwards optional filters without undefined payload properties", async () => {
    enableDiagnostics();
    const { handler, trigger, kv } = setupAdapter();
    trigger.mockResolvedValue({ success: true, enabled: true, events: [] });
    await handler(request({
      skillId: " skill_1 ",
      skillVersion: "2",
      limit: "20",
      kind: " success ",
      attribution: " user-confirmed ",
      project: " project-a ",
      agentId: " agent-a ",
      sessionId: " session-a ",
    }));
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-feedback-diagnostics",
      payload: {
        skillId: "skill_1",
        skillVersion: 2,
        limit: 20,
        kind: "success",
        attribution: "user-confirmed",
        project: "project-a",
        agentId: "agent-a",
        sessionId: "session-a",
      },
    });

    trigger.mockClear();
    await handler(request({ skillId: "skill_1" }));
    const payload = trigger.mock.calls[0]![0].payload as Record<string, unknown>;
    for (const key of ["kind", "attribution", "project", "agentId", "sessionId", "skillVersion", "limit"]) {
      expect(payload).not.toHaveProperty(key);
    }
    expectNoKvAccess(kv);
  });

  it("maps each internal result without reshaping it", async () => {
    enableDiagnostics();
    const cases: Array<{ result: Record<string, unknown>; status: number }> = [
      { result: { success: true, enabled: true, scannedCount: 1, events: [] }, status: 200 },
      { result: { success: false, enabled: true, reason: "invalid skill feedback diagnostics input" }, status: 400 },
      { result: { success: false, enabled: true, reason: "failed to load skill feedback diagnostics" }, status: 500 },
      { result: { success: false, enabled: true, reason: "unexpected result" }, status: 500 },
    ];
    for (const { result, status } of cases) {
      const { handler, trigger, kv } = setupAdapter();
      trigger.mockResolvedValue(result);
      const response = await handler(request());
      expect(response.status_code).toBe(status);
      expect(response.body).toBe(result);
      expect(trigger).toHaveBeenCalledTimes(1);
      expectNoKvAccess(kv);
    }
  });

  it("maps an internal disabled fallback and thrown trigger exception to stable responses", async () => {
    enableDiagnostics();
    const fallback = setupAdapter();
    fallback.trigger.mockResolvedValue({ success: true, enabled: false, reason: "skill feedback diagnostics are disabled" });
    await expect(fallback.handler(request())).resolves.toMatchObject({
      status_code: 503,
      body: { flag: "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS" },
    });
    expectNoKvAccess(fallback.kv);

    const failure = setupAdapter();
    failure.trigger.mockRejectedValue(new Error("sensitive SDK failure"));
    await expect(failure.handler(request())).resolves.toEqual({
      status_code: 500,
      body: { success: false, error: "Skill feedback diagnostics query failed" },
    });
    expectNoKvAccess(failure.kv);
  });

  it("preserves the internal limit bound through the routed end-to-end path", async () => {
    enableDiagnostics();
    const routed = createSdk({ routeRegisteredFunctions: true });
    const kv = createCountedKv();
    registerSkillFeedbackDiagnosticsFunction(routed.sdk as never, kv as never);
    registerApiTriggers(routed.sdk as never, kv as never);
    const handler = routed.functions.get("api::skill-feedback-diagnostics")! as ApiHandler;
    const response = await handler(request({ skillId: "skill_release", limit: "501" }));
    expect(response).toMatchObject({
      status_code: 400,
      body: { success: false, reason: "invalid skill feedback diagnostics input" },
    });
    expect(routed.trigger).toHaveBeenCalledTimes(1);
    expect(routed.trigger).toHaveBeenCalledWith({ function_id: "mem::skill-feedback-diagnostics", payload: { skillId: "skill_release", limit: 501 } });
    expect(kv.listCalls).toEqual([]);
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("delegates to Phase 2A exactly once while preserving ledger diagnostics semantics", async () => {
    enableDiagnostics();
    process.env["AGENTMEMORY_SKILL_FEEDBACK"] = "false";
    const rows = [
      feedbackEvent("newer", { skillVersion: 2, kind: "failure", attribution: "agent-observed", createdAt: "2026-07-23T00:00:00.000Z" }),
      feedbackEvent("a", { createdAt: "2026-07-22T00:00:00.000Z" }),
      feedbackEvent("b", { skillVersion: 2, kind: "correction", createdAt: "2026-07-22T00:00:00.000Z" }),
      feedbackEvent("old", { kind: "stale", createdAt: "2026-07-20T00:00:00.000Z" }),
      feedbackEvent("other-skill", { skillId: "skill_other" }),
      null,
      { id: "malformed" },
    ];
    const before = JSON.stringify(rows);
    const routed = createSdk({ routeRegisteredFunctions: true });
    const kv = createCountedKv(rows);
    registerSkillFeedbackDiagnosticsFunction(routed.sdk as never, kv as never);
    registerApiTriggers(routed.sdk as never, kv as never);
    const handler = routed.functions.get("api::skill-feedback-diagnostics")! as ApiHandler;

    const response = await handler(request({ skillId: "skill_release", limit: "2" }));
    expect(response.status_code).toBe(200);
    const body = response.body as {
      scannedCount: number; validCount: number; malformedCount: number; matchedCount: number;
      returnedCount: number; truncated: boolean; aggregate: { total: number; byKind: Record<string, number> };
      events: SkillFeedbackEvent[];
    };
    expect(body).toMatchObject({
      scannedCount: 7,
      validCount: 5,
      malformedCount: 2,
      matchedCount: 4,
      returnedCount: 2,
      truncated: true,
      aggregate: { total: 4, byKind: { success: 1, failure: 1, correction: 1, stale: 1 } },
    });
    expect(body.events.map((event) => event.id)).toEqual(["newer", "a"]);
    body.events[0]!.sourceObservationIds.push("mutated");
    body.events[0]!.sourceSessionIds.push("mutated");
    expect(JSON.stringify(rows)).toBe(before);
    expect(routed.trigger).toHaveBeenCalledTimes(1);
    expect(routed.trigger).toHaveBeenCalledWith({ function_id: "mem::skill-feedback-diagnostics", payload: { skillId: "skill_release", limit: 2 } });
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });

  it("exposes the additive MCP tool and gates it before validation or delegation", async () => {
    const { handler, trigger, kv } = setupMcpAdapter();
    const response = await handler(mcpRequest({ skillId: [] }));

    expect(getAllTools().some((tool) => tool.name === "memory_skill_feedback_diagnostics")).toBe(true);
    expect(response).toMatchObject({
      status_code: 200,
      body: {
        isError: true,
        content: [{ type: "text" }],
      },
    });
    expect(JSON.parse((response.body as { content: Array<{ text: string }> }).content[0]!.text)).toMatchObject({
      success: false,
      flag: "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS",
    });
    expect(trigger).not.toHaveBeenCalled();
    expectNoKvAccess(kv);
  });

  it("validates and forwards MCP diagnostic filters without direct KV access", async () => {
    enableDiagnostics();
    const { handler, trigger, kv } = setupMcpAdapter();
    const internalResult = { success: true, enabled: true, scannedCount: 0, events: [] };
    trigger.mockResolvedValue(internalResult);

    const response = await handler(mcpRequest({
      skillId: " skill_1 ",
      skillVersion: 2,
      kind: "success",
      attribution: "user-confirmed",
      project: " project-a ",
      agentId: " agent-a ",
      sessionId: " session-a ",
      limit: 20,
    }));

    expect(JSON.parse((response.body as { content: Array<{ text: string }> }).content[0]!.text)).toEqual(internalResult);
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-feedback-diagnostics",
      payload: {
        skillId: "skill_1",
        skillVersion: 2,
        kind: "success",
        attribution: "user-confirmed",
        project: "project-a",
        agentId: "agent-a",
        sessionId: "session-a",
        limit: 20,
      },
    });

    for (const arguments_ of [
      {},
      { skillId: "skill_1", kind: "unknown" },
      { skillId: "skill_1", attribution: "unknown" },
      { skillId: "skill_1", skillVersion: 1.5 },
      { skillId: "skill_1", limit: 0 },
      { skillId: "skill_1", project: "   " },
    ]) {
      trigger.mockClear();
      await expect(handler(mcpRequest(arguments_))).resolves.toEqual({
        status_code: 400,
        body: { error: "invalid skill feedback diagnostics input" },
      });
      expect(trigger).not.toHaveBeenCalled();
    }
    expectNoKvAccess(kv);
  });

  it("routes MCP diagnostics to the existing Phase 2A function without ledger writes", async () => {
    enableDiagnostics();
    const rows = [feedbackEvent("feedback_1")];
    const routed = createSdk({ routeRegisteredFunctions: true });
    const kv = createCountedKv(rows);
    registerSkillFeedbackDiagnosticsFunction(routed.sdk as never, kv as never);
    registerMcpEndpoints(routed.sdk as never, kv as never);
    const handler = routed.functions.get("mcp::tools::call")! as McpHandler;

    const response = await handler(mcpRequest({ skillId: "skill_release", limit: 1 }));
    const body = JSON.parse((response.body as { content: Array<{ text: string }> }).content[0]!.text);

    expect(body).toMatchObject({ success: true, enabled: true, returnedCount: 1 });
    expect(routed.trigger).toHaveBeenCalledWith({
      function_id: "mem::skill-feedback-diagnostics",
      payload: { skillId: "skill_release", limit: 1 },
    });
    expect(kv.listCalls).toEqual([KV.skillFeedback]);
    expect(kv.getCalls).toEqual([]);
    expect(kv.setCalls).toEqual([]);
    expect(kv.deleteCalls).toEqual([]);
  });
});
