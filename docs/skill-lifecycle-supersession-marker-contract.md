# Skill Supersession Operation Identity and Durable Marker Contract

## 1. Status and authorization boundary

**Status: designed only.** Phase 4B2 makes the Phase 4B1 durable staged
supersession protocol unambiguous. It defines the conceptual operation identity,
marker evidence, marker state authority, and retention boundary that a later
implementation must preserve.

This document creates no KV namespace, TypeScript type, runtime function,
marker writer, recovery worker, configuration flag, or public surface. It does
not implement the conditional primitives required by Phase 4B1. The companion
semantic contracts remain
[`conditional-state-primitive-contract.md`](conditional-state-primitive-contract.md)
for full-record CAS and
[`conditional-state-create-if-absent-contract.md`](conditional-state-create-if-absent-contract.md)
for missing-key creation.

## 2. Conceptual identity envelope

Each supersession operation has one immutable conceptual identity envelope:

```text
schemaVersion = 1
kind = "skill_supersession"

oldSkillId
replacementSkillId

project
agentId

operationTimestamp

expectedOldSkill
expectedReplacementSkill
```

`project` and `agentId` are normalized only at this envelope boundary:

```text
missing project -> null
missing agentId -> null
```

Scope strings are otherwise exact persisted values. They must not be trimmed,
lowercased, Unicode-normalized, or otherwise transformed. `operationTimestamp`
is part of the identity and must be preserved across replay; a retry must not
generate a replacement timestamp. Changing any identity field creates a
different operation.

## 3. Canonical serialization

Canonicalization applies to complete persisted JSON values, not arbitrary
in-memory representations. The canonical identity envelope uses these rules:

- Object member names are recursively sorted in UTF-16 code-unit ascending
  order.
- Arrays preserve stored order exactly.
- Strings use standard JSON escaping with no Unicode normalization.
- Numbers are finite JSON numbers in standard compact JSON representation.
- `null` and booleans use their normal JSON representations.
- No whitespace occurs outside JSON string contents.
- The resulting byte sequence is UTF-8.

Missing object members remain missing. They are never converted to `null`,
except for the explicit top-level `project` and `agentId` normalization above.
An invalid or non-JSON persisted value is not canonicalized as operation
identity evidence.

## 4. Operation digest

The operation ID is a domain-separated SHA-256 digest:

```text
domain = "agentmemory.skill-supersession.v1\\n"

operationId = lowercase_hex(
  SHA256(
    UTF8(domain) || canonicalIdentityEnvelope
  )
)
```

This digest is an AgentMemory protocol identity only. It is not an iii state
revision, CAS token, database transaction ID, or security credential.

The following consequences are mandatory:

```text
same complete identity       -> same operationId
different expected record    -> different operationId
different timestamp          -> different operationId
different scope              -> different operationId
different old/replacement    -> different operationId
```

The Phase 3A evidence hash must not be reused: it has a different
canonicalization domain and purpose.

## 5. Conceptual marker contents

A future marker is conceptually `SkillSupersessionMarkerV1`. Its immutable
creation evidence is equivalent to:

```text
schemaVersion
kind
operationId

oldSkillId
replacementSkillId

project
agentId
operationTimestamp

expectedOldSkill
expectedReplacementSkill

linkedReplacementSkill
supersededOldSkill
```

`linkedReplacementSkill` is the exact complete target record derived from
`expectedReplacementSkill` with the required `supersedes` link. `supersededOldSkill`
is the exact complete target record derived from `expectedOldSkill` with the
chosen lifecycle timestamp. Both are determined before the first skill mutation
and are immutable operation evidence.

The marker's mutable authority is deliberately limited to:

```text
state
terminalReason?  // bounded enum or code only
```

`terminalReason` must not carry arbitrary errors, stack traces, instruction
text excerpts, backend responses, or other unbounded private data. This is a
conceptual contract only; no source type or persisted schema is introduced.

## 6. State invariants and transitions

The marker states remain exactly:

```text
prepared
replacement_linked
old_superseded
completed
conflict
reconciliation_required
```

No state is added by this contract. The only normal progression is:

```text
prepared -> replacement_linked -> old_superseded -> completed
```

