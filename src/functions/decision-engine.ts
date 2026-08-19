import type { ISdk } from "iii-sdk";
import { loadDecisionConfig } from "../config.js";
import { stripPrivateData } from "./privacy.js";
import { KV, fingerprintId, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  ActiveDecisionMode,
  DecisionConfig,
  DecisionAction,
  DecisionAudit,
  DecisionCandidate,
  DecisionCandidateKind,
  DecisionCandidateQueue,
  DecisionEvidenceRef,
  DecisionInput,
  DecisionMode,
  DecisionObservationState,
  DecisionProvider,
  DecisionSourceFunction,
  HookType,
  MemoryDecision,
  MemoryProvider,
  ObservationType,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

interface NormalizedInput {
  input: DecisionInput;
  fallbackReason?: string;
}

interface DecideResponse {
  success: true;
  disabled: boolean;
  mode: DecisionMode;
  provider: DecisionProvider;
  decision: MemoryDecision | null;
  audited: boolean;
  candidateQueued: boolean;
  candidateQueueId?: string;
  auditId?: string;
  fallbackReason?: string;
}

const DECISION_ACTIONS = new Set<DecisionAction>([
  "ignore",
  "working_memory",
  "episodic_memory",
  "semantic_memory_candidate",
  "procedural_memory_candidate",
]);

const SOURCE_FUNCTIONS = new Set<DecisionSourceFunction>([
  "mem::observe",
  "mem::compress",
  "mem::remember",
  "mem::consolidate",
  "mem::consolidation-pipeline",
  "mem::context",
  "mem::search",
  "mem::smart-search",
]);

const HOOK_TYPES = new Set<HookType>([
  "session_start",
  "prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "post_tool_failure",
  "pre_compact",
  "subagent_start",
  "subagent_stop",
  "notification",
  "task_completed",
  "stop",
  "session_end",
]);

const OBSERVATION_TYPES = new Set<ObservationType>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

const OBSERVATION_STATES = new Set<DecisionObservationState>([
  "raw",
  "compressed",
  "unknown",
]);

const MEMORY_TYPES = new Set([
  "pattern",
  "preference",
  "architecture",
  "bug",
  "workflow",
  "fact",
]);

const SAFE_IGNORE_REASON_CODES = new Set([
  "secret_or_credential_like_content",
  "temporary_tool_noise",
  "fallback_secret_or_noise_ignore",
]);

const CANDIDATE_ACTION_TO_KIND = {
  semantic_memory_candidate: "semantic",
  procedural_memory_candidate: "procedural",
} as const satisfies Partial<Record<DecisionAction, DecisionCandidateQueue["kind"]>>;

const LLM_REASON_CODE_RE = /^[a-z][a-z0-9_:-]{0,79}$/;
const LLM_SYSTEM_PROMPT = [
  "You are the AgentMemory Decision Engine classifier.",
  "Return one JSON object only, with no markdown or surrounding prose.",
  "Choose exactly one supported memory action.",
  "Semantic and procedural actions are batch-consolidation candidates.",
  "Do not include secrets or private data in the response.",
].join(" ");

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim())
    : [];
}

function parseSourceFunction(value: unknown): DecisionSourceFunction | undefined {
  return typeof value === "string" && SOURCE_FUNCTIONS.has(value as DecisionSourceFunction)
    ? (value as DecisionSourceFunction)
    : undefined;
}

function parseHookType(value: unknown): HookType | undefined {
  return typeof value === "string" && HOOK_TYPES.has(value as HookType)
    ? (value as HookType)
    : undefined;
}

function parseObservationType(value: unknown): ObservationType | undefined {
  return typeof value === "string" && OBSERVATION_TYPES.has(value as ObservationType)
    ? (value as ObservationType)
    : undefined;
}

function parseObservationState(value: unknown): DecisionObservationState | undefined {
  return typeof value === "string" &&
    OBSERVATION_STATES.has(value as DecisionObservationState)
    ? (value as DecisionObservationState)
    : undefined;
}

function parseMemoryType(
  value: unknown,
): NonNullable<DecisionInput["memoryDraft"]>["type"] | undefined {
  return typeof value === "string" && MEMORY_TYPES.has(value)
    ? (value as NonNullable<DecisionInput["memoryDraft"]>["type"])
    : undefined;
}

function parseEvidenceRefs(value: unknown): DecisionEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const kind = stringValue(entry.kind);
    const id = stringValue(entry.id);
    if (!kind || !id) return [];
    if (
      kind !== "observation" &&
      kind !== "memory" &&
      kind !== "summary" &&
      kind !== "semantic" &&
      kind !== "procedural" &&
      kind !== "lesson" &&
      kind !== "graph"
    ) {
      return [];
    }
    const ref: DecisionEvidenceRef = { kind, id };
    const sessionId = stringValue(entry.sessionId);
    if (sessionId) ref.sessionId = sessionId;
    return [ref];
  });
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!isRecord(item)) return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    const result: UnknownRecord = {};
    for (const key of Object.keys(item).sort()) {
      result[key] = normalize(item[key]);
    }
    return result;
  };

  try {
    return JSON.stringify(normalize(value));
  } catch {
    return String(value);
  }
}

function collectSignalText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectSignalText);
  if (!isRecord(value)) return [];

  const keys = [
    "userPrompt",
    "prompt",
    "message",
    "toolOutput",
    "assistantResponse",
    "summary",
    "content",
    "text",
    "error",
    "sanitizedRaw",
  ];
  return keys.flatMap((key) => collectSignalText(value[key]));
}

