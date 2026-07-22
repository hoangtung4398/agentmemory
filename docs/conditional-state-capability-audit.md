# Conditional State Capability Audit

## Scope

This Phase 3B2A audit evaluates whether the state surface resolved by this
checkout can safely perform the future Phase 3B skill-feedback reducer write.
The audit base is `f40a8a32492e8393026f945a07826147c3e999eb` and the resolved
`iii-sdk` package is `0.11.2`.

This is evidence only. It adds no conditional primitive, state-layer change,
reducer application, reduction metadata, configuration, REST/MCP/CLI/hook
surface, or production state write.

## Primary Conclusion

**PROVEN_UNSUITABLE** for the Phase 3B reducer's required conditional,
single-key replacement.

The public state API exposes atomic mutation operations, but no caller-supplied
expected revision, expected value, fingerprint, ETag, compare operation, or
distinct precondition-conflict result. Therefore it cannot make replacing an
`AgentSkill` conditional on the authoritative version, counters, and
`feedbackReduction` state read by the reducer. A `get` followed by `set` or an
unconditional `update` can stale-overwrite a concurrent writer.

This conclusion is deliberately narrow. It does not claim that iii-engine has
no private or future conditional primitive, and it does not contradict the SDK
declaration that a supplied ordered update operation list is atomic.

## Phase 3B Requirement Matrix

| Required reducer property | Evidence | Result |
| --- | --- | --- |
| One authoritative key | `KV.skills` already stores an `AgentSkill` by skill ID | Compatible design target |
| Caller can supply expected state | `StateKV.update` payload is only `scope`, `key`, and `ops` | Not available |
| Compare and replacement are indivisible | No public compare/test/precondition operation; SDK only declares ordered mutation operations atomic | Not proven and not expressible |
| Two writers cannot both win | A second writer can issue an unconditional mutation after reading stale state | Not guaranteed |
| Failed precondition is distinguishable | `StateKV` returns `T`; SDK state result declares values, not a conflict outcome | Not available |
| Multi-process safety | Process-local `withKeyedLock` is a module `Map`; engine locking semantics are not documented in installed SDK | Not established |
| Timeout outcome has documented retry behavior | SDK exposes `invocationTimeoutMs`; no installed documentation defines commit outcome after timeout | Unresolved |

The missing caller precondition alone is sufficient for this public surface to
be unsuitable. The remaining unresolved backend details are recorded rather
than inferred.

## Evidence Map

### Repository wrapper and call sites

`src/state/kv.ts` forwards five function IDs through `sdk.trigger()`:
`state::get`, `state::set`, `state::update`, `state::delete`, and `state::list`.
Its `update` input is exactly `{ scope, key, ops }`; each operation has
`type`, `path`, and optional `value`. It neither accepts nor returns a revision,
expected value, ETag, fingerprint, transaction token, or conflict discriminator.
The wrapper types the result as `T`, so the SDK's optional old/new values are
not surfaced as a conditional-write result to AgentMemory callers.

Repository `kv.update` call sites update fields such as session counters and
decision-audit fields. They supply mutation operations only. Search found no
repository use of `compareAndSet`, `expectedRevision`, `expectedValue`,
`ifMatch`, or `etag` against the state API.

`src/state/keyed-mutex.ts` implements `withKeyedLock` with a module-level
`Map<string, Promise<void>>`. It serializes calls only in one Node.js process;
it is not an engine, database, or multi-worker coordination primitive. Several
functions use it to reduce same-process read-modify-write races, which is not
evidence of distributed conditional-write safety. Test mocks that execute the
callback immediately likewise are not backend-concurrency proof.

### Resolved SDK public contract

`package.json` requests `iii-sdk` `0.11.2`, and `npm ls iii-sdk --depth=0`
resolves `iii-sdk@0.11.2`. No npm, pnpm, yarn, or shrinkwrap lockfile is present
in this checkout, so package-resolution integrity cannot be independently
established from a lockfile.

`node_modules/iii-sdk/dist/state.d.mts` defines `StateUpdateInput` as
`scope`, `key`, and `ops`, and calls those operations atomic. Its
`StateUpdateResult` contains optional `old_value` and `new_value`; it contains
no revision, compare result, conflict code, or failed-precondition variant.

The imported `UpdateOp` union in
`node_modules/iii-sdk/dist/stream-BkrU83KD.d.mts` permits only `set`,
`increment`, `decrement`, `remove`, and `merge`. It has no RFC 6902 `test` op
or equivalent conditional operation. The installed SDK package exports types
and client code, not the iii-engine state backend implementation.

The SDK documents `invocationTimeoutMs` with a default of 30 seconds, but the
installed public types and README do not define whether an invocation that times
out before its response committed, failed before commit, or committed after the
caller timed out.

### Deployment and persistence

`iii-config.yaml` configures an `iii-state` worker with a file-based KV adapter
at `./data/state_store.db`. The Docker configuration maps the equivalent
database path to `/data/state_store.db` and pins the iii-engine image to
`0.11.2`. This demonstrates durable storage configuration, not conditional
update, transaction, locking, conflict, multi-worker, or retry semantics. The
installed SDK did not provide the corresponding backend implementation for
source inspection.

## `state::update` Questions

| Question | Audit answer |
| --- | --- |
| Is mutation sent to the server rather than applied in `StateKV`? | `StateKV` delegates to `sdk.trigger({ function_id: 'state::update' })`; server-side backend behavior is not present in the installed SDK source. |
| Is one supplied operation list atomic? | The public SDK type documentation says yes. |
| Which operation types are available? | `set`, `increment`, `decrement`, `remove`, and `merge`. |
| Is there an RFC 6902 `test` or compare op? | No. |
| Can caller supply expected revision/value/fingerprint? | No public input field supports it. |
| Can a failed precondition be distinguished from validation/network failure? | No precondition or conflict result is exposed. |
| Can version, counters, metadata, and evidence fingerprint be conditioned together? | No; they can be mutated, but not compared before mutation through this public API. |
| Can two workers be proven unable to win? | No. The repository's keyed mutex is process-local and engine semantics are undocumented here. |
| Is retry after timeout safe? | Not documented; a client must treat commit outcome as unknown rather than blindly retry. |

## Architectural Decision

The proposed Phase 3B reducer remains blocked. It must not fall back to
`kv.get` plus `kv.set`, unguarded `kv.update`, process-local locking, a second
receipt key, or client-side precondition checks. Those approaches do not meet
the documented single-authoritative-record and multi-worker idempotency
contract in `skill-feedback-reducer-idempotency.md`.

A later, separately authorized milestone may reassess only after a conditional
primitive is available and proven from the actual deployed backend. That future
evidence must show a single-key compare plus replacement, a distinct conflict
outcome, multi-worker behavior, and timeout/ambiguous-result retry semantics.

## Commands Used

The audit inspected the resolved dependency and repository with bounded source
searches including:

```text
git grep -n -e "state::get" -e "state::set" -e "state::update" -e "state::delete" -e "state::list" -e "compareAndSet" -e "expectedRevision" -e "expectedValue" -e "ifMatch" -e "etag" -e "transaction" -e "atomic" -- src test docs scripts plugin
rg -n "state::(get|set|update|delete|list)|compareAndSet|expectedRevision|expectedValue|ifMatch|etag|transaction|atomic|revision|conflict" node_modules/iii-sdk
rg -n "kv\\.update\\(|state::update|withKeyedLock" src test
```

Search results were used as an inventory, not as proof that an uninspected
backend cannot implement additional private behavior.
