import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KV } from "../src/state/schema.js";
import type {
  DecisionAudit,
  DecisionCandidateQueue,
  DecisionInput,
  Memory,
  MemoryDecision,
} from "../src/types.js";

const ENV_KEYS = [
  "AGENTMEMORY_DECISION_MODE",
  "AGENTMEMORY_DECISION_PROVIDER",
  "AGENTMEMORY_DECISION_AUDIT",
  "AGENTMEMORY_DECISION_SHADOW_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_QUEUE",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE",
  "AGENTMEMORY_DECISION_CONSUME_CANDIDATES",
  "AGENTMEMORY_DECISION_CANDIDATE_BATCH_LIMIT",
  "AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE",
  "AGENTMEMORY_DECISION_ENFORCE_IGNORE",
  "AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE",
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

describe("Decision Engine PR1 config", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-decision-"));
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

  it("defaults to disabled mode with heuristic provider and no active audit or queue", async () => {
    writeEnv("");
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toEqual({
      mode: "disabled",
      provider: "heuristic",
      auditEnabled: false,
      shadowQueueEnabled: false,
      candidateQueueEnabled: false,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });
  });

  it("invalid mode and provider fall back safely", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "surprise";
    process.env["AGENTMEMORY_DECISION_PROVIDER"] = "remote-magic";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toEqual({
      mode: "disabled",
      provider: "heuristic",
      auditEnabled: false,
      shadowQueueEnabled: false,
      candidateQueueEnabled: false,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });
  });

  it("disabled mode keeps audit and shadow queue inactive even when flags are set", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "disabled";
    process.env["AGENTMEMORY_DECISION_AUDIT"] = "true";
    process.env["AGENTMEMORY_DECISION_SHADOW_QUEUE"] = "true";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toMatchObject({
      mode: "disabled",
      auditEnabled: false,
      shadowQueueEnabled: false,
      candidateQueueEnabled: false,
      enforceIgnoreEnabled: false,
    });
  });

  it("shadow mode enables audit by default but not candidate queues", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "shadow";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toEqual({
      mode: "shadow",
      provider: "heuristic",
      auditEnabled: true,
      shadowQueueEnabled: false,
      candidateQueueEnabled: false,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });
  });

  it("shadow candidate queue requires AGENTMEMORY_DECISION_SHADOW_QUEUE", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "shadow";
    process.env["AGENTMEMORY_DECISION_SHADOW_QUEUE"] = "1";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toMatchObject({
      mode: "shadow",
      shadowQueueEnabled: true,
      candidateQueueEnabled: true,
    });
  });

  it("advisory and enforce modes enable audit and candidate queue by default", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "advisory";
    process.env["AGENTMEMORY_DECISION_PROVIDER"] = "hybrid";
    process.env["AGENTMEMORY_DECISION_SHADOW_QUEUE"] = "true";
    let cfg = await freshConfig();

    expect(cfg.loadDecisionConfig()).toEqual({
      mode: "advisory",
      provider: "hybrid",
      auditEnabled: true,
      shadowQueueEnabled: false,
      candidateQueueEnabled: true,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });

    process.env["AGENTMEMORY_DECISION_MODE"] = "enforce";
    process.env["AGENTMEMORY_DECISION_PROVIDER"] = "llm";
    cfg = await freshConfig();

    expect(cfg.loadDecisionConfig()).toEqual({
      mode: "enforce",
      provider: "llm",
      auditEnabled: true,
      shadowQueueEnabled: false,
      candidateQueueEnabled: true,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });
  });

  it("AGENTMEMORY_DECISION_CANDIDATE_QUEUE=false disables queue writes in active modes", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "advisory";
    process.env["AGENTMEMORY_DECISION_CANDIDATE_QUEUE"] = "false";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toMatchObject({
      mode: "advisory",
      candidateQueueEnabled: false,
    });
  });

  it("clamps candidate queue min confidence to the safe range", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "advisory";
    process.env["AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE"] = "0.2";
    let { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig().candidateMinConfidence).toBe(0.5);

    process.env["AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE"] = "1.7";
    ({ loadDecisionConfig } = await freshConfig());
    expect(loadDecisionConfig().candidateMinConfidence).toBe(1);
  });

  it("defaults candidate consumption off with conservative batch settings", async () => {
    const {
      getDecisionCandidateBatchLimit,
      getDecisionCandidateMinEvidence,
      isDecisionCandidateConsumptionEnabled,
    } = await freshConfig();

    expect(isDecisionCandidateConsumptionEnabled()).toBe(false);
    expect(getDecisionCandidateBatchLimit()).toBe(50);
    expect(getDecisionCandidateMinEvidence()).toBe(2);
  });

  it("enables candidate consumption only for true-like values", async () => {
    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "1";
    let cfg = await freshConfig();
    expect(cfg.isDecisionCandidateConsumptionEnabled()).toBe(true);

    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "true";
    cfg = await freshConfig();
    expect(cfg.isDecisionCandidateConsumptionEnabled()).toBe(true);

    process.env["AGENTMEMORY_DECISION_CONSUME_CANDIDATES"] = "yes";
    cfg = await freshConfig();
    expect(cfg.isDecisionCandidateConsumptionEnabled()).toBe(false);
  });

  it("clamps candidate consumption batch limit and min evidence", async () => {
    process.env["AGENTMEMORY_DECISION_CANDIDATE_BATCH_LIMIT"] = "0";
    process.env["AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE"] = "0";
    let cfg = await freshConfig();
    expect(cfg.getDecisionCandidateBatchLimit()).toBe(1);
    expect(cfg.getDecisionCandidateMinEvidence()).toBe(1);

    process.env["AGENTMEMORY_DECISION_CANDIDATE_BATCH_LIMIT"] = "900";
    process.env["AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE"] = "20";
    cfg = await freshConfig();
    expect(cfg.getDecisionCandidateBatchLimit()).toBe(500);
    expect(cfg.getDecisionCandidateMinEvidence()).toBe(10);
  });

  it("enforce ignore requires an explicit flag and clamps confidence safely", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "enforce";
    process.env["AGENTMEMORY_DECISION_ENFORCE_IGNORE"] = "true";
    process.env["AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE"] = "0.2";
    let { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toMatchObject({
      mode: "enforce",
      enforceIgnoreEnabled: true,
      enforceIgnoreMinConfidence: 0.85,
    });

    process.env["AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE"] = "1.7";
    ({ loadDecisionConfig } = await freshConfig());
    expect(loadDecisionConfig().enforceIgnoreMinConfidence).toBe(1);
  });

  it("active modes allow audit to be explicitly disabled", async () => {
    process.env["AGENTMEMORY_DECISION_MODE"] = "shadow";
    process.env["AGENTMEMORY_DECISION_AUDIT"] = "false";
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toMatchObject({
      mode: "shadow",
      auditEnabled: false,
    });
  });

  it("reads decision config from ~/.agentmemory/.env", async () => {
    writeEnv(
      [
        "AGENTMEMORY_DECISION_MODE=shadow",
        "AGENTMEMORY_DECISION_PROVIDER=hybrid",
        "AGENTMEMORY_DECISION_SHADOW_QUEUE=true",
      ].join("\n"),
    );
    const { loadDecisionConfig } = await freshConfig();

    expect(loadDecisionConfig()).toEqual({
      mode: "shadow",
      provider: "hybrid",
      auditEnabled: true,
      shadowQueueEnabled: true,
      candidateQueueEnabled: true,
      candidateMinConfidence: 0.7,
      enforceIgnoreEnabled: false,
      enforceIgnoreMinConfidence: 0.85,
    });
  });
});

