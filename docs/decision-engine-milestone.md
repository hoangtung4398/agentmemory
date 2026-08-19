# Decision Engine Milestone

This document records the AgentMemory v2 Decision Engine milestone merged by
PR #1. It is an operational baseline, not a new runtime contract. The full
design remains in the repository-level Decision Engine documents.

## What Merged

The PR1-PR10 milestone added an additive, compatibility-preserving Decision
Engine pipeline:

- Decision types, configuration, and `mem::decide`.
- A heuristic classifier that produces an action, confidence, importance,
  reason codes, and optional semantic or procedural candidate.
- `DecisionAudit` persistence and read-only diagnostics.
- Observe and remember integrations in shadow and advisory modes.
- A narrowly gated enforce-ignore path for obvious observe noise.
- Semantic and procedural candidate queues.
- Default-off candidate consumption in `mem::consolidation-pipeline`.
- REST and MCP diagnostics plus focused and end-to-end tests.

The canonical consolidation function is `mem::consolidation-pipeline`.
`mem::consolidate-pipeline` remains a legacy compatibility alias.

## Default Safety Posture

- `AGENTMEMORY_DECISION_MODE=disabled` is the default.
- Disabled mode does not build a `DecisionInput`, create a decision, persist a
  `DecisionAudit`, or write a candidate queue row.
- Candidate consumption is disabled by default.
- Existing hook payloads, REST and MCP schemas, KV record shapes, and
  BM25/vector/graph/RRF ranking remain unchanged.
- The company repository was not changed as part of this personal-repository
  milestone.

Shadow-only LLM observation is implemented when the existing provider is
present and the decision configuration selects `shadow` plus `llm` or
`hybrid`. The heuristic candidate remains selected and authoritative; LLM
output can only add a validated `source: "llm"` candidate for comparison.
LLM-controlled advisory/enforce behavior and LLM decision selection remain
unimplemented.

## Configuration

