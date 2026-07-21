import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type {
  SkillFeedbackAggregate,
  SkillFeedbackAttribution,
  SkillFeedbackEvent,
  SkillFeedbackKind,
} from "../types.js";
import {
  isSkillFeedbackAttribution,
  isSkillFeedbackKind,
  isValidSkillFeedbackEvent,
  MAX_SKILL_FEEDBACK_ID_LENGTH,
  MAX_SKILL_FEEDBACK_SCOPE_LENGTH,
} from "./skill-feedback-model.js";

const MAX_DIAGNOSTICS_LIMIT = 500;

export interface SkillFeedbackDiagnosticsInput {
  skillId?: unknown;
  skillVersion?: unknown;
  kind?: unknown;
  attribution?: unknown;
  project?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  limit?: unknown;
}

export interface SkillFeedbackDiagnosticsFilters {
  skillId: string;
  skillVersion?: number;
  kind?: SkillFeedbackKind;
  attribution?: SkillFeedbackAttribution;
  project?: string;
  agentId?: string;
  sessionId?: string;
  limit: number;
}

export interface SkillFeedbackDiagnosticsResult {
  success: boolean;
  enabled: boolean;
  filters?: SkillFeedbackDiagnosticsFilters;
  scannedCount: number;
  validCount: number;
  malformedCount: number;
  matchedCount: number;
  returnedCount: number;
  truncated: boolean;
  aggregate: SkillFeedbackAggregate;
  events: SkillFeedbackEvent[];
  reason?: string;
}

function zeroAggregate(): SkillFeedbackAggregate {
  return {
    total: 0,
    byKind: { success: 0, failure: 0, correction: 0, stale: 0 },
    byAttribution: { "user-confirmed": 0, "agent-observed": 0 },
    byVersion: [],
  };
}

function result(
  success: boolean,
  enabled: boolean,
  reason?: string,
): SkillFeedbackDiagnosticsResult {
  return {
    success,
    enabled,
    scannedCount: 0,
    validCount: 0,
    malformedCount: 0,
    matchedCount: 0,
    returnedCount: 0,
    truncated: false,
    aggregate: zeroAggregate(),
    events: [],
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function optionalString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  return normalizedString(value, maxLength) ?? null;
}

function optionalPositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalLimit(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DIAGNOSTICS_LIMIT
    ? value
    : undefined;
}

function normalizeFilters(
  input: SkillFeedbackDiagnosticsInput | undefined,
  defaultLimit: number,
): SkillFeedbackDiagnosticsFilters | undefined {
  const skillId = normalizedString(input?.skillId, MAX_SKILL_FEEDBACK_ID_LENGTH);
  const skillVersion = optionalPositiveInteger(input?.skillVersion);
  const project = optionalString(input?.project, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
  const agentId = optionalString(input?.agentId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
  const sessionId = optionalString(input?.sessionId, MAX_SKILL_FEEDBACK_SCOPE_LENGTH);
  const limit = optionalLimit(input?.limit, defaultLimit);

  if (
    !skillId ||
    skillVersion === null ||
    project === null ||
    agentId === null ||
    sessionId === null ||
    limit === undefined ||
    (input?.kind !== undefined && !isSkillFeedbackKind(input.kind)) ||
    (input?.attribution !== undefined && !isSkillFeedbackAttribution(input.attribution))
  ) {
    return undefined;
  }

  return {
    skillId,
    ...(skillVersion === undefined ? {} : { skillVersion }),
    ...(input?.kind === undefined ? {} : { kind: input.kind }),
    ...(input?.attribution === undefined ? {} : { attribution: input.attribution }),
    ...(project === undefined ? {} : { project }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    limit,
  };
}

function matchesFilters(event: SkillFeedbackEvent, filters: SkillFeedbackDiagnosticsFilters): boolean {
  return event.skillId === filters.skillId &&
    (filters.skillVersion === undefined || event.skillVersion === filters.skillVersion) &&
    (filters.kind === undefined || event.kind === filters.kind) &&
    (filters.attribution === undefined || event.attribution === filters.attribution) &&
    (filters.project === undefined || event.project === filters.project) &&
    (filters.agentId === undefined || event.agentId === filters.agentId) &&
    (filters.sessionId === undefined || event.sessionId === filters.sessionId);
}

function sortEvents(events: SkillFeedbackEvent[]): SkillFeedbackEvent[] {
  return [...events].sort((a, b) => {
    const timestampDifference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return timestampDifference !== 0 ? timestampDifference : a.id.localeCompare(b.id);
  });
}

function aggregateEvents(events: SkillFeedbackEvent[]): SkillFeedbackAggregate {
  const aggregate = zeroAggregate();
  const versions = new Map<number, SkillFeedbackAggregate["byVersion"][number]>();

  for (const event of events) {
    aggregate.total++;
    aggregate.byKind[event.kind]++;
    aggregate.byAttribution[event.attribution]++;
    const version = versions.get(event.skillVersion) ?? {
      skillVersion: event.skillVersion,
      total: 0,
      success: 0,
      failure: 0,
      correction: 0,
      stale: 0,
    };
    version.total++;
    version[event.kind]++;
    versions.set(event.skillVersion, version);
  }

  aggregate.byVersion = Array.from(versions.values()).sort((a, b) => a.skillVersion - b.skillVersion);
  const sorted = sortEvents(events);
  if (sorted.length > 0) {
    aggregate.latestCreatedAt = sorted[0]!.createdAt;
    aggregate.earliestCreatedAt = sorted[sorted.length - 1]!.createdAt;
  }
  return aggregate;
}

function copyEvent(event: SkillFeedbackEvent): SkillFeedbackEvent {
  return {
    ...event,
    sourceObservationIds: [...event.sourceObservationIds],
    sourceSessionIds: [...event.sourceSessionIds],
  };
}

export function registerSkillFeedbackDiagnosticsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-feedback-diagnostics",
    async (data: SkillFeedbackDiagnosticsInput | undefined): Promise<SkillFeedbackDiagnosticsResult> => {
      const config = loadSkillConfig();
      if (!config.feedbackDiagnosticsEnabled) {
        return result(true, false, "skill feedback diagnostics are disabled");
      }

      const filters = normalizeFilters(data, config.feedbackDiagnosticsLimit);
      if (!filters) return result(false, true, "invalid skill feedback diagnostics input");

      let rows: unknown[];
      try {
        rows = await kv.list<unknown>(KV.skillFeedback);
      } catch {
        return result(false, true, "failed to load skill feedback diagnostics");
      }

      const validEvents = rows.filter((row): row is SkillFeedbackEvent => isValidSkillFeedbackEvent(row));
      const matchedEvents = sortEvents(validEvents.filter((event) => matchesFilters(event, filters)));
      const events = matchedEvents.slice(0, filters.limit).map(copyEvent);
      return {
        success: true,
        enabled: true,
        filters,
        scannedCount: rows.length,
        validCount: validEvents.length,
        malformedCount: rows.length - validEvents.length,
        matchedCount: matchedEvents.length,
        returnedCount: events.length,
        truncated: matchedEvents.length > events.length,
        aggregate: aggregateEvents(matchedEvents),
        events,
      };
    },
  );
}
