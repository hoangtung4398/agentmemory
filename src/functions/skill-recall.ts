import type { ISdk } from "iii-sdk";
import { loadSkillConfig } from "../config.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { SkillRecallResult } from "../types.js";
import {
  evaluateSkillRecallPopulation,
  normalizeSkillRecallInput,
} from "./skill-recall-policy.js";

export { normalizeSkillRecallInput } from "./skill-recall-policy.js";
export { SKILL_RECALL_MAX_QUERY_LENGTH } from "./skill-recall-policy.js";
export type {
  SkillAdvisory,
  SkillRecallInput,
  SkillRecallInputParseResult,
  SkillRecallResult,
} from "../types.js";

export function registerSkillRecallFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::skill-recall",
    async (data: unknown): Promise<SkillRecallResult | { success: false; error: string }> => {
      const config = loadSkillConfig();
      if (!config.recallEnabled) {
        return { success: false, error: "Agent skill recall not enabled" };
      }
      const normalized = normalizeSkillRecallInput(data);
      if (!normalized.success) return normalized;
      const input = normalized.input;
      const limit = input.limit ?? config.recallLimit;
      const rows = await kv.list<unknown>(KV.skills);
      const evaluation = evaluateSkillRecallPopulation(
        rows,
        input,
        config.recallMinConfidence,
        limit,
      );
      return {
        success: true,
        enabled: true,
        scannedCount: evaluation.scannedCount,
        matchedCount: evaluation.matchedCount,
        returnedCount: evaluation.returnedCount,
        truncated: evaluation.truncated,
        privacySuppressedCount: evaluation.privacySuppressedCount,
        advisories: evaluation.advisories,
      };
    },
  );
}
