# Skill Retirement Exact-Target and Unknown-Outcome Contract

## 1. Status and authorization boundary

**Status: designed only.** Phase 4B4 freezes the exact single-record
retirement semantics that a future implementation must preserve. It prevents a
later lifecycle writer from inventing replay, timestamp, idempotency, or
unknown-outcome behavior.

This document authorizes no runtime behavior. It creates no TypeScript
request/result type, StateKV method, function registration, worker,
configuration flag, environment variable, KV namespace, audit schema, REST,
MCP, CLI, hook, viewer, or telemetry surface. The required conditional write
primitive is not currently consumable.

## 2. Scope

Retirement is exactly one existing `AgentSkill`, one exact key in the existing
skill KV scope, and one `active` to `retired` transition. It is not
supersession, replacement creation, promotion, multi-key mutation, a marker
protocol, a reconciliation worker, feedback reduction, or automatic lifecycle
review application.

## 3. Conceptual future request evidence

A future retirement request has the following conceptual evidence:

```text
skillId
project
agentId
expectedSkill
operationTimestamp
explicitRetirementIntent
```

`expectedSkill` is the complete persisted `AgentSkill` record, not a version,
status, hash, or selected-field subset. Before any future mutation attempt:

```text
expectedSkill.id == skillId
expectedSkill.status == "active"
expectedSkill.project exactly matches requested project
expectedSkill.agentId exactly matches requested agentId
```

Missing `project` and `agentId` remain missing. Scope values are not trimmed,
lowercased, Unicode-normalized, or changed to `null`. Explicit request scope
and record scope must agree before a mutation can be attempted. Explicit intent
alone never authorizes a write; a separately authorized default-off apply path
would still be required. The operation-specific admission boundary is defined
by [Phase 4B5](skill-lifecycle-mutation-authorization-contract.md); this
contract's target, CAS, and reconciliation semantics remain unchanged.

## 4. Exact retirement target

The target is defined once from the complete expected record:

```text
retiredTarget = exact copy of expectedSkill except:
  status = "retired"
  updatedAt = operationTimestamp
```

Only `status` and `updatedAt` may differ. Every other persisted value remains
structurally equivalent under the persisted JSON model, including `id`, `name`,
`triggerCondition`, `steps`, `expectedOutcome`, `antiPatterns`, `files`,
`concepts`, `confidence`, `strength`, usage and feedback counters, all source
and provenance arrays, `createdAt`, `lastUsedAt`, `lastReinforcedAt`, `version`,
`supersedes`, `project`, `agentId`, and every other existing field.

In particular, retirement does not increment `version` and does not change
`supersedes`. It therefore changes lifecycle metadata only, preserving the
Phase 4B0 boundary.

Complete-record equality is structural: object member order is irrelevant,
array order is significant, and a missing member differs from `null`. No
version-only, status-only, hash-only, or selected-field predicate is
authoritative retirement evidence.

## 5. Timestamp semantics

`operationTimestamp` is supplied once and remains identical for the same
logical retirement request. It is not regenerated because of replay, timeout,
response loss, or reconciliation reread. It uses the existing persisted ISO
timestamp convention and updates no field other than `updatedAt`.

Phase 4B4 introduces no `retiredAt`, operation-journal timestamp, or new
schema field.

## 6. Required future atomic primitive

Retirement selects exactly:

```text
FULL_RECORD_SINGLE_KEY_CAS
```

Its conceptual mapping is:

```text
scope: existing skill KV scope
key: skillId
expected_value: expectedSkill
new_value: retiredTarget
```

This mapping is design-only and not currently consumable. `get -> set`,
`get -> update`, process-local locking, version-only comparison, status-only
comparison, and post-write rereading are not atomic mutation substitutes. The
conditional-state contract's complete persisted-record equality remains the
only selected comparison rule.

## 7. CREATE_IF_ABSENT boundary

```text
RETIREMENT_CREATE_IF_ABSENT_REQUIREMENT:
  NONE
```

A missing skill is never recreated by retirement. Therefore retirement needs
only the future proven single-key CAS primitive, unlike supersession's durable
marker protocol.

## 8. Pre-dispatch state handling

When the exact authoritative current record is known before a future CAS
request, classify it without mutation as follows:

```text
current == expectedSkill   -> eligible for one CAS attempt, subject to explicit retirement intent
current == retiredTarget   -> EXACT_TARGET_PRESENT, zero mutation
current is missing         -> RECORD_MISSING, zero mutation
current is any third value -> DIVERGED_STATE, zero mutation
```

`EXACT_TARGET_PRESENT` is a current-state observation only. It does not claim
that this invocation applied retirement; another invocation or later sequence
could have established the same target state.

## 9. Normal CAS outcomes