function candidateKindForAction(
  action: DecisionAction,
): DecisionCandidateQueue["kind"] | undefined {
  return CANDIDATE_ACTION_TO_KIND[action as keyof typeof CANDIDATE_ACTION_TO_KIND];
}

function candidateQueueContent(
  input: DecisionInput,
): string | undefined {
  const parts = Array.from(new Set([
    input.memoryDraft?.content,
    input.compressedSignals?.narrative,
    ...(input.compressedSignals?.facts ?? []),
    ...collectSignalText(input.rawSignals),
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0)));
  if (parts.length === 0) return undefined;
  const content = parts.join("\n").trim();
  if (!content) return undefined;
  return content;
}

function candidateExpiresAt(now: string, ttlDays: number | undefined): string | undefined {
  if (ttlDays === undefined) return undefined;
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeDecisionInput(
  data: unknown,
  mode: ActiveDecisionMode,
  now: string,
): NormalizedInput {
  const source = isRecord(data) ? data : {};
  const missing: string[] = [];
  if (!isRecord(data)) missing.push("object payload");

  const sourceFunction = parseSourceFunction(source.sourceFunction);
  if (!sourceFunction) missing.push("sourceFunction");

  const insertionPoint = stringValue(source.insertionPoint);
  if (!insertionPoint) missing.push("insertionPoint");

  const input: DecisionInput = {
    id: stringValue(source.id) ?? generateId("di"),
    inputHash: stringValue(source.inputHash) ?? fingerprintId("din", stableStringify(source)),
    mode,
    sourceFunction: sourceFunction ?? "mem::observe",
    insertionPoint: insertionPoint ?? "mem::decide",
    timestamp: stringValue(source.timestamp) ?? now,
    evidenceRefs: parseEvidenceRefs(source.evidenceRefs),
    constraints: {
      preserveDefaultBehavior: true,
      mayWriteExistingKvShape: false,
      mayChangeHookPayload: false,
      mayChangeSearchRanking: false,
    },
  };

  const project = stringValue(source.project);
  const sessionId = stringValue(source.sessionId);
  const cwd = stringValue(source.cwd);
  const agentId = stringValue(source.agentId);
  const observationId = stringValue(source.observationId);
  const observationState = parseObservationState(source.observationState);
  const hookType = parseHookType(source.hookType);
  const toolName = stringValue(source.toolName);

  if (project) input.project = project;
  if (sessionId) input.sessionId = sessionId;
  if (cwd) input.cwd = cwd;
  if (agentId) input.agentId = agentId;
  if (observationId) input.observationId = observationId;
  if (observationState) input.observationState = observationState;
  if (hookType) input.hookType = hookType;
  if (toolName) input.toolName = toolName;
  if (isRecord(source.rawSignals)) input.rawSignals = source.rawSignals;

  if (isRecord(source.compressedSignals)) {
    input.compressedSignals = {
      type: parseObservationType(source.compressedSignals.type),
      title: stringValue(source.compressedSignals.title),
      facts: stringArray(source.compressedSignals.facts),
      narrative: stringValue(source.compressedSignals.narrative),
      concepts: stringArray(source.compressedSignals.concepts),
      files: stringArray(source.compressedSignals.files),
      importance: numberValue(source.compressedSignals.importance),
      confidence: numberValue(source.compressedSignals.confidence),
    };
  }

  if (isRecord(source.memoryDraft)) {
    input.memoryDraft = {
      type: parseMemoryType(source.memoryDraft.type),
      title: stringValue(source.memoryDraft.title),
      content: stringValue(source.memoryDraft.content),
      concepts: stringArray(source.memoryDraft.concepts),
      files: stringArray(source.memoryDraft.files),
      project: stringValue(source.memoryDraft.project),
      agentId: stringValue(source.memoryDraft.agentId),
    };
  }

  if (isRecord(source.retrievalSignals)) {
    input.retrievalSignals = {
      query: stringValue(source.retrievalSignals.query),
      resultIds: stringArray(source.retrievalSignals.resultIds),
      resultCount: numberValue(source.retrievalSignals.resultCount),
    };
  }

  if (isRecord(source.contextSignals)) {
    input.contextSignals = {
      blockCount: numberValue(source.contextSignals.blockCount),
      tokenBudget: numberValue(source.contextSignals.tokenBudget),
      sourceKinds: stringArray(source.contextSignals.sourceKinds),
    };
  }

  return {
    input,
    fallbackReason: missing.length > 0 ? `invalid DecisionInput: missing ${missing.join(", ")}` : undefined,
  };
}

function textParts(input: DecisionInput): string[] {
  const parts = [
    input.sourceFunction,
    input.insertionPoint,
    input.project,
    input.sessionId,
    input.cwd,
    input.hookType,
    input.toolName,
    input.observationState,
  ];

  if (input.rawSignals) parts.push(stableStringify(input.rawSignals));
  if (input.compressedSignals) {
    const c = input.compressedSignals;
    parts.push(
      c.type,
      c.title,
      c.narrative,
      ...(c.facts ?? []),
      ...(c.concepts ?? []),
      ...(c.files ?? []),
      c.importance?.toString(),
      c.confidence?.toString(),
    );
  }
  if (input.memoryDraft) {
    const m = input.memoryDraft;
    parts.push(
      m.type,
      m.title,
      m.content,
      m.project,
      ...(m.concepts ?? []),
      ...(m.files ?? []),
    );
  }
  if (input.retrievalSignals) {
    parts.push(
      input.retrievalSignals.query,
      input.retrievalSignals.resultCount?.toString(),
      ...(input.retrievalSignals.resultIds ?? []),
    );
  }
  if (input.contextSignals) {
    parts.push(
      input.contextSignals.blockCount?.toString(),
      input.contextSignals.tokenBudget?.toString(),
      ...(input.contextSignals.sourceKinds ?? []),
    );
  }

  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function decisionText(input: DecisionInput): string {
  return textParts(input).join("\n").toLowerCase();
}

function hasFileSignal(input: DecisionInput, text: string): boolean {
  return Boolean(
    input.compressedSignals?.files?.length ||
      input.memoryDraft?.files?.length ||
      /(?:^|[\s"'`(])(?:\.\/|\/|[a-z]:\\|src[\\/]|test[\\/]|lib[\\/]|app[\\/])[\w./\\-]+\.[a-z0-9]+/i.test(text),
  );
}

function hasConceptSignal(input: DecisionInput): boolean {
  return Boolean(
    input.compressedSignals?.concepts?.length ||
      input.memoryDraft?.concepts?.length ||
      input.contextSignals?.sourceKinds?.length,
  );
}

function hasFacts(input: DecisionInput): boolean {
  return Boolean(input.compressedSignals?.facts?.length);
}

function isSecretHeavy(input: DecisionInput, text: string): boolean {
  const redactions = text.match(/\bredacted\b|redacted_secret|<redacted>|\[redacted\]|\*\*\*/gi)?.length ?? 0;
  return (
    redactions >= 2 ||
    /\b(?:bearer\s+[a-z0-9._-]{16,}|sk-[a-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*[a-z0-9._-]{12,}|password\s*[:=]\s*\S{8,}|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})\b/i.test(text) ||
    /-----begin (?:rsa |openssh |ec |dsa )?private key-----/i.test(text) ||
    (input.rawSignals?.redacted === true || input.rawSignals?.sanitized === true)
  );
}

function isObviousNoise(input: DecisionInput, text: string): boolean {
  const hasSubstance =
    hasFileSignal(input, text) ||
    hasConceptSignal(input) ||
    hasFacts(input) ||
    (input.memoryDraft?.content?.length ?? 0) > 80 ||
    (input.compressedSignals?.narrative?.length ?? 0) > 120;

  if (hasSubstance) return false;
  if (input.hookType === "notification") return true;
  return /(?:no output|empty output|command completed|completed successfully|fetching|loading|spinner|progress notification|in progress|^\s*(?:ok|done|success)\s*$)/i.test(text);
}

function hasFailureSignal(text: string, input: DecisionInput): boolean {
  return Boolean(
    input.compressedSignals?.type === "error" ||
      input.hookType === "post_tool_failure" ||
      /\b(?:error|failed|failure|exception|traceback|exit code [1-9]|stderr|stack trace)\b/i.test(text),
  );
}

function hasDiagnosticDetail(text: string, input: DecisionInput): boolean {
  return Boolean(
    hasFileSignal(input, text) ||
      /\b(?:syntaxerror|typeerror|referenceerror|enoent|eacces|constraint|module not found|npm err|line \d+|at [\w$.<>]+\s*\()/i.test(text),
  );
}

function hasProcedureSignal(text: string): boolean {
  return /\b(?:procedure|workflow|steps?|run .+ then .+|worked after|to release|first .+ then|1\. .+2\.|step 1)\b/i.test(text);
}

function makeCandidate(
  input: DecisionInput,
  now: string,
  action: DecisionAction,
  confidence: number,
  importance: number,
  ttlDays: number | undefined,
  reasonCodes: string[],
  explanation: string,
): DecisionCandidate {
  return {
    id: generateId("dc"),
    inputId: input.id,
    action,
    source: "heuristic",
    reasonCodes,
    explanation,
    confidence,
    importance,
    ttlDays,
    tags: reasonCodes,
    concepts: [
      ...(input.compressedSignals?.concepts ?? []),
      ...(input.memoryDraft?.concepts ?? []),
    ],
    files: [
      ...(input.compressedSignals?.files ?? []),
      ...(input.memoryDraft?.files ?? []),
    ],
    evidenceRefs: input.evidenceRefs,
    proposedQueue:
      action === "semantic_memory_candidate"
        ? "semantic"
        : action === "procedural_memory_candidate"
          ? "procedural"
          : undefined,
    createdAt: now,
  };
}

function heuristicCandidates(input: DecisionInput, now: string): DecisionCandidate[] {
  const text = decisionText(input);
  const candidates: DecisionCandidate[] = [];
  const fileSignal = hasFileSignal(input, text);
  const conceptSignal = hasConceptSignal(input);
  const failureSignal = hasFailureSignal(text, input);
  const diagnosticDetail = hasDiagnosticDetail(text, input);
  const procedureSignal = hasProcedureSignal(text);

  if (isSecretHeavy(input, text)) {
    candidates.push(makeCandidate(
      input,
      now,
      "ignore",
      0.85,
      1,
      0,
      ["secret_or_credential_like_content"],
      "Credential-like or heavily redacted content should not be promoted.",
    ));
  }

  if (isObviousNoise(input, text)) {
    candidates.push(makeCandidate(
      input,
      now,
      "ignore",
      0.75,
      1,
      1,
      ["temporary_tool_noise"],
      "The signal looks like transient tool or progress noise.",
    ));
  }

  if (failureSignal && diagnosticDetail) {
    candidates.push(makeCandidate(
      input,
      now,
      "episodic_memory",
      0.72,
      7,
      90,
      ["failed_attempt_with_useful_error"],
      "Failure evidence includes diagnostic detail worth retaining as an episode.",
    ));
  } else if (failureSignal) {
    candidates.push(makeCandidate(
      input,
      now,
      "working_memory",
      0.55,
      3,
      3,
      ["failed_command_without_learning"],
      "The failure is useful short-term but lacks durable diagnostic detail.",
    ));
  }

  if (/\b(?:bug|fix(?:ed|es)?|regression|root cause|resolved|patched)\b/i.test(text) && (fileSignal || /\btests?\b/i.test(text))) {
    candidates.push(makeCandidate(
      input,
      now,
      "episodic_memory",
      0.78,
      8,
      180,
      ["bug_and_fix_evidence"],
      "Bug, fix, or regression evidence is tied to files or tests.",
    ));
  }

  if (/\b(?:remember|save|note|keep this)\b/i.test(text) && input.hookType === "prompt_submit") {
    candidates.push(makeCandidate(
      input,
      now,
      "episodic_memory",
      0.82,
      8,
      365,
      ["raw_prompt_asks_to_remember"],
      "The user explicitly asked to remember or save the information.",
    ));
  }

  if (/\b(?:prefer|always|never|do not|don't|must|should)\b/i.test(text) && (input.hookType === "prompt_submit" || input.memoryDraft?.content)) {
    candidates.push(makeCandidate(
      input,
      now,
      "semantic_memory_candidate",
      0.8,
      8,
      365,
      ["user_preference"],
      "The evidence appears to describe a stable user preference or policy.",
    ));
  }

  if (/\b(?:architecture|module|component|lifecycle|pipeline|schema|storage|kv|state|mcp|rest|hook|embedding|retrieval|graph|index)\b/i.test(text) && (fileSignal || conceptSignal || input.project)) {
    candidates.push(makeCandidate(
      input,
      now,
      "semantic_memory_candidate",
      0.72,
      8,
      365,
      ["architecture_fact"],
      "The evidence describes stable architecture or system structure.",
    ));
  }

  if (/\b(?:decided|decision|chose|accepted|rejected|tradeoff|keep|preserve)\b/i.test(text) && (fileSignal || conceptSignal || input.project)) {
    candidates.push(makeCandidate(
      input,
      now,
      "semantic_memory_candidate",
      0.76,
      8,
      365,
      ["project_decision"],
      "The evidence records a project decision or tradeoff.",
    ));
  }

  if (/\b(?:repeated|repeat|across sessions|same workflow|every time|routine)\b/i.test(text)) {
    candidates.push(makeCandidate(
      input,
      now,
      "procedural_memory_candidate",
      0.7,
      7,
      365,
      ["repeated_workflow_signal"],
      "The evidence points to a repeated workflow that should be batch consolidated.",
    ));
  }

  if (procedureSignal) {
    candidates.push(makeCandidate(
      input,
      now,
      "procedural_memory_candidate",
      0.74,
      8,
      365,
      ["successful_procedure"],
      "The evidence contains an ordered procedure or successful workflow.",
    ));
  }

  if (
    input.hookType === "stop" ||
    input.hookType === "session_end" ||
    input.hookType === "task_completed" ||
    /\b(?:session milestone|task completed|key decisions?|summary)\b/i.test(text)
  ) {
    candidates.push(makeCandidate(
      input,
      now,
      "episodic_memory",
      0.65,
      6,
      120,
      ["session_milestone"],
      "The evidence marks a session milestone or completed task.",
    ));
  }

  if (fileSignal) {
    candidates.push(makeCandidate(
      input,
      now,
      "working_memory",
      0.7,
      5,
      7,
      ["file_specific_short_term_context"],
      "File-specific context is useful near-term without durable promotion.",
    ));
  }

  if (
    input.compressedSignals?.type === "file_read" ||
    input.compressedSignals?.type === "search" ||
    /\b(?:rg|grep|find|search|list|read|cat|ls|get-content)\b/i.test(input.toolName ?? "")
  ) {
    candidates.push(makeCandidate(
      input,
      now,
      "working_memory",
      0.62,
      4,
      3,
      ["search_or_read_only_context"],
      "Read-only or search context should stay short-lived unless stronger signals appear.",
    ));
  }

  if (
    input.observationState === "compressed" &&
    (input.compressedSignals?.confidence ?? 1) <= 0.35 &&
    !hasFacts(input) &&
    !fileSignal &&
    !conceptSignal
  ) {
    candidates.push(makeCandidate(
      input,
      now,
      "working_memory",
      0.58,
      3,
      3,
      ["low_confidence_synthetic_compression"],
      "Low-confidence compressed evidence should remain short-term.",
    ));
  }

  if (
    (input.compressedSignals?.importance ?? 0) >= 8 &&
    (hasFacts(input) || fileSignal || conceptSignal)
  ) {
    candidates.push(makeCandidate(
      input,
      now,
      "episodic_memory",
      0.68,
      8,
      180,
      ["high_importance_compressed_observation"],
      "High-importance compressed evidence is significant enough for episodic review.",
    ));
  }

  if (input.sourceFunction === "mem::consolidation-pipeline" && /\b(?:repeated fact|same fact|stable fact|summaries)\b/i.test(text)) {
    candidates.push(makeCandidate(
      input,
      now,
      "semantic_memory_candidate",
      0.82,
      8,
      365,
      ["consolidation_semantic_candidate"],
      "Batch evidence points to a stable semantic fact.",
    ));
  }

  if (input.sourceFunction === "mem::consolidation-pipeline" && procedureSignal) {
    candidates.push(makeCandidate(
      input,
      now,
      "procedural_memory_candidate",
      0.82,
      8,
      365,
      ["consolidation_procedural_candidate"],
      "Batch evidence points to a stable procedure.",
    ));
  }

  if (candidates.length === 0) {
    candidates.push(makeCandidate(
      input,
      now,
      "working_memory",
      0.5,
      3,
      7,
      ["ambiguous_evidence_default"],
      "No durable-memory rule matched, so preserve the signal as working memory.",
    ));
  }

  return candidates;
}

function tiePriority(candidate: DecisionCandidate): number {
  if (
    candidate.action === "ignore" &&
    candidate.reasonCodes.some((code) => SAFE_IGNORE_REASON_CODES.has(code))
  ) {
    return 100;
  }
  if (
    candidate.action === "semantic_memory_candidate" ||
    candidate.action === "procedural_memory_candidate"
  ) {
    return 90;
  }
  if (candidate.action === "working_memory") return 80;
  if (candidate.action === "episodic_memory") return 70;
  return 10;
}

function selectCandidate(candidates: DecisionCandidate[]): DecisionCandidate {
  return [...candidates].sort((a, b) => {
    const confidenceDiff = b.confidence - a.confidence;
    if (Math.abs(confidenceDiff) > 0.0001) return confidenceDiff;
    return tiePriority(b) - tiePriority(a);
  })[0];
}

function validateCandidate(candidate: DecisionCandidate): void {
  if (!DECISION_ACTIONS.has(candidate.action)) throw new Error("invalid action");
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error("invalid confidence");
  }
  if (!Number.isFinite(candidate.importance) || candidate.importance < 0 || candidate.importance > 10) {
    throw new Error("invalid importance");
  }
  if (candidate.ttlDays !== undefined && (!Number.isFinite(candidate.ttlDays) || candidate.ttlDays < 0)) {
    throw new Error("invalid ttlDays");
  }
  if (candidate.reasonCodes.length === 0) throw new Error("reasonCodes is required");
  if (!candidate.explanation.trim()) throw new Error("explanation is required");
  if (candidate.action === "semantic_memory_candidate" && candidate.proposedQueue !== "semantic") {
    throw new Error("semantic candidate requires semantic queue metadata");
  }
  if (candidate.action === "procedural_memory_candidate" && candidate.proposedQueue !== "procedural") {
    throw new Error("procedural candidate requires procedural queue metadata");
  }
}

function makeDecision(
  input: DecisionInput,
  candidates: DecisionCandidate[],
  selected: DecisionCandidate,
  auditEnabled: boolean,
  now: string,
): MemoryDecision {
  return {
    id: generateId("md"),
    inputId: input.id,
    mode: input.mode,
    action: selected.action,
    confidence: selected.confidence,
    importance: selected.importance,
    ttlDays: selected.ttlDays,
    reasonCodes: selected.reasonCodes,
    explanation: selected.explanation,
    candidates,
    selectedCandidateId: selected.id,
    appliesTo: {
      observationId: input.observationId,
      sessionId: input.sessionId,
      project: input.project,
      agentId: input.agentId,
    },
    effects: {
      persistAudit: auditEnabled,
      enqueueCandidate: false,
      alterExistingFlow: false,
      skipExistingWrite: false,
      alterIndexing: false,
    },
    createdAt: now,
  };
}

function validateDecision(decision: MemoryDecision): void {
  validateCandidate({
    id: decision.selectedCandidateId ?? decision.id,
    inputId: decision.inputId,
    action: decision.action,
    source: "heuristic",
    reasonCodes: decision.reasonCodes,
    explanation: decision.explanation,
    confidence: decision.confidence,
    importance: decision.importance,
    ttlDays: decision.ttlDays,
    tags: decision.reasonCodes,
    concepts: [],
    files: [],
    evidenceRefs: [],
    proposedQueue:
      decision.action === "semantic_memory_candidate"
        ? "semantic"
        : decision.action === "procedural_memory_candidate"
          ? "procedural"
          : undefined,
    createdAt: decision.createdAt,
  });
  if (decision.effects.alterIndexing !== false) throw new Error("alterIndexing must remain false");
  if (decision.reasonCodes.length === 0) throw new Error("reasonCodes is required");
}

function fallbackDecision(
  input: DecisionInput,
  auditEnabled: boolean,
  now: string,
  fallbackReason: string,
): MemoryDecision {
  const text = decisionText(input);
  const ignore = isSecretHeavy(input, text) || isObviousNoise(input, text);
  const candidate = makeCandidate(
    input,
    now,
    ignore ? "ignore" : "working_memory",
    ignore ? 0.85 : 0.5,
    ignore ? 1 : 3,
    ignore ? 0 : 3,
    [ignore ? "fallback_secret_or_noise_ignore" : "fallback_working_memory"],
    `Decision classifier fallback: ${fallbackReason}.`,
  );
  return makeDecision(input, [candidate], candidate, auditEnabled, now);
}

function outcomeForMode(mode: ActiveDecisionMode): DecisionAudit["outcome"] {
  if (mode === "shadow") return "observed";
  return "advised";
}

interface CandidateQueueWrite {
  queued: boolean;
  queueId?: string;
  error?: string;
}

async function persistDecisionCandidateQueue(
  kv: StateKV,
  input: DecisionInput,
  decision: MemoryDecision,
  config: DecisionConfig,
): Promise<CandidateQueueWrite> {
  if (!config.candidateQueueEnabled) return { queued: false };

  const kind = candidateKindForAction(decision.action);
  if (!kind) return { queued: false };

  const candidate = decision.candidates.find((c) => c.id === decision.selectedCandidateId);
  if (!candidate) return { queued: false, error: "selected_candidate_missing" };
  if (candidate.action !== decision.action) return { queued: false, error: "action_mismatch" };
  if (candidate.proposedQueue !== kind) return { queued: false, error: "queue_kind_mismatch" };
  if (candidate.confidence < config.candidateMinConfidence) return { queued: false };
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    return { queued: false, error: "invalid_confidence" };
  }
  if (!Number.isFinite(candidate.importance) || candidate.importance < 0 || candidate.importance > 10) {
    return { queued: false, error: "invalid_importance" };
  }
  if (
    candidate.ttlDays !== undefined &&
    (!Number.isFinite(candidate.ttlDays) || candidate.ttlDays < 0)
  ) {
    return { queued: false, error: "invalid_ttlDays" };
  }

  const content = candidateQueueContent(input);
  if (!content) return { queued: false, error: "invalid_content" };

  const row: DecisionCandidateQueue = {
    id: generateId("dq"),
    kind,
    status: "pending",
    decisionId: decision.id,
    candidateId: candidate.id,
    project: decision.appliesTo.project,
    sessionId: decision.appliesTo.sessionId,
    agentId: decision.appliesTo.agentId,
    content,
    concepts: candidate.concepts,
    files: candidate.files,
    confidence: candidate.confidence,
    importance: candidate.importance,
    ttlDays: candidate.ttlDays,
    evidenceRefs: candidate.evidenceRefs,
    createdAt: decision.createdAt,
    expiresAt: candidateExpiresAt(decision.createdAt, candidate.ttlDays),
  };

  try {
    await kv.set(KV.decisionCandidates, row.id, row);
    return { queued: true, queueId: row.id };
  } catch {
    return { queued: false, error: "queue_write_failed" };
  }
}

async function persistDecisionAudit(
  kv: StateKV,
  input: DecisionInput,
  decision: MemoryDecision,
  outcome: DecisionAudit["outcome"],
  fallbackReason?: string,
  candidateQueue?: CandidateQueueWrite,
  llmShadowCode?: LlmShadowObservation["auditCode"],
): Promise<DecisionAudit> {
  const audit: DecisionAudit = {
    id: generateId("da"),
    decisionId: decision.id,
    inputId: input.id,
    inputHash: input.inputHash,
    mode: input.mode,
    sourceFunction: input.sourceFunction,
    insertionPoint: input.insertionPoint,
    action: decision.action,
    project: decision.appliesTo.project,
    sessionId: decision.appliesTo.sessionId,
    agentId: decision.appliesTo.agentId,
    observationId: decision.appliesTo.observationId,
    memoryId: decision.appliesTo.memoryId,
    confidence: decision.confidence,
    importance: decision.importance,
    ttlDays: decision.ttlDays,
    reasonCodes: llmShadowCode
      ? [...decision.reasonCodes, llmShadowCode]
      : decision.reasonCodes,
    explanation: decision.explanation,
    evidenceRefs: input.evidenceRefs,
    outcome,
    fallbackReason,
    candidateQueued: candidateQueue?.queued ?? false,
    candidateQueueId: candidateQueue?.queueId,
    candidateQueueError: candidateQueue?.error,
    existingBehaviorPreserved: true,
    createdAt: decision.createdAt,
  };
  await kv.set(KV.decisionAudit, audit.id, audit);
  return audit;
}

function buildDecision(
  input: DecisionInput,
  auditEnabled: boolean,
  now: string,
): { decision: MemoryDecision; fallbackReason?: string } {
  try {
    const candidates = heuristicCandidates(input, now);
    for (const candidate of candidates) validateCandidate(candidate);
    const selected = selectCandidate(candidates);
    const decision = makeDecision(input, candidates, selected, auditEnabled, now);
    validateDecision(decision);
    return { decision };
  } catch (err) {
    const fallbackReason = err instanceof Error ? err.message : String(err);
    const decision = fallbackDecision(input, auditEnabled, now, fallbackReason);
    validateDecision(decision);
    return { decision, fallbackReason };
  }
}

interface LlmShadowObservation {
  candidate?: DecisionCandidate;
  auditCode?:
    | "llm_shadow_agreement"
    | "llm_shadow_disagreement"
    | "llm_shadow_invalid"
    | "llm_shadow_unavailable"
    | "llm_shadow_skipped_sensitive";
  fallbackReason?:
    | "llm_shadow_provider_error"
    | "llm_shadow_empty_response"
    | "llm_shadow_invalid_json"
    | "llm_shadow_invalid_schema"
    | "llm_shadow_sensitive_output";
}

interface LlmClassification {
  action: DecisionAction;
  confidence: number;
  importance: number;
  ttlDays?: number;
  reasonCodes: string[];
  explanation: string;
  concepts: string[];
  files: string[];
  privacy: {
    containsSensitiveData: boolean;
    redactionRequired: boolean;
  };
  candidate: {
    kind: DecisionCandidateKind;
    content: string;
  };
}

function sanitizedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = stripPrivateData(value).trim();
  return text ? text.slice(0, limit) : undefined;
}

function sanitizedTextArray(value: string[] | undefined, limit: number, itemLimit: number): string[] {
  return (value ?? [])
    .map((item) => sanitizedText(item, itemLimit))
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function llmPrompt(input: DecisionInput): string {
  const payload = {
    sourceFunction: input.sourceFunction,
    insertionPoint: input.insertionPoint,
    hookType: input.hookType,
    toolName: input.toolName,
    observationState: input.observationState,
    compressedSignals: input.compressedSignals && {
      type: input.compressedSignals.type,
      title: sanitizedText(input.compressedSignals.title, 200),
      facts: sanitizedTextArray(input.compressedSignals.facts, 5, 200),
      narrative: sanitizedText(input.compressedSignals.narrative, 700),
      concepts: sanitizedTextArray(input.compressedSignals.concepts, 10, 120),
      files: sanitizedTextArray(input.compressedSignals.files, 10, 160),
      importance: input.compressedSignals.importance,
      confidence: input.compressedSignals.confidence,
    },
    memoryDraft: input.memoryDraft && {
      type: input.memoryDraft.type,
      title: sanitizedText(input.memoryDraft.title, 200),
      content: sanitizedText(input.memoryDraft.content, 700),
      concepts: sanitizedTextArray(input.memoryDraft.concepts, 10, 120),
      files: sanitizedTextArray(input.memoryDraft.files, 10, 160),
    },
    rawSignals: {
      userPrompt: sanitizedText(input.rawSignals?.userPrompt, 700),
    },
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 6000) return serialized;

  return JSON.stringify({
    sourceFunction: input.sourceFunction,
    insertionPoint: input.insertionPoint,
    hookType: input.hookType,
    toolName: input.toolName,
    observationState: input.observationState,
    compressedSignals: input.compressedSignals && {
      type: input.compressedSignals.type,
      title: sanitizedText(input.compressedSignals.title, 80),
      facts: sanitizedTextArray(input.compressedSignals.facts, 2, 80),
      narrative: sanitizedText(input.compressedSignals.narrative, 200),
    },
    memoryDraft: input.memoryDraft && {
      type: input.memoryDraft.type,
      title: sanitizedText(input.memoryDraft.title, 80),
      content: sanitizedText(input.memoryDraft.content, 200),
    },
    rawSignals: {
      userPrompt: sanitizedText(input.rawSignals?.userPrompt, 200),
    },
  });
}

function hasExactKeys(value: UnknownRecord, allowed: string[], required: string[]): boolean {
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function boundedStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.map((item) => typeof item === "string" ? item.trim() : "");
  return items.every((item) => item.length > 0 && item.length <= 500) ? items : undefined;
}

function parseLlmClassification(response: string): LlmClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new Error("llm_shadow_invalid_json");
  }
  if (!isRecord(parsed) || !hasExactKeys(
    parsed,
    ["action", "confidence", "importance", "ttlDays", "reasonCodes", "explanation", "concepts", "files", "privacy", "candidate"],
    ["action", "confidence", "importance", "reasonCodes", "explanation", "concepts", "files", "privacy", "candidate"],
  )) throw new Error("llm_shadow_invalid_schema");

  const action = typeof parsed.action === "string" && DECISION_ACTIONS.has(parsed.action as DecisionAction)
    ? parsed.action as DecisionAction
    : undefined;
  const confidence = numberValue(parsed.confidence);
  const importance = numberValue(parsed.importance);
  const ttlDays = parsed.ttlDays === undefined ? undefined : numberValue(parsed.ttlDays);
  const reasonCodes = boundedStringArray(parsed.reasonCodes, 8);
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim() : "";
  const concepts = boundedStringArray(parsed.concepts, 20);
  const files = boundedStringArray(parsed.files, 20);
  const privacy = isRecord(parsed.privacy) && hasExactKeys(
    parsed.privacy,
    ["containsSensitiveData", "redactionRequired"],
    ["containsSensitiveData", "redactionRequired"],
  ) && typeof parsed.privacy.containsSensitiveData === "boolean" &&
    typeof parsed.privacy.redactionRequired === "boolean"
    ? parsed.privacy as LlmClassification["privacy"]
    : undefined;
  const candidate = isRecord(parsed.candidate) && hasExactKeys(parsed.candidate, ["kind", "content"], ["kind", "content"])
    && (parsed.candidate.kind === "semantic" || parsed.candidate.kind === "procedural" || parsed.candidate.kind === "none")
    && typeof parsed.candidate.content === "string" && parsed.candidate.content.length <= 2000
    ? parsed.candidate as LlmClassification["candidate"]
    : undefined;

  if (
    !action || confidence === undefined || confidence < 0 || confidence > 1 ||
    importance === undefined || importance < 0 || importance > 10 ||
    (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 0 || ttlDays > 3650)) ||
    !reasonCodes || reasonCodes.length === 0 || !reasonCodes.every((code) => LLM_REASON_CODE_RE.test(code)) ||
    explanation.length === 0 || explanation.length > 500 || !concepts || !files || !privacy || !candidate
  ) throw new Error("llm_shadow_invalid_schema");

  const requiresCandidate = action === "semantic_memory_candidate" || action === "procedural_memory_candidate";
  const expectedKind = action === "semantic_memory_candidate" ? "semantic" : action === "procedural_memory_candidate" ? "procedural" : "none";
  if (candidate.kind !== expectedKind || (requiresCandidate && candidate.content.trim().length === 0)) {
    throw new Error("llm_shadow_invalid_schema");
  }

  return { action, confidence, importance, ttlDays, reasonCodes, explanation, concepts, files, privacy, candidate };
}

function llmShadowAllowed(
  config: DecisionConfig,
  input: DecisionInput,
  selected: DecisionCandidate,
  provider: MemoryProvider | undefined,
): { allowed: boolean; sensitive: boolean } {
  const sensitive = isSecretHeavy(input, decisionText(input));
  return {
    allowed: config.mode === "shadow" &&
      (config.provider === "llm" || config.provider === "hybrid") &&
      Boolean(provider) &&
      selected.confidence < 0.85 &&
      (input.sourceFunction === "mem::remember" ||
        (input.sourceFunction === "mem::observe" && input.hookType === "prompt_submit")) &&
      !sensitive,
    sensitive,
  };
}

function llmCandidate(input: DecisionInput, classification: LlmClassification, now: string): DecisionCandidate {
  return {
    id: generateId("dc"),
    inputId: input.id,
    action: classification.action,
    source: "llm",
    reasonCodes: classification.reasonCodes,
    explanation: classification.explanation,
    confidence: classification.confidence,
    importance: classification.importance,
    ttlDays: classification.ttlDays,
    tags: classification.reasonCodes,
    concepts: classification.concepts,
    files: classification.files,
    evidenceRefs: input.evidenceRefs,
    proposedQueue: classification.candidate.kind === "none" ? undefined : classification.candidate.kind,
    createdAt: now,
  };
}

async function observeLlmShadow(
  config: DecisionConfig,
  input: DecisionInput,
  decision: MemoryDecision,
  provider: MemoryProvider | undefined,
  now: string,
): Promise<LlmShadowObservation> {
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selectedCandidateId);
  if (!selected) return { auditCode: "llm_shadow_unavailable" };
  const gate = llmShadowAllowed(config, input, selected, provider);
  if (gate.sensitive && config.mode === "shadow" && (config.provider === "llm" || config.provider === "hybrid")) {
    return { auditCode: "llm_shadow_skipped_sensitive" };
  }
  if (!gate.allowed) return {};

  let response: string;
  try {
    response = await provider!.summarize(LLM_SYSTEM_PROMPT, llmPrompt(input));
  } catch {
    return { auditCode: "llm_shadow_unavailable", fallbackReason: "llm_shadow_provider_error" };
  }
  if (!response.trim()) {
    return { auditCode: "llm_shadow_invalid", fallbackReason: "llm_shadow_empty_response" };
  }
  if (stripPrivateData(response) !== response) {
    return { auditCode: "llm_shadow_invalid", fallbackReason: "llm_shadow_sensitive_output" };
  }
  try {
    const classification = parseLlmClassification(response);
    if (classification.privacy.containsSensitiveData || classification.privacy.redactionRequired) {
      return { auditCode: "llm_shadow_invalid", fallbackReason: "llm_shadow_sensitive_output" };
    }
    const candidate = llmCandidate(input, classification, now);
    validateCandidate(candidate);
    return {
      candidate,
      auditCode: candidate.action === selected.action ? "llm_shadow_agreement" : "llm_shadow_disagreement",
    };
  } catch (error) {
    const fallbackReason = error instanceof Error && (
      error.message === "llm_shadow_invalid_json" || error.message === "llm_shadow_invalid_schema"
    ) ? error.message : "llm_shadow_invalid_schema";
    return { auditCode: "llm_shadow_invalid", fallbackReason };
  }
}

