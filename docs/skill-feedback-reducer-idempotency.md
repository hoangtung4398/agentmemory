# Skill Feedback Reducer Idempotency Contract

## 3.1 Status and authorization boundary

Phase 3A is implemented and merged. It provides the read-only
`mem::skill-feedback-reduction-plan` planner. This document defines only the
proposed Phase 3B application contract. No Phase 3B write implementation
exists, and approving this document does not authorize one. A separate
implementation milestone and explicit authorization are required.

## 3.2 Existing contracts

- Planner: `mem::skill-feedback-reduction-plan`.
- Gate: `AGENTMEMORY_SKILL_FEEDBACK_REDUCER`.
- Planner path: one `KV.skills` get, one `KV.skillFeedback` list,
  `applied: false`, and zero writes.
- Counters: `AgentSkill.successCount` and `AgentSkill.failureCount`.
- Evidence: append-only `SkillFeedbackEvent` ledger.

The current mapping is `success -> success +1`, `failure -> failure +1`,
`correction -> failure +1`, and `stale -> no counter delta`. Phase 3A
`proposedCounters` must not be persisted directly because it is calculated from
current counters plus the complete applicable evidence set; replay would
double-count evidence.

## 3.3 Goals

Future Phase 3B must provide logical exactly-once counter effects for an
unchanged evidence set, retry safety, deterministic results, compatibility with
historical append-only feedback, and independence from the feedback writer. It
must not mutate or consume feedback, increment twice, leave partial counter
state, silently overwrite a concurrent skill change, or apply a wrong version.

## 3.4 Non-goals

Phase 3B excludes confidence, strength, `usageCount`, status, retirement,
supersession, version increments, feedback inference, automatic reinforcement,
event deletion/consumption, REST, MCP, hooks, scheduling, ranking, vector
search, embeddings, graph/search behavior, promotion, and recall.

## 3.5 Threat and failure model

The future implementation must handle repeated application, same-process and
multi-process concurrency, crashes before/after write, feedback arriving
between plan/apply, stale versions, changed counters, malformed rows, duplicate
IDs, unexpectedly altered or removed rows, failed reads/writes, and timeouts
with unknown write outcome. Each case returns apply, no-op, conflict, integrity
failure, read failure, write failure, or write outcome unknown. No case uses
best-effort counter mutation.

## 4. Selected idempotency design

### 4.1 Single authoritative record

Authoritative idempotency state is colocated with the `AgentSkill` record. A
future application updates counters and reduction metadata in one conditional,
atomic write to the same `KV.skills` key.

Do not use per-event receipts, a separate application key, event-consumed
markers, or audit rows as the authority. Updating a skill plus a separate
receipt requires a multi-key transaction, which the current `StateKV` wrapper
does not expose.

### 4.2 Proposed additive metadata contract

```ts
interface AgentSkillFeedbackReductionState {
  schemaVersion: 1;
  skillVersion: number;
  baselineSuccessCount: number;
  baselineFailureCount: number;
  evidenceHash: string;
  applicableEventCount: number;
  appliedSuccessDelta: number;
  appliedFailureDelta: number;
  appliedAt: string;
}

interface AgentSkill {
  feedbackReduction?: AgentSkillFeedbackReductionState;
}
```

This is design-only. Do not add it to `src/types.ts` in this milestone.

### 4.3 Baseline rule

On first successful apply for a skill version:

```text
baselineSuccessCount = current skill.successCount
baselineFailureCount = current skill.failureCount
targetSuccessCount = baselineSuccessCount + aggregateSuccessDelta
targetFailureCount = baselineFailureCount + aggregateFailureDelta
```

Never calculate persisted targets as current counters plus the complete ledger
aggregate. Immutable baseline plus full aggregate is the idempotency guarantee.

### 4.4 Version rule

Reduction state is scoped to one exact `AgentSkill.version`. Without state,
initialize a baseline only during the first authorized apply. Matching state
reuses the immutable baseline. Older state may be atomically replaced with a
new-version baseline from current counters, excluding old-version feedback. A
state version greater than the skill version is integrity failure. A
caller-supplied version differing from the current version is conflict; both
perform no write.

