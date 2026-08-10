export interface Session {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "completed" | "abandoned";
  observationCount: number;
  model?: string;
  tags?: string[];
  firstPrompt?: string;
  summary?: string;
  commitShas?: string[];
  agentId?: string;
}

export interface CommitLink {
  sha: string;
  shortSha: string;
  branch?: string;
  repo?: string;
  message?: string;
  author?: string;
  authoredAt?: string;
  files?: string[];
  sessionIds: string[];
  linkedAt: string;
}

export interface RawObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  hookType: HookType;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  assistantResponse?: string;
  raw: unknown;
  modality?: "text" | "image" | "mixed";
  imageData?: string;
  agentId?: string;
}

export interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  confidence?: number;
  imageRef?: string;
  imageData?: string;
  imageDescription?: string;
  modality?: "text" | "image" | "mixed";
  agentId?: string;
}

export type ObservationType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "command_run"
  | "search"
  | "web_fetch"
  | "conversation"
  | "error"
  | "decision"
  | "discovery"
  | "subagent"
  | "notification"
  | "task"
  | "image"
  | "other";

export interface Memory {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
  title: string;
  content: string;
  concepts: string[];
  files: string[];
  sessionIds: string[];
  strength: number;
  version: number;
  parentId?: string;
  supersedes?: string[];
  relatedIds?: string[];
  sourceObservationIds?: string[];
  isLatest: boolean;
  forgetAfter?: string;
  imageRef?: string;
  imageData?: string;
  agentId?: string;
  project?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  createdAt: string;
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  observationCount: number;
}

export type HookType =
  | "session_start"
  | "prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_failure"
  | "pre_compact"
  | "subagent_start"
  | "subagent_stop"
  | "notification"
  | "task_completed"
  | "stop"
  | "session_end";

export interface HookPayload {
  hookType: HookType;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
}

export interface ProviderConfig {
  provider: ProviderType;
  model: string;
  maxTokens: number;
  /** Optional base URL override (e.g. for Anthropic-compatible APIs or local proxies) */
  baseURL?: string;
}

export type ProviderType = "agent-sdk" | "anthropic" | "gemini" | "openrouter" | "minimax" | "openai" | "noop";

export interface MemoryProvider {
  name: string;
  compress(systemPrompt: string, userPrompt: string): Promise<string>;
  summarize(systemPrompt: string, userPrompt: string): Promise<string>;
  describeImage?(imageData: string, mimeType: string, prompt: string): Promise<string>;
}

export interface AgentMemoryConfig {
  engineUrl: string;
  restPort: number;
  streamsPort: number;
  provider: ProviderConfig;
  tokenBudget: number;
  maxObservationsPerSession: number;
  compressionModel: string;
  dataDir: string;
}

export type DecisionMode = "disabled" | "shadow" | "advisory" | "enforce";

export type ActiveDecisionMode = Exclude<DecisionMode, "disabled">;

export type DecisionProvider = "heuristic" | "llm" | "hybrid";

export type DecisionAction =
  | "ignore"
  | "working_memory"
  | "episodic_memory"
  | "semantic_memory_candidate"
  | "procedural_memory_candidate";

export type DecisionCandidateKind = "semantic" | "procedural" | "none";

export type DecisionSourceFunction =
  | "mem::observe"
  | "mem::compress"
  | "mem::remember"
  | "mem::consolidate"
  | "mem::consolidation-pipeline"
  | "mem::context"
  | "mem::search"
  | "mem::smart-search";

export type DecisionObservationState = "raw" | "compressed" | "unknown";

export interface DecisionEvidenceRef {
  kind:
    | "observation"
    | "memory"
    | "summary"
    | "semantic"
    | "procedural"
    | "lesson"
    | "graph";
  id: string;
  sessionId?: string;
}

export interface DecisionInput {
  id: string;
  inputHash: string;
  mode: ActiveDecisionMode;
  sourceFunction: DecisionSourceFunction;
  insertionPoint: string;
  timestamp: string;
  project?: string;
  sessionId?: string;
  cwd?: string;
  agentId?: string;
  observationId?: string;
  observationState?: DecisionObservationState;
  hookType?: HookType;
  toolName?: string;
  rawSignals?: Record<string, unknown>;
  compressedSignals?: {
    type?: ObservationType;
    title?: string;
    facts?: string[];
    narrative?: string;
    concepts?: string[];
    files?: string[];
    importance?: number;
    confidence?: number;
  };
  memoryDraft?: {
    type?: Memory["type"];
    title?: string;
    content?: string;
    concepts?: string[];
    files?: string[];
    project?: string;
    agentId?: string;
  };
  retrievalSignals?: {
    query?: string;
    resultIds?: string[];
    resultCount?: number;
  };
  contextSignals?: {
    blockCount?: number;
    tokenBudget?: number;
    sourceKinds?: string[];
  };
  evidenceRefs: DecisionEvidenceRef[];
  constraints: {
    preserveDefaultBehavior: boolean;
    mayWriteExistingKvShape: false;
    mayChangeHookPayload: false;
    mayChangeSearchRanking: false;
  };
}

export interface DecisionCandidate {
  id: string;
  inputId: string;
  action: DecisionAction;
  source: "heuristic" | "llm" | "merged";
  reasonCodes: string[];
  explanation: string;
  confidence: number;
  importance: number;
  ttlDays?: number;
  tags: string[];
  concepts: string[];
  files: string[];
  evidenceRefs: DecisionEvidenceRef[];
  proposedQueue?: Exclude<DecisionCandidateKind, "none">;
  createdAt: string;
}

export interface MemoryDecision {
  id: string;
  inputId: string;
  mode: ActiveDecisionMode;
  action: DecisionAction;
  confidence: number;
  importance: number;
  ttlDays?: number;
  reasonCodes: string[];
  explanation: string;
  candidates: DecisionCandidate[];
  selectedCandidateId?: string;
  appliesTo: {
    observationId?: string;
    memoryId?: string;
    sessionId?: string;
    project?: string;
    agentId?: string;
  };
  effects: {
    persistAudit: boolean;
    enqueueCandidate: boolean;
    alterExistingFlow: boolean;
    skipExistingWrite: boolean;
    alterIndexing: false;
  };
  createdAt: string;
}

