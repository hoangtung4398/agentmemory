# Conditional State Upstream Ownership Audit

## 1. Status and authorization boundary

**Primary decision: `BLOCKED_PENDING_UPSTREAM_ALIGNMENT`.** This Phase 3B2C0
audit is documentation plus read-only inspection of `iii-hq/iii`. It does not
authorize an upstream issue, fork, branch, pull request, push, release, SDK or
image publication, runtime probe, or any AgentMemory implementation.

Status words are deliberate: **inspected** means source or metadata was read at
the immutable references below; **designed** means a future contract exists in
documentation; **implemented** means source is changed; **tested** means a
named test was run; **proven** means the relevant authoritative behavior and
evidence are established; **released** means a distributable artifact was
published; and **consumable** means AgentMemory can safely use that released
capability. Only the first two apply to the future primitive today. It is not
implemented, tested, proven, released, or consumable.

## 2. Downstream and upstream repositories

| Repository | Role | Authority |
| --- | --- | --- |
| `hoangtung4398/agentmemory` | Downstream application and this audit | Owns only future `StateKV` adaptation and the reducer after upstream proof. |
| `iii-hq/iii` | Upstream engine, state worker, adapters, SDKs, release workflows | Owns authoritative comparison/replacement correctness and the public SDK contract. |

AgentMemory cannot implement, emulate, or prove the upstream correctness
property with a local lock, `get` plus `set`, or `state::update`.

## 3. Immutable source references

| Purpose | Immutable reference | Meaning |
| --- | --- | --- |
| Pinned release source | `iii/v0.11.2^{}` = `2b445957701f94dc5f56f900af314e9d59f3b0f7` | AgentMemory's pinned SDK and engine line. |
| Current comparison snapshot | `c84f918f6f5e92e32ad78e6695d581c9e1995c9b` | Bounded source comparison only; not floating `main`. |
| Floating reference, not used as evidence | `main` | Deliberately excluded because it can move. |

The tag object is `6f63c9c1517d996eb68577a7f127ab950fc83a82` and peels to
the release source commit above. The release ref and current snapshot were
both inspected read-only.

## 4. Distributed artifact mapping

| Consumer reference or artifact | Source relationship | Audit status | Boundary |
| --- | --- | --- | --- |
| AgentMemory package dependency `iii-sdk@0.11.2` | Exact dependency in AgentMemory `package.json`; npm metadata reports version `0.11.2` | Proven | Pins the Node SDK package, not a future primitive. |
| `iii-sdk@0.11.2` npm package | Release source `sdk/packages/node/iii/package.json` names `iii-sdk` version `0.11.2`; release workflow invokes npm publish | Partially proven | Published package exists; this audit does not reproduce or attest its build provenance. |
| AgentMemory Docker reference `iiidev/iii:0.11.2` | Exact default in `docker-compose.yml` | Proven | Pins an image tag, not source provenance. |
| `iiidev/iii:0.11.2` image | Release workflow names `iiidev/iii`, and registry manifest resolves to digest `sha256:4d032e1df5d6a4dc2080a94dd11dd87411de5dccb46bd563b557de9ba3c20894` | Partially proven | Tag is available; matching version alone does not prove the image was built from the inspected tag. |
| `iii/v0.11.2` GitHub release source | Peeled tag resolves to `2b445957...`; GitHub release exists | Proven | Source and binary-release artifact availability do not establish future CAS support. |

## 5. State-worker source inventory

The release state worker owns function registration and dispatch. Its inspected
inventory is below; blob IDs make the source evidence reproducible.