describe("Decision Engine PR1 types and KV scopes", () => {
  it("adds decision KV scopes without changing existing memory row shape", () => {
    expect(KV.decision).toBe("mem:decision");
    expect(KV.decisionAudit).toBe("mem:decision:audit");
    expect(KV.decisionCandidates).toBe("mem:decision:candidates");

    const legacyMemory: Memory = {
      id: "mem_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "fact",
      title: "Existing shape",
      content: "Existing Memory rows do not require decision fields.",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 1,
      version: 1,
      isLatest: true,
    };

    expect(legacyMemory).not.toHaveProperty("decisionId");
  });

  it("types active decision records without a disabled runtime mode", () => {
    const input: DecisionInput = {
      id: "di_1",
      inputHash: "hash",
      mode: "shadow",
      sourceFunction: "mem::observe",
      insertionPoint: "after_sanitization_before_kv_write",
      timestamp: "2026-01-01T00:00:00.000Z",
      evidenceRefs: [],
      constraints: {
        preserveDefaultBehavior: true,
        mayWriteExistingKvShape: false,
        mayChangeHookPayload: false,
        mayChangeSearchRanking: false,
      },
    };

    const decision: MemoryDecision = {
      id: "md_1",
      inputId: input.id,
      mode: input.mode,
      action: "working_memory",
      confidence: 0.7,
      importance: 5,
      reasonCodes: ["file_specific_short_term_context"],
      explanation: "Keep ambiguous evidence as working memory.",
      candidates: [],
      appliesTo: {},
      effects: {
        persistAudit: true,
        enqueueCandidate: false,
        alterExistingFlow: false,
        skipExistingWrite: false,
        alterIndexing: false,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const audit: DecisionAudit = {
      id: "da_1",
      decisionId: decision.id,
      inputId: input.id,
      inputHash: input.inputHash,
      mode: decision.mode,
      sourceFunction: input.sourceFunction,
      insertionPoint: input.insertionPoint,
      action: decision.action,
      confidence: decision.confidence,
      importance: decision.importance,
      reasonCodes: decision.reasonCodes,
      explanation: decision.explanation,
      evidenceRefs: [],
      outcome: "observed",
      existingBehaviorPreserved: true,
      createdAt: decision.createdAt,
    };

    const queued: DecisionCandidateQueue = {
      id: "dq_1",
      kind: "semantic",
      status: "pending",
      decisionId: decision.id,
      candidateId: "dc_1",
      content: "Candidate rows are additive.",
      concepts: [],
      files: [],
      confidence: 0.8,
      importance: 7,
      evidenceRefs: [],
      createdAt: decision.createdAt,
    };

    expect(audit.mode).toBe("shadow");
    expect(queued.kind).toBe("semantic");
  });
});