export interface DecisionAudit {
  id: string;
  decisionId: string;
  inputId: string;
  inputHash: string;
  mode: ActiveDecisionMode;
  sourceFunction: DecisionSourceFunction;
  insertionPoint: string;
  action: DecisionAction;
  project?: string;
  sessionId?: string;
  agentId?: string;
  observationId?: string;
  memoryId?: string;
  confidence: number;
  importance: number;
  ttlDays?: number;
  reasonCodes: string[];
  explanation: string;
  evidenceRefs: DecisionEvidenceRef[];
  outcome: "observed" | "advised" | "enforced" | "fallback";
  fallbackReason?: string;
  candidateQueued?: boolean;
  candidateQueueId?: string;
  candidateQueueError?: string;
  existingBehaviorPreserved: boolean;
  createdAt: string;
}

export interface DecisionCandidateQueue {
  id: string;
  kind: Exclude<DecisionCandidateKind, "none">;
  status: "pending" | "consumed" | "rejected" | "expired";
  decisionId: string;
  candidateId: string;
  project?: string;
  sessionId?: string;
  agentId?: string;
  content: string;
  concepts: string[];
  files: string[];
  confidence: number;
  importance: number;
  ttlDays?: number;
  evidenceRefs: DecisionEvidenceRef[];
  createdAt: string;
  expiresAt?: string;
  consumedAt?: string;
  consumedBy?: "mem::consolidation-pipeline";
}

export interface DecisionConfig {
  mode: DecisionMode;
  provider: DecisionProvider;
  auditEnabled: boolean;
  shadowQueueEnabled: boolean;
  candidateQueueEnabled: boolean;
  candidateMinConfidence: number;
  enforceIgnoreEnabled: boolean;
  enforceIgnoreMinConfidence: number;
}

export interface SkillConfig {
  enabled: boolean;
  feedbackEnabled: boolean;
  feedbackDiagnosticsEnabled: boolean;
  feedbackDiagnosticsLimit: number;
  feedbackReducerEnabled: boolean;
  lifecycleReviewEnabled: boolean;
  diagnosticsEnabled: boolean;
  diagnosticsLimit: number;
  recallEnabled: boolean;
  recallLimit: number;
  recallMinConfidence: number;
  contextEnabled: boolean;
  contextTokenBudget: number;
  promotionEnabled: boolean;
  promotionMinStrength: number;
  promotionMinEvidence: number;
}

export interface SkillRecallInput {
  project?: string;
  agentId?: string;
  query?: string;
  files?: string[];
  concepts?: string[];
  limit?: number;
}

export interface SkillAdvisory {
  source: "skill-advisory";
  skillId: string;
  name: string;
  triggerCondition: string;
  steps: string[];
  expectedOutcome: string;
  antiPatterns: string[];
  project?: string;
  agentId?: string;
  files: string[];
  concepts: string[];
  confidence: number;
  strength: number;
  score: number;
  sourceProceduralMemoryIds: string[];
}

export interface SkillRecallResult {
  success: boolean;
  enabled: boolean;
  scannedCount: number;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  privacySuppressedCount: number;
  advisories: SkillAdvisory[];
}

export type SkillRecallInputParseResult =
  | { success: true; input: SkillRecallInput }
  | { success: false; error: string };

export interface SkillRecallExplainInput {
  skillId?: unknown;
  project?: unknown;
  agentId?: unknown;
  query?: unknown;
  files?: unknown;
  concepts?: unknown;
  limit?: unknown;
}

export type SkillRecallExplanationState =
  | "malformed"
  | "privacy_suppressed"
  | "excluded"
  | "matched_not_returned"
  | "selected";

export type SkillRecallExplanationReasonCode =
  | "malformed_skill"
  | "inactive"
  | "below_min_confidence"
  | "project_scope_mismatch"
  | "agent_scope_mismatch"
  | "privacy_suppressed"
  | "no_context_match"
  | "outside_limit"
  | "selected";

export interface SkillRecallScoreBreakdown {
  projectScopeScore: number;
  agentScopeScore: number;
  conceptMatchCount: number;
  conceptScore: number;
  fileMatchCount: number;
  fileScore: number;
  queryTokenMatchCount: number;
  queryScore: number;
  totalScore: number;
}

export interface SkillRecallExplainResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  skillId?: string;
  state?: SkillRecallExplanationState;
  reasonCodes: SkillRecallExplanationReasonCode[];
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  privacySuppressedCount: number;
  matchedCount: number;
  effectiveLimit: number;
  selected: boolean;
  rank?: number;
  scoreBreakdown?: SkillRecallScoreBreakdown;
  advisory?: SkillAdvisory;
}

export type SkillRecallDiagnosticsState =
  | "malformed"
  | "excluded"
  | "matched_not_returned"
  | "selected";

export type SkillRecallDiagnosticsReasonCode = Exclude<
  SkillRecallExplanationReasonCode,
  "privacy_suppressed"
>;

export interface SkillRecallDiagnosticsInput {
  project?: unknown;
  agentId?: unknown;
  query?: unknown;
  files?: unknown;
  concepts?: unknown;
  limit?: unknown;
  state?: unknown;
  reasonCode?: unknown;
  itemLimit?: unknown;
}

export interface SkillRecallDiagnosticsItem {
  skillId: string;
  state: SkillRecallDiagnosticsState;
  reasonCodes: SkillRecallDiagnosticsReasonCode[];
  selected: boolean;
  rank?: number;
  scoreBreakdown?: SkillRecallScoreBreakdown;
}

export interface SkillRecallDiagnosticsSummary {
  stateCounts: Record<SkillRecallDiagnosticsState, number>;
  reasonCounts: Partial<Record<SkillRecallDiagnosticsReasonCode, number>>;
}

export interface SkillRecallDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  privacySuppressedCount: number;
  privateProtectedCount: number;
  anonymousMalformedCount: number;
  matchedCount: number;
  recallReturnedCount: number;
  effectiveLimit: number;
  recallTruncated: boolean;
  duplicateSkillIdCount: number;
  diagnosticMatchedCount: number;
  diagnosticReturnedCount: number;
  diagnosticTruncated: boolean;
  summary: SkillRecallDiagnosticsSummary;
  items: SkillRecallDiagnosticsItem[];
}