Allowed failure progression is bounded as follows:

| Current state | Allowed transition | Required condition |
| --- | --- | --- |
| `prepared` | `conflict` | No skill mutation from this operation committed. |
| `prepared` | `reconciliation_required` | Outcome cannot be proven. |
| `replacement_linked` | `conflict` | Exact CAS rollback restores `expectedReplacementSkill`. |
| `replacement_linked` | `reconciliation_required` | Rollback or authoritative state cannot be proven. |
| `old_superseded` | `reconciliation_required` | Failure or state remains unresolved. |
| `completed` | terminal | No further transition. |
| `conflict` | terminal | No further transition. |
| `reconciliation_required` | terminal | No automatic exit in this milestone. |

A future reconciler requires separate authorization. It must not be inferred
from this marker contract.

## 7. Transition authority

Every marker state transition is a full-record CAS of the marker itself. Initial
creation of the `prepared` marker alone requires conditional missing-key
creation. No `get -> set`, partial update, blind overwrite, or process-local
lock is sufficient for marker authority.

The marker remains the durable authority for the operation. Full-record CAS and
conditional creation are still future runtime prerequisites; this document does
not alter either semantic contract or claim they are available.

## 8. Replay and integrity contract

Same-operation replay must recompute exactly the same operation ID. For an
existing marker:

```text
operationId exists
+ immutable creation fields exactly match
    -> resume or reconcile only according to recorded state

operationId exists
+ any immutable field differs
    -> integrity failure
    -> zero overwrite
    -> no new interpretation of that marker
```

If the original operation timestamp or complete identity evidence is lost, the
caller must not guess it. A newly reviewed request may create a new operation
with a new identity, but it is never a replay of the old operation.

## 9. Privacy and bounded-state boundary

Because it contains complete skill snapshots, a marker has at least the same
sensitivity as `mem:skills`. Future marker records must not be exposed through
REST, MCP, CLI output, viewers, logs, diagnostic dumps, conflict responses, or
telemetry payloads without a separately reviewed privacy-safe surface. Raw
skill contents and full markers are not logged by default.

The marker stores a constant number of complete skill snapshots; it must not
embed append-only transition history. Before any first skill mutation, a future
runtime must prove that the complete marker fits applicable backend size limits.
Failure to persist the initial marker means zero skill mutation.

## 10. Lookup and IO boundary

Normal execution and replay look up exactly one marker by exact `operationId`.
They must not require listing all markers, scanning a marker namespace, or
searching by old skill or replacement skill. Future normal behavior is therefore
bounded to exact-key state operations.

Global cleanup and administration are outside this contract.

## 11. Retention boundary

The conservative first-runtime rule is:

```text
no automatic marker deletion
no automatic marker compaction
```

This applies to `completed`, `conflict`, and `reconciliation_required` markers.
The durable marker remains replay and recovery authority. Garbage collection,
archival, TTLs, or deletion require a separately authorized retention milestone,
because deletion can change replay and reconciliation guarantees. This document
implements none of them.

## 12. Compatibility boundary

This design preserves the existing `AgentSkill` schema; KV keys and scopes;
get/set/update/delete/list behavior; REST and MCP schemas; CLI; hooks; ranking;
recall; context packing; feedback; promotion; replacement creation; Phase 4A
lifecycle review; and default runtime behavior. The marker is not yet a
persisted KV schema.

Phase 4B runtime remains blocked pending proven runtime primitives and a
separately authorized implementation. No lifecycle write follows from this
document.

## 13. Status

```text
PHASE_4B2:
  DESIGNED_ONLY

SUPERSESSION_OPERATION_IDENTITY:
  CANONICAL_SHA256_V1

SUPERSESSION_MARKER_SCHEMA:
  CONCEPTUAL_ONLY

SUPERSESSION_MARKER_RETENTION:
  NO_AUTOMATIC_DELETION_DESIGNED

RECONCILIATION_RUNTIME:
  NOT_AUTHORIZED

PHASE_3B2C1:
  WAITING_ON_SUBSTANTIVE_MAINTAINER_RESPONSE

PHASE_4B_RUNTIME:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```
