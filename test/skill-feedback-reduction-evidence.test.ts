import { describe, expect, it } from "vitest";
import {
  buildSkillFeedbackReductionEvidence,
  findDuplicateSkillFeedbackEventIds,
  sortSkillFeedbackEvents,
} from "../src/functions/skill-feedback-reduction-evidence.js";
import type { SkillFeedbackEvent } from "../src/types.js";

function event(id: string, overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId: "skill_release",
    skillVersion: 2,
    kind: "success",
    attribution: "user-confirmed",
    source: "explicit",
    sourceObservationIds: [],
    sourceSessionIds: [],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("skill feedback reduction evidence", () => {
  it("sorts by timestamp descending then ID ascending and hashes canonical JSON", () => {
    const sorted = sortSkillFeedbackEvents([
      event("z", { createdAt: "2026-07-21T00:00:01.000Z" }),
      event("b", { createdAt: "2026-07-21T00:00:02.000Z" }),
      event("a", { createdAt: "2026-07-21T00:00:02.000Z" }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "z"]);
    expect(buildSkillFeedbackReductionEvidence(sorted)).toEqual({
      canonicalJson: "[{\"id\":\"a\",\"skillId\":\"skill_release\",\"skillVersion\":2,\"kind\":\"success\",\"attribution\":\"user-confirmed\",\"source\":\"explicit\",\"project\":null,\"agentId\":null,\"sessionId\":null,\"sourceObservationIds\":[],\"sourceSessionIds\":[],\"createdAt\":\"2026-07-21T00:00:02.000Z\"},{\"id\":\"b\",\"skillId\":\"skill_release\",\"skillVersion\":2,\"kind\":\"success\",\"attribution\":\"user-confirmed\",\"source\":\"explicit\",\"project\":null,\"agentId\":null,\"sessionId\":null,\"sourceObservationIds\":[],\"sourceSessionIds\":[],\"createdAt\":\"2026-07-21T00:00:02.000Z\"},{\"id\":\"z\",\"skillId\":\"skill_release\",\"skillVersion\":2,\"kind\":\"success\",\"attribution\":\"user-confirmed\",\"source\":\"explicit\",\"project\":null,\"agentId\":null,\"sessionId\":null,\"sourceObservationIds\":[],\"sourceSessionIds\":[],\"createdAt\":\"2026-07-21T00:00:01.000Z\"}]",
      evidenceHash: "fc159c629ae628c04377e382a86dcb4a8e57f92c51d875641b559823abcfbae2",
    });
  });

  it("reports each duplicate ID once in ascending order", () => {
    expect(findDuplicateSkillFeedbackEventIds([
      event("b"), event("a"), event("b"), event("a"), event("c"),
    ])).toEqual(["a", "b"]);
  });
});