The future CAS outcome mapping is fixed as:

```text
applied         -> RETIREMENT_TARGET_ESTABLISHED
conflict        -> zero mutation; reread/replan only if the caller chooses
not_found       -> zero mutation; never recreate
not_committed   -> zero retirement mutation proven
outcome_unknown -> no blind retry; exact-key reconciliation required
```

This document adds no CAS outcome. `outcome_unknown` retains the generic
conditional-state contract meaning and is never reported as a definitive
failure.

## 10. Unknown-outcome reconciliation

After `outcome_unknown`, reconciliation reads only the same exact skill key and
uses complete-record structural comparison:

```text
current == retiredTarget       -> TARGET_PRESENT
current == expectedSkill       -> BASELINE_PRESENT
current is missing             -> RECORD_MISSING
current is any other record    -> DIVERGED_STATE
authoritative read unavailable -> RETIREMENT_READ_FAILURE
```

The interpretation is conservative. `TARGET_PRESENT` means only that the
intended retirement target is currently established; it does not prove which
invocation committed it. `BASELINE_PRESENT` means only that the original
expected state currently exists; it does not prove the earlier attempt never
temporarily committed. `DIVERGED_STATE` may be a legitimate concurrent change
and must never be overwritten. `RECORD_MISSING` never permits recreation.

`RETIREMENT_READ_FAILURE` is not a lifecycle conflict or proof of non-commit.
It permits no automatic retry, write, or state inference.

## 11. Retry and idempotency boundaries

There is no automatic or transparent retry after `outcome_unknown`. If
reconciliation yields `BASELINE_PRESENT`, a later future implementation may
submit another CAS only after explicit retirement intent remains valid, the
current complete record is reread, all preconditions are revalidated, and the
exact expected/target pair is recomputed. That is a newly validated request,
not a blind network retry. The same logical timestamp may be retained only
when deliberately continuing the same retirement intent.

Retirement needs no durable marker, receipt, operation journal, transaction ID,
or create-if-absent record. Its idempotency model is:

```text
STATE_BASED_EXACT_TARGET_RECOGNITION
```

When the authoritative record already structurally equals `retiredTarget`, the
result is deterministic with zero CAS and zero mutation. A record whose
`status` is `retired` but whose `updatedAt` or any other persisted field differs
is `DIVERGED_STATE`, not automatically idempotent. A `superseded` record is
also divergent and is never a retirement success; no `superseded` to `retired`
transition is designed here.

## 12. Concurrency and privacy boundaries

Any concurrent change to any persisted skill field makes the future full-record
CAS conflict. This includes feedback and usage counters, confidence, strength,
`updatedAt`, status, version, provenance, scope, `supersedes`, and instruction
content. Retirement must never overwrite an unrelated concurrent update merely
because status remains `active`.

Conceptual results may expose only bounded metadata such as `skillId`, `state`,
`targetEstablished`, and `recordPresent`. They must not expose raw complete
skill records, instruction text, provenance arrays, feedback bodies, or backend
values in ordinary conflict, reconciliation, log, or error output.

## 13. Compatibility boundary

This design preserves the existing `AgentSkill` schema; skill KV scope and
record shapes; StateKV and state APIs; the conditional-state primitive contract;
REST, MCP, CLI, hooks, viewer, telemetry; ranking, recall, context, promotion,
feedback, lifecycle review, and default runtime behavior. No data is persisted.

No StateKV addition or adoption, CAS implementation, shim, mock-as-proof,
capability probe, runtime use, CREATE_IF_ABSENT implementation, lifecycle
writer, reactivation, superseded-to-retired write, public surface, or Phase
4B1-4B3 change follows from this document.

## 14. Status

```text
PHASE_4B4:
  DESIGNED_ONLY

RETIREMENT_ATOMICITY:
  FULL_RECORD_SINGLE_KEY_CAS_REQUIRED

RETIREMENT_CREATE_IF_ABSENT:
  NOT_REQUIRED

RETIREMENT_TARGET:
  EXACT_FULL_RECORD_ACTIVE_TO_RETIRED

RETIREMENT_TIMESTAMP:
  UPDATED_AT_FROM_OPERATION_TIMESTAMP

RETIREMENT_IDEMPOTENCY:
  STATE_BASED_EXACT_TARGET_RECOGNITION

RETIREMENT_UNKNOWN_OUTCOME:
  EXACT_KEY_REREAD_AND_FULL_RECORD_CLASSIFICATION

RETIREMENT_RUNTIME:
  NOT_AUTHORIZED

RETIREMENT_WRITES:
  NOT_AUTHORIZED

PHASE_3B2C1:
  WAITING_ON_SUBSTANTIVE_MAINTAINER_RESPONSE

PHASE_4B_RUNTIME:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```
