# Skill Feedback Reducer Idempotency Contract

## 3.1 Status and authorization boundary

Phase 3A is implemented and merged. It provides the read-only
`mem::skill-feedback-reduction-plan` planner. This document defines only the
proposed Phase 3B application contract. No Phase 3B write implementation
exists, and approving this document does not authorize one. A separate
implementation milestone and explicit authorization are required.

## 3.2 Existing contracts

- Planner: `mem::skill-feedback-reduction-plan`.
- Gate: `AGENTMEMORY_SKILL_FEEDBACK_REDUCER`, which enables only the
  read-only planner.
- Planner path: one `KV.skills` get, one `KV.skillFeedback` list,
  `applied: false`, and zero writes.
- Counters: `AgentSkill.successCount` and `AgentSkill.failureCount`.
- Evidence: append-only `SkillFeedbackEvent` ledger.

The current mapping is `success -> success +1`, `failure -> failure +1`,
`correction -> failure +1`, and `stale -> no counter delta`. Phase 3A
`proposedCounters` must not be persisted directly because it is calculated from
current counters plus the complete applicable evidence set; replay would
double-count evidence.

### Future apply feature gate

The following is a conceptual, future-only configuration contract:

```text
AGENTMEMORY_SKILL_FEEDBACK_REDUCER_APPLY=false
```

This PR does not add the variable to source, configuration, or generated
references. It defaults to `false`. `AGENTMEMORY_SKILL_FEEDBACK_REDUCER`
continues to enable only the Phase 3A read-only planning capability, so setting
`AGENTMEMORY_SKILL_FEEDBACK_REDUCER=true` alone must never authorize counter
writes.

The future apply function requires all of these flags to be true:

```text
AGENTMEMORY_SKILLS=true
AGENTMEMORY_SKILL_FEEDBACK_REDUCER=true
AGENTMEMORY_SKILL_FEEDBACK_REDUCER_APPLY=true
```

`AGENTMEMORY_SKILL_FEEDBACK=false` may remain false because historical
explicit evidence can still be applied. The apply gate does not imply automatic
invocation, scheduling, hooks, REST, or MCP exposure. Introducing this
environment variable in code requires separately authorized Phase 3B3 work.
If the apply gate is false, `mem::skill-feedback-reduction-apply` must return
before all KV reads and writes, using `skill feedback reducer is disabled`
unless a separately reviewed future implementation adopts a more specific
reason.

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
with unknown write outcome. No case uses best-effort counter mutation.

| Scenario | Required outcome | Write allowed? |
| --- | --- | --- |
| First valid application | `apply` | One conditional skill write |
| Identical replay after confirmed application | `no-op` | No |
| Retry after a response was lost but the write committed | `no-op` after reread and recompute | No |
| Same-process concurrent calls | One may apply; a later call returns no-op or conflict | At most one successful conditional write |
| Multi-worker concurrent calls | One CAS may succeed; losers return conflict | At most one successful conditional write |
| Crash before conditional write | Read/write failure or retryable failure | No committed change |
| Crash after committed write before response | `skill feedback reduction write outcome unknown` | Do not issue a blind second write |
| New feedback between planning and applying | `stale evidence hash` conflict | No |
| Requested version differs from current skill version | `skill version conflict` | No |
| Skill version, counters, or reduction metadata change before CAS | `skill changed during application` conflict | No |
| Malformed ledger rows coexist with valid rows | Count and skip malformed rows | Application may continue using valid evidence |
| Duplicate applicable event IDs | `duplicate feedback event id` integrity failure | No |
| Applicable event count decreases | `feedback evidence regression` integrity failure | No |
| Event count is unchanged but evidence hash changes | `skill reduction state integrity failure` | No |
| Event count increases and expected hash is current | Recompute absolute target from baseline | One conditional write |
| Feedback ledger or skill read fails | `failed to load skill feedback reduction application` | No |
| Conditional write definitively fails before commit | `failed to apply skill feedback reduction` | No committed change |
| Conditional write precondition fails | `skill changed during application` conflict | No |
| Write times out with unknown commit status | `skill feedback reduction write outcome unknown` | No blind retry |