| Release path | Blob | Current snapshot counterpart | Finding |
| --- | --- | --- | --- |
| `engine/src/workers/state/state.rs` | `c66bb2d772d44747d0c31800c6de66bf99bb8489` | `dcf1e2a15907a1b50605b208d7f09661d80e7cf3` | Registers `state::set`, `get`, `delete`, `update`, `list`, and `list_groups`; no compare-and-set registration. |
| `engine/src/workers/state/structs.rs` | `3a65ed1227b40217d49b4380067254eb52d39e1d` | `b7dbf09f04d9cc08fd3764670189563d371142a8` | State inputs contain scope/key/value or ordered operations; no expected value or conflict outcome. |
| `engine/src/workers/state/config.rs` | `3b6464ffe925efcfb75494ad3a8ee64c2aa865d7` | `18d5af4791d7e842e5bc4c126699438af6f10ef6` | State-worker configuration ownership. |
| `engine/src/workers/state/registry.rs` | `6b6015a211664d8feba4a2a01c4b7a120ef301cf` | `e316ce5e0b8a4fe253a719d955148f5ebbdf643a` | Adapter registration ownership. |
| `engine/src/workers/state/adapters/mod.rs` | `d12ed5cfea33b7a32de41e7dea980f82a466ec54` | `29eafa68a884a899435ee0b4f3050fb89b6da398` | Trait exposes only current operations; current adds reconfiguration but no conditional operation. |
| `engine/src/builtins/kv.rs` | `637eec3ca08373a6983505b05816839a40ea2e43` | `f7c768236fe74391e407ebcadcdf921b54b2fa9d` | Built-in file/KV implementation and per-process locking/persistence mechanics. |
| `engine/src/update_ops.rs` | Not present at release | `81da07bf045bbc0d458bba63e528851adcfedc10` | Current-only update-operation restructuring; not evidence of a conditional primitive. |

Both references retain the same state function family and neither inspected
public input/result surface contains `expected_value`, an explicit conditional
operation, or an `applied`/`conflict`/`not_found` normal result union.

## 6. Adapter ownership and capabilities

At `iii/v0.11.2`, `StateAdapter` defines `set`, `get`, `delete`, `update`,
`list`, `list_groups`, and `destroy`. The module declares exactly the three
shipped adapter modules below; none has a conditional trait method.

| Adapter | Release path and blob | Current result | Capability relevance |
| --- | --- | --- | --- |
| Built-in KV/file | `adapters/kv_store.rs` `6ade7bb6f3bdb9608b60ec060cc3a24e14baa137` | Same adapter family remains | Delegates existing methods to `BuiltinKvStore`; no public conditional operation. |
| Redis | `adapters/redis_adapter.rs` `54ffe58d9c103eb74e072db07107cc0641a05e9b` | Current blob `8f026894cdbca2e81856870684b0803575056ad0` | Uses Lua for current set/update mechanics, but exposes neither caller-supplied expected state nor a conflict result. |
| Bridge | `adapters/bridge.rs` `1487561b12c109d8a936e5e2322aed8a44177e08` | Current blob `8735b834d4f3fdde759481f1d5b38b2964e33fd2` | Proxies the existing state functions to another worker; it cannot manufacture a missing authoritative primitive. |

The selected proof policy is **`ALL_SHIPPED_ADAPTERS_MUST_SUPPORT`**. This
avoids silently weakening the contract on a configured adapter. A future
upstream change may instead propose `UNSUPPORTED_ADAPTERS_FAIL_CAPABILITY_DISCOVERY`,
but that would require an explicit, reviewed capability contract and does not
exist today.

## 7. SDK ownership and public surface

The upstream Rust SDK owns wire types used by the engine; its release
`sdk/packages/rust/iii/src/types.rs` blob is
`4d44c297768331c08069e946e4d9d3cb159448b1`. It supplies `UpdateOp`,
`UpdateResult`, and `SetResult`, none of which models a conditional result.

The Node SDK owns downstream TypeScript input/result types. Release
`sdk/packages/node/iii/src/state.ts` blob
`126a05717dd5d41a1bc7af90c20af544bb31753c` exposes `IState.get`, `set`,
`delete`, `list`, and `update`; current blob
`68e34174de06d1d87f6a0984bfd4043d47c36f9c` keeps that same operation set.
Any future primitive therefore needs coordinated engine deserialization,
adapter trait, Rust types, Node types/client behavior, and release work in
`iii-hq/iii`.

