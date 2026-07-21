import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerApiTriggers } from "../src/triggers/api.js";

const envKeys = ["AGENTMEMORY_SKILLS", "AGENTMEMORY_SKILL_FEEDBACK", "AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS"];
const original: Record<string, string | undefined> = {};

function setup(secret?: string) {
  const functions = new Map<string, Function>();
  const triggers: unknown[] = [];
  const trigger = vi.fn();
  const sdk = {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: (triggerConfig: unknown) => triggers.push(triggerConfig),
    trigger,
  };
  registerApiTriggers(sdk as never, {} as never, secret);
  return { functions, triggers, trigger };
}

describe("api::skill-feedback-diagnostics", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of envKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("registers an authenticated GET endpoint", () => {
    const { functions, triggers } = setup();
    expect(functions.has("api::skill-feedback-diagnostics")).toBe(true);
    expect(triggers).toContainEqual(expect.objectContaining({
      function_id: "api::skill-feedback-diagnostics",
      config: expect.objectContaining({ api_path: "/agentmemory/skill-feedback/diagnostics", http_method: "GET", middleware_function_ids: ["middleware::api-auth"] }),
    }));
  });

  it("authenticates before checking the feature gate", async () => {
    const { functions, trigger } = setup("secret");
    const handler = functions.get("api::skill-feedback-diagnostics")!;
    await expect(handler({ headers: {}, query_params: {} })).resolves.toMatchObject({ status_code: 401 });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("delegates one trimmed, typed query when diagnostics is enabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_FEEDBACK"] = "false";
    process.env["AGENTMEMORY_SKILL_FEEDBACK_DIAGNOSTICS"] = "true";
    const { functions, trigger } = setup();
    trigger.mockResolvedValue({ success: true, enabled: true, events: [] });
    const handler = functions.get("api::skill-feedback-diagnostics")!;
    await expect(handler({ headers: {}, query_params: { skillId: " skill_1 ", skillVersion: "2", limit: "500", kind: "success" } })).resolves.toMatchObject({ status_code: 200 });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith({ function_id: "mem::skill-feedback-diagnostics", payload: { skillId: "skill_1", skillVersion: 2, limit: 500, kind: "success" } });
  });
});