For an increased event count, a larger count plus a changed full hash is treated
as new append-only evidence. The initial design cannot cryptographically prove
that an older row was not replaced while another row was appended. Absolute
recomputation from the immutable baseline prevents double addition, but does
not prove ledger history. A future digest chain or retained event-ID commitment
would provide stronger proof; neither is authorized by this design.

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
`canonicalApplicableEvents` is the UTF-8 byte sequence of a compact JSON
serialization of the sorted event array. Sort by `createdAt` descending, then
by `id` in UTF-16 code-unit ascending order for equal timestamps.

Each event object emits every key in this exact order:

```ts
{ id, skillId, skillVersion, kind, attribution, source, project, agentId,
  sessionId, sourceObservationIds, sourceSessionIds, createdAt }
```

Absent `project`, `agentId`, and `sessionId` are JSON `null`; their keys are
never omitted. The serialization has no insignificant whitespace, uses standard
JSON string escaping, and emits validated numbers in their decimal JSON
representation. `sourceObservationIds` and `sourceSessionIds` preserve their
validated stored order. Locale-sensitive comparison is prohibited. Compute the
lowercase hexadecimal SHA-256 of the exact UTF-8 byte sequence:

```text
evidenceHash = sha256(canonicalApplicableEvents)
```

For example, an event with no project, agent, or session uses this compact form
(the source arrays retain their stored order):

```json
[{"id":"evt-1","skillId":"skill-1","skillVersion":2,"kind":"success","attribution":"user-confirmed","source":"explicit","project":null,"agentId":null,"sessionId":null,"sourceObservationIds":["obs-2","obs-1"],"sourceSessionIds":[],"createdAt":"2026-07-21T00:00:00.000Z"}]
```

Canonical examples and future test vectors must satisfy the current
`SkillFeedbackEvent` validator and its literal unions before serialization.
Invalid events are never canonicalized as applicable evidence.

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
never accepts arbitrary delta input. The stable future reason strings are:

```text
skill feedback reducer is disabled
invalid skill feedback reduction apply input
skill not found
skill version conflict
stale evidence hash
duplicate feedback event id
feedback evidence regression
skill reduction state integrity failure
skill changed during application
failed to load skill feedback reduction application
failed to apply skill feedback reduction
skill feedback reduction write outcome unknown
```

Conflict and integrity failure are distinct outcomes. Write outcome unknown is
never reported as a confirmed failure. A retry after that outcome rereads and
recomputes first; callers must not blindly resubmit a previous replacement
record.

`stale evidence hash` is a caller-plan conflict: the expected evidence hash
differs from the recomputed hash. `skill changed during application` is a
concurrent-state conflict: skill version, counters, or `feedbackReduction`
metadata changed before CAS, including a failed conditional-write precondition.
`skill reduction state integrity failure` represents contradictory persisted or
ledger state, including an unchanged applicable-event count with a different
full evidence hash. None of these outcomes permits a fallback write.

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
is independent of the writer. Phase 3A remains read-only and unchanged while
the apply gate is disabled, and its planner flag alone never authorizes a
counter write.

## 14. Alternatives rejected

Separate receipts require multi-key atomicity. Consumed-event markers mutate
append-only evidence. Audit rows are observability, not transaction authority.
Current counters plus incremental deltas double-count replay. A process-local
mutex cannot protect multiple processes.

## 15. Future implementation gates

1. Phase 3B1: implemented read-only canonical evidence hashing and duplicate-ID
   integrity checks in the planner; no state is written.
2. Phase 3B2: proven conditional state primitive.
3. Phase 3B3: internal apply implementation with the separate, default-off
   `AGENTMEMORY_SKILL_FEEDBACK_REDUCER_APPLY` gate.
4. Phase 3B4: optional reviewed surface.

Each needs its own design, tests, review, and authorization.

## 16. Future implementation test matrix

### Gate and validation