export interface SkillContextExplainInput {
  project?: unknown;
  agentId?: unknown;
  query?: unknown;
  files?: unknown;
  concepts?: unknown;
  limit?: unknown;
  tokenBudget?: unknown;
}

export type SkillContextPackingState = "packed" | "omitted_budget";

export type SkillContextPackingReasonCode = "packed" | "exceeds_token_budget";

export interface SkillContextPackingDecision {
  skillId: string;
  recallRank: number;
  state: SkillContextPackingState;
  reasonCodes: SkillContextPackingReasonCode[];
  renderedAdvisoryTokens: number;
  candidateSectionTokens: number;
  packedPosition?: number;
}

export interface SkillAdvisoryPackingEvaluation {
  content: string | null;
  tokens: number;
  sectionOverheadTokens: number;
  decisions: SkillContextPackingDecision[];
}

export interface SkillContextExplainResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  privacySuppressedCount: number;
  privateProtectedCount: number;
  matchedCount: number;
  recallReturnedCount: number;
  recallTruncated: boolean;
  effectiveRecallLimit: number;
  configuredTokenBudget: number;
  requestedTokenBudget?: number;
  effectiveTokenBudget: number;
  sectionOverheadTokens: number;
  packedCount: number;
  omittedCount: number;
  packedTokens: number;
  sectionCreated: boolean;
  duplicateSkillIdCount: number;
  items: SkillContextPackingDecision[];
}

export interface SkillContextAdmissionExplainInput {
  project?: unknown;
  agentId?: unknown;
  query?: unknown;
  files?: unknown;
  concepts?: unknown;
  limit?: unknown;
  overallBudget?: unknown;
  usedTokens?: unknown;
  selectedBlockCount?: unknown;
}

export type SkillContextAdmissionState =
  | "disabled"
  | "failed"
  | "skipped_no_budget"
  | "recall_empty"
  | "packing_empty"
  | "admitted"
  | "rejected_outer_budget";

export type SkillContextAdmissionReasonCode =
  | "context_disabled"
  | "invalid_input"
  | "storage_failure"
  | "duplicate_skill_id"
  | "no_remaining_budget"
  | "no_recalled_advisories"
  | "no_advisory_fits"
  | "section_admitted"
  | "section_exceeds_outer_budget";

export interface SkillContextAdmissionEvaluation {
  separatorTokens: number;
  remainingOverallBudget: number;
  effectiveSkillTokenBudget: number;
  shouldAttemptRecall: boolean;
  sectionCreated: boolean;
  sectionAdmitted: boolean;
  projectedUsedTokens: number;
  projectedBlockCount: number;
}

export interface SkillContextAdmissionExplainResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  state: SkillContextAdmissionState;
  reasonCodes: SkillContextAdmissionReasonCode[];
  overallBudget: number;
  usedTokensBeforeSkill: number;
  selectedBlockCountBeforeSkill: number;
  configuredSkillTokenBudget: number;
  separatorTokens: number;
  remainingOverallBudget: number;
  effectiveSkillTokenBudget: number;
  recallAttempted: boolean;
  effectiveRecallLimit: number;
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  privacySuppressedCount: number;
  privateProtectedCount: number;
  matchedCount: number;
  recallReturnedCount: number;
  recallTruncated: boolean;
  duplicateSkillIdCount: number;
  packedCount: number;
  omittedCount: number;
  packedTokens: number;
  sectionCreated: boolean;
  sectionAdmitted: boolean;
  projectedUsedTokens: number;
  projectedBlockCount: number;
}

export interface SkillContextRuntimeExplainInput {
  project?: unknown;
  agentId?: unknown;
  overallBudget?: unknown;
  usedTokens?: unknown;
  selectedBlockCount?: unknown;
}

export type SkillContextRuntimeState =
  | "disabled"
  | "failed"
  | "skipped_no_budget"
  | "recall_empty"
  | "packing_empty"
  | "admitted"
  | "rejected_outer_budget";

export type SkillContextRuntimeReasonCode =
  | "context_disabled"
  | "invalid_input"
  | "recall_trigger_failure"
  | "invalid_recall_result"
  | "no_remaining_budget"
  | "no_recalled_advisories"
  | "no_advisory_fits"
  | "section_admitted"
  | "section_exceeds_outer_budget";

export interface SkillContextRuntimeExplainResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  state: SkillContextRuntimeState;
  reasonCodes: SkillContextRuntimeReasonCode[];
  overallBudget: number;
  usedTokensBeforeSkill: number;
  selectedBlockCountBeforeSkill: number;
  configuredSkillTokenBudget: number;
  separatorTokens: number;
  remainingOverallBudget: number;
  effectiveSkillTokenBudget: number;
  effectiveRecallLimit: number;
  recallAttempted: boolean;
  recallTriggerSucceeded: boolean;
  recallResultParsed: boolean;
  parsedAdvisoryCount: number;
  packedCount: number;
  omittedCount: number;
  packedTokens: number;
  sectionCreated: boolean;
  sectionAdmitted: boolean;
  projectedUsedTokens: number;
  projectedBlockCount: number;
}

export interface SkillContextParityDiagnosticsInput {
  project?: unknown;
  agentId?: unknown;
  overallBudget?: unknown;
  usedTokens?: unknown;
  selectedBlockCount?: unknown;
}

export interface SkillContextParitySnapshot {
  success: boolean;
  enabled: boolean;
  state: SkillContextAdmissionState | SkillContextRuntimeState;
  overallBudget: number;
  usedTokensBeforeSkill: number;
  selectedBlockCountBeforeSkill: number;
  configuredSkillTokenBudget: number;
  separatorTokens: number;
  remainingOverallBudget: number;
  effectiveSkillTokenBudget: number;
  effectiveRecallLimit: number;
  recallAttempted: boolean;
  recalledAdvisoryCount: number;
  packedCount: number;
  omittedCount: number;
  packedTokens: number;
  sectionCreated: boolean;
  sectionAdmitted: boolean;
  projectedUsedTokens: number;
  projectedBlockCount: number;
}

