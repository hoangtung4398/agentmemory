# Review-Driven Skill Lifecycle Mutation Contract

## Status

Phase 4B0 is a design and state-safety audit only. It authorizes no runtime
implementation. Phase 4A recommendations remain read-only and always return
`applied: false`; they must never dispatch, schedule, or imply a lifecycle
write.

This contract defines prerequisites for a future, separately authorized,
default-off mutation path. It does not grant that authorization.

## Current State Boundary

`AgentSkill` already has `status` (`active`, `retired`, or `superseded`), an
optional `supersedes` reference, lifecycle timestamps, and a `version`.
The resolved public `StateKV` surface provides `get`, unconditional `set`,
unconditional ordered `update`, `delete`, and `list`. It exposes neither a
caller-preconditioned conditional write/CAS nor a multi-key transaction or
conflict result. The existing capability audit classifies that surface as
**PROVEN_UNSUITABLE** for stale-write-safe conditional replacement.

Consequently, get-then-set, get-then-update, process-local locking, and
rereading after an unconditional write are not substitutes for the required
atomic precondition check. They do not protect multiple workers or an unknown
outcome after a timeout or response loss.

## Retirement Contract

A future retirement request is an explicit, direct-only operator action. It
must include:

- the exact `skillId`;
- the expected current `version`;
- the exact persisted `project` and `agentId` scope when present;
- expected current status `active`;
- explicit caller intent to retire; and
- a separate future default-off apply authorization. `lifecycleReviewEnabled`
  is evaluation permission only and can never authorize mutation.

The required atomic operation must compare those caller preconditions against
the authoritative current record and either apply the transition or return a
conflict without changing state. A successful retirement changes only
lifecycle metadata: `status` from `active` to `retired` and the lifecycle
timestamp chosen by the eventual implementation contract. Instruction text,
counters, provenance, version, and `supersedes` must remain unchanged.

An already-applied request with the same authoritative retired state must have
a deterministic idempotent no-op result. Any version, status, or scope change
is a conflict with zero mutation. An unknown write outcome must never cause a
blind retry; it requires an authoritative, safe reconciliation path defined by
the future primitive/protocol.

## Supersession Contract

Supersession is distinct from retirement. It requires an explicit replacement
skill and must establish both authoritative-record invariants:

```text
replacement.supersedes === oldSkill.id
oldSkill.status === "superseded"
```

Phase 4B1 selects the [durable staged protocol](skill-lifecycle-supersession-protocol.md).
It requires full-record single-key CAS plus CREATE_IF_ABSENT for markers with
immutable identity fields and CAS-protected state progression; both remain
blocked runtime prerequisites.

The current StateKV surface provides neither option. Therefore Phase 4B runtime
supersession and retirement remain blocked unless a safe primitive or protocol
is separately authorized, implemented, and proven. A partial pair of ordinary
writes is not acceptable: it can leave a replacement without lineage or an old
skill superseded without its replacement.

## Concurrency, Failure, and Recovery Requirements

The eventual design must state and test behavior for same-process and
multi-worker races, stale versions, concurrent skill/counter changes, crashes
before and after dispatch, response loss or timeouts, and repeated delivery.
It must define the replay identity, deterministic no-op/conflict outcomes,
rollback limits, and reconciliation authority. Recovery may observe and repair
only states explicitly represented by the chosen durable protocol; it must not
guess that an unknown write succeeded.

The mutation path must use bounded reads/writes, preserve project and agent
isolation, avoid exposing instruction bodies, provenance, feedback bodies, or
other private content in conflict/recovery results, and preserve all existing
record shapes and default behavior when disabled. It must not alter ranking,
recall, context packing, hook payloads, REST/MCP schemas, or existing lifecycle
review behavior.

## Explicit Non-Behavior

Phase 4B0 performs zero runtime state reads or writes. It adds no function
registration, configuration or environment flag, KV field/scope/schema, audit
operation, REST/MCP/CLI/hook/viewer surface, replacement creation, automatic
retirement/supersession, or ranking/recall/context change. Public inventory
remains 60 MCP tools, 135 REST endpoints, and 15 skills.

## Future Implementation Gate

Before a lifecycle write implementation can be proposed, a separate review
must authorize and prove the conditional single-key primitive needed for
retirement and, for supersession, either an atomic multi-key transaction or a
durable staged protocol. That review must include concurrency, crash, replay,
privacy, bounded-I/O, and compatibility proof. This document is not that
implementation or proof.