Decision configuration is read from the environment or AgentMemory `.env`.
Invalid values fall back to the listed defaults.

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTMEMORY_DECISION_MODE` | `disabled` | Selects `disabled`, `shadow`, `advisory`, or `enforce`. |
| `AGENTMEMORY_DECISION_PROVIDER` | `heuristic` | Selects heuristic-only behavior or eligible LLM1 shadow observation; advisory and enforce remain heuristic-only. |
| `AGENTMEMORY_DECISION_AUDIT` | `true` when active | Enables decision audit persistence for an active mode. |
| `AGENTMEMORY_DECISION_SHADOW_QUEUE` | `false` | Allows experimental candidate-queue persistence in shadow mode. |
| `AGENTMEMORY_DECISION_CANDIDATE_QUEUE` | `true` for advisory/enforce | Enables queue writes when the mode otherwise permits them. |
| `AGENTMEMORY_DECISION_CANDIDATE_MIN_CONFIDENCE` | `0.7` | Minimum candidate confidence; clamped to `0.5` through `1.0`. |
| `AGENTMEMORY_DECISION_ENFORCE_IGNORE` | `false` | Enables the narrow observe enforce-ignore path. |
| `AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE` | `0.85` | Enforce-ignore threshold; clamped to `0.85` through `1.0`. |
| `AGENTMEMORY_DECISION_CONSUME_CANDIDATES` | `false` | Allows consolidation to consume pending candidate rows. |
| `AGENTMEMORY_DECISION_CANDIDATE_BATCH_LIMIT` | `50` | Maximum candidate rows considered per run; clamped to `1` through `500`. |
| `AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE` | `2` | Evidence count needed for candidate promotion; clamped to `1` through `10`. |

### Enable Shadow Mode

Shadow mode computes decisions and writes audits while preserving current
observe, remember, search, context, consolidation, indexing, and stream
behavior.

```bash
AGENTMEMORY_DECISION_MODE=shadow
```

Shadow mode persists `DecisionAudit` rows by default. It does not write
candidate queue rows unless both the experimental shadow queue and candidate
queue settings permit it:

```bash
AGENTMEMORY_DECISION_MODE=shadow
AGENTMEMORY_DECISION_SHADOW_QUEUE=true
AGENTMEMORY_DECISION_CANDIDATE_QUEUE=true
```

### Enable Advisory Mode

Advisory mode continues existing writes and indexing, records decisions, and
can persist semantic or procedural candidate rows for later inspection or
batch consolidation.

```bash
AGENTMEMORY_DECISION_MODE=advisory
AGENTMEMORY_DECISION_CANDIDATE_QUEUE=true
```

### Enable Enforce-Ignore Safely

Enforce mode is deliberately limited. Enable it only after shadow or advisory
audits demonstrate that the classifier correctly identifies local tool noise.

```bash
AGENTMEMORY_DECISION_MODE=enforce
AGENTMEMORY_DECISION_ENFORCE_IGNORE=true
AGENTMEMORY_DECISION_ENFORCE_IGNORE_MIN_CONFIDENCE=0.85
```

The implementation enforces only a high-confidence `ignore` decision for
`notification` or `post_tool_use` observations with approved noise reason
codes and no disqualifier. Prompts, decisions, summaries, errors, failures,
and edit-like events are disqualified. When enforcement applies, the raw
observation, raw stream event, and session count are retained; compression
and downstream indexing are skipped. All other actions, including
`working_memory`, remain advisory.

### Enable Candidate Consumption

Candidate consumption is independent of decision mode and remains off until
explicitly enabled. It runs inside `mem::consolidation-pipeline`; normal
consolidation prerequisites still apply.

```bash
AGENTMEMORY_DECISION_CONSUME_CANDIDATES=true
AGENTMEMORY_DECISION_CANDIDATE_BATCH_LIMIT=50
AGENTMEMORY_DECISION_CANDIDATE_MIN_EVIDENCE=2
```

Eligible pending candidates are grouped into existing `SemanticMemory` or
`ProceduralMemory` records. Repeated pipeline runs do not re-consume rows
already marked `consumed`. Expired and invalid rows are retained for
diagnostics with `expired` or `rejected` status.

## Diagnostics

These diagnostics are additive and read-only:

| Surface | Purpose |
| --- | --- |
| `GET /agentmemory/decision/audit` | Lists Decision Engine audits with optional mode, action, source, insertion-point, project, agent, session, and limit filters. |
| `GET /agentmemory/decision/candidates` | Lists candidate queue rows with optional kind, status, project, agent, session, decision, candidate, and limit filters. |
| `memory_decision_audit` | MCP equivalent for audit inspection. |
| `memory_decision_candidates` | MCP equivalent for candidate inspection. |

Neither diagnostic marks rows viewed, changes their status, or mutates memory
state.

## Known Limitations

- Shadow-only LLM observation exists; LLM-controlled advisory/enforce/selection remains unimplemented.
- No `working_memory` enforcement is implemented.
- No Skill/Self-Improvement Layer is implemented.
- Candidate consumption is opt-in and conservative; it is not a replacement
  for the existing consolidation pipeline.
- The Decision Engine does not alter ranking, vector search, graph search, or
  RRF.

### Baseline Failures Outside This Milestone

At milestone verification time, the Decision Engine focused suite passed 8
files and 109 tests, `npm run skills:check` passed, and `git diff --check`
passed. The following pre-existing failures were intentionally not fixed:

- `npx tsc --noEmit --pretty false` errors in unrelated modules, including
  CLI, slots, trigger, provider, and state helpers.
- Full-suite failures in `obsidian-export`, `cli-remove`, `slots-flag-gate`,
  `integration-plaintext-http` (Python environment), `connect-new-agents`,
  `compress-file`, `hook-project`, and `copilot-plugin`.

These failures should be handled by a separate baseline cleanup effort, not by
Decision Engine rollout work.

## Roadmap

The next work remains design- and safety-first:

1. PR11: Skill/Self-Improvement Layer design.
2. PR12: Skill diagnostics and read model.
3. PR13: Skill promotion behind explicit configuration.
4. PR14: Skill recall diagnostics.
5. PR15: Skill context injection in advisory mode.
6. Later: LLM classifier in shadow-only mode.
7. Later: TypeScript and full-suite baseline cleanup.

None of these roadmap items are implemented by this milestone.
