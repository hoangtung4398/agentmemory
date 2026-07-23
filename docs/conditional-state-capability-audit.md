# Conditional State Capability Audit

## Status and Authorization Boundary

Phase 3B1 is merged. Phase 3B2A is an audit-only documentation milestone based
on `f40a8a32492e8393026f945a07826147c3e999eb`; it does not authorize a
conditional primitive, a reducer write, reduction metadata, configuration, or a
production state write. The resolved public dependency is `iii-sdk@0.11.2`.

This audit decides whether that public state surface can perform the future
Phase 3B reducer's same-key conditional replacement. It does not make a claim
about every private, internal, or future iii-engine implementation.

## Required Reducer Guarantees

The proposed reducer must condition one replacement of the authoritative
`KV.skills` record on the same observed skill version, counters, and
`feedbackReduction` fingerprint. It needs a caller-supplied expected state,
indivisible comparison and mutation, a distinguishable conflict outcome, no
stale overwrite across workers, and safe handling when a response or timeout
leaves commit outcome unknown.

## Current StateKV Surface

| Method | Runtime function | Payload | Conditional input | Claimed guarantee |
| --- | --- | --- | --- | --- |
| `get` | `state::get` | `scope`, `key` | None | Read a value |
| `set` | `state::set` | `scope`, `key`, `value` | None | Create or overwrite a value |
| `update` | `state::update` | `scope`, `key`, `ops` | None | Apply an ordered update operation list atomically |
| `delete` | `state::delete` | `scope`, `key` | None | Delete a value |
| `list` | `state::list` | `scope` | None | List scope values |

`src/state/kv.ts` forwards those payloads through `sdk.trigger()`. It exposes
no expected revision, expected value, ETag, fingerprint, transaction token, or
conflict discriminator. Its generic return type does not surface a
conditional-write result to AgentMemory callers.

## Dependency Identity

| Component | Requested version | Resolved version/source | Evidence path |
| --- | --- | --- | --- |
| iii SDK | `0.11.2` | `iii-sdk@0.11.2` | `package.json`, `npm ls iii-sdk --depth=0`, `node_modules/iii-sdk/package.json` |
| State API types | n/a | Installed package | `node_modules/iii-sdk/dist/state.d.mts` |
| Update operation types | n/a | Installed package | `node_modules/iii-sdk/dist/stream-BkrU83KD.d.mts` |
| State worker | n/a | File-based KV configuration | `iii-config.yaml`, Docker configuration |

No npm, pnpm, yarn, or shrinkwrap lockfile exists at this base. The installed
package therefore cannot be independently reproduced from a committed lockfile.

## State Runtime Implementation Evidence

The installed SDK provides client code and public type declarations, not the
iii-engine state backend implementation. The repository configures an
`iii-state` worker using a file-based KV adapter, but no inspected source proves
backend transaction, lock, multi-worker, retry, or post-timeout semantics.

Evidence classifications used below are exact:

| Finding | Classification | Basis |
| --- | --- | --- |
| `StateKV` payload shape | Proven by repository source | `src/state/kv.ts` |
| Available `UpdateOp` variants | Proven by installed SDK source | Installed declaration union |
| Ordered operations are described as atomic | Documented but not runtime-verified | Installed SDK declaration comment |
| No compare/test/expected-state input in audited public request shape | Proven by repository source and installed SDK source | Wrapper and SDK input/operation declarations |
| No distinct precondition conflict result in audited public result shape | Proven by repository source and installed SDK source | Wrapper return type and SDK result declarations |
| `withKeyedLock` is process-local | Proven by repository source | Module-level `Map` implementation |
| File-backed persistence configuration | Proven by repository source | Engine configuration |
| Backend transaction and multi-worker behavior | Unknown | Engine implementation was not available in installed SDK |
| Timeout commit outcome and SDK automatic retry behavior | Unknown | Public timeout option has no commit/retry semantics |

SDK declarations establish the audited public contract; they do not prove the
private backend algorithm. Test mocks are test-only behavior, not production
guarantees.

## Capability Matrix

| Capability | Required | Evidence | Status |
| --- | --- | --- | --- |
| Single authoritative key | Yes | `KV.skills` stores an `AgentSkill` by skill ID | Proven |
| Single-key operation | Yes | State functions accept `scope` and `key` | Proven |
| Atomic replacement | Yes | No public complete conditional replacement contract is documented | Unknown |
| Atomic ordered patch | Optional | SDK documents ordered `ops` as atomic | Proven |
| Caller-supplied expected state | Yes | No wrapper or SDK input field | Absent |
| Compare and mutation indivisible | Yes | No compare or `test` operation | Absent |
| Distinguishable conflict result | Yes | No precondition/conflict result shape | Absent |
| No stale overwrite | Yes | Unconditional mutation remains expressible | Absent |
| Cross-process safety | Yes | Backend semantics unavailable | Unknown |
| Cross-machine safety | Yes | Backend semantics unavailable | Unknown |
| Timeout/response-loss semantics | Yes | Not documented | Unknown |
| Automatic mutation retry semantics | Yes | Not documented | Unknown |
| Unknown write outcome can be modelled | Yes | Future design can model it; runtime behavior is undocumented | Unknown |

The `Absent` findings apply to the audited public surface, not to an uninspected
private or future engine primitive.

## Three Distinct State Capabilities

### Atomic Replacement

The backend writes a complete record without partial corruption. It does not by
itself prevent a stale writer from replacing newer state.

### Atomic Ordered Patch

The backend applies an ordered group of mutations atomically. The installed SDK
documents this capability for `state::update`; it does not compare authoritative
state first.

### Conditional Atomic Replacement

