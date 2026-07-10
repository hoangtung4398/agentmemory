# Decision Engine Implementation Plan

This plan breaks AgentMemory v2 Decision Engine into small compatibility-preserving PRs. It does not include unrelated refactors, ranking optimization, vector optimization, hook payload changes, MCP schema changes, REST schema changes, or existing KV shape changes.

## PR1: Types and Config Only

Scope:

- Add TypeScript types for `DecisionInput`, `DecisionCandidate`, `MemoryDecision`, `DecisionAudit`, and `DecisionCandidateQueue`.
- Add config parsing for decision mode with default `disabled`.
- Define new KV scope constants for decision audit/candidates only.
- No runtime insertion point calls.

Expected behavior:

- Entire current test suite remains unchanged.
- No decision rows are written.
- Disabled mode is the default.

Tests:

- Config default is disabled.
- Invalid mode falls back to disabled or fails safely according to chosen config style.
- New types do not require changes to existing record shapes.

## PR2: `mem::decide` Shadow Mode

Scope:

- Add `mem::decide` as a new function.
- Implement heuristic classifier only.
- Validate decisions.
- Persist `DecisionAudit` only when mode is `shadow`, `advisory`, or `enforce`.
- No integration into observe/remember/consolidation yet.

Expected behavior:

- Calling `mem::decide` directly produces an audit row in shadow mode.
- No existing pipeline behavior changes.
- No provider key required.

Tests:

- Direct classifier tests for all five actions.
- No LLM/provider required.
- Invalid input falls back safely.
- Decision audit rows are written only when enabled.

## PR3: Observe Integration in Shadow Mode

Scope:

- Call `mem::decide` from `mem::observe` after sanitization and before raw KV write.
- Optionally call again after compression before indexing for compressed-state classification.
- Shadow mode only.
- Existing observe behavior must be identical except new decision audit rows. Candidate queue writes are not part of default shadow integration.

Expected behavior:

- Raw observation write still happens.
- Compression still happens according to `AGENTMEMORY_AUTO_COMPRESS`.
- Raw/compressed overwrite semantics remain unchanged.
- BM25/vector/graph indexing remains unchanged.

Tests:

- `test/auto-compress.test.ts`: auto-compress gate unchanged.
- `test/observe-implicit-session.test.ts`: implicit session behavior unchanged.
- New tests: shadow decision audit rows are written; stored observation/index output is unchanged.
- Mixed raw/compressed observation state is tolerated.

## PR4: Remember Integration in Shadow Mode

Scope:

- Call `mem::decide` from `mem::remember` after validation/normalization and before save.
- Shadow mode only.
- Do not block or alter `memory_save`.
- Do not alter supersede/version behavior.

Expected behavior:

- `Memory` row is identical to current behavior.
- BM25/vector indexing remains unchanged.
- Cascade behavior remains unchanged.
- Decision audit records what the engine would have done.

Tests:

- `test/remember-project-scope.test.ts`: project supersede compatibility unchanged.
- `test/agent-id-scope.test.ts`: agent id stamping unchanged.
- `test/search.test.ts`: saved memory remains searchable.
- New test: decision audit for remember draft.

## PR5: Decision Diagnostics REST/MCP

Scope:

- Add new diagnostics-only REST endpoints.
- Add new diagnostics-only MCP tools.
- Follow existing endpoint/tool consistency rules.
- Do not modify existing REST/MCP schemas.

Expected behavior:

- Existing tools/endpoints unchanged.
- New diagnostics can list decision audits and candidate queue rows.
- Tool counts/docs/tests updated according to repository rules.

Tests:

- MCP standalone/full tool count updates.
- REST auth behavior for diagnostics endpoints.
- Decision audit list/filter behavior.
- No change to existing tool schemas.

## PR6: Advisory Mode

Scope:

- Enable advisory mode at insertion points.
- Persist audit and candidate queue rows.
- Expose advisory decisions only through new diagnostics surfaces.
- Do not change existing observe/remember/search/context return shapes.

Expected behavior:

- Semantic/procedural candidates can be queued.
- Existing memory writes and indexes still happen.
- Search/context behavior unchanged.

Tests:

- Advisory observe queues candidate rows without changing observation/index behavior.
- Advisory remember records classification without blocking save.
- Advisory context/search returns byte-compatible output/order where applicable.
- BM25-only and no-provider operation still works.

## PR7: Enforce Ignore and Working Memory Only

