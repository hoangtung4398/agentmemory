import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
  DecisionCandidateQueue,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import {
  getConsolidationDecayDays,
  getDecisionCandidateBatchLimit,
  getDecisionCandidateMinEvidence,
  isConsolidationEnabled,
  isDecisionCandidateConsumptionEnabled,
} from "../config.js";
import { logger } from "../logger.js";

type CandidateKind = DecisionCandidateQueue["kind"];

interface CandidateConsumptionResult {
  scanned: number;
  consumed: number;
  expired: number;
  rejected: number;
  pending: number;
  semanticCreated: number;
  proceduralCreated: number;
}

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

function isValidKind(value: unknown): value is CandidateKind {
  return value === "semantic" || value === "procedural";
}

function candidateExpired(candidate: DecisionCandidateQueue, nowMs: number): boolean {
  if (!candidate.expiresAt) return false;
  const expiresAt = Date.parse(candidate.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function validPendingCandidate(candidate: DecisionCandidateQueue): boolean {
  return (
    candidate.status === "pending" &&
    isValidKind(candidate.kind) &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1 &&
    Number.isFinite(candidate.importance) &&
    candidate.importance >= 0 &&
    candidate.importance <= 10
  );
}

function candidateMatchesScope(
  candidate: DecisionCandidateQueue,
  data?: { project?: string },
): boolean {
  if (!data?.project) return true;
  return candidate.project === data.project;
}

function candidateGroupKey(candidate: DecisionCandidateQueue): string {
  const concept = candidate.concepts[0]?.toLowerCase();
  const file = candidate.files[0]?.toLowerCase();
  const contentKey = candidate.content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 8)
    .join(" ");
  return [
    candidate.kind,
    candidate.project ?? "",
    candidate.agentId ?? "",
    concept || file || contentKey,
  ].join("|");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function sourceSessionIds(candidates: DecisionCandidateQueue[]): string[] {
  return uniqueStrings([
    ...candidates.map((candidate) => candidate.sessionId),
    ...candidates.flatMap((candidate) =>
      candidate.evidenceRefs.map((ref) => ref.sessionId),
    ),
  ]);
}

function sourceObservationIds(candidates: DecisionCandidateQueue[]): string[] {
  return uniqueStrings(
    candidates.flatMap((candidate) =>
      candidate.evidenceRefs
        .filter((ref) => ref.kind === "observation")
        .map((ref) => ref.id),
    ),
  );
}

function sourceMemoryIds(candidates: DecisionCandidateQueue[]): string[] {
  return uniqueStrings(
    candidates.flatMap((candidate) =>
      candidate.evidenceRefs
        .filter((ref) => ref.kind === "memory")
        .map((ref) => ref.id),
    ),
  );
}

function averageConfidence(candidates: DecisionCandidateQueue[]): number {
  const total = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0);
  return Math.max(0.1, Math.min(1, total / Math.max(1, candidates.length)));
}

function semanticFact(candidates: DecisionCandidateQueue[]): string {
  return candidates
    .map((candidate) => candidate.content.replace(/\s+/g, " ").trim())
    .sort((a, b) => a.length - b.length)[0]
    .slice(0, 500);
}

function proceduralName(candidates: DecisionCandidateQueue[]): string {
  const concept = candidates.flatMap((candidate) => candidate.concepts)[0];
  if (concept) return concept.replace(/\s+/g, " ").trim().slice(0, 80);
  return candidates[0].content
    .replace(/^(successful\s+)?procedure\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Candidate workflow";
}

function proceduralSteps(candidates: DecisionCandidateQueue[]): string[] {
  const text = candidates.map((candidate) => candidate.content).join("\n");
  const numbered = text
    .split(/\n+/)
    .map((line) => line.match(/^\s*(?:\d+\.|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  if (numbered.length >= 2) return numbered.slice(0, 12);

  const afterColon = text.replace(/^(?:successful\s+)?procedure\s*:\s*/i, "");
  const parts = afterColon
    .split(/\b(?:first|then|next|finally)\b|[.;]\s*/i)
    .map((part) => part.replace(/^[\s,:-]+/, "").trim())
    .filter((part) => part.length > 0);
  return uniqueStrings(parts).slice(0, 12);
}

async function markCandidate(
  kv: StateKV,
  candidate: DecisionCandidateQueue,
  updates: Partial<DecisionCandidateQueue>,
): Promise<void> {
  await kv.set(KV.decisionCandidates, candidate.id, {
    ...candidate,
    ...updates,
  });
}

async function consumeSemanticCandidates(
  kv: StateKV,
  groups: DecisionCandidateQueue[][],
  minEvidence: number,
  now: string,
  result: CandidateConsumptionResult,
): Promise<void> {
  const existing = await kv.list<SemanticMemory>(KV.semantic);
  for (const group of groups) {
    if (group.length < minEvidence) {
      result.pending += group.length;
      continue;
    }
    const fact = semanticFact(group);
    const confidence = averageConfidence(group);
    const existingMatch = existing.find(
      (semantic) => semantic.fact.toLowerCase() === fact.toLowerCase(),
    );
    if (existingMatch) {
      existingMatch.accessCount++;
      existingMatch.lastAccessedAt = now;
      existingMatch.updatedAt = now;
      existingMatch.confidence = Math.max(existingMatch.confidence, confidence);
      existingMatch.strength = Math.max(existingMatch.strength, confidence);
      await kv.set(KV.semantic, existingMatch.id, existingMatch);
    } else {
      const semantic: SemanticMemory = {
        id: generateId("sem"),
        fact,
        confidence,
        sourceSessionIds: sourceSessionIds(group),
        sourceMemoryIds: sourceMemoryIds(group),
        accessCount: 1,
        lastAccessedAt: now,
        strength: confidence,
        createdAt: now,
        updatedAt: now,
      };
      await kv.set(KV.semantic, semantic.id, semantic);
      existing.push(semantic);
      result.semanticCreated++;
    }
    for (const candidate of group) {
      await markCandidate(kv, candidate, {
        status: "consumed",
        consumedAt: now,
        consumedBy: "mem::consolidation-pipeline",
      });
      result.consumed++;
    }
  }
}

async function consumeProceduralCandidates(
  kv: StateKV,
  groups: DecisionCandidateQueue[][],
  minEvidence: number,
  now: string,
  result: CandidateConsumptionResult,
): Promise<void> {
  const existing = await kv.list<ProceduralMemory>(KV.procedural);
  for (const group of groups) {
    const steps = proceduralSteps(group);
    if (group.length < minEvidence || steps.length < 2) {
      result.pending += group.length;
      continue;
    }
    const name = proceduralName(group);
    const existingMatch = existing.find(
      (procedure) => procedure.name.toLowerCase() === name.toLowerCase(),
    );
    if (existingMatch) {
      existingMatch.frequency += group.length;
      existingMatch.updatedAt = now;
      existingMatch.strength = Math.min(1, existingMatch.strength + 0.1);
      await kv.set(KV.procedural, existingMatch.id, existingMatch);
    } else {
      const procedure: ProceduralMemory = {
        id: generateId("proc"),
        name,
        steps,
        triggerCondition: "When related workflow evidence recurs",
        frequency: group.length,
        sourceSessionIds: sourceSessionIds(group),
        sourceObservationIds: sourceObservationIds(group),
        tags: uniqueStrings(group.flatMap((candidate) => candidate.concepts)),
        concepts: uniqueStrings(group.flatMap((candidate) => candidate.concepts)),
        strength: averageConfidence(group),
        createdAt: now,
        updatedAt: now,
      };
      await kv.set(KV.procedural, procedure.id, procedure);
      existing.push(procedure);
      result.proceduralCreated++;
    }
    for (const candidate of group) {
      await markCandidate(kv, candidate, {
        status: "consumed",
        consumedAt: now,
        consumedBy: "mem::consolidation-pipeline",
      });
      result.consumed++;
    }
  }
}

async function consumeDecisionCandidates(
  kv: StateKV,
  kinds: Set<CandidateKind>,
  data?: { project?: string },
): Promise<CandidateConsumptionResult | null> {
  if (!isDecisionCandidateConsumptionEnabled()) return null;

  const limit = getDecisionCandidateBatchLimit();
  const minEvidence = getDecisionCandidateMinEvidence();
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const candidates = (await kv.list<DecisionCandidateQueue>(KV.decisionCandidates))
    .filter((candidate) => candidate.status === "pending")
    .filter((candidate) => !isValidKind(candidate.kind) || kinds.has(candidate.kind))
    .filter((candidate) => candidateMatchesScope(candidate, data))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);

  if (candidates.length === 0) return null;

  const result: CandidateConsumptionResult = {
    scanned: candidates.length,
    consumed: 0,
    expired: 0,
    rejected: 0,
    pending: 0,
    semanticCreated: 0,
    proceduralCreated: 0,
  };
  const valid: DecisionCandidateQueue[] = [];

  for (const candidate of candidates) {
    if (candidateExpired(candidate, nowMs)) {
      await markCandidate(kv, candidate, { status: "expired" });
      result.expired++;
    } else if (!validPendingCandidate(candidate)) {
      await markCandidate(kv, candidate, { status: "rejected" });
      result.rejected++;
    } else {
      valid.push(candidate);
    }
  }

  const grouped = new Map<string, DecisionCandidateQueue[]>();
  for (const candidate of valid) {
    const key = candidateGroupKey(candidate);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(candidate);
  }

  const semanticGroups = [...grouped.values()].filter((group) => group[0].kind === "semantic");
  const proceduralGroups = [...grouped.values()].filter((group) => group[0].kind === "procedural");

  await consumeSemanticCandidates(kv, semanticGroups, minEvidence, now, result);
  await consumeProceduralCandidates(kv, proceduralGroups, minEvidence, now, result);
  return result;
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  const handler = async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);
        const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const prompt = buildSemanticMergePrompt(
            recentSummaries.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              concepts: s.concepts,
            })),
          );

          try {
            const response = await provider.summarize(
              SEMANTIC_MERGE_SYSTEM,
              prompt,
            );

            const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
            let match;
            let newFacts = 0;
            const now = new Date().toISOString();

            while ((match = factRegex.exec(response)) !== null) {
              const parsedConf = parseFloat(match[1]);
              const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
              const fact = match[2].trim();

              const existing = existingSemantic.find(
                (s) => s.fact.toLowerCase() === fact.toLowerCase(),
              );
              if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = now;
                existing.updatedAt = now;
                existing.confidence = Math.max(existing.confidence, confidence);
                await kv.set(KV.semantic, existing.id, existing);
              } else {
                const sem: SemanticMemory = {
                  id: generateId("sem"),
                  fact,
                  confidence,
                  sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                  sourceMemoryIds: [],
                  accessCount: 1,
                  lastAccessedAt: now,
                  strength: confidence,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.semantic, sem.id, sem);
                newFacts++;
              }
            }
            results.semantic = { newFacts, totalSummaries: summaries.length };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Semantic consolidation failed", { error: msg });
            results.semantic = { error: msg };
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project: data?.project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((m) => ({
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      const candidateKinds = new Set<CandidateKind>();
      if (tier === "all" || tier === "semantic") candidateKinds.add("semantic");
      if (tier === "all" || tier === "procedural") candidateKinds.add("procedural");
      if (candidateKinds.size > 0) {
        try {
          const consumed = await consumeDecisionCandidates(kv, candidateKinds, data);
          if (consumed) results.decisionCandidates = consumed;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Decision candidate consumption failed", { error: msg });
          results.decisionCandidates = { error: msg };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        applyDecay(semantic, decayDays);
        for (const s of semantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        applyDecay(procedural, decayDays);
        for (const p of procedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: semantic.length,
          procedural: procedural.length,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    };

  sdk.registerFunction("mem::consolidation-pipeline", handler);
  // Legacy compatibility alias for existing callers, REST routes, and MCP tools.
  sdk.registerFunction("mem::consolidate-pipeline", handler);
}
