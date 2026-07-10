# Compatibility Plan

AgentMemory v2 Decision Engine must be additive. The default path is disabled mode, where the current code paths, data shapes, public APIs, indexing, ranking, and hook behavior remain unchanged.

The first implementation PRs must not include enforce behavior. PR1 and PR2 are types/config and direct `mem::decide` only. PR3 and PR4 are shadow integrations only. Enforce behavior must wait until shadow/advisory tests prove compatibility.

## Compatibility Guarantees

| Constraint | Plan |
| --- | --- |
| Default disabled mode | Decision Engine config defaults to `disabled`; no decision function is called and no decision rows are written. |
| Shadow mode first | First runtime integration computes decisions only for audit diagnostics by default. Existing writes, indexes, streams, and responses stay unchanged. Candidate queues in shadow require an explicit experimental flag. |
| No hook payload changes | Hooks continue sending the same JSON payloads to existing REST endpoints. Decision inputs are built server-side from current normalized data. |
| No MCP schema changes | Existing MCP tools keep names and argument schemas. Decision diagnostics, if exposed, use new tools only. |
| No REST schema changes | Existing endpoints keep payloads and responses. Decision diagnostics, if exposed, use new endpoints only. |
| New KV scopes only | Add decision-specific scopes such as `mem:decision:audit` and `mem:decision:candidates`. Do not alter existing scope row shapes. |
| No existing KV shape changes | `Session`, observation rows, `Memory`, `SessionSummary`, `SemanticMemory`, `ProceduralMemory`, graph rows, lessons, and audit rows remain unchanged. |
| Raw/compressed observation semantics | Treat raw and compressed as lifecycle states of one observation id. Do not require separate durable records. |
| No search behavior change in shadow | Search result order, filtering, access tracking, and formatting remain identical. |
| BM25-only operation still works | Heuristic classifier requires no embeddings. Decision Engine does not depend on vector search. |
| No provider key required | Heuristic classifier is always available. LLM classifier is optional and falls back to heuristic. |
| No ranking changes | BM25, vector, graph, RRF, diversification, and reranker behavior stay unchanged in first milestone. |
| No vector optimization | Vector search remains as-is. |
| No unrelated refactors | PRs are scoped to decision types/config, shadow execution, diagnostics, limited advisory/enforce behavior, and candidate queues. |

## Behavior Preservation Matrix

| Pipeline | Disabled | Shadow | Advisory | Enforce first milestone |
| --- | --- | --- | --- | --- |
| Hook capture | unchanged | unchanged | unchanged | unchanged except safe high-confidence ignore/working when explicitly enabled |
| Raw KV write | unchanged | unchanged | unchanged | unchanged for non-enforced cases |
| Compression | unchanged | unchanged | unchanged | unchanged |
| BM25/vector indexing | unchanged | unchanged | unchanged | unchanged internals; skipped only if upstream write is safely skipped |
| Graph extraction/retrieval | unchanged | unchanged | unchanged | unchanged |
| `mem::remember` save | unchanged | unchanged | unchanged | unchanged in first milestone |
| Consolidation memory creation | unchanged | unchanged | unchanged | unchanged in first milestone |
| Semantic/procedural writes | unchanged | unchanged | additive candidate queue only | existing shapes; candidate consumption only after queue PR |
| Context/search return shape | unchanged | unchanged | unchanged | unchanged |

## New Surfaces

New surfaces must be additive:

- `mem::decide` as a new internal/function-level diagnostic classifier.
- Optional new REST diagnostics endpoint such as `/agentmemory/decision/audit`.
- Optional new MCP diagnostics tool such as `memory_decision_audit`.
- New KV scopes for decision audit and candidates.

Existing MCP tools and REST endpoints must not gain required parameters or change response shape.

## Rollback Plan

Rollback must not require data migration:

1. Set decision mode to `disabled`.
2. Existing pipelines stop calling decision logic.
3. Existing memory/search/context behavior remains available.
4. Decision audit/candidate scopes can remain unused.
5. Candidate queues are ignored by consolidation unless explicitly enabled.

## Compatibility Tests

Required tests by milestone:

- Disabled mode: existing test suite passes with no decision rows.
- Shadow observe: same session/observation/index results as current behavior plus decision audit.
- Shadow remember: same memory row, supersede behavior, and search visibility plus decision audit.
- Shadow search/context: same result ordering and context string.
- BM25-only: no embedding provider configured; decisions still compute heuristically.
- No provider: no LLM keys; decisions still compute heuristically.
- Raw/compressed mixed rows: classifier tolerates raw, compressed, and unknown observation state.

## Explicit Non-Changes

- Do not change hook payload shapes.
- Do not change MCP tool schemas.
- Do not change REST endpoint payload shapes.
- Do not change existing KV record shapes.
- Do not assume raw and compressed observations are separate durable records.
- Do not change BM25/vector/graph/RRF ranking in the first milestone.
- Do not optimize vector search yet.
- Do not refactor unrelated modules.