Scope:

- Add enforce behavior only for high-confidence `ignore` and `working_memory`.
- Keep `episodic_memory`, `semantic_memory_candidate`, and `procedural_memory_candidate` advisory.
- Feature-gate enforce behavior with conservative thresholds.
- Do not enforce changes to `mem::remember` public saves in first milestone.

Expected behavior:

- Obvious tool noise may be ignored if explicitly enabled and tested.
- Working-memory-only events may avoid durable episodic promotion when safe.
- Existing ranking internals remain unchanged.

Tests:

- High-confidence ignored noise does not create durable searchable records when enforce is enabled.
- Non-noise observations still follow current observe/compress/index flow.
- Enforce unsupported action downgrades to advisory.
- Rollback to shadow/disabled restores current behavior.

## PR7 Enforce Semantics

Enforce behavior must be conservative. Unsupported enforce actions must downgrade to advisory and must not change the existing pipeline.

Enforce ignore must not apply to:

- `UserPromptSubmit` / prompt-submit events,
- `SessionStart`,
- `Stop`,
- `SessionEnd`,
- compact/session summary events,
- any event that contains user-authored instructions, session summary content, key decisions, file modifications, errors with diagnostic detail, or explicit remember/save language.

Enforce ignore is limited to:

- obvious post-tool noise,
- empty tool output,
- progress notifications,
- duplicated telemetry,
- secret-heavy payloads after sanitization.

First-milestone behavior for enforce-ignore in `mem::observe`:

| Operation | Decision | Rationale |
| --- | --- | --- |
| Skip raw KV write | No | Preserve capture compatibility, session telemetry, raw auditability, and mixed raw/compressed observation semantics. |
| Skip compression | Yes | Avoid promoting obvious noise into compressed retrieval material. |
| Skip indexing | Yes | No BM25/vector/graph indexing for high-confidence ignored noise. Ranking internals remain unchanged. |
| Update session observation count | Yes | Preserve session lifecycle/count behavior for captured hook activity. |
| Emit stream event | Yes, raw/capture stream only | Preserve live capture visibility; do not emit compressed/indexed stream events for ignored noise. |
| Always write `DecisionAudit` | Yes | Enforce actions must be auditable and reversible by disabling enforce mode. |

This means first-milestone enforce-ignore is not a hard telemetry drop. It preserves raw capture and session accounting while preventing high-confidence noise from becoming compressed/indexed retrieval material.

## PR8: Semantic/Procedural Candidate Queues

Scope:

- Formalize queue lifecycle: pending, consumed, rejected, expired.
- Store semantic and procedural candidate rows from observe/compress/remember/consolidate advisory decisions.
- Add queue diagnostics.
- No direct `SemanticMemory` or `ProceduralMemory` writes from raw hook events.

Expected behavior:

- Candidate queues collect evidence.
- Final semantic/procedural writes still happen only through consolidation pipeline.
- Existing tier record shapes remain unchanged.

Tests:

- Queue rows validate kind/action consistency.
- TTL/expiry works without deleting existing memory rows.
- Candidate rows preserve evidence refs.
- Diagnostics list pending/consumed/rejected/expired states.

## PR9: Consolidation Pipeline Consumes Candidates

Scope:

- `mem::consolidation-pipeline` reads pending semantic/procedural candidates as additional batch evidence.
- Candidate consumption writes existing `SemanticMemory` and `ProceduralMemory` shapes only.
- Mark consumed/rejected candidates in queue.
- Existing summary/pattern consolidation remains available.

Expected behavior:

- Empty queue means current consolidation behavior.
- Candidate queue adds evidence but does not bypass confidence/evidence validation.
- Existing semantic/procedural KV shapes unchanged.

Tests:

- `test/consolidation-pipeline.test.ts`: disabled/force/audit behavior unchanged.
- Empty queue behavior identical.
- Semantic candidate becomes semantic memory only through pipeline.
- Procedural candidate becomes procedural memory only through repeated/batch evidence.
- Invalid candidates are rejected without affecting existing pipeline.

## Cross-PR Guardrails

- Default mode remains disabled.
- Shadow mode must be behavior-preserving.
- Existing hooks, REST endpoints, MCP tools, KV shapes, and ranking stay unchanged.
- No vector optimization.
- No graph/ranking refactor.
- No unrelated module refactor.
- All decision effects must be auditable and reversible by disabling the engine.
