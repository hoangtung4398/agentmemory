import { describe, expect, it } from "vitest";
import {
  buildSkillFeedbackReductionEvidence,
  canonicalizeSkillFeedbackEvents,
  findDuplicateSkillFeedbackEventIds,
  sortSkillFeedbackEvents,
} from "../src/functions/skill-feedback-reduction-evidence.js";
import type { SkillFeedbackEvent } from "../src/types.js";

function event(id: string, overrides: Partial<SkillFeedbackEvent> = {}): SkillFeedbackEvent {
  return {
    id,
    skillId: "skill-1",
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
  it("uses the approved canonical vector and fixed SHA-256 hash", () => {
    const evidence = buildSkillFeedbackReductionEvidence([
      event("evt-1", { sourceObservationIds: ["obs-2", "obs-1"] }),
    ]);

    expect(evidence.canonicalJson).toBe(
      "[{\"id\":\"evt-1\",\"skillId\":\"skill-1\",\"skillVersion\":2,\"kind\":\"success\",\"attribution\":\"user-confirmed\",\"source\":\"explicit\",\"project\":null,\"agentId\":null,\"sessionId\":null,\"sourceObservationIds\":[\"obs-2\",\"obs-1\"],\"sourceSessionIds\":[],\"createdAt\":\"2026-07-21T00:00:00.000Z\"}]",
    );
    expect(evidence.evidenceHash).toBe("60594b2e3280f6f3e151a39c45c4cd229177d99886469bf0466fc0036ed1680c");
  });

  it("uses the fixed empty-evidence representation and hash", () => {
    expect(buildSkillFeedbackReductionEvidence([])).toEqual({
      canonicalJson: "[]",
      evidenceHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    });
  });

  it("canonicalizes optional fields as null in the documented key order", () => {
    const canonicalJson = canonicalizeSkillFeedbackEvents([
      event("evt-1", { sourceObservationIds: ["obs-2", "obs-1"], sourceSessionIds: ["session-2", "session-1"] }),
    ]);

    expect(canonicalJson).toBe(
      "[{\"id\":\"evt-1\",\"skillId\":\"skill-1\",\"skillVersion\":2,\"kind\":\"success\",\"attribution\":\"user-confirmed\",\"source\":\"explicit\",\"project\":null,\"agentId\":null,\"sessionId\":null,\"sourceObservationIds\":[\"obs-2\",\"obs-1\"],\"sourceSessionIds\":[\"session-2\",\"session-1\"],\"createdAt\":\"2026-07-21T00:00:00.000Z\"}]",
    );
    expect(canonicalJson).not.toContain(" ");
  });

  it("sorts by timestamp descending then by case-sensitive UTF-16 ID order without mutating input", () => {
    const input = [
      event("\uE000", { createdAt: "2026-07-21T00:00:00.000Z" }),
      event("z", { createdAt: "2026-07-21T00:00:01.000Z" }),
      event("B", { createdAt: "2026-07-21T00:00:02.000Z" }),
      event("a", { createdAt: "2026-07-21T00:00:02.000Z" }),
      event("😀", { createdAt: "2026-07-21T00:00:00.000Z" }),
    ];
    const before = JSON.stringify(input);

    expect(sortSkillFeedbackEvents(input).map((item) => item.id)).toEqual(["B", "a", "z", "😀", "\uE000"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("finds unique duplicate IDs in UTF-16 ascending order without mutating input", () => {
    const input = [event("\uE000"), event("😀"), event("\uE000"), event("😀"), event("a")];
    const before = JSON.stringify(input);

    expect(findDuplicateSkillFeedbackEventIds(input)).toEqual(["😀", "\uE000"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ["kind", { kind: "failure" }],
    ["attribution", { attribution: "agent-observed" }],
    ["project", { project: "project-a" }],
    ["agentId", { agentId: "agent-a" }],
    ["sessionId", { sessionId: "session-a" }],
    ["source observation order", { sourceObservationIds: ["obs-2", "obs-1"] }],
    ["source session order", { sourceSessionIds: ["session-2", "session-1"] }],
    ["createdAt", { createdAt: "2026-07-22T00:00:00.000Z" }],
  ] as const)("changes the hash when %s changes", (_name, overrides) => {
    const baseline = buildSkillFeedbackReductionEvidence([event("evt-1", {
      sourceObservationIds: ["obs-1", "obs-2"],
      sourceSessionIds: ["session-1", "session-2"],
    })]);
    const changed = buildSkillFeedbackReductionEvidence([event("evt-1", {
      sourceObservationIds: ["obs-1", "obs-2"],
      sourceSessionIds: ["session-1", "session-2"],
      ...overrides,
    })]);

    expect(changed.evidenceHash).not.toBe(baseline.evidenceHash);
  });

  it("does not mutate events or source evidence arrays while building evidence", () => {
    const input = [event("evt-1", { sourceObservationIds: ["obs-2", "obs-1"], sourceSessionIds: ["session-2", "session-1"] })];
    const before = JSON.stringify(input);

    buildSkillFeedbackReductionEvidence(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});