export type SkillContextParityMismatchCode =
  | "path_success_mismatch"
  | "path_enabled_mismatch"
  | "path_state_mismatch"
  | "overall_budget_mismatch"
  | "used_tokens_mismatch"
  | "selected_block_count_mismatch"
  | "configured_skill_budget_mismatch"
  | "separator_tokens_mismatch"
  | "remaining_budget_mismatch"
  | "effective_skill_budget_mismatch"
  | "effective_recall_limit_mismatch"
  | "recall_attempt_mismatch"
  | "recalled_advisory_count_mismatch"
  | "packed_count_mismatch"
  | "omitted_count_mismatch"
  | "packed_tokens_mismatch"
  | "section_created_mismatch"
  | "section_admitted_mismatch"
  | "projected_used_tokens_mismatch"
  | "projected_block_count_mismatch";

export type SkillContextParityDiagnosticsState = "disabled" | "failed" | "consistent" | "mismatch";

export type SkillContextParityDiagnosticsReasonCode =
  | "context_disabled"
  | "invalid_input"
  | "direct_trigger_failure"
  | "invalid_direct_result"
  | "runtime_trigger_failure"
  | "invalid_runtime_result"
  | "paths_consistent"
  | "paths_mismatch";

export interface SkillContextParityDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  state: SkillContextParityDiagnosticsState;
  reasonCodes: SkillContextParityDiagnosticsReasonCode[];
  reason?: string;
  comparisonMode: "sequential_best_effort_non_atomic";
  comparisonAvailable: boolean;
  consistent: boolean;
  directTriggerAttempted: boolean;
  directTriggerSucceeded: boolean;
  directResultParsed: boolean;
  runtimeTriggerAttempted: boolean;
  runtimeTriggerSucceeded: boolean;
  runtimeResultParsed: boolean;
  mismatchCodes: SkillContextParityMismatchCode[];
  direct: SkillContextParitySnapshot | null;
  runtime: SkillContextParitySnapshot | null;
}

export interface SkillContextParityStabilityDiagnosticsInput {
  project?: unknown;
  agentId?: unknown;
  overallBudget?: unknown;
  usedTokens?: unknown;
  selectedBlockCount?: unknown;
}

export interface SkillContextParityStabilitySampleSummary {
  success: boolean;
  enabled: boolean;
  state: SkillContextParityDiagnosticsState;
  comparisonAvailable: boolean;
  consistent: boolean;
  mismatchCodes: SkillContextParityMismatchCode[];
}

export interface SkillContextParityStabilityEvaluation {
  state: "stable_consistent" | "stable_mismatch" | "observed_drift";
  directDriftCodes: SkillContextParityMismatchCode[];
  runtimeDriftCodes: SkillContextParityMismatchCode[];
  stableAcrossSamples: boolean;
  repeatableMismatch: boolean;
}

export type SkillContextParityStabilityState =
  | "disabled"
  | "failed"
  | "stable_consistent"
  | "stable_mismatch"
  | "observed_drift";

export type SkillContextParityStabilityReasonCode =
  | "context_disabled"
  | "invalid_input"
  | "first_trigger_failure"
  | "invalid_first_result"
  | "first_comparison_unavailable"
  | "second_trigger_failure"
  | "invalid_second_result"
  | "second_comparison_unavailable"
  | "stable_consistency_observed"
  | "stable_mismatch_observed"
  | "sample_drift_observed";

export interface SkillContextParityStabilityDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  state: SkillContextParityStabilityState;
  reasonCodes: SkillContextParityStabilityReasonCode[];
  reason?: string;
  samplingMode: "sequential_double_sample_non_atomic";
  sampleCount: 2;
  firstTriggerAttempted: boolean;
  firstTriggerSucceeded: boolean;
  firstResultParsed: boolean;
  secondTriggerAttempted: boolean;
  secondTriggerSucceeded: boolean;
  secondResultParsed: boolean;
  first: SkillContextParityStabilitySampleSummary | null;
  second: SkillContextParityStabilitySampleSummary | null;
  directDriftCodes: SkillContextParityMismatchCode[];
  runtimeDriftCodes: SkillContextParityMismatchCode[];
  stableAcrossSamples: boolean;
  repeatableMismatch: boolean;
}

export interface SkillContextParityDriftAttributionDiagnosticsInput {
  project?: unknown;
  agentId?: unknown;
  overallBudget?: unknown;
  usedTokens?: unknown;
  selectedBlockCount?: unknown;
}

export type SkillContextParityAttributionStage =
  | "path_contract"
  | "budget"
  | "recall"
  | "packing"
  | "admission";

export interface SkillContextParityAttributionSummary {
  stages: SkillContextParityAttributionStage[];
  stageCounts: {
    path_contract: number;
    budget: number;
    recall: number;
    packing: number;
    admission: number;
  };
}

export type SkillContextParityDriftAttributionDiagnosticsState =
  | "disabled"
  | "failed"
  | "stable_consistent"
  | "stable_mismatch"
  | "observed_drift";

export type SkillContextParityDriftAttributionDiagnosticsReasonCode =
  | "context_disabled"
  | "invalid_input"
  | "stability_trigger_failure"
  | "invalid_stability_result"
  | "stability_classification_unavailable"
  | "stable_consistency_attributed"
  | "stable_mismatch_attributed"
  | "observed_drift_attributed";

export interface SkillContextParityDriftAttributionDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  state: SkillContextParityDriftAttributionDiagnosticsState;
  reasonCodes: SkillContextParityDriftAttributionDiagnosticsReasonCode[];
  reason?: string;
  sourceSamplingMode: "sequential_double_sample_non_atomic";
  attributionAvailable: boolean;
  stabilityTriggerAttempted: boolean;
  stabilityTriggerSucceeded: boolean;
  stabilityResultParsed: boolean;
  parityOutcomeChanged: boolean;
  repeatableMismatchAttribution: SkillContextParityAttributionSummary;
  directDriftAttribution: SkillContextParityAttributionSummary;
  runtimeDriftAttribution: SkillContextParityAttributionSummary;
}

export interface SearchResult {
  observation: CompressedObservation;
  score: number;
  sessionId: string;
}

export interface ContextBlock {
  type: "summary" | "observation" | "memory";
  content: string;
  tokens: number;
  recency: number;
  sourceIds?: string[];
}

