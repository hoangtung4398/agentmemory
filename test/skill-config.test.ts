import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV_KEYS = [
  "AGENTMEMORY_SKILLS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS",
  "AGENTMEMORY_SKILL_DIAGNOSTICS_LIMIT",
  "AGENTMEMORY_SKILL_RECALL",
  "AGENTMEMORY_SKILL_RECALL_LIMIT",
  "AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE",
  "AGENTMEMORY_SKILL_CONTEXT",
  "AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET",
  "AGENTMEMORY_SKILL_FEEDBACK",
  "AGENTMEMORY_SKILL_PROMOTION",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_STRENGTH",
  "AGENTMEMORY_SKILL_PROMOTION_MIN_EVIDENCE",
];

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL: Record<string, string | undefined> = {};

let sandboxHome: string;

async function freshConfig() {
  vi.resetModules();
  return await import("../src/config.js");
}

function writeEnv(contents: string): void {
  const dir = join(sandboxHome, ".agentmemory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

describe("AgentSkill read model configuration", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(import.meta.dirname, "skill-config-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const key of ENV_KEYS) {
      ORIGINAL[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
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

  it("disables skills and diagnostics by default", async () => {
    writeEnv("");
    const { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toEqual({
      enabled: false,
      feedbackEnabled: false,
      diagnosticsEnabled: false,
      diagnosticsLimit: 50,
      recallEnabled: false,
      recallLimit: 3,
      recallMinConfidence: 0.7,
      contextEnabled: false,
      contextTokenBudget: 320,
      promotionEnabled: false,
      promotionMinStrength: 0.7,
      promotionMinEvidence: 2,
    });
  });

  it("enables diagnostics by default when skills are explicitly enabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "1";
    const { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toEqual({
      enabled: true,
      feedbackEnabled: false,
      diagnosticsEnabled: true,
      diagnosticsLimit: 50,
      recallEnabled: false,
      recallLimit: 3,
      recallMinConfidence: 0.7,
      contextEnabled: false,
      contextTokenBudget: 320,
      promotionEnabled: false,
      promotionMinStrength: 0.7,
      promotionMinEvidence: 2,
    });
  });

  it("does not enable diagnostics when skills are disabled", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "false";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "true";
    const { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toMatchObject({
      enabled: false,
      diagnosticsEnabled: false,
    });
  });

  it("allows diagnostics to be explicitly disabled and clamps its limit", async () => {
    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS"] = "0";
    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS_LIMIT"] = "0";
    let { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toEqual({
      enabled: true,
      feedbackEnabled: false,
      diagnosticsEnabled: false,
      diagnosticsLimit: 1,
      recallEnabled: false,
      recallLimit: 3,
      recallMinConfidence: 0.7,
      contextEnabled: false,
      contextTokenBudget: 320,
      promotionEnabled: false,
      promotionMinStrength: 0.7,
      promotionMinEvidence: 2,
    });

    process.env["AGENTMEMORY_SKILL_DIAGNOSTICS_LIMIT"] = "900";
    ({ loadSkillConfig } = await freshConfig());
    expect(loadSkillConfig().diagnosticsLimit).toBe(500);
  });

  it("reads the additive flags from ~/.agentmemory/.env", async () => {
    writeEnv([
      "AGENTMEMORY_SKILLS=true",
      "AGENTMEMORY_SKILL_DIAGNOSTICS_LIMIT=23",
    ].join("\n"));
    const { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toEqual({
      enabled: true,
      feedbackEnabled: false,
      diagnosticsEnabled: true,
      diagnosticsLimit: 23,
      recallEnabled: false,
      recallLimit: 3,
      recallMinConfidence: 0.7,
      contextEnabled: false,
      contextTokenBudget: 320,
      promotionEnabled: false,
      promotionMinStrength: 0.7,
      promotionMinEvidence: 2,
    });
  });

  it("requires skills to enable promotion and clamps promotion thresholds", async () => {
    process.env["AGENTMEMORY_SKILL_PROMOTION"] = "1";
    process.env["AGENTMEMORY_SKILL_PROMOTION_MIN_STRENGTH"] = "2";
    process.env["AGENTMEMORY_SKILL_PROMOTION_MIN_EVIDENCE"] = "0";
    let { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toMatchObject({
      enabled: false,
      promotionEnabled: false,
      promotionMinStrength: 1,
      promotionMinEvidence: 1,
    });

    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_PROMOTION_MIN_STRENGTH"] = "-1";
    process.env["AGENTMEMORY_SKILL_PROMOTION_MIN_EVIDENCE"] = "99";
    ({ loadSkillConfig } = await freshConfig());

    expect(loadSkillConfig()).toMatchObject({
      promotionEnabled: true,
      promotionMinStrength: 0,
      promotionMinEvidence: 10,
    });
  });

  it("requires skills to enable the explicit feedback ledger", async () => {
    process.env["AGENTMEMORY_SKILL_FEEDBACK"] = "true";
    let { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toMatchObject({
      enabled: false,
      feedbackEnabled: false,
    });

    process.env["AGENTMEMORY_SKILLS"] = "true";
    ({ loadSkillConfig } = await freshConfig());
    expect(loadSkillConfig()).toMatchObject({
      enabled: true,
      feedbackEnabled: true,
      recallEnabled: false,
      contextEnabled: false,
      promotionEnabled: false,
    });
  });

  it("keeps advisory recall opt-in and clamps its independent thresholds", async () => {
    process.env["AGENTMEMORY_SKILL_RECALL"] = "1";
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "0";
    process.env["AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"] = "2";
    let { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toMatchObject({
      enabled: false,
      recallEnabled: false,
      recallLimit: 1,
      recallMinConfidence: 1,
    });

    process.env["AGENTMEMORY_SKILLS"] = "true";
    process.env["AGENTMEMORY_SKILL_RECALL_LIMIT"] = "99";
    process.env["AGENTMEMORY_SKILL_RECALL_MIN_CONFIDENCE"] = "-1";
    ({ loadSkillConfig } = await freshConfig());

    expect(loadSkillConfig()).toMatchObject({
      recallEnabled: true,
      recallLimit: 10,
      recallMinConfidence: 0,
    });
  });

  it("requires skills and recall to enable advisory context and clamps its budget", async () => {
    process.env["AGENTMEMORY_SKILL_CONTEXT"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET"] = "1";
    let { loadSkillConfig } = await freshConfig();

    expect(loadSkillConfig()).toMatchObject({
      enabled: false,
      recallEnabled: false,
      contextEnabled: false,
      contextTokenBudget: 64,
    });

    process.env["AGENTMEMORY_SKILLS"] = "true";
    ({ loadSkillConfig } = await freshConfig());
    expect(loadSkillConfig()).toMatchObject({
      enabled: true,
      recallEnabled: false,
      contextEnabled: false,
    });

    process.env["AGENTMEMORY_SKILL_RECALL"] = "true";
    process.env["AGENTMEMORY_SKILL_CONTEXT_TOKEN_BUDGET"] = "9999";
    ({ loadSkillConfig } = await freshConfig());

    expect(loadSkillConfig()).toMatchObject({
      recallEnabled: true,
      contextEnabled: true,
      contextTokenBudget: 1000,
    });
  });
});