## 5. Canonical evidence fingerprint

Use Phase 3A selection rules: matching skill ID/current version, exact requested
project and agent scope, no skill-scope contradiction, and valid feedback rows.
Sort `createdAt` descending then `id` ascending for equal timestamps.

Canonicalize each event with fixed key order:

```ts
{ id, skillId, skillVersion, kind, attribution, source, project, agentId,
  sessionId, sourceObservationIds, sourceSessionIds, createdAt }
```

Absent optionals use one documented representation; validated array order is
preserved; key order is fixed by the canonical serializer; locale-sensitive
comparison is prohibited. Compute lowercase hexadecimal SHA-256:

```text
evidenceHash = sha256(canonicalApplicableEvents)
```

The hash detects appended/altered evidence, kind/scope/version changes, and
canonicalization order defects. Count or latest timestamp alone is insufficient.

## 6. Replay, append, and no-op rules

When stored and recomputed hashes match, stored deltas match the derived
absolute target, and current counters equal that target, return successful no-op
with `alreadyApplied: true` and write nothing. A matching hash with divergent
counters is integrity conflict; do not repair silently. A stale caller hash is
conflict before write.

For new evidence, recompute the full aggregate from immutable baseline and
conditionally write new absolute targets. A changed hash never permits
incremental addition to current counters.

Initial Phase 3B selects full recomputation rather than a digest chain. It must
detect applicable-event count regression and duplicate IDs. It cannot
cryptographically prove equal-sized replacement without the full hash changing;
a changed hash still recomputes from baseline rather than adding incrementally.

## 7. Duplicate event ID contract

All valid applicable event IDs must be unique before any future write. Duplicate
applicable IDs are integrity failure: no write, no silent deduplication, and no
first/last selection. Malformed rows remain counted and skipped as in Phase 3A;
duplicate valid IDs are not malformed rows.

## 8. Atomicity and concurrency contract

`withKeyedLock` is process-local only. A future implementation may use
`withKeyedLock("skill-feedback-reducer:<skillId>")` to reduce same-process
duplication, but it must not claim multi-worker safety.

Production application requires a conditional single-key operation equivalent
to:

```ts
compareAndSet(KV.skills, skillId, expectedRevisionOrFingerprint, replacementSkill)
```

Preconditions cover skill ID, skill version, success/failure counters, and
reduction metadata fingerprint/state. A failed precondition returns conflict;
rereading/replanning may be offered, but stale writes do not retry automatically.

> Phase 3B write implementation is blocked until source inspection and
> concurrency tests prove conditional state semantics, or a separately reviewed
> CAS primitive is added.

Plain `kv.get` followed by `kv.set` is not safe. The in-process lock is not a
distributed atomicity guarantee.

## 9. Future internal function contract

The future function is internal-only: `mem::skill-feedback-reduction-apply`.

```ts
interface SkillFeedbackReductionApplyInput {
  skillId: string;
  skillVersion: number;
  expectedEvidenceHash: string;
  project?: string;
  agentId?: string;
}

interface SkillFeedbackReductionApplyResult {
  success: boolean;
  enabled: boolean;
  applied: boolean;
  alreadyApplied: boolean;
  conflict: boolean;
  skillId?: string;
  skillVersion?: number;
  evidenceHash?: string;
  applicableEventCount?: number;
  previousCounters?: { success: number; failure: number };
  resultingCounters?: { success: number; failure: number };
  appliedDelta?: { success: number; failure: number };
  reason?: string;
}
```

Apply recomputes evidence inside the protected conditional path, requires the
expected hash, never trusts caller deltas/counters, rejects stale hashes, and
never accepts arbitrary delta input. Stable reasons include disabled, invalid
input, skill not found, version conflict, stale hash, duplicate ID, evidence
regression, reduction-state integrity failure, skill changed during application,
failed read/apply, and write outcome unknown.

## 10. Write sequence contract