export function registerDecisionEngineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider?: MemoryProvider,
): void {
  sdk.registerFunction("mem::decide", async (data: unknown): Promise<DecideResponse> => {
    const config = loadDecisionConfig();

    if (config.mode === "disabled") {
      return {
        success: true,
        disabled: true,
        mode: config.mode,
        provider: config.provider,
        decision: null,
        audited: false,
        candidateQueued: false,
      };
    }

    const now = new Date().toISOString();
    const { input, fallbackReason: inputFallbackReason } = normalizeDecisionInput(
      data,
      config.mode,
      now,
    );
    const built = inputFallbackReason
      ? {
          decision: fallbackDecision(input, config.auditEnabled, now, inputFallbackReason),
          fallbackReason: inputFallbackReason,
        }
      : buildDecision(input, config.auditEnabled, now);

    const llmShadow = inputFallbackReason
      ? undefined
      : await observeLlmShadow(config, input, built.decision, provider, now);
    if (llmShadow?.candidate) {
      built.decision.candidates.push(llmShadow.candidate);
    }

    const candidateQueue = await persistDecisionCandidateQueue(
      kv,
      input,
      built.decision,
      config,
    );
    if (candidateQueue.queued) {
      built.decision.effects.enqueueCandidate = true;
    }

    const audit = config.auditEnabled
      ? await persistDecisionAudit(
          kv,
          input,
          built.decision,
          built.fallbackReason ? "fallback" : outcomeForMode(config.mode),
          built.fallbackReason ?? llmShadow?.fallbackReason,
          candidateQueue,
          llmShadow?.auditCode,
        )
      : undefined;

    return {
      success: true,
      disabled: false,
      mode: config.mode,
      provider: config.provider,
      decision: built.decision,
      audited: Boolean(audit),
      auditId: audit?.id,
      candidateQueued: candidateQueue.queued,
      candidateQueueId: candidateQueue.queueId,
      fallbackReason: built.fallbackReason ?? llmShadow?.fallbackReason,
    };
  });
}