The backend checks caller-supplied expected authoritative state and performs one
replacement only when it still matches. This is the Phase 3B requirement.

The audited public surface proves atomic ordered patch behavior only. Atomic
ordered patch is not compare-and-set.

## `state::update` Assessment

`StateKV` delegates `state::update` to `sdk.trigger()`, so mutation is not
performed inside the wrapper. The public input is limited to `scope`, `key`, and
ordered `ops`. The installed `UpdateOp` union permits `set`, `increment`,
`decrement`, `remove`, and `merge`; it has no RFC 6902 `test` operation or
equivalent expected-state comparison.

The operation list is documented as atomic, but caller preconditions cannot be
expressed and no conflict outcome is exposed. Version, counters, reduction
metadata, and evidence fingerprint can be mutated but cannot be compared before
the mutation through this public contract. Two writers can therefore issue
unconditional mutations after observing the same older state.

## Concurrency and Failure Model

| Scenario | Public-surface finding | Required future behavior |
| --- | --- | --- |
| Two writers use the same observed state | Both can issue unconditional mutations | Only one conditional write may succeed |
| Stale writer arrives later | Stale overwrite is expressible | Conflict |
| Worker crashes before request | No committed write is expected | Safe retry after reread |
| Worker crashes after dispatch | Commit state unknown | Reread before retry |
| Timeout before commit | Indistinguishable | Outcome unknown |
| Timeout after commit | Indistinguishable | Outcome unknown and no blind replay |
| Response lost after commit | Indistinguishable | Reread and recompute |
| Backend restart | Semantics unavailable | Documented durability and conflict behavior required |
| SDK retries mutation automatically | Behavior unavailable | Must be disabled or proven idempotent |
| Caller retries | Unsafe for unconditional mutation | Recompute and conditional apply only |

Unknown entries describe required future behavior, not actual commit behavior.

## Dynamic Probe Status

Not executed because an isolated runtime with proven non-shared state,
controlled multi-process topology, and response-loss instrumentation was not
established for this audit.

No production, company, or shared development state was accessed, and no
disposable runtime probe was committed. The absence of a probe leaves backend
multi-worker and timeout behavior `Unknown`; it does not change the
`PROVEN_UNSUITABLE` conclusion because caller preconditions are already absent
from the public request contract.

## Primary Conclusion

**PROVEN_UNSUITABLE** for the Phase 3B reducer's required conditional,
single-key replacement.

The audited public `iii-sdk@0.11.2` surface offers atomic ordered mutation
operations but cannot carry caller-supplied expected state, compare before
mutation, or return a distinct precondition conflict. This alone excludes it
from the reducer CAS contract. Backend concurrency and timeout details remain
unknown, and this does not prove iii-engine lacks a private or future primitive.

## Phase 3B2B Recommendation

**ADD_NEW_RUNTIME_PRIMITIVE**

`ADAPT_EXISTING_PRIMITIVE` is rejected because the public surface cannot carry
caller-supplied expected state or return a distinct conflict. `ACQUIRE_MORE_EVIDENCE`
is not the primary recommendation because additional backend details cannot make
the existing public request shape express a precondition. Future evidence may
reveal another supported primitive, but the audited `state::update` contract
remains unsuitable. Phase 3B2B must design a new or newly exposed runtime
primitive before implementation is considered.

## Prohibited Assumptions

Future work must not infer CAS from a function name, remote execution, atomic
patch wording, a process-local mutex, or test mocks. It must not use `get` plus
`set`, unguarded `update`, a second receipt key, or client-side precondition
checks as a replacement for a same-key conditional write.

## Evidence Appendix

| Path | Symbol/configuration | Classification | What it proves | What it does not prove |
| --- | --- | --- | --- | --- |
| `src/state/kv.ts` | `StateKV` | Proven by repository source | Public function IDs, payloads, and wrapper returns | Engine behavior |
| `src/state/keyed-mutex.ts` | `withKeyedLock` | Proven by repository source | Same-process `Map` serialization | Cross-process or distributed locking |
| `package.json` | `iii-sdk` dependency | Proven by repository source | Requested version | Resolved installation integrity |
| `node_modules/iii-sdk/package.json` | `version` | Proven by installed SDK source | Installed version | Lockfile reproducibility |
| `node_modules/iii-sdk/dist/state.d.mts` | `StateUpdateInput`, `StateUpdateResult` | Proven by installed SDK source | Public update fields and result shape | Backend algorithm or conflict implementation |
| `node_modules/iii-sdk/dist/stream-BkrU83KD.d.mts` | `UpdateOp` | Proven by installed SDK source | Available mutation variants lack compare/test | Private extension points |
| `iii-config.yaml` | `iii-state` file-based adapter | Proven by repository source | Persistence configuration | Transactions, conflicts, worker topology, or retries |
| `iii-config.docker.yaml` and `docker-compose.yml` | Engine state path/image | Proven by repository source | Container deployment configuration | State backend semantics |

## Commands Used

The audit used bounded source inspection including:

```text
git grep -n -e "state::get" -e "state::set" -e "state::update" -e "state::delete" -e "state::list" -e "compareAndSet" -e "expectedRevision" -e "expectedValue" -e "ifMatch" -e "etag" -e "transaction" -e "atomic" -- src test docs scripts plugin
rg -n "state::(get|set|update|delete|list)|compareAndSet|expectedRevision|expectedValue|ifMatch|etag|transaction|atomic|revision|conflict" node_modules/iii-sdk
rg -n "kv\\.update\\(|state::update|withKeyedLock" src test
```

Results are an inventory of the audited repository and installed public package,
not proof that an uninspected backend has no private behavior.
