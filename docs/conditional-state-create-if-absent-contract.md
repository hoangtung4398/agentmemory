# Conditional Missing-Key Creation Contract

## 1. Status and authorization boundary

**Status: designed only.** Phase 3B2B1 defines the missing-key creation
semantic required by the Phase 4B1 durable staged protocol. It does not
implement, test, prove, release, or make available a runtime primitive, SDK
type, `StateKV` method, reducer write, marker schema, capability probe, or
state mutation.

The future upstream shape remains unresolved. It may be a separate
create-if-absent operation or a generalized conditional-state operation that
represents an expected missing value. Either is acceptable only when it
satisfies this complete semantic contract. This document selects neither a
function name nor an SDK method, target iii version, adapter policy, or release
line.

The companion full-record replacement contract is
[`conditional-state-primitive-contract.md`](conditional-state-primitive-contract.md).
The two contracts are complementary and do not claim current iii-engine or
AgentMemory support.

## 2. Decision summary

For exactly one existing state `scope` and `key`, the future semantic operation
atomically does one of the following at the authoritative linearization point:

```text
if the key is absent:
    persist the complete requested JSON value
    return semantic CREATED/APPLIED

if the key exists:
    perform zero mutation
    return semantic ALREADY_EXISTS/CONFLICT
```

`CREATED/APPLIED` and `ALREADY_EXISTS/CONFLICT` are semantic categories, not
frozen wire values or API names.

## 3. Precise absence model

`ABSENT` means that the requested scope/key does not exist at the authoritative
linearization point. It is distinct from every persistable JSON value:

```text
ABSENT != null
ABSENT != {}
ABSENT != ""
ABSENT != undefined-as-a-value
```

The current state API's representation of a missing read must not weaken this
distinction. A key containing `null` exists and therefore produces the
already-exists/conflict semantic outcome.

## 4. Value and request validation

Validation occurs before dispatch. Scope and key must meet existing state
naming rules. The requested value uses the same persisted JSON-value
constraints as the full-record CAS contract: it is finite and serializable,
subject to existing state-size limits, and contains no cycle, `undefined`,
`bigint`, function, symbol, `NaN`, or positive/negative infinity.

Every invalid request is definitively `not_committed`, with zero state
mutation. This design introduces no new state value shape and does not make
`undefined` a persistable value.

## 5. Single-key atomicity

The absence test and complete-value persistence have one same-key
linearization boundary. The operation is atomic for one scope/key only and
must serialize at that authoritative backend boundary against all same-key
mutation paths:

- `set`
- `update`
- `delete`
- full-record compare-and-set
- another conditional create

Two concurrent conditional creators for one initially absent key may yield at
most one creation success. A process-local mutex, `get -> set`, `list -> set`,
existing update, post-write reread, or application-side lock is not the
primitive and must never be represented as equivalent.

Correctness must hold across workers, processes, and machines sharing the
authoritative backend. A later legal mutation can change the final value, but
does not retroactively change the earlier operation's semantic result.

## 6. Normal outcomes

`created/applied` is returned only when the complete requested value reaches
the defined commit point and the runtime can definitively report that commit.
A later same-key read observes that value or a strictly later legal mutation.

`already_exists/conflict` is returned only when the key exists at the
linearization point. It performs zero mutation and must not return the existing
value merely to support caller reconciliation.

An ordinary replay after a confirmed creation must not return a second creation
success solely because the existing value equals the requested value. The
primitive observes an existing key. A higher-level protocol may separately
reconcile exact-value equality.

## 7. Failure classification

Future runtime or SDK failures use the existing conditional-write distinction:

```ts
type StateConditionalWriteFailure =
  | { outcome: "not_committed"; code: string }
  | { outcome: "outcome_unknown"; code: string };
```

