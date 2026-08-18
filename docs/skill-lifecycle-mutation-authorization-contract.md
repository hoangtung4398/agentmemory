# Lifecycle Mutation Authorization and Dispatch-Boundary Contract

## Status

```text
DESIGN ONLY
NO RUNTIME AUTHORIZED
NO LIFECYCLE WRITE AUTHORIZED
```

Phase 4B5 defines admission-authority semantics only. It creates no config
field, environment variable, TypeScript type, function, StateKV method,
REST/MCP/CLI surface, KV record, marker, audit record, worker, or scheduler.

## Separate authority roles

The following are semantic labels, not implementation identifiers:

```text
LIFECYCLE_REVIEW_AUTHORITY:
  evaluation/read-only only
RETIREMENT_APPLY_AUTHORITY:
  permission to admit a future retirement mutation request only
SUPERSESSION_APPLY_AUTHORITY:
  permission to admit a future supersession mutation request only
```

`lifecycleReviewEnabled` remains evaluation permission only. Under no
circumstance does `lifecycleReviewEnabled == true` imply either apply
authority. Parent skill enablement, including `AGENTMEMORY_SKILLS=true`, also
does not authorize lifecycle mutation.

## Operation-specific default deny

Retirement authority and supersession authority are independent:

```text
retirement authority != supersession authority
```

`RETIREMENT_APPLY_AUTHORITY=true` with
`SUPERSESSION_APPLY_AUTHORITY=false` can conceptually admit only retirement;
the inverse can admit only supersession. One generic boolean must not silently
authorize both families. Both future apply authorities default to disabled/deny
and fail closed for absent, false, invalid, unrecognized, or unavailable state.

```text
AUTHORIZATION_CONFIG_SHAPE:
  NOT_SELECTED
```

No current gate changes because no gate is introduced. Names such as
`AGENTMEMORY_SKILL_LIFECYCLE_APPLY`, `AGENTMEMORY_SKILL_RETIRE`,
`AGENTMEMORY_SKILL_SUPERSEDE`, `lifecycleApplyEnabled`, `retirementEnabled`,
and `supersessionEnabled` are not selected by this design.

## Intent and direct-only dispatch

Apply authority alone is insufficient. Future admission requires both the
operation-specific authority and explicit per-operation caller intent:

```text
retirement: RETIREMENT_APPLY_AUTHORITY + intent to retire this exact skill
supersession: SUPERSESSION_APPLY_AUTHORITY + intent to supersede this exact old skill with this exact replacement
```

A global enablement state is never standing permission to mutate arbitrary
skills. Lifecycle mutation is a direct-only operator action. It must never
originate automatically from lifecycle review or inventory, diagnostics,
recall, context, feedback, reducer, promotion, decision engine, hooks,
sessions, timers, schedulers, startup scans, maintenance sweeps, retries, or
another skill mutation. `review_for_retirement` remains advice only and Phase
4A remains `applied: false`.

Recommendation-to-write chaining and indirect variants are prohibited:

```text
lifecycle review -> recommendation -> automatic lifecycle writer
diagnostic -> trigger -> review -> writer
feedback -> lifecycle recommendation -> writer
promotion -> automatically supersede prior skill
```

An operator or explicitly authorized caller must start the request independently.

## Independent data-plane prerequisite

Admission authority does not prove storage safety:

```text
CONTROL_PLANE_AUTHORIZATION
AND
DATA_PLANE_PRIMITIVE_AVAILABILITY
```

Retirement also requires explicit intent and proven, consumable
`FULL_RECORD_SINGLE_KEY_CAS`. Supersession also requires explicit intent,
proven CAS, proven `CREATE_IF_ABSENT`, and separately authorized runtime. The
upstream primitives remain unavailable, so all mutation paths remain blocked.

The conceptual admission matrix is:

```text
wrong/missing explicit intent -> DENIED_NO_EXPLICIT_INTENT
operation apply authority disabled -> DENIED_APPLY_AUTHORITY
wrong family authority -> DENIED_OPERATION_AUTHORITY_MISMATCH
safe primitive unavailable/unproven -> BLOCKED_RUNTIME_PREREQUISITE
controls satisfied but runtime unauthorized -> NOT_RUNTIME_AUTHORIZED
```

These are documentation concepts only, not source result types.

## Hierarchy, dispatch, and execution boundary

The future hierarchy is fail-closed:

```text
skills enabled -> lifecycle evaluation authority -> does NOT grant mutation authority
separate retirement apply authority -> retirement admission only
separate supersession apply authority -> supersession admission only
```

No alternate config loader or unrelated `*Enabled` flag gains authority by
implication. A future authorization check occurs before the first mutating
dispatch: before retirement CAS, and before supersession marker creation. No
state write may discover authorization. Successful admission means only that a
request may proceed to the next prerequisite check; it does not mean a mutation
applied or dispatched, CAS is available, a marker exists, or a protocol completed.

## In-flight, reconciliation, and replay boundaries

```text
APPLY_AUTHORITY_ROLE:
  NEW_OPERATION_ADMISSION
```

No cancellation semantics are designed. A setting change after first mutating
dispatch never itself implies rollback, abandonment, completion, recovery, or a
marker transition. A newly recomputed retirement CAS after unknown outcome
needs fresh admission. Phase 4B5 grants no supersession resume/recovery write.

Read-only reconciliation classification is neither mutation admission nor
repair authority. No reconciliation result grants authority, and authority does
not turn reconciliation into a writer. No durable authorization marker,
approval KV record, token, receipt, operation ID, or persisted approval time is
designed. Supersession marker evidence is not operator authorization. Retries
and replays never bypass admission; prior permission never authorizes later
requests by itself.

## Privacy and compatibility

Authorization failures may conceptually expose only `operationKind`,
`authorized`, and `reasonCode`; they do not expose skill contents, instructions,
provenance, expected/replacement records, feedback, or marker snapshots. No
logging or audit schema is designed.

This preserves `AgentSkill`, `SkillConfig`, `src/config.ts`, StateKV, KV shapes,
CAS and CREATE_IF_ABSENT contracts, retirement target semantics, supersession
protocol and markers, reconciliation contracts, all public surfaces, ranking,
recall, context, feedback, promotion, lifecycle review, and all defaults.

## Status

```text
PHASE_4B5:
  DESIGNED_ONLY
LIFECYCLE_MUTATION_AUTHORIZATION:
  CONTROL_PLANE_ADMISSION_ONLY
LIFECYCLE_REVIEW_AUTHORITY:
  EVALUATION_ONLY_NEVER_MUTATION
RETIREMENT_APPLY_AUTHORITY:
  OPERATION_SPECIFIC_DEFAULT_DENY
SUPERSESSION_APPLY_AUTHORITY:
  OPERATION_SPECIFIC_DEFAULT_DENY
MUTATION_INTENT:
  EXPLICIT_PER_OPERATION_REQUIRED
AUTHORIZATION_CONFIG_SHAPE:
  NOT_SELECTED
AUTHORIZATION_PERSISTENCE:
  NONE_DESIGNED
APPLY_AUTHORITY_ROLE:
  NEW_OPERATION_ADMISSION
AUTHORIZATION_RUNTIME:
  NOT_AUTHORIZED
LIFECYCLE_WRITES:
  NOT_AUTHORIZED
PHASE_3B2C1:
  WAITING_ON_SUBSTANTIVE_MAINTAINER_RESPONSE
PHASE_4B_RUNTIME:
  BLOCKED_PENDING_RUNTIME_PRIMITIVES
```