export interface EvalResult {
  valid: boolean;
  errors: string[];
  qualityScore: number;
  latencyMs: number;
  functionId: string;
}

export interface FunctionMetrics {
  functionId: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  avgQualityScore: number;
}

export interface HealthSnapshot {
  connectionState: string;
  workers: Array<{ id: string; name: string; status: string }>;
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  cpu: { userMicros: number; systemMicros: number; percent: number };
  eventLoopLagMs: number;
  uptimeSeconds: number;
  kvConnectivity?: { status: string; latencyMs?: number; error?: string };
  status: "healthy" | "degraded" | "critical";
  alerts: string[];
  notes?: string[];
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailureAt: number | null;
  openedAt: number | null;
}

export interface MemorySlot {
  label: string;
  content: string;
  sizeLimit: number;
  description: string;
  pinned: boolean;
  readOnly: boolean;
  scope: "project" | "global";
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  embedImage?(src: string): Promise<Float32Array>;
}

export interface MemoryRelation {
  type: "supersedes" | "extends" | "derives" | "contradicts" | "related";
  sourceId: string;
  targetId: string;
  createdAt: string;
  confidence?: number;
}

export interface HybridSearchResult {
  observation: CompressedObservation;
  bm25Score: number;
  vectorScore: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface CompactSearchResult {
  obsId: string;
  sessionId: string;
  title: string;
  type: ObservationType;
  score: number;
  timestamp: string;
}

export interface CompactLessonResult {
  lessonId: string;
  content: string;
  confidence: number;
  score: number;
  createdAt: string;
  project?: string;
  tags: string[];
}

export interface TimelineEntry {
  observation: CompressedObservation;
  sessionId: string;
  relativePosition: number;
}

export interface ProjectProfile {
  project: string;
  updatedAt: string;
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  conventions: string[];
  commonErrors: string[];
  recentActivity: string[];
  sessionCount: number;
  totalObservations: number;
  summary?: string;
}

export interface ExportPagination {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface ExportData {
  version: "0.3.0" | "0.4.0" | "0.5.0" | "0.6.0" | "0.6.1" | "0.7.0" | "0.7.2" | "0.7.3" | "0.7.4" | "0.7.5" | "0.7.6" | "0.7.7" | "0.7.9" | "0.8.0" | "0.8.1" | "0.8.2" | "0.8.3" | "0.8.4" | "0.8.5" | "0.8.6" | "0.8.7" | "0.8.8" | "0.8.9" | "0.8.10" | "0.8.11" | "0.8.12" | "0.8.13" | "0.9.0" | "0.9.1" | "0.9.2" | "0.9.3" | "0.9.4" | "0.9.5" | "0.9.6" | "0.9.7" | "0.9.8" | "0.9.9" | "0.9.10" | "0.9.11" | "0.9.12" | "0.9.13" | "0.9.14" | "0.9.15" | "0.9.16" | "0.9.17" | "0.9.18" | "0.9.19" | "0.9.20" | "0.9.21" | "0.9.22" | "0.9.23" | "0.9.24" | "0.9.25" | "0.9.26" | "0.9.27";
  exportedAt: string;
  sessions: Session[];
  observations: Record<string, CompressedObservation[]>;
  memories: Memory[];
  summaries: SessionSummary[];
  profiles?: ProjectProfile[];
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  semanticMemories?: SemanticMemory[];
  proceduralMemories?: ProceduralMemory[];
  actions?: Action[];
  actionEdges?: ActionEdge[];
  routines?: Routine[];
  signals?: Signal[];
  checkpoints?: Checkpoint[];
  sentinels?: Sentinel[];
  sketches?: Sketch[];
  crystals?: Crystal[];
  facets?: Facet[];
  lessons?: Lesson[];
  insights?: Insight[];
  accessLogs?: AccessLogExport[];
  pagination?: ExportPagination;
}

export interface AccessLogExport {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export interface EmbeddingConfig {
  provider?: string;
  bm25Weight: number;
  vectorWeight: number;
}

export interface FallbackConfig {
  providers: ProviderType[];
}

export interface ClaudeBridgeConfig {
  enabled: boolean;
  projectPath: string;
  memoryFilePath: string;
  lineBudget: number;
}

export interface StandaloneConfig {
  dataDir: string;
  persistPath: string;
  agentType?: string;
}

export type GraphNodeType =
  | "file"
  | "function"
  | "concept"
  | "error"
  | "decision"
  | "pattern"
  | "library"
  | "person"
  | "project"
  | "preference"
  | "location"
  | "organization"
  | "event";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  properties: Record<string, unknown>;
  sourceObservationIds: string[];
  createdAt: string;
  updatedAt?: string;
  aliases?: string[];
  stale?: boolean;
}

export type GraphEdgeType =
  | "uses"
  | "imports"
  | "modifies"
  | "causes"
  | "fixes"
  | "depends_on"
  | "related_to"
  | "works_at"
  | "prefers"
  | "blocked_by"
  | "caused_by"
  | "optimizes_for"
  | "rejected"
  | "avoids"
  | "located_in"
  | "succeeded_by";

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  weight: number;
  sourceObservationIds: string[];
  createdAt: string;
  tcommit?: string;
  tvalid?: string;
  tvalidEnd?: string;
  context?: EdgeContext;
  version?: number;
  supersededBy?: string;
  isLatest?: boolean;
  stale?: boolean;
}

export interface EdgeContext {
  reasoning?: string;
  sentiment?: string;
  alternatives?: string[];
  situationalFactors?: string[];
  confidence?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
  // #753: pagination + truncation signals for large graphs. `total*`
  // counts reflect the full unbounded result for the given filter so
  // the viewer can show "showing N of M" without re-querying. `truncated`
  // is true when the default cap kicked in (operator may have wanted
  // the full set but didn't ask for one).
  totalNodes?: number;
  totalEdges?: number;
  truncated?: boolean;
  // Echoes back the cap that produced this page so a paged client can
  // detect when the default was applied vs an explicit `limit`.
  limit?: number;
  offset?: number;
  // #814: indicates the response came from the precomputed top-degree
  // snapshot rather than a live kv.list enumeration. Set only on the
  // empty-body / nodeType-only branch on large corpora where the
  // unbounded enumeration would exceed the iii invocation timeout.
  fromSnapshot?: boolean;
  // #814: when the snapshot is stale or absent and the live fallback
  // also failed, expose an explanatory note so the viewer can surface
  // an actionable banner instead of a blank graph.
  warning?: string;
}

// #814: persisted top-degree subgraph + aggregate counts. Stored under
// KV.graphSnapshot with a single key "current". `dirty` is set true by
// mem::graph-extract after writes and flipped false when the snapshot
// rebuild completes.
export interface GraphSnapshot {
  version: 1;
  topNodes: GraphNode[];
  topEdges: GraphEdge[];
  // Synchronous degree lookup keyed by nodeId. Maintained alongside
  // topNodes so re-ranking after an edge write doesn't require an
  // async kv.get for every top-N entry inside the sort comparator.
  // Keys are limited to the top-N set; non-top nodes track their
  // degree in KV.graphNodeDegree only.
  topDegrees: Record<string, number>;
  stats: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  };
  updatedAt: string;
  dirty: boolean;
  // #825 follow-up: ISO timestamp set by mem::graph-reset. After
  // reset, mem::graph-extract treats any pre-resetAt node as an
  // orphan (skip merge, write fresh) so future extracts don't
  // silently reconnect to legacy rows via stale name-index entries.
  // Absent / 1970 epoch = no reset has run.
  resetAt?: string;
}