`not_committed` is permitted only when non-commit is proven, including local
validation failure, rejection before the authoritative operation begins, or a
backend rollback guarantee. A dispatched timeout, response loss, transport
interruption, worker termination, backend restart, or backend error without a
no-commit guarantee is `outcome_unknown`, never a silently definitive failure.

No transparent or blind retry is permitted after a potentially delivered
request. A `get -> set` fallback is never permitted.

## 8. Unknown-outcome reconciliation

After `outcome_unknown`, the caller rereads the authoritative key before any
new creation attempt:

```text
current equals the exact intended complete value
    -> intended target state is established
    -> do not claim which invocation created it

current exists but differs
    -> conflict / replanning

current is absent
    -> no automatic retry
    -> a new request is allowed only after the higher-level caller revalidates
       that creation remains valid
```

The final rule prevents an unknown create followed by a legitimate later delete
from being blindly resurrected.

## 9. Required race matrix

Future implementation and proof must preserve deterministic semantics for the
following cases. Results are defined by authoritative linearization order, not
caller arrival time.

| Race or condition | Required semantic boundary |
| --- | --- |
| creator vs creator | At most one receives creation success. |
| creator vs set/update/CAS | The operation linearized first determines whether creation or the competing mutation observes or changes the key. |
| creator vs delete | A delete before creation linearization leaves the key absent for creation; a delete after successful creation may remove it later. |
| key initially absent | One successful creation is possible. |
| key initially `null` | The key exists; creation must not overwrite it. |
| crash before dispatch | `not_committed`; no write. |
| crash before commit | `not_committed` only with a backend no-commit guarantee; otherwise `outcome_unknown`. |
| crash after commit before response | `outcome_unknown`; reread reconciliation is required. |
| response loss or timeout | `outcome_unknown` unless non-commit is proven. |
| backend restart | Cannot falsely acknowledge creation before its documented durability point. |
| duplicate delivery | Existing-key outcome, never a second creation success. |

## 10. Visibility and durability

An acknowledged creation is visible to later same-key reads unless superseded
by a strictly later mutation. A future runtime must document its durability
point and prove that restart cannot acknowledge creation before that point. No
partial JSON state may be visible after failures.

## 11. Phase 4B1 marker reconciliation boundary

The durable staged protocol may reconcile an existing marker only when the
complete immutable operation identity and all immutable creation fields exactly
match the intended marker. That protocol-level exception does not alter the
primitive's existing-key outcome and creates no marker scope, key, or schema in
this milestone.

## 12. Security and compatibility

Future support is additive. It must not change existing `get`, `set`, `update`,
`delete`, or `list` semantics; KV record shapes; `AgentSkill`; REST/MCP schemas;
hooks; ranking; recall; context packing; feedback behavior; or lifecycle review
behavior.

Existing values must not be returned in conflict responses solely for
reconciliation. Raw requested values, existing values, and secrets must not be
logged by default. Existing state authorization continues to govern scope/key
access.

Capability discovery is upstream-owned and unresolved. A future AgentMemory
adapter must fail closed when this semantic capability is unavailable and must
never emulate it.

## 13. Future proof boundary

An authorized upstream implementation must prove value validation before
dispatch; same-key serialization across file/KV, Redis, bridge, worker, process,
and machine boundaries as applicable; creator races; all listed mutation races;
crash, timeout, response-loss, restart, visibility, and durability behavior;
unknown-outcome reconciliation without retry; unchanged existing APIs; and
fail-closed behavior for unsupported adapters. Mocks alone cannot establish the
authoritative backend guarantee.

## 14. Status

```text
PHASE_3B2B1:
  DESIGNED_ONLY

CREATE_IF_ABSENT_API_SHAPE:
  PENDING_UPSTREAM_ALIGNMENT

PHASE_3B2C1:
  WAITING_ON_SUBSTANTIVE_MAINTAINER_RESPONSE

PHASE_3B2C2:
  BLOCKED

PHASE_4B_RUNTIME:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```

No implementation follows from this contract while upstream alignment remains
pending.
