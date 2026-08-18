# Skill Supersession Atomicity Protocol

## Decision

Phase 4B1 selects **DURABLE_STAGED_PROTOCOL** rather than an atomic multi-key
transaction. A multi-key transaction would be simpler but is not required for
the first lifecycle design and is not available in the current state surface.
The staged protocol remains blocked until its minimum single-key primitives are
implemented and proven; this document implements neither strategy.

Supersession is an explicit operation between two already-existing skills. It
does not create or promote the replacement.

## Preconditions and Invariant

Before any future write, the authoritative records must prove:

```text
old.id != replacement.id
old.status == active
replacement.status == active
old.version == expectedOldVersion
replacement.version == expectedReplacementVersion
old.project/agentId exactly match replacement.project/agentId
replacement.supersedes is absent
```

The final invariant is:

```text
replacement.supersedes === old.id
old.status === "superseded"
```

A replay may accept `replacement.supersedes === old.id` only when the durable
operation authority proves the same operation identity and all terminal fields
match. All instruction content, steps, outcome, anti-patterns, files, concepts,
quality counters, confidence, strength, provenance arrays, and versions remain
unchanged. The sole lifecycle timestamp is a supplied operation timestamp,
stored identically on every replay of that operation.

## Rejected Alternative

**ATOMIC_MULTI_KEY_TRANSACTION** is rejected for the first Phase 4B path: it
would require a larger, unavailable runtime primitive. It remains a possible
future alternative, but this contract must not claim it exists.

## Durable Staged Protocol

Operation identity and the marker's creation fields are immutable: they are a
canonical digest of old/replacement ids, their full-record expected values,
exact scopes, and operation timestamp. The durable protocol marker is the
authority; its state is deliberately mutable only through full-record CAS.
Journal creation requires
**CREATE_IF_ABSENT** for that identity. Unconditional `KV.set` is not a safe
journal, since duplicate delivery could overwrite progress.
The missing-key creation semantics are defined by
[`conditional-state-create-if-absent-contract.md`](conditional-state-create-if-absent-contract.md);
this protocol does not redesign that primitive.
The exact operation identity, conceptual marker contents, replay authority, and
retention boundary are defined by
[`skill-lifecycle-supersession-marker-contract.md`](skill-lifecycle-supersession-marker-contract.md).
This protocol does not add a marker schema or runtime writer.

States are `prepared`, `replacement_linked`, `old_superseded`, `completed`,
`conflict`, and `reconciliation_required`. Creation records immutable expected
full records. Every marker progression and authoritative skill transition uses
full-record CAS:

1. create the `prepared` marker with CREATE_IF_ABSENT;
2. CAS replacement from its expected full record to the identical record with
   `supersedes: old.id`, then CAS the exact `prepared` marker to
   `replacement_linked`;
3. CAS old from its expected full record to the identical record with status
   `superseded` and the operation timestamp, then CAS the exact
   `replacement_linked` marker to `old_superseded`;
4. CAS the exact `old_superseded` marker to `completed` only after the two
   marker transitions have recorded the matching full-record values.

The completion invariant is both skill records plus a completed marker with
the same operation identity. A competing replacement for one old skill, or one
replacement for two old skills, conflicts because its full-record CAS no longer
matches. Two replacements racing for one old skill can both reach
`replacement_linked`; the loser whose old-skill CAS conflicts must CAS its own
linked replacement back to its recorded expected full record and transition its
marker to `conflict`. If that rollback CAS cannot prove its exact post-link
value, it must transition to `reconciliation_required` and never complete.
Stale/corrupt/conflicting metadata enters `reconciliation_required`; it is not
overwritten. A timeout or lost response is unknown until the marker and exact
CAS preconditions permit deterministic reconciliation. There is no blind retry.

Automatic rollback is permitted only when full-record CAS proves the exact
post-operation record still exists. Otherwise the protocol terminates in
`reconciliation_required`. Reconciliation is an explicit future authority and
never guesses that an unknown write succeeded. The separately designed
[`skill-lifecycle-supersession-reconciliation-contract.md`](skill-lifecycle-supersession-reconciliation-contract.md)
defines only bounded read-only evidence classification; it authorizes no
runtime repair, resume, rollback, or marker transition.

## Failure Matrix

Same-operation replay and two workers converge through CREATE_IF_ABSENT and
marker identity. Old/replacement changes before either write, concurrent
counter/feedback/lifecycle updates, conflicting replacements, missing/corrupt
markers, and rollback conflicts produce zero unsafe mutation or reconciliation.
Crashes before any write leave `prepared`; crashes after either skill CAS and
before finalization resume only through immutable creation evidence, mutable
marker state, and full-record CAS.
This covers response loss, partial state, and stale versions without locks,
get-then-set/update, or post-write rereading as atomic substitutes.

## Final Classifications

```text
RETIREMENT_SINGLE_KEY_REQUIREMENT:
  FULL_RECORD_SINGLE_KEY_CAS
SUPERSESSION_ATOMICITY_STRATEGY:
  DURABLE_STAGED_PROTOCOL
MINIMUM_RUNTIME_PRIMITIVES:
  FULL_RECORD_SINGLE_KEY_CAS
  CREATE_IF_ABSENT_FOR_IMMUTABLE_PROTOCOL_MARKERS
PHASE_4B_RUNTIME_STATUS:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```

The current CAS design and CREATE_IF_ABSENT are not implemented, proven, or
consumable. No lifecycle runtime implementation can follow from this document.
