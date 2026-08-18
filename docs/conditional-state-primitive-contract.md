# Conditional State Primitive Contract

## 1. Status and authorization boundary

**Status: designed only.** This Phase 3B2B document defines a proposed future
conditional single-key state primitive. It is not implemented, tested, proven,
released, or consumable in the current iii-engine image, `iii-sdk@0.11.2`, or
AgentMemory.

This document covers full-record compare-and-set only. The complementary
missing-key creation semantics are designed separately in
[`conditional-state-create-if-absent-contract.md`](conditional-state-create-if-absent-contract.md).

This documentation milestone authorizes no runtime function, SDK type,
`StateKV` method, reducer write, schema change, capability probe, or state
mutation. Phase 3B3 remains blocked until later runtime/SDK implementation and
AgentMemory adapter proof are separately authorized and completed.

Phase 3B2C0 has now inspected the upstream ownership boundary and selected
**`BLOCKED_PENDING_UPSTREAM_ALIGNMENT`**. iii-hq/iii owns runtime correctness,
the state-worker/adapters, SDK request/result types, and released artifacts;
AgentMemory must not implement or emulate this guarantee. The currently
consumed downstream baseline is the `iii/v0.11.2` source line together with the
corresponding `iii-sdk@0.11.2` and `iiidev/iii:0.11.2` references. The fixed
newer source is a comparison snapshot, not an implementation target. No
implementation target line is approved for the primitive. See
[`conditional-state-upstream-ownership.md`](conditional-state-upstream-ownership.md).

## 2. Decision summary

The selected future public semantic is full-record compare-and-set for exactly
one `scope` and `key`: compare the complete expected persisted JSON value with
the complete current value and replace it with the complete new value only when
they are structurally equal, in one indivisible backend operation.

The conceptual function ID is `state::compare-and-set`. The conceptual future
AgentMemory adapter name is `StateKV.compareAndSet`. These are contract names,
not existing registrations or source APIs.

## 3. Goals

- Prevent stale full-record overwrites for one state key.
- Return distinguishable normal `applied`, `conflict`, and `not_found` results.
- Serialize comparison and replacement with all same-key mutation paths.
- Provide correctness across workers, processes, and machines sharing an
  authoritative backend.
- Preserve current state APIs and avoid an `AgentSkill` revision/schema change.

## 4. Non-goals

This contract does not design partial updates, field predicates, multi-key
transactions, create-if-absent semantics, receipts, idempotency keys,
transaction IDs, ETags, revisions, expected hashes, migration, public REST/MCP
exposure, or automatic mutation retries.

## 5. Selected primitive

The future primitive operates on an existing value only. At its single
linearization point it reads the current value for one `scope`/`key`, compares
the entire value to `expected_value`, and replaces the entire value with
`new_value` only on equality. Full-record comparison is intentionally stricter
than checking only skill ID, version, counters, or `feedbackReduction`: a
concurrent change to any unrelated field conflicts instead of being overwritten.

## 6. JSON value model

The future public contract accepts only persisted JSON data:

```ts
type StateJsonPrimitive = null | boolean | number | string;
type StateJsonValue =
  | StateJsonPrimitive
  | StateJsonValue[]
  | { [key: string]: StateJsonValue };
```

This model is a design artifact only. It does not add a source type or change
current state record shapes.

## 7. Request contract

```ts
interface StateCompareAndSetInput<T extends StateJsonValue = StateJsonValue> {
  scope: string;
  key: string;
  expected_value: T;
  new_value: T;
}
```

The conceptual successful invocation result is:

```ts
type StateCompareAndSetResult =
  | { outcome: "applied" }
  | { outcome: "conflict" }
  | { outcome: "not_found" };
```

The future implementation may use a revision, fingerprint, transaction, or
database compare operation internally, but no such mechanism changes this
public full-value contract.

## 8. Validation contract

Validation occurs before the mutation path. `scope` and `key` must be non-empty
and valid under existing state naming rules. Both values must be supported,
finite, serializable persisted values: no `undefined`, function, symbol,
`bigint`, `NaN`, positive/negative infinity, or cyclic structure. Arrays and
objects must be finite. Existing state-size limits still apply; a future runtime
implementation must document request-size limits.

`expected_value` and `new_value` must not be structurally equal. A caller with
no state change must not invoke this primitive. A future runtime may reject that
request so replay of an applied request cannot receive a second `applied`
outcome merely because the target equals itself. Every invalid request performs
no state mutation.

## 9. Persisted-value equality

Equality is structural over the value actually persisted for the requested
scope/key, not JavaScript object identity or JSON source byte order. `null`
equals only `null`; booleans compare by value; strings compare exactly without
case folding or Unicode normalization; JSON numbers compare after the runtime's
normal JSON serialization and decoding rules. Arrays are order-sensitive and
length-sensitive. Object member names and values compare recursively, while
object member order is irrelevant. A missing member differs from an explicit
`null` member.

