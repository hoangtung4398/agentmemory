# AgentMemory Lifecycle

Important caveats:

- Not every `CompressedObservation` becomes an episodic `Memory`. Most observations remain evidence/search material only.
- `Memory` is created through explicit remember flows, import, or consolidation. It is not automatically emitted for every hook event.
- Working memory is contextual and operational; it is not necessarily a durable long-term tier like `Memory`, `SemanticMemory`, or `ProceduralMemory`.
- `ProceduralMemory` is derived from repeated workflow/pattern evidence, not directly from every episodic memory.
- `SemanticMemory` and `ProceduralMemory` should normally be formed through batch consolidation, not directly from raw hook events.

## Memory Lifecycle Diagram

```mermaid
flowchart TD
  Hook["Hook / MCP / REST input"] --> Raw["RawObservation"]
  Raw --> Compressed["CompressedObservation"]
  Compressed --> Working["Working context: recent observations and slots"]
  Compressed --> Evidence["Evidence pool"]
  Evidence --> MemoryWrite["remember, import, or consolidation"]
  MemoryWrite --> Episodic["Memory"]
  Compressed --> Summary["SessionSummary"]
  Compressed --> Graph["GraphNode + GraphEdge"]
  Summary --> BatchConsolidation["batch consolidation"]
  BatchConsolidation --> Semantic["SemanticMemory"]
  Episodic --> PatternEvidence["repeated workflow/pattern evidence"]
  PatternEvidence --> Procedural["ProceduralMemory"]
  Episodic --> Lesson["Lesson / Insight"]
  Working --> Retrieve["Search / Context"]
  Episodic --> Retrieve
  Semantic --> Retrieve
  Procedural --> Retrieve
  Graph --> Retrieve
  Retrieve --> Access["Access log + retention score"]
  Access --> Decay["Decay / eviction / forget"]
```

## Observation Lifecycle

```mermaid
stateDiagram-v2
  [*] --> HookPayload
  HookPayload --> Rejected: invalid required fields or duplicate
  HookPayload --> RawStored: mem::observe stores raw
  RawStored --> SyntheticCompressed: auto compression off
  RawStored --> LLMCompressed: auto compression on
  SyntheticCompressed --> Indexed
  LLMCompressed --> Indexed
  Indexed --> GraphExtracted: graph extraction enabled
  Indexed --> Retrieved: search/context
  Indexed --> Summarized: summary path
  Indexed --> Forgotten: explicit forget/session delete
  Retrieved --> Indexed
  Forgotten --> [*]
```

Trace:
1. Hook scripts or integrations send a `HookPayload` to REST.
2. `mem::observe` validates, sanitizes, deduplicates, updates or creates `Session`, and stores `RawObservation`.
3. Compression creates `CompressedObservation`: synthetic by default, LLM-backed when `AGENTMEMORY_AUTO_COMPRESS=true`.
4. The compressed observation is written to BM25 and, when embeddings are configured, vector search.
5. Optional graph extraction derives nodes and edges from compressed observations.
6. Search, context, summaries, consolidation, and graph retrieval consume the observation.
7. Forget paths remove the observation and associated index/image references explicitly.

## Session Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Active: first observation or session-start
  Active --> Active: more observations increment count
  Active --> Summarized: stop, compact, or session-end summary path
  Summarized --> Completed: stop/session-end
  Active --> Abandoned: stale or incomplete session handling
  Completed --> Consolidated: summaries feed consolidation
  Completed --> Forgotten: explicit session forget
  Abandoned --> Forgotten
```

Trace: a session starts implicitly on first observation. Its observation count, first prompt, model, agent id, cwd, project, and commit metadata accumulate. Completion writes end metadata and often a summary. Completed summaries feed semantic consolidation while the session remains the parent scope for observations.

## Memory Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Candidate: remember/consolidate/import
  Candidate --> Rejected: invalid content/type/project guard
  Candidate --> Created: new memory
  Candidate --> Superseding: similar latest memory found
  Superseding --> Created: new version stored
  Superseding --> Superseded: previous isLatest=false
  Created --> Indexed: BM25/vector
  Indexed --> Retrieved: search/context/smart-search
  Retrieved --> Reinforced: access tracking
  Indexed --> Evictable: TTL or low retention score
  Evictable --> Deleted: forget/evict
```