export type ConsolidationTier =
  | "working"
  | "episodic"
  | "semantic"
  | "procedural";

export interface SemanticMemory {
  id: string;
  fact: string;
  confidence: number;
  sourceSessionIds: string[];
  sourceMemoryIds: string[];
  accessCount: number;
  lastAccessedAt: string;
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProceduralMemory {
  id: string;
  name: string;
  steps: string[];
  triggerCondition: string;
  expectedOutcome?: string;
  frequency: number;
  sourceSessionIds: string[];
  sourceObservationIds?: string[];
  tags?: string[];
  concepts?: string[];
  strength: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentSkillStatus = "active" | "retired" | "superseded";

export interface AgentSkill {
  id: string;
  name: string;
  triggerCondition: string;
  steps: string[];
  expectedOutcome: string;
  antiPatterns: string[];
  project?: string;
  agentId?: string;
  files: string[];
  concepts: string[];
  confidence: number;
  strength: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  sourceProceduralMemoryIds: string[];
  sourceCandidateIds: string[];
  sourceObservationIds: string[];
  sourceSessionIds: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastReinforcedAt?: string;
  status: AgentSkillStatus;
  supersedes?: string;
  version: number;
}

export type SkillFeedbackKind =
  | "success"
  | "failure"
  | "correction"
  | "stale";

export type SkillFeedbackAttribution =
  | "user-confirmed"
  | "agent-observed";

export interface SkillFeedbackEvent {
  id: string;
  skillId: string;
  skillVersion: number;
  kind: SkillFeedbackKind;
  attribution: SkillFeedbackAttribution;
  source: "explicit";
  project?: string;
  agentId?: string;
  sessionId?: string;
  sourceObservationIds: string[];
  sourceSessionIds: string[];
  createdAt: string;
}

export interface SkillFeedbackAggregate {
  total: number;
  byKind: {
    success: number;
    failure: number;
    correction: number;
    stale: number;
  };
  byAttribution: {
    "user-confirmed": number;
    "agent-observed": number;
  };
  byVersion: Array<{
    skillVersion: number;
    total: number;
    success: number;
    failure: number;
    correction: number;
    stale: number;
  }>;
  earliestCreatedAt?: string;
  latestCreatedAt?: string;
}

export interface SkillFeedbackReductionPlanInput {
  skillId?: unknown;
  skillVersion?: unknown;
  project?: unknown;
  agentId?: unknown;
}

export interface SkillFeedbackReductionPlanCounters {
  success: number;
  failure: number;
}

export interface SkillFeedbackReductionPlanResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  skillId?: string;
  skillVersion?: number;
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  applicableCount: number;
  ignoredCount: number;
  proposedDelta: SkillFeedbackReductionPlanCounters;
  currentCounters?: SkillFeedbackReductionPlanCounters;
  proposedCounters?: SkillFeedbackReductionPlanCounters;
  sourceEventIds: string[];
  evidenceHash?: string;
  duplicateEventIds: string[];
  reason?: string;
}

export type SkillLifecycleRecommendation =
  | "none"
  | "keep_active"
  | "review_for_revision"
  | "review_for_retirement";

export type SkillLifecycleReviewReasonCode =
  | "skill_not_active"
  | "no_applicable_feedback"
  | "repeated_user_confirmed_stale"
  | "user_confirmed_correction"
  | "repeated_user_confirmed_failure"
  | "stable_user_confirmed_success"
  | "latest_user_confirmed_success"
  | "negative_feedback_present"
  | "insufficient_user_confirmed_evidence";

export interface SkillLifecycleReviewInput {
  skillId?: unknown;
  skillVersion?: unknown;
  project?: unknown;
  agentId?: unknown;
}

export interface SkillLifecycleReviewEvidenceCounts {
  total: number;
  success: number;
  failure: number;
  correction: number;
  stale: number;
  userConfirmedTotal: number;
  userConfirmedSuccess: number;
  userConfirmedFailure: number;
  userConfirmedCorrection: number;
  userConfirmedStale: number;
  agentObservedTotal: number;
  agentObservedSuccess: number;
  agentObservedFailure: number;
  agentObservedStale: number;
}

export interface SkillLifecycleReviewResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  skillId?: string;
  skillVersion?: number;
  currentStatus?: AgentSkillStatus;
  recommendation: SkillLifecycleRecommendation;
  reasonCodes: SkillLifecycleReviewReasonCode[];
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  applicableCount: number;
  ignoredCount: number;
  evidenceCounts: SkillLifecycleReviewEvidenceCounts;
  sourceEventIds: string[];
  duplicateEventIds: string[];
  latestEvidenceAt?: string;
  latestUserConfirmedKind?: SkillFeedbackKind;
  reason?: string;
}

export interface SkillLifecycleReviewInventoryInput {
  project?: unknown;
  agentId?: unknown;
  status?: unknown;
  recommendation?: unknown;
  reasonCode?: unknown;
  scanLimit?: unknown;
  limit?: unknown;
}