- Disabled gate before any KV read.
- Planner gate alone does not authorize application.
- Disabled apply gate returns before any KV read or write.
- Application requires the skills, planner, and apply gates together.
- Malformed input before any KV read.
- Feedback writer disabled while the apply gate is enabled.
- Missing skill.
- Requested-version mismatch.

### Evidence and hashing

- Deterministic hash across repeated calls.
- Canonical optional fields use JSON `null`.
- Equal timestamps use the ID tie-break.
- Malformed rows are skipped and counted.
- Duplicate valid IDs are rejected.
- Count regression is rejected.
- Equal count plus changed hash is rejected.
- New appended evidence produces a new hash.
- Stale expected hash is rejected.

### Baseline and counters

- First application captures the baseline.
- Target counters use baseline plus the full aggregate.
- Identical replay is a no-op.
- New evidence recomputes from baseline.
- The `success`/`failure`/`correction`/`stale` mapping remains unchanged.
- Counter divergence with a matching hash fails closed.
- Version transition creates a new version baseline.
- Future-version reduction state fails integrity checks.

### Atomicity and concurrency

- Same-process concurrent calls.
- Two-worker CAS race with only one successful conditional write.
- Failed CAS returns conflict and a stale write is not automatically retried.
- Crash before commit.
- Response loss after commit.
- Definitive write failure.
- Write outcome unknown.
- Retry after outcome unknown resolves to no-op when the first write committed.

### Preservation

- Unrelated `AgentSkill` fields remain byte-for-byte equivalent.
- Feedback events remain unchanged and no event is consumed.
- No audit is required for idempotency.
- A no-op does not modify `updatedAt`; an actual application does.
- Confidence, strength, usage, status, and version remain unchanged.
- No REST, MCP, CLI, or hook registration appears.

## 17. Relationship to the skill-layer roadmap

Phase 3A is implemented read-only planning. This is the Phase 3B idempotency
and atomicity contract, not implementation. Phase 4 lifecycle work remains
separate. Do not mark Phase 3B implemented.

## 18. Prohibited changes

This milestone does not change source, tests, configuration, state layer,
generated references, REST/MCP/hooks, or tool counts. It adds no metadata in
code, CAS primitive, receipt scope, apply function, environment variable, or
ranking/search change.

## 19. Documentation validation

The design PR changes only this file and `docs/skill-layer-design.md`. Run
TypeScript, build, skills check, full tests, and `git diff --check`. Surface
counts remain 60 MCP tools and 135 REST registrations.

## 20. Commit and push

Use one signed-off `docs: design skill feedback reducer idempotency` commit on
`docs/skill-feedback-reducer-idempotency-design`. Do not amend, rebase,
force-push, add cleanup commits, or modify source after validation.

## 21. Post-push verification

The branch must be clean, one ahead, zero behind, identical locally/remotely,
and differ from `main` in exactly these two documentation files.

## 22. Draft PR

Open a Draft PR titled `docs: design skill feedback reducer idempotency` from
`docs/skill-feedback-reducer-idempotency-design` to `main`. Do not mark Ready,
request reviewers, add labels, enable auto-merge, or start Phase 3B1.

## 23. CI policy

The repository CI workflow ignores `docs/**`, `**/*.md`, and `**/*.mdx`. A
docs-only PR therefore has no PR-triggered workflow run; that absence is neither
success nor failure. Local TypeScript, build, skills check, full tests, and
`git diff --check` remain mandatory. Do not change source, configuration, or a
workflow solely to trigger CI, and do not manually dispatch CI unless separately
authorized. If CI applies to a future non-docs change, all Ubuntu/macOS Node
20/22 jobs must pass install, build, skills check, and full tests.

## 24. Review policy

After CI, inspect comments, reviews, requested changes, inline comments, and
unresolved threads once. Classify findings as design blocker, valid
clarification, implementation-phase request, or unrelated. Do not address
comments, mark Ready, or merge in the same run; each requires separate explicit
authorization.

## 25. Report and stop

Report branch/commit state, the exact two files, selected single-record design,
baseline/hash/replay/duplicate/version/concurrency rules, validation/CI/review
state, and confirmation that no source, test, generated, or configuration file
changed. Then stop.