## 8. Release and CI ownership

Release source has monorepo build/test scripts in root `package.json`, including
`build:engine`, `test:engine`, `test:sdk-node`, `test:sdk-rust`, Rust workspace
tests, format, and clippy commands. `release-iii.yml` is tag-triggered by
`iii/v*`; it creates the GitHub release, invokes engine binary release, Node
SDK npm publishing, Rust SDK publishing, and a Docker engine workflow.

`_npm.yml` builds the selected package and publishes with the upstream NPM
token. `docker-engine.yml` downloads a tagged engine binary, builds platform
images, and publishes `iiidev/iii:<version>`. Those secret-bound publish steps
are upstream release-owner responsibilities; their existence is not permission
or proof that a new backport can be released.

## 9. Contribution and licensing boundary

`CONTRIBUTING.md` asks contributors to discuss larger features in an issue,
fork the repository, submit a focused PR against `main`, include applicable
tests, and run `cargo fmt` and `cargo clippy -- -D warnings`. It also requires
contributors to have employer/IP permission where relevant. Contributions are
under Apache-2.0 terms, while the engine runtime is distributed under ELv2.

The future upstream owner is an **upstream maintainer** for acceptance and
release publication; an **external contributor** may prepare a reviewed PR;
an **AgentMemory maintainer** owns only downstream compatibility analysis and
later adapter/reducer integration. This audit performs none of those actions.

## 10. Release-line versus current-main comparison

The comparison is bounded to the fixed snapshots. The release uses `iii-sdk`
and engine version `0.11.2`; the comparison snapshot declares `0.22.0` for
both. Between these refs, the bounded diff modifies the state worker, all three
state adapters, the built-in KV store, Node and Rust SDK trees, root workspace
files, and many release/CI and `iii-worker` paths. `engine/src/update_ops.rs`
exists only in the comparison snapshot.

Despite that substantial evolution, the inspected current state adapter trait,
state input structs, and Node `IState` surface still do not contain the designed
conditional operation. Current main is therefore neither a proven upgrade path
nor evidence that the 0.11 line can receive a backport.

## 11. Ownership matrix

| Concern | Owning repo | Owning path | 0.11.2 status | Current status | Future owner |
| --- | --- | --- | --- | --- | --- |
| Runtime registration | `iii-hq/iii` | `engine/src/workers/state/state.rs` | Inspected: no CAS | Inspected: no CAS | Upstream maintainer/external contributor |
| Request deserialization | `iii-hq/iii` | `engine/src/workers/state/structs.rs` | Inspected: no expected state | Inspected: no expected state | Upstream maintainer/external contributor |
| Adapter trait | `iii-hq/iii` | `engine/src/workers/state/adapters/mod.rs` | Inspected: no conditional method | Inspected: no conditional method | Upstream maintainer/external contributor |
| File/KV adapter | `iii-hq/iii` | `engine/src/workers/state/adapters/kv_store.rs`, `engine/src/builtins/kv.rs` | Inspected | Inspected | Upstream maintainer/external contributor |
| Redis adapter | `iii-hq/iii` | `engine/src/workers/state/adapters/redis_adapter.rs` | Inspected | Inspected | Upstream maintainer/external contributor |
| Bridge adapter | `iii-hq/iii` | `engine/src/workers/state/adapters/bridge.rs` | Inspected | Inspected | Upstream maintainer/external contributor |
| Rust SDK types | `iii-hq/iii` | `sdk/packages/rust/iii/src/types.rs` | Inspected: no result union | Bounded tree changed | Upstream maintainer/external contributor |
| Node SDK types/client | `iii-hq/iii` | `sdk/packages/node/iii/src/state.ts` | Inspected: no CAS method | Inspected: no CAS method | Upstream maintainer/external contributor |
| Engine release | `iii-hq/iii` | `.github/workflows/release-iii.yml` | Inspected | Inspected workflow differs | Upstream release publisher |
| npm SDK release | `iii-hq/iii` | `.github/workflows/_npm.yml` | Inspected | Inspected workflow differs | Upstream release publisher |
| AgentMemory `StateKV` | `hoangtung4398/agentmemory` | `src/state/kv.ts` | Downstream, blocked | Downstream, blocked | AgentMemory maintainer after upstream proof |
| AgentMemory reducer | `hoangtung4398/agentmemory` | future reducer gate only | Downstream, blocked | Downstream, blocked | AgentMemory maintainer after 3B2D |

