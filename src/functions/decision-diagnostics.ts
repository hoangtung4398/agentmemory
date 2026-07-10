import type { DecisionAudit, DecisionCandidateQueue } from "../types.js";

export interface DecisionAuditFilters {
  mode?: string;
  action?: string;
  sourceFunction?: string;
  insertionPoint?: string;
  project?: string;
  agentId?: string;
  sessionId?: string;
  limit?: number;
}

export interface DecisionCandidateFilters {
  kind?: string;
  status?: string;
  project?: string;
  agentId?: string;
  sessionId?: string;
  decisionId?: string;
  candidateId?: string;
  limit?: number;
}

export interface CompactDecisionAudit {
  id: string;
  decisionId: string;
  inputId: string;
  mode: DecisionAudit["mode"];
  sourceFunction: DecisionAudit["sourceFunction"];
  insertionPoint: string;
  action: DecisionAudit["action"];
  project?: string;
  sessionId?: string;
  agentId?: string;
  observationId?: string;
  memoryId?: string;
  confidence: number;
  importance: number;
  ttlDays?: number;
  reasonCodes: string[];
  outcome: DecisionAudit["outcome"];
  fallbackReason?: string;
  candidateQueued?: boolean;
  candidateQueueId?: string;
  existingBehaviorPreserved: boolean;
  createdAt: string;
}

export interface CompactDecisionCandidate {
  id: string;
  kind: DecisionCandidateQueue["kind"];
  status: DecisionCandidateQueue["status"];
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
  evidenceRefs: DecisionCandidateQueue["evidenceRefs"];
  createdAt: string;
  expiresAt?: string;
  consumedAt?: string;
  consumedBy?: DecisionCandidateQueue["consumedBy"];
}

export function nonEmptyFilterValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function parseDecisionAuditLimit(value: unknown, fallback = 50): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

export const parseDecisionCandidateLimit = parseDecisionAuditLimit;

function matches(actual: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

function matchesSession(audit: DecisionAudit, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  return (
    audit.sessionId === sessionId ||
    audit.evidenceRefs.some((ref) => ref.sessionId === sessionId)
  );
}

function matchesCandidateSession(
  candidate: DecisionCandidateQueue,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return true;
  return (
    candidate.sessionId === sessionId ||
    candidate.evidenceRefs.some((ref) => ref.sessionId === sessionId)
  );
}

export function filterDecisionAudits(
  audits: DecisionAudit[],
  filters: DecisionAuditFilters,
): DecisionAudit[] {
  const limit = filters.limit ?? 50;
  return [...audits]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((audit) =>
      matches(audit.mode, filters.mode) &&
      matches(audit.action, filters.action) &&
      matches(audit.sourceFunction, filters.sourceFunction) &&
      matches(audit.insertionPoint, filters.insertionPoint) &&
      matches(audit.project, filters.project) &&
      matches(audit.agentId, filters.agentId) &&
      matchesSession(audit, filters.sessionId)
    )
    .slice(0, limit);
}

export function compactDecisionAudit(audit: DecisionAudit): CompactDecisionAudit {
  return {
    id: audit.id,
    decisionId: audit.decisionId,
    inputId: audit.inputId,
    mode: audit.mode,
    sourceFunction: audit.sourceFunction,
    insertionPoint: audit.insertionPoint,
    action: audit.action,
    project: audit.project,
    sessionId: audit.sessionId,
    agentId: audit.agentId,
    observationId: audit.observationId,
    memoryId: audit.memoryId,
    confidence: audit.confidence,
    importance: audit.importance,
    ttlDays: audit.ttlDays,
    reasonCodes: audit.reasonCodes,
    outcome: audit.outcome,
    fallbackReason: audit.fallbackReason,
    candidateQueued: audit.candidateQueued,
    candidateQueueId: audit.candidateQueueId,
    existingBehaviorPreserved: audit.existingBehaviorPreserved,
    createdAt: audit.createdAt,
  };
}

export function filterDecisionCandidates(
  candidates: DecisionCandidateQueue[],
  filters: DecisionCandidateFilters,
): DecisionCandidateQueue[] {
  const limit = filters.limit ?? 50;
  return [...candidates]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((candidate) =>
      matches(candidate.kind, filters.kind) &&
      matches(candidate.status, filters.status) &&
      matches(candidate.project, filters.project) &&
      matches(candidate.agentId, filters.agentId) &&
      matches(candidate.decisionId, filters.decisionId) &&
      matches(candidate.candidateId, filters.candidateId) &&
      matchesCandidateSession(candidate, filters.sessionId)
    )
    .slice(0, limit);
}

export function compactDecisionCandidate(
  candidate: DecisionCandidateQueue,
): CompactDecisionCandidate {
  return {
    id: candidate.id,
    kind: candidate.kind,
    status: candidate.status,
    decisionId: candidate.decisionId,
    candidateId: candidate.candidateId,
    project: candidate.project,
    sessionId: candidate.sessionId,
    agentId: candidate.agentId,
    content: candidate.content,
    concepts: candidate.concepts,
    files: candidate.files,
    confidence: candidate.confidence,
    importance: candidate.importance,
    ttlDays: candidate.ttlDays,
    evidenceRefs: candidate.evidenceRefs,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    consumedAt: candidate.consumedAt,
    consumedBy: candidate.consumedBy,
  };
}