export interface SkillLifecycleReviewInventoryItem {
  success: boolean;
  skillId: string;
  skillVersion: number;
  currentStatus: AgentSkillStatus;
  project?: string;
  agentId?: string;
  recommendation: SkillLifecycleRecommendation;
  reasonCodes: SkillLifecycleReviewReasonCode[];
  applicableCount: number;
  evidenceCounts: SkillLifecycleReviewEvidenceCounts;
  duplicateEventIds: string[];
  latestEvidenceAt?: string;
  latestUserConfirmedKind?: SkillFeedbackKind;
  reason?: string;
}

export interface SkillLifecycleReviewInventorySummary {
  statusCounts: Record<AgentSkillStatus, number>;
  recommendationCounts: Record<SkillLifecycleRecommendation, number>;
  reasonCounts: Partial<Record<SkillLifecycleReviewReasonCode, number>>;
  failedItemCount: number;
}

export interface SkillLifecycleReviewInventoryResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  skillRowCount: number;
  validSkillCount: number;
  malformedSkillCount: number;
  candidateCount: number;
  ignoredSkillCount: number;
  scannedCount: number;
  matchedCount: number;
  returnedCount: number;
  scanTruncated: boolean;
  resultTruncated: boolean;
  truncated: boolean;
  feedbackScannedCount: number;
  validFeedbackCount: number;
  malformedFeedbackCount: number;
  duplicateSkillIds: string[];
  summary: SkillLifecycleReviewInventorySummary;
  items: SkillLifecycleReviewInventoryItem[];
}

export type SkillLineageRelationState =
  | "root"
  | "resolved"
  | "missing_target"
  | "malformed_reference"
  | "self_reference"
  | "cycle";

export type SkillLineageFindingCode =
  | "malformed_supersedes"
  | "self_supersedes"
  | "cycle_detected"
  | "missing_superseded_skill"
  | "multiple_superseders";

export type SkillLineageScopeRelation =
  | "not_applicable"
  | "same"
  | "different";

export interface SkillLineageDiagnosticsInput {
  project?: unknown;
  agentId?: unknown;
  status?: unknown;
  relationState?: unknown;
  findingCode?: unknown;
  scopeRelation?: unknown;
  limit?: unknown;
}

export interface SkillLineageDiagnosticsItem {
  skillId: string;
  skillVersion: number;
  currentStatus: AgentSkillStatus;
  project?: string;
  agentId?: string;
  supersedes?: string;
  relationState: SkillLineageRelationState;
  scopeRelation: SkillLineageScopeRelation;
  targetStatus?: AgentSkillStatus;
  incomingSupersederIds: string[];
  cycleMemberIds: string[];
  findingCodes: SkillLineageFindingCode[];
}

export interface SkillLineageDiagnosticsSummary {
  statusCounts: Record<AgentSkillStatus, number>;
  relationStateCounts: Record<SkillLineageRelationState, number>;
  findingCounts: Partial<Record<SkillLineageFindingCode, number>>;
  declaredReferenceCount: number;
  resolvedReferenceCount: number;
  missingReferenceCount: number;
  cycleComponentCount: number;
  cycleSkillCount: number;
  branchingTargetCount: number;
}

export interface SkillLineageDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  applied: false;
  reason?: string;
  skillRowCount: number;
  validSkillCount: number;
  malformedSkillCount: number;
  duplicateSkillIds: string[];
  matchedCount: number;
  returnedCount: number;
  resultTruncated: boolean;
  truncated: boolean;
  summary: SkillLineageDiagnosticsSummary;
  items: SkillLineageDiagnosticsItem[];
}

export interface TeamConfig {
  teamId: string;
  userId: string;
  mode: "shared" | "private";
}

export type AgentScopeMode = "shared" | "isolated";
export interface AgentScope {
  agentId: string;
  mode: AgentScopeMode;
}

export interface TeamSharedItem {
  id: string;
  sharedBy: string;
  sharedAt: string;
  type: "observation" | "memory" | "pattern";
  content: unknown;
  project: string;
  visibility: "shared" | "private";
}

export interface TeamProfile {
  teamId: string;
  members: string[];
  topConcepts: Array<{ concept: string; frequency: number }>;
  topFiles: Array<{ file: string; frequency: number }>;
  sharedPatterns: string[];
  totalSharedItems: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation:
    | "observe"
    | "compress"
    | "remember"
    | "forget"
    | "evolve"
    | "consolidate"
    | "share"
    | "delete"
    | "import"
    | "export"
    | "action_create"
    | "action_update"
    | "lease_acquire"
    | "lease_release"
    | "lease_renew"
    | "routine_run"
    | "signal_send"
    | "checkpoint_resolve"
    | "mesh_sync"
    | "relation_create"
    | "relation_update"
    | "sentinel_create"
    | "sentinel_trigger"
    | "sketch_create"
    | "sketch_promote"
    | "retention_score"
    | "sketch_discard"
    | "crystallize"
    | "diagnose"
    | "heal"
    | "index_persist"
    | "facet_tag"
    | "lesson_save"
    | "lesson_recall"
    | "lesson_strengthen"
    | "obsidian_export"
    | "reflect"
    | "insight_search"
    | "skill_extract"
    | "skill_promote"
    | "core_add"
    | "core_remove"
    | "auto_page"
    | "vision_embed"
    | "slot_append"
    | "slot_replace"
    | "slot_create"
    | "slot_delete"
    | "slot_reflect";
  userId?: string;
  functionId: string;
  targetIds: string[];
  details: Record<string, unknown>;
  qualityScore?: number;
}

export interface GovernanceFilter {
  type?: string[];
  dateFrom?: string;
  dateTo?: string;
  project?: string;
  qualityBelow?: number;
}

export interface SnapshotMeta {
  id: string;
  commitHash: string;
  createdAt: string;
  message: string;
  stats: {
    sessions: number;
    observations: number;
    memories: number;
    graphNodes: number;
  };
}

export interface SnapshotDiff {
  fromCommit: string;
  toCommit: string;
  added: { memories: number; observations: number; graphNodes: number };
  removed: { memories: number; observations: number; graphNodes: number };
}

