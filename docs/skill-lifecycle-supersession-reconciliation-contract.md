# Skill Supersession Reconciliation Evidence Contract

## 1. Status and authorization boundary

**Status: designed only.** Phase 4B3 defines how a future reconciler may
classify authoritative evidence for a Phase 4B2 marker whose state is
`reconciliation_required`. It is a read-only evidence contract, not a recovery
or lifecycle protocol.

This document creates no KV namespace, persisted schema, TypeScript type,
runtime function, worker, configuration flag, or public surface. It authorizes
no marker mutation, skill mutation, repair, resume, rollback, retry, or
automatic state transition. Phase 4B1's conditional primitives remain required
and unavailable; their contracts are unchanged.

## 2. Exact-operation authority

Reconciliation authority starts only with one exact Phase 4B2 `operationId`.
The caller must already possess that value. It must not search by skill IDs,
project, agent, timestamp, marker state, or any other derived field. It must
not list or scan marker or skill namespaces, infer an operation from current
records, or mint a new timestamp or operation ID.

This contract applies only when that exact marker is currently
`reconciliation_required`. `completed` and `conflict` are outside its scope and
remain closed; no present-record reading is a transition or reinterpretation of
either terminal marker state.

If an exact operation ID is unavailable, the reconciler cannot make an
authoritative classification. It does not guess, scan, or substitute a nearby
operation.

## 3. Conceptual bounded reads

For one exact operation ID, the conceptual read budget is at most:

```text
1 exact marker read by operationId
1 exact old-skill read by oldSkillId
1 exact replacement-skill read by replacementSkillId
```

The marker is validated before either skill record is interpreted. The old and
replacement reads are exact-key reads only. This is a conceptual evidence
shape, not an implementation or a new storage API.

## 4. Marker integrity gate

Before comparing current skills, the marker must prove all of the following:

```text
schemaVersion == 1
kind == "skill_supersession"
recomputed operationId == stored operationId
expectedOldSkill.id == oldSkillId
expectedReplacementSkill.id == replacementSkillId
oldSkillId != replacementSkillId
expectedOldSkill and expectedReplacementSkill carry the exact marker scope
expectedOldSkill and expectedReplacementSkill scopes agree with each other
expectedOldSkill.status == "active"
expectedReplacementSkill.status == "active"
expectedReplacementSkill.supersedes is absent
linkedReplacementSkill is exactly the allowed target derived from expectedReplacementSkill
supersededOldSkill is exactly the allowed target derived from expectedOldSkill and operationTimestamp
no unrelated field differs in either target record
```

Scope values are exact persisted values: no trimming, case conversion, Unicode
normalization, or missing-to-`null` substitution occurs while validating record
snapshots. The permitted targets are those frozen by the Phase 4B2 marker
contract; this document does not redefine them.

Any failed condition is `MARKER_INTEGRITY_FAILURE`. It stops interpretation of
the current skill records. No marker overwrite, repair, replacement, or state
transition follows from that outcome.

## 5. Complete-record comparison rule

Every current-record comparison uses the same full-record structural semantics
as Phase 4B1 CAS:

```text
object key order: irrelevant
array order: significant
missing member: distinct from null
record comparison: complete persisted record
```

The reconciler must not reduce comparison to versions, statuses, hashes, or a
selected-field predicate. It cannot use a matching lifecycle field to overlook
concurrent feedback, counters, provenance, instructions, or any other record
difference.

## 6. Freeze matrix and precedence

After a valid marker, compare the current old record with `OE` and `OT`, and
the current replacement record with `RE` and `RT`:

```text
OE = expectedOldSkill
OT = supersededOldSkill
RE = expectedReplacementSkill
RT = linkedReplacementSkill
```

Marker integrity always takes precedence. For an integrity-valid marker, the
classification matrix is:

| Old record | Replacement record | Classification |
| --- | --- | --- |
| `OE` | `RE` | `BASELINE_PAIR_PRESENT` |
| `OE` | `RT` | `REPLACEMENT_LINKED_PAIR_PRESENT` |
| `OT` | `RT` | `TARGET_PAIR_PRESENT` |
| `OT` | `RE` | `PROTOCOL_ORDERING_VIOLATION` |
| missing | any | `RECORD_MISSING` |
| any | missing | `RECORD_MISSING` |
| any third value | any | `DIVERGED_STATE` |
| any | any third value | `DIVERGED_STATE` |

`RECORD_MISSING` applies before a third-value classification. Read failure or
an inability to obtain authoritative evidence is not this matrix: it is
`RECONCILIATION_READ_FAILURE`.

## 7. Conservative interpretation

`BASELINE_PAIR_PRESENT` says only that both current records equal the expected
baseline pair. It cannot prove that neither record was changed and restored.

`REPLACEMENT_LINKED_PAIR_PRESENT` says that the replacement equals its exact
link target while the old record remains expected. It does not authorize
completing supersession.

`TARGET_PAIR_PRESENT` says only that the intended pair is currently
established. It must never attribute that pair to a particular earlier
invocation after an unknown outcome.

`PROTOCOL_ORDERING_VIOLATION` says that old is at its target while replacement
is still expected; this is not a successful Phase 4B1 ordering. `DIVERGED_STATE`
may represent a valid concurrent update or corruption and must not be
overwritten. `RECORD_MISSING` never authorizes record recreation.

These limits preserve the Phase 4B1 CAS and create-if-absent unknown-outcome
model: a current match establishes only present evidence, never historical
attribution. Conversely, baseline evidence does not prove that no prior
operation temporarily committed.

## 8. No-repair and terminal boundary

Classification may inform a separate, future policy only. It authorizes no
CAS, rollback, marker completion, conflict marking, resume, recreation, or
other write. `classification != mutation authorization`.

`reconciliation_required` remains terminal in this milestone. This contract
introduces no state transition out of it. `completed` and `conflict` remain
closed marker states; invoking reconciliation for either is outside this
contract and infers no transition from current skill records.

`terminalReason`, when present, is bounded diagnostic context only. It never
overrides immutable marker snapshots or current complete records, and must not
be treated as free-form evidence.

## 9. Failure and privacy boundary

Any read failure, unavailable exact operation ID, or inability to obtain
authoritative evidence yields `RECONCILIATION_READ_FAILURE`. It is not a
lifecycle conflict, proof of non-commit, or permission for automatic retry,
write, or state inference.

A conceptual privacy-safe result may expose only:

```text
operationId
classification
oldRecordPresent
replacementRecordPresent
markerIntegrityValid
```

It must not return snapshots, raw records, instructions, provenance, skill
content, backend error values, or repair guidance. Marker evidence remains at
least as sensitive as `mem:skills`.

## 10. Compatibility boundary

This design preserves the `AgentSkill` schema; Phase 4B2 conceptual marker
schema and state list; KV scopes and record shapes; StateKV and state APIs;
CAS and CREATE_IF_ABSENT contracts; REST, MCP, CLI, hooks, viewer, telemetry;
ranking, recall, context, feedback, promotion, lifecycle review; and default
runtime behavior. No data is persisted.

Phase 4B runtime remains blocked pending proven runtime primitives and
separate implementation authorization. Phase 3B2C1 remains waiting on a
substantive maintainer response. Phase 4B3 does not change either status.

## 11. Status

```text
PHASE_4B3:
  DESIGNED_ONLY

RECONCILIATION_MODE:
  READ_ONLY_EVIDENCE_CLASSIFICATION

RECONCILIATION_LOOKUP:
  EXACT_OPERATION_ID_ONLY

RECONCILIATION_REPAIR_POLICY:
  NOT_DESIGNED

RECONCILIATION_RUNTIME:
  NOT_AUTHORIZED

RECONCILIATION_WRITES:
  NOT_AUTHORIZED

PHASE_3B2C1:
  WAITING_ON_SUBSTANTIVE_MAINTAINER_RESPONSE

PHASE_4B_RUNTIME:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```