There is no implicit conversion, numeric-string conversion, substring match,
partial-object match, or field-mask comparison. Caller-side `JSON.stringify`
is not authoritative, and the runtime and AgentMemory need not share a canonical
JSON hash format.

## 10. Normal outcome contract

`applied` is returned only when the key exists, the complete current value
structurally equals `expected_value`, the complete replacement reaches the
defined commit/linearization point, and the runtime can definitively report
that committed outcome. A subsequent same-key read observes the replacement or
a strictly later mutation.

`conflict` is returned only when the key exists but its complete current value
differs from `expected_value`. It performs no write and returns no current value;
the caller rereads through the ordinary state path.

`not_found` is returned when the key does not exist at the comparison point. It
performs no write and never creates the key. Create-if-absent is outside this
contract.

## 11. Atomicity and linearization

Read, complete-value comparison, and replacement have one same-key
linearization point and are not externally interleavable. The primitive is
atomic for exactly one scope/key, not for multiple keys. It must serialize with
all same-key mutation paths, including current or future `state::set`,
`state::update`, `state::delete`, and `state::compare-and-set`, not merely other
compare-and-set requests.

No set/update/delete may occur between comparison and replacement. Failed
comparison performs no partial mutation, and exceptions cannot leave a partial
JSON value. Different keys do not need global serialization.

## 12. Cross-worker and cross-machine guarantee

The future primitive must provide the same outcome semantics across async tasks,
AgentMemory instances, Node.js processes, workers, and machines using the same
authoritative backend. A process-local mutex such as `withKeyedLock` can be a
future same-process optimization but cannot establish correctness or alter
outcomes. Synchronization belongs at the state runtime or storage transaction
boundary.

## 13. Visibility and durability

This design does not change `state::get`. A later implementation must prove that
an acknowledged `applied` result is visible to later same-key reads; a reread
can reconcile conflicts and unknown outcomes; and a backend restart cannot
acknowledge `applied` before the documented durability point. Existing backend
behavior is not claimed to already meet these requirements.

## 14. Failure classification

Normal results are only `applied`, `conflict`, and `not_found`. Future SDK or
adapter failures conceptually classify as:

```ts
type StateConditionalWriteFailure =
  | { outcome: "not_committed"; code: string }
  | { outcome: "outcome_unknown"; code: string };
```

`not_committed` is valid only when no replacement reached the linearization
point is proven, such as local validation failure, explicit rejection before
transaction entry, or a backend rollback guarantee. `outcome_unknown` is
required after a dispatched timeout, transport interruption, response loss,
worker termination, client cancellation, or backend error without a no-commit
guarantee. Unknown must never be reported as definitive failure.

## 15. Retry and reconciliation

The future SDK and AgentMemory adapter must not blindly or transparently retry
a request that may have been delivered; generic mutation retry middleware is
also prohibited unless non-delivery is proven. After `outcome_unknown`, reread
the key and recompute before any new request. A current value equal to
`new_value` reconciles to the intended target without attributing the commit to
a particular invocation. A value equal to `expected_value` permits a newly
recomputed request. Any other value is a conflict and requires replanning.
No path falls back to unconditional set or update.

## 16. Concurrency examples

For initial value `A`, writer one submits `A -> B` and writer two submits
`A -> C`. At most one returns `applied`; the other returns `conflict`; final
state is `B` or `C`, never a partial combination. Ordering is defined by the
runtime linearization point, not caller arrival time. Future proof must cover
the same race against unconditional set, atomic update, delete, and another
compare-and-set.

## 17. Missing-key and deletion races

An absent key returns `not_found`. A key deleted after caller read but before
comparison also returns `not_found` and is not recreated. When compare-and-set
applies before a later delete, it remains `applied` although the later delete
can remove the replacement. If a key is created after a `not_found`
linearization point, that earlier invocation remains `not_found`.

## 18. Reducer mapping

A future Phase 3B reducer would pass the complete `AgentSkill` read before
recomputation as `expected_value` and a complete replacement preserving every
unrelated field as `new_value`. Full-record equality conflicts on any concurrent
skill change, including version, counters, reduction metadata, status, usage,
timestamps, lineage, confidence, strength, scope, or another persisted field.

Future mappings are `applied` to reducer apply, `conflict` or `not_found` after
the initial read to `skill changed during application`, `not_committed` to
`failed to apply skill feedback reduction`, and `outcome_unknown` to `skill
feedback reduction write outcome unknown`. Existing reason strings do not
change, and no source mapping is implemented here.

## 19. Full-value comparison rationale

