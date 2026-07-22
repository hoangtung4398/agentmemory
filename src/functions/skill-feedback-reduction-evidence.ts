import { createHash } from "node:crypto";
import type { SkillFeedbackEvent } from "../types.js";

export interface SkillFeedbackReductionEvidence {
  canonicalJson: string;
  evidenceHash: string;
}

export function sortSkillFeedbackEvents(events: SkillFeedbackEvent[]): SkillFeedbackEvent[] {
  return [...events].sort((a, b) => {
    const timestampDifference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (timestampDifference !== 0) return timestampDifference;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

export function findDuplicateSkillFeedbackEventIds(events: SkillFeedbackEvent[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const event of events) {
    if (seen.has(event.id)) duplicates.add(event.id);
    seen.add(event.id);
  }

  return [...duplicates].sort();
}

export function canonicalizeSkillFeedbackEvents(events: SkillFeedbackEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    id: event.id,
    skillId: event.skillId,
    skillVersion: event.skillVersion,
    kind: event.kind,
    attribution: event.attribution,
    source: event.source,
    project: event.project ?? null,
    agentId: event.agentId ?? null,
    sessionId: event.sessionId ?? null,
    sourceObservationIds: event.sourceObservationIds,
    sourceSessionIds: event.sourceSessionIds,
    createdAt: event.createdAt,
  })));
}

export function buildSkillFeedbackReductionEvidence(
  events: SkillFeedbackEvent[],
): SkillFeedbackReductionEvidence {
  const canonicalJson = canonicalizeSkillFeedbackEvents(events);
  return {
    canonicalJson,
    evidenceHash: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  };
}