## 12. Version-line matrix

The only allowed cells in this matrix are `Proven`, `Absent`, `Unknown`, and
`Not applicable`.

| Criterion | `iii/v0.11.2` line | Current snapshot `c84f918...` | Consequence |
| --- | --- | --- | --- |
| Source available | Proven | Proven | Both fixed trees can be inspected. |
| Release branch maintained | Absent | Not applicable | Remote heads include `main` but no `0.11` maintenance branch. |
| Feature PR accepted | Unknown | Unknown | Requires upstream maintainer alignment. |
| Build | Unknown | Unknown | Build scripts are present, but this audit does not run upstream builds. |
| Node SDK publishable | Unknown | Unknown | Release workflow and published 0.11.2 npm metadata exist, but no future primitive release route is approved. |
| Backend tests | Absent | Absent | No conditional primitive or authoritative CAS test exists to inspect. |
| AgentMemory compatibility | Proven | Unknown | AgentMemory is deliberately pinned to 0.11.2; newer line compatibility is not established. |
| Requires refactor | Not applicable | Proven | AgentMemory documentation says newer iii sandbox-model releases require refactoring. |
| Migration | Not applicable | Unknown | No approved upgrade plan exists. |
| Maintainer alignment | Unknown | Unknown | No upstream discussion, acceptance, or release commitment was requested. |

## 13. Authoritative backend proof options

Future upstream work must prove one authoritative same-key linearization path
for every shipped adapter selected by the policy. At minimum it must cover
full-JSON structural equality, `applied`, `conflict`, and `not_found`; races
against set/update/delete; cross-worker/process behavior; timeout/response-loss
reconciliation; and backend durability/visibility appropriate to each adapter.

The file/KV implementation and Redis Lua implementation are different
authoritative boundaries, while bridge delegates to another state worker. A
mock, local SDK equality check, process-local mutex, or a get-plus-set sequence
cannot supply that proof.

## 14. Contribution path

Before an upstream implementation, a maintainer-aligned issue or discussion
must establish target version line, adapter support policy, public wire result,
release owner, and acceptance criteria. A future contributor would fork
`iii-hq/iii`, make a focused PR against `main` unless maintainers explicitly
authorize another target, add engine/SDK/adapter tests, run Rust formatting and
clippy plus relevant Node tests, satisfy licensing/IP requirements, and await
maintainer review and release publication.

This is a future process description, not an instruction to open an issue or
perform upstream work now.

## 15. Primary version-line decision

**`BLOCKED_PENDING_UPSTREAM_ALIGNMENT`** is selected.

`BACKPORT_0_11_2_LINE` is not selected because there is no inspected maintained
0.11 release branch or maintainer/release commitment. `UPGRADE_AGENTMEMORY_FIRST`
is not selected because the fixed current snapshot also lacks the primitive and
AgentMemory's compatibility/refactor path is not proven.

## 16. Decision rationale

The 0.11.2 state worker, adapters, and Node/Rust SDK types establish that the
required primitive is absent. The current snapshot retains that absence while
showing a substantial version-line and runtime/SDK evolution. Although the
0.11.2 source, npm package, GitHub release, and Docker tag are available, this
does not prove a supported backport route, release authority, or all-adapter
correctness proof.