export interface Action {
  id: string;
  title: string;
  description: string;
  status: "pending" | "active" | "done" | "blocked" | "cancelled";
  priority: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  assignedTo?: string;
  project?: string;
  tags: string[];
  sourceObservationIds: string[];
  sourceMemoryIds: string[];
  result?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
  sketchId?: string;
  crystallizedInto?: string;
}

export type ActionEdgeType =
  | "requires"
  | "unlocks"
  | "spawned_by"
  | "gated_by"
  | "conflicts_with";

export interface ActionEdge {
  id: string;
  type: ActionEdgeType;
  sourceActionId: string;
  targetActionId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface Lease {
  id: string;
  actionId: string;
  agentId: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  status: "active" | "expired" | "released";
}

export interface Routine {
  id: string;
  name: string;
  description: string;
  steps: RoutineStep[];
  createdAt: string;
  updatedAt: string;
  frozen: boolean;
  tags: string[];
  sourceProceduralIds: string[];
}

export interface RoutineStep {
  order: number;
  title: string;
  description: string;
  actionTemplate: Partial<Action>;
  dependsOn: number[];
}

export interface RoutineRun {
  id: string;
  routineId: string;
  status: "running" | "completed" | "failed" | "paused";
  startedAt: string;
  completedAt?: string;
  actionIds: string[];
  stepStatus: Record<number, "pending" | "active" | "done" | "failed">;
  initiatedBy: string;
}

export interface Signal {
  id: string;
  from: string;
  to?: string;
  threadId?: string;
  replyTo?: string;
  type: "info" | "request" | "response" | "alert" | "handoff";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  readAt?: string;
  expiresAt?: string;
}

export interface Checkpoint {
  id: string;
  name: string;
  description: string;
  status: "pending" | "passed" | "failed" | "expired";
  type: "ci" | "approval" | "deploy" | "external" | "timer";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  result?: unknown;
  expiresAt?: string;
  linkedActionIds: string[];
}

export interface Sketch {
  id: string;
  title: string;
  description: string;
  status: "active" | "promoted" | "discarded";
  actionIds: string[];
  project?: string;
  createdAt: string;
  expiresAt: string;
  promotedAt?: string;
  discardedAt?: string;
}

export interface Facet {
  id: string;
  targetId: string;
  targetType: "action" | "memory" | "observation";
  dimension: string;
  value: string;
  createdAt: string;
}

export interface Sentinel {
  id: string;
  name: string;
  type: "webhook" | "timer" | "threshold" | "pattern" | "approval" | "custom";
  status: "watching" | "triggered" | "cancelled" | "expired";
  config: Record<string, unknown>;
  result?: unknown;
  createdAt: string;
  triggeredAt?: string;
  expiresAt?: string;
  linkedActionIds: string[];
  escalatedAt?: string;
}

export interface Crystal {
  id: string;
  narrative: string;
  keyOutcomes: string[];
  filesAffected: string[];
  lessons: string[];
  sourceActionIds: string[];
  sessionId?: string;
  project?: string;
  createdAt: string;
}

export interface Lesson {
  id: string;
  content: string;
  context: string;
  confidence: number;
  reinforcements: number;
  source: "crystal" | "manual" | "consolidation";
  sourceIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface Insight {
  id: string;
  title: string;
  content: string;
  confidence: number;
  reinforcements: number;
  sourceConceptCluster: string[];
  sourceMemoryIds: string[];
  sourceLessonIds: string[];
  sourceCrystalIds: string[];
  project?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastReinforcedAt?: string;
  lastDecayedAt?: string;
  decayRate: number;
  deleted?: boolean;
}

export interface DiagnosticCheck {
  name: string;
  category: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fixable: boolean;
}

export interface MeshPeer {
  id: string;
  url: string;
  name: string;
  lastSyncAt?: string;
  status: "connected" | "disconnected" | "syncing" | "error";
  sharedScopes: string[];
  syncFilter?: { project?: string };
}


export interface EnrichedChunk {
  id: string;
  originalObsId: string;
  sessionId: string;
  content: string;
  resolvedEntities: Record<string, string>;
  preferences: string[];
  contextBridges: string[];
  windowStart: number;
  windowEnd: number;
  createdAt: string;
}

export interface LatentEmbedding {
  obsId: string;
  contentEmbedding: string;
  latentEmbedding: string;
  sessionId: string;
}

export interface QueryExpansion {
  original: string;
  reformulations: string[];
  temporalConcretizations: string[];
  entityExtractions: string[];
}

export interface TripleStreamResult {
  observation: CompressedObservation;
  vectorScore: number;
  bm25Score: number;
  graphScore: number;
  combinedScore: number;
  sessionId: string;
  graphContext?: string;
}

export interface TemporalQuery {
  entityName: string;
  asOf?: string;
  from?: string;
  to?: string;
  includeHistory?: boolean;
}

export interface TemporalState {
  entity: GraphNode;
  currentEdges: GraphEdge[];
  historicalEdges: GraphEdge[];
  timeline: Array<{
    edge: GraphEdge;
    validFrom: string;
    validTo?: string;
    context?: EdgeContext;
  }>;
}

export interface RetentionScore {
  memoryId: string;
  // Which KV scope this row came from. Needed by mem::retention-evict
  // so the delete loop routes to KV.memories or KV.semantic correctly.
  // Missing on pre-0.8.10 rows — callers must treat `undefined` as
  // "unknown" and probe both scopes for backwards-compat. See #124.
  source?: "episodic" | "semantic";
  score: number;
  salience: number;
  temporalDecay: number;
  reinforcementBoost: number;
  lastAccessed: string;
  accessCount: number;
}

export interface DecayConfig {
  lambda: number;
  sigma: number;
  tierThresholds: {
    hot: number;
    warm: number;
    cold: number;
  };
}

/**
 * KV.state scope — long-lived system counters + flags keyed by string.
 * Keep keys/types in sync with the state-scope callers (e.g.,
 * disk-size-manager) so TypeScript enforces consistent value shapes
 * instead of every caller using ad-hoc `<number>` generics.
 */
export interface StateScope {
  "system:currentDiskSize": number;
}

export type StateScopeKey = keyof StateScope;