Trace: `Memory` is the episodic/manual long-term object. New content may supersede an older similar memory. The active member of a lineage is the row with `isLatest=true`. Retrieval updates access metadata outside the memory row; retention or explicit forget later removes rows and projections.

## Summary Lifecycle

```mermaid
flowchart TD
  Observations["Session observations"] --> Summarize["summary / compact functions"]
  Summarize --> Summary["SessionSummary in KV.summaries"]
  Summary --> Context["mem::context"]
  Summary --> Semantic["semantic consolidation"]
  Summary --> Exports["resources, skills, export"]
```

Trace: summaries are derived from session observations and keyed by `sessionId`. They compress decisions, modified files, concepts, and narrative. Context uses recent summaries; the consolidation pipeline uses them as evidence for semantic facts.

## Semantic Memory Lifecycle

```mermaid
stateDiagram-v2
  [*] --> CandidateFacts: consolidation reads summaries
  CandidateFacts --> Skipped: disabled, no provider, or insufficient evidence
  CandidateFacts --> Created: new confident fact
  CandidateFacts --> Updated: similar fact reinforced
  Created --> Retrieved
  Updated --> Retrieved
  Retrieved --> Accessed: accessCount / lastAccessedAt
  Accessed --> Decayed: consolidation or retention
  Decayed --> Deleted: eviction or delete path
```

Trace: semantic memory captures generalized facts with confidence, strength, source sessions, source memories, and access counters. It is not stored as a `Memory` subtype; it has its own KV scope and retention handling.

## Procedural Memory Lifecycle

```mermaid
flowchart TD
  PatternMemories["Latest pattern/workflow memories"] --> FrequencyGate{"frequency high enough?"}
  FrequencyGate -->|no| Ignored["ignored this sweep"]
  FrequencyGate -->|yes| Procedure["ProceduralMemory"]
  Procedure --> Recall["retrieval/context/tool recall"]
  Recall --> Reinforce["frequency or strength updated"]
  Procedure --> Decay["decay / retention"]
```

Trace: procedural memory is extracted from repeated workflows and pattern memories. It stores name, steps, trigger condition, expected outcome, source sessions/observations, concepts/tags, frequency, strength, and timestamps.

## Lessons Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Saved: lesson-save
  Saved --> Strengthened: same fingerprint or explicit strengthen
  Saved --> Recalled: term match + confidence + recency
  Strengthened --> Recalled
  Saved --> Decayed: weekly decay sweep
  Decayed --> SoftDeleted: confidence <= 0.1 and no reinforcement
  Recalled --> Saved
  SoftDeleted --> [*]
```

Trace: `Lesson` ids are fingerprints of normalized lesson content. Saving the same lesson reinforces it. Recall matches query terms against content, context, and tags, then applies confidence and recency. Decay lowers confidence weekly and soft-deletes weak unreinforced lessons.

## Graph Node and Edge Lifecycle

```mermaid
flowchart TD
  Batch["CompressedObservation[]"] --> Prompt["graph extraction prompt"]
  Prompt --> XML["provider XML response"]
  XML --> Parse["parseGraphXml"]
  Parse --> NodeMerge{"nameIndex hit and not pre-reset?"}
  NodeMerge -->|yes| MergeNode["merge properties, aliases, source ids"]
  NodeMerge -->|no| NewNode["write node, name index, degree 0"]
  Parse --> EdgeMerge{"edgeKey hit and not pre-reset?"}
  EdgeMerge -->|yes| MergeEdge["merge source ids and weight"]
  EdgeMerge -->|no| NewEdge["write edge, edge key, degree deltas"]
  MergeNode --> Snapshot["update GraphSnapshot"]
  NewNode --> Snapshot
  MergeEdge --> Snapshot
  NewEdge --> Snapshot
  Snapshot --> Query["graph-query and hybrid graph retrieval"]
```

Trace: graph extraction is LLM-driven and XML-parsed. Deduplication is by node type/name and source-target-type edge key. Snapshot and degree caches avoid full graph listing for common viewer and empty-query paths. `resetAt` acts as a reset boundary so old indexed rows are ignored after graph reset.