The future sequence is gate; validation; process-local lock; read skill; read
and validate ledger; select current-version evidence; reject duplicate IDs;
canonicalize/hash; compare caller hash; derive baseline; calculate absolute
targets; preserve unrelated fields in a replacement; execute one conditional
atomic write; return applied/no-op/conflict.

It must not write feedback, mark events consumed, update a separate authority,
perform two independent writes, or mutate counters before the final write.

## 11. Field-preservation contract

A replacement preserves `id`, `name`, `triggerCondition`, `steps`,
`expectedOutcome`, `antiPatterns`, project/agent/files/concepts, confidence,
strength, `usageCount`, all source IDs, `createdAt`, last-use/reinforcement
timestamps, status, supersedes, and version. Only `successCount`,
`failureCount`, `updatedAt`, and `feedbackReduction` may change. `updatedAt`
changes only for actual apply, never no-op replay.

## 12. Audit contract

Audit is not authoritative idempotency state. The first write milestone needs no
separate audit unless separately authorized. An optional audit is outside the
critical atomicity path; its failure must not cause replay. Skill-local metadata
remains authoritative. This design changes no audit code.

## 13. Migration and compatibility

Existing skills without `feedbackReduction` remain valid. The field is optional
and additive; no startup migration, key-format change, or feedback-shape change
runs. Historical append-only evidence remains readable. The future apply gate
is independent of the writer; Phase 3A remains read-only and unchanged while
the apply gate is disabled.

## 14. Alternatives rejected

Separate receipts require multi-key atomicity. Consumed-event markers mutate
append-only evidence. Audit rows are observability, not transaction authority.
Current counters plus incremental deltas double-count replay. A process-local
mutex cannot protect multiple processes.

## 15. Future implementation gates

1. Phase 3B1: read-only planner-contract hardening.
2. Phase 3B2: proven conditional state primitive.
3. Phase 3B3: internal apply implementation.
4. Phase 3B4: optional reviewed surface.

Each needs its own design, tests, review, and authorization.

## 16. Relationship to the skill-layer roadmap

Phase 3A is implemented read-only planning. This is the Phase 3B idempotency
and atomicity contract, not implementation. Phase 4 lifecycle work remains
separate. Do not mark Phase 3B implemented.

## 17. Prohibited changes

This milestone does not change source, tests, configuration, state layer,
generated references, REST/MCP/hooks, or tool counts. It adds no metadata in
code, CAS primitive, receipt scope, apply function, environment variable, or
ranking/search change.

## 18. Documentation validation

The design PR changes only this file and `docs/skill-layer-design.md`. Run
TypeScript, build, skills check, full tests, and `git diff --check`. Surface
counts remain 60 MCP tools and 135 REST registrations.

## 19. Commit and push

Use one signed-off `docs: design skill feedback reducer idempotency` commit on
`docs/skill-feedback-reducer-idempotency-design`. Do not amend, rebase,
force-push, add cleanup commits, or modify source after validation.

## 20. Post-push verification

The branch must be clean, one ahead, zero behind, identical locally/remotely,
and differ from `main` in exactly these two documentation files.

## 21. Draft PR

Open a Draft PR titled `docs: design skill feedback reducer idempotency` from
`docs/skill-feedback-reducer-idempotency-design` to `main`. Do not mark Ready,
request reviewers, add labels, enable auto-merge, or start Phase 3B1.

## 22. CI policy

All Ubuntu/macOS Node 20/22 jobs must pass install, build, skills check, and
full tests. On failure, report run/job/step/error and classify documentation,
tooling, existing regression, or environment. Do not rerun or patch automatically.

## 23. Review policy

After CI, inspect comments, reviews, requested changes, inline comments, and
unresolved threads once. Classify findings as design blocker, valid
clarification, implementation-phase request, or unrelated. Do not address
comments, mark Ready, or merge in the same run; each requires separate explicit
authorization.

## 24. Report and stop

Report branch/commit state, the exact two files, selected single-record design,
baseline/hash/replay/duplicate/version/concurrency rules, validation/CI/review
state, and confirmation that no source, test, generated, or configuration file
changed. Then stop.