`BLOCKED_PENDING_UPSTREAM_ALIGNMENT` blocks implementation and downstream
adoption decisions; it does not make alignment logically impossible. Phase
3B2C1 is the separately authorized upstream-alignment milestone. No 3B2C2
implementation, 3B2C3 proof/release work, 3B2D downstream adoption, or 3B3
reducer work may begin until 3B2C1 records maintainer-approved target-line,
adapter-policy, contribution, acceptance, and release decisions. This PR does
not authorize 3B2C1 itself.

## 17. Required upstream deliverables

1. Maintainer-approved target line and contribution/release plan.
2. Runtime registration, request/result deserialization, and `StateAdapter`
   contract for the designed full-record operation.
3. File/KV, Redis, and bridge behavior under the selected all-adapters policy.
4. Coordinated Rust and Node SDK public types/client behavior.
5. Authoritative backend concurrency, failure, and compatibility tests.
6. Released engine and SDK artifacts with verifiable source/artifact provenance.

## 18. Required downstream deliverables

1. A separately authorized 3B2D `StateKV.compareAndSet` adapter.
2. Explicit capability/pinned-version handling that fails closed, never
   emulates CAS, and does not probe production state dynamically.
3. Isolated AgentMemory compatibility and integration tests against released
   upstream artifacts.
4. Only after that proof, separately authorized reducer work behind its
   default-off gate.

## 19. Future phase split

| Phase | Scope | Status |
| --- | --- | --- |
| 3B2C0 | This ownership/version-line audit | Designed and inspected documentation only |
| 3B2C1 | Separately authorized upstream alignment and implementation-plan approval | Future |
| 3B2C2 | Runtime and SDK implementation in an authorized iii target line | Future |
| 3B2C3 | Authoritative proof and released artifact/provenance evidence | Future |
| 3B2D | AgentMemory adapter, capability/pinning, and integration | Future |
| 3B3 | Internal reducer application | Blocked until 3B2C3 and 3B2D are complete |

The next possible milestone after this audit is reviewed and merged is 3B2C1,
subject to separate explicit authorization. It is where alignment can occur;
it is not a prerequisite that must already be complete. If its outcome later
selects a backport, maintainer and release alignment remains part of that
outcome. If it selects an upgrade, a separate AgentMemory runtime-upgrade
prerequisite precedes 3B2D.

## 20. Prohibited assumptions

- A matching Docker or npm version proves source provenance or conditional support.
- Existing atomic update semantics are compare-and-set semantics.
- A bridge, SDK method name, mock, process-local lock, or client retry supplies
  authoritative cross-worker correctness.
- Current main is an approved upgrade target or 0.11 is a maintained backport line.
- AgentMemory may add `StateKV.compareAndSet`, capability detection, types,
  tests, pins, or reducer writes before upstream artifacts are proven.
- Any upstream fork, issue, pull request, push, build, release, or publication
  is authorized by this documentation audit.

## 21. Evidence appendix

Read-only evidence collected for this audit:

- Fixed tag and source: `iii/v0.11.2` tag object `6f63c9c...`, peeled commit
  `2b445957...`; current comparison commit `c84f918f...`.
- Release state trait blob `d12ed5c...` and current trait blob `29eafa...`;
  both list only current state methods and no conditional method.
- Release Node state blob `126a057...` and current Node state blob `68e341...`;
  both expose no CAS method or discriminated conditional outcome.
- Release Redis adapter blob `54ffe58...` demonstrates existing Lua atomic
  operations, not a caller-precondition API.
- `iii-sdk@0.11.2` npm metadata reports its published tarball; the Docker tag
  resolves to the digest stated above. Neither query establishes image/source
  provenance beyond its documented release workflow relationship.
- Remote-head inspection found no `0.11` maintenance branch. `main` was not
  used as a substitute source reference.