Complete expected-value comparison was selected because no revision field exists,
no `AgentSkill` schema or separate authority is needed, unrelated concurrent
edits cannot be overwritten, and structural comparison works generically across
state values. The runtime can optimize internally without changing semantics,
and no caller/runtime canonical hash agreement is required. It may create more
conflicts than a field-subset predicate, but that stricter result safely
preserves concurrent record changes.

## 20. Security and observability

The future primitive uses existing state authorization and cannot bypass
scope/key access rules. Conflicts and errors do not return the current record.
Expected/replacement values and raw secrets are not logged by default.
Permitted observability includes a scope category, key hash, duration, outcome,
payload size, and counts for `applied`, `conflict`, `not_found`,
`not_committed`, and `outcome_unknown`, subject to safe logging policy.

Metrics and logs are not transaction authority, cannot determine whether a
write applied, cannot require retry when observability fails, and cannot form a
second receipt record. This design authorizes no audit implementation.

## 21. Compatibility and capability discovery

The primitive is additive: current get/set/update/delete/list behavior, keys,
schemas, feedback events, and callers remain unchanged, with no startup
migration or dependency update. A future AgentMemory adapter fails closed when
the runtime primitive is unavailable and must never emulate it with get+set or
existing update.

Future runtime/SDK integration must prove support using an explicit capability
manifest, SDK-supported query, or a pinned runtime/SDK version with verified
contract tests. It must not infer support from a function name, attempt a write
against production data, or silently fall back after an unknown-function error.
This document selects no capability mechanism and implements none.

## 22. Alternatives rejected

Get followed by set is not indivisible. Existing `state::update` has no
expected-state input or conflict result. A process-local mutex cannot protect
processes or machines. A field-subset predicate can overwrite unrelated changes.
An expected canonical hash requires a shared canonicalization/collision contract.
A revision inside `AgentSkill` changes application schema. A receipt or lock key
needs multi-key atomicity and another authority. Create-if-absent expands an
unneeded reducer semantic. Automatic SDK retries obscure commit outcome.

## 23. Runtime, SDK and AgentMemory ownership

Correctness cannot live solely in AgentMemory. The runtime/state worker performs
comparison and replacement at the authoritative transaction or lock boundary.
The SDK exposes the request, discriminated normal outcomes, and failure
semantics. AgentMemory may later add a typed `StateKV` adapter only after runtime
and SDK support are implemented and proven. The reducer remains blocked until
that primitive and adapter have been implemented, reviewed, and verified.

## 24. Future implementation proof matrix

Phase 3B2C must prove, against at least one authoritative backend rather than
mocks alone: validation rejects invalid scope/key, unsupported JSON, cycles,
oversize payloads, and identical values without mutation; matching values apply,
mismatches conflict, and missing keys stay absent; structural equality honors
object order independence, array order, null-versus-missing, nesting, strings,
and types; and two writers across processes/workers/machines plus set/update/
delete races allow at most one apply from one expected value.

It must also cover validation-before-dispatch, explicit rejection, crashes before,
during, and after commit, timeout, response loss, restart, and transport loss
without false definitive-failure classification; unknown-outcome reconciliation
for target, expected, and divergent values without automatic retry; durability,
visibility, no partial JSON, no stale overwrite; unchanged existing state APIs;
unsupported runtime fail-closed behavior; no fallback; and no AgentMemory public
API registration.

## 25. Future phase gates

- **Phase 3B2B:** this full-record conditional replacement contract design.
- **Phase 3B2B1:** the companion missing-key creation contract, designed only;
  its API shape remains pending upstream alignment.
- **Phase 3B2C0:** upstream ownership and version-line audit, inspected and
  documentation-only; it selects `BLOCKED_PENDING_UPSTREAM_ALIGNMENT`.
- **Phase 3B2C1:** upstream alignment is awaiting substantive maintainer
  response; it does not authorize upstream or downstream implementation.
- **Phase 3B2C2:** future runtime/SDK implementation in an authorized upstream
  target line.
- **Phase 3B2C3:** future authoritative backend proof and released artifact /
  provenance evidence.
- **Phase 3B2D:** future AgentMemory `StateKV` adoption, capability detection,
  pinning, and isolated integration proof, separately authorized.
- **Phase 3B3:** future internal reducer application, blocked until 3B2C3 and
  3B2D are implemented, reviewed, proven, released where required, and
  consumable by AgentMemory.

## 26. Prohibited assumptions

Do not treat atomic ordered patching, a remote function name, a test mock, a
process-local lock, or a successful client-side equality check as compare-and-
set. Do not claim the designed primitive is implemented, proven, or available.
Do not infer backend transaction, retry, timeout, durability, or cross-worker
semantics from the current public `iii-sdk@0.11.2` surface.
