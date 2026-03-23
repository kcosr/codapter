# Backend Routing And Codex Proxy Phase Task Plan

Status: Locked

## 1. Scope

Execute the backend refactor required to:

1. replace the current Pi-shaped `IBackend` contract with a routed high-level backend contract,
2. preserve current Pi behavior on the new contract,
3. add a new Codex backend with stdio support first and websocket support second,
4. expose backend-prefixed model ids through one picker,
5. make collab routing backend-aware so Pi parent threads can spawn Codex child agents.

Out of scope for this execution stream:

1. Claude backend implementation,
2. Codex -> Pi subagent spawning,
3. architecture reference doc updates before the behavior stabilizes in code.

## 2. Global Rules

1. End-state implementations only; no dual backend contracts left in-tree after migration.
2. No backward-compatibility fallbacks for old internal model-id shapes unless a phase explicitly requires a short-lived migration helper.
3. `command/exec` remains adapter-native and unchanged in behavior.
4. Preserve current Pi observable behavior while migrating Pi to the new backend contract.
5. Use `agent-runner-review` for independent reviews when phase gates require external review.
6. Do not pass timeout or reasoning-effort CLI overrides to review runs.
7. Review completion must be determined from the live session stream (`result.completed` or `result.failed`), not redirected logs.

## 3. Phases

### Phase 1: Contract And Router Foundations

Deliverables:

1. Replace the current `packages/core/src/backend.ts` contract with the high-level routed `IBackend`.
2. Add backend router support in core.
3. Introduce backend-prefixed model-id parsing helpers.
4. Remove hardcoded single-backend assumptions from core constructor wiring.
5. Define race-safe backend event subscription semantics so no early backend events can be dropped.
6. Define one router-owned aggregated default-model selection rule.
7. Lock the concrete exported TypeScript signatures for `packages/core/src/backend.ts` and `packages/core/src/backend-router.ts` before Pi or Codex backend implementation begins.

Acceptance criteria:

1. Core can register multiple backends by `backendType`.
2. Aggregated `model/list` can be produced across registered backends.
3. A requested model can be parsed into `{ backendType, rawModelId }` before thread creation.
4. Hardcoded `backendType: "pi"` writes are removed from generic core paths.
5. The contract explicitly supports backend-originated `error` events in addition to notifications and server requests.
6. The router exposes at most one aggregated `isDefault: true` model entry.
7. `packages/core/src/backend.ts` and `packages/core/src/backend-router.ts` compile as the locked code-level source of truth for later phases.

### Phase 2: Pi Port To The New Contract

Deliverables:

1. Port Pi onto the new high-level `IBackend`.
2. Re-scope `TurnStateMachine` as a Pi-owned normalization helper.
3. Preserve existing thread registry semantics for Pi threads.
4. Keep current smoke and unit coverage green for Pi behavior.
5. Normalize Pi `thread/read` responses to the backend-neutral thread-read result shape.

Acceptance criteria:

1. Existing Pi tests pass with no user-visible behavior regression.
2. `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, and `turn/interrupt` continue to work for Pi.
3. `item/tool/requestUserInput` still works for Pi-backed elicitation.
4. No references to the old low-level backend contract remain in active code paths.
5. `thread/read` continues to work for Pi using the new backend-neutral read contract.

### Phase 3: Codex Backend Stdio Integration

Deliverables:

1. Add `packages/backend-codex`.
2. Launch `codex app-server` over stdio and complete downstream initialize handshake.
3. Implement request/response/notification relay between codapter and upstream Codex.
4. Implement bidirectional model-id rewrite between codapter routed ids and raw Codex ids.
5. Implement explicit outer-request-id to backend-request-id mapping for proxied Codex server requests.
6. Implement backend-neutral `thread/read` for Codex-owned threads.
7. Persist Codex thread ownership in thread registry.
8. Define partial-availability behavior so Codex can be unavailable without poisoning Pi.

Acceptance criteria:

1. `model/list` includes Codex-prefixed entries.
2. `thread/start` can create a Codex-owned thread from a `codex::...` model selection.
3. `turn/start` on a Codex-owned thread produces Codex-backed thread/item notifications.
4. Upstream Codex server requests needed for basic interaction are relayed and resolvable.
5. `thread/read` on a Codex-owned thread returns stable turns/items without using Pi history builders.
6. Codex non-fatal proxy/protocol problems surface as explicit backend error events.
7. Codex startup failure leaves Pi model listing and Pi thread operations functional.

### Phase 4: Optional Codex Websocket Support

Deliverables:

1. Support websocket connectivity for Codex backend as a secondary transport, or
2. explicitly stub the transport with deterministic rejects and a documented deferral decision.

Acceptance criteria:

1. Either websocket support exists and is covered by integration tests, or
2. the code rejects the mode deterministically, includes a documented rationale, and phase evidence records the defer decision.

### Phase 5: Backend-Aware Collab Routing

Deliverables:

1. Make `CollabManager` backend-aware.
2. Route child-thread backend selection from the requested model before child creation.
3. Support Pi parent spawning Codex child threads.
4. Route every child-agent backend operation through the owning backend, not just spawn.
5. Persist child `backendType` in registry metadata.

Acceptance criteria:

1. A Pi parent can spawn a Codex child when the requested model resolves to the Codex backend.
2. `sendInput`, `wait`, `resume`, and `close` route to the correct child backend.
3. Invalid cross-backend model selections fail deterministically.
4. Stale child backend handles after restart or child-backend exit fail deterministically.
5. Codex -> Pi spawning remains explicitly rejected or unavailable as a documented non-goal.

### Phase 6: Final Hardening

Deliverables:

1. mixed-backend regression coverage,
2. docs and tests aligned with final contract,
3. cleanup of superseded helper code and dead abstractions.

Acceptance criteria:

1. No dead dual-contract code remains.
2. Mixed backend thread routing works across create/resume/fork/list/read flows.
3. Review gates have been satisfied and triaged.

## 4. Verification Matrix

| Area | Verification |
| --- | --- |
| Backend routing | unit tests for model-id parse and backend selection |
| Pi behavior preservation | existing unit/smoke coverage and targeted regression tests |
| Codex stdio backend | integration tests with mock child app-server |
| Codex websocket backend | integration tests or deterministic reject assertion |
| Thread persistence | registry tests for `backendType` and opaque backend handle semantics |
| Collab routing | integration tests for Pi parent -> Codex child lifecycle |
| Generic server-request relay | integration tests for request/resolve, timeout, and cancellation flow |
| Event ordering | tests for no dropped events on thread start/resume/fork |
| Thread read | integration tests for Pi and Codex history hydration |
| Backend availability | tests that a failed Codex backend does not remove Pi service |
| Cross-backend fork | deterministic reject tests |

## 5. Review Policy

Required external reviews:

1. design artifact review during authoring stage,
2. execution-phase reviews at milestone gates when the execution stream requires them.

For this authoring stage, independent reviewers must cover:

1. clarity,
2. missing requirements,
3. risks,
4. test gaps.

## 6. Milestone Commit Gate

Required milestone gates:

1. after Phase 2 (Pi port complete and green),
2. after Phase 3 (Codex stdio working),
3. after Phase 5 (backend-aware collab working),
4. after Phase 6 (cleanup and hardening complete).

Each gate requires:

1. tests for the completed phase green,
2. review findings triaged,
3. explicit go/no-go decision entered into Section 9 evidence.

## 7. Execution Handoff Contract

Required read order:

1. `docs/implementation/backend-routing-and-codex-proxy/schema-proposal.md`
2. `docs/implementation/backend-routing-and-codex-proxy/design.md`
3. `docs/implementation/backend-routing-and-codex-proxy/phase-task-plan.md`

Phase start point:

1. start at Phase 1 only,
2. execute phases in strict order,
3. do not skip ahead to Codex work before Pi has been ported to the new contract,
4. within Phase 1, freeze the concrete backend and router signatures first before broader refactors continue.

Boundaries and semantic-preservation constraints:

1. preserve current Pi behavior while migrating contracts,
2. keep `command/exec` adapter-native,
3. do not add backward-compatibility bridges for old internal backend contracts,
4. do not implement Claude backend in this topic,
5. do not implement Codex -> Pi subagent spawning in this topic.

Review command policy requirements:

1. use `agent-runner-review`,
2. run at least Gemini and Pi reviewers when the phase gate calls for external review,
3. monitor the live session stream for completion,
4. do not pass timeout or reasoning overrides.

Completion requirements:

1. complete all declared phases,
2. update stabilized architecture docs only after code behavior is final,
3. update `CHANGELOG.md` if the work is shipped externally,
4. fill Section 9 evidence for every completed phase,
5. provide a final phase summary with go/no-go outcome.
6. do not start Phase 3 until request-id mapping and backend-neutral `thread/read` semantics are locked in code.

## 8. Operator Checklist

For each phase:

1. confirm prior phase acceptance criteria are met,
2. implement only the scoped deliverables,
3. run required verification,
4. run required review gate when applicable,
5. triage findings as `accept`, `defer`, or `reject`,
6. record evidence in Section 9,
7. make go/no-go decision before advancing.

## 9. Evidence Log Schema

This section is mandatory for execution. The same format is also used here to record authoring-stage design review evidence.

### 9.0 Authoring-Stage Design Review Evidence

- completion date: 2026-03-23
- commit hash(es): n/a
- acceptance evidence: design, schema, and phase-plan artifacts updated after Gemini and Pi review to lock event-ordering semantics, bidirectional model-id rewrite, explicit backend error events, backend-neutral `thread/read`, request-id mapping, backend-aware collab routing beyond spawn, partial backend availability, cross-backend fork rejects, and expanded failure-mode coverage.
- review run IDs + triage outcomes:
  - `r_20260323174304937_0868182b` (Gemini): accepted event buffering/no-drop requirement, bidirectional model-id rewrite, explicit backend error events, collab failure-mode tests, server-request timeout/cancel coverage; accepted partial-availability clarification; deferred dynamic tool and MCP passthrough requests as out of scope.
  - `r_20260323174304937_1c73a839` (Pi): accepted `CollabManager` backend-routing expansion across all child operations, backend-neutral `thread/read`, outer-to-inner request-id mapping, partial-availability semantics, cross-backend fork rejection, handle-update persistence semantics, and additional crash/recovery tests; rejected changing scope to implement Codex auth/config passthrough details in this topic.
- go/no-go decision: go

### 9.1 Phase 1 Evidence

- completion date: 2026-03-23
- commit hash(es): `7e9ca49`, `f99e00a`
- acceptance evidence: locked routed `IBackend` signatures in `packages/core/src/backend.ts`; added `packages/core/src/backend-router.ts` with backend registration, prefixed model parsing, and single aggregated default arbitration; removed single-backend-only core wiring assumptions and locked backend-originated `error`/`disconnect` event handling in app-server routing paths.
- review run IDs + triage outcomes:
  - `r_20260323193617115_1052d003` (Gemini): accepted contract/router default-selection and event-buffering checks; deferred dedicated router/buffer unit test expansion to hardening backlog.
  - `r_20260323193617115_4712fb59` (Pi): accepted routed contract freeze and no-drop event-ordering semantics; rejected legacy migration fallback suggestions (`no backward-compatibility bridges` rule).
  - `r_20260323193947576_67de5d57` (Codex): accepted removal of hardcoded single-backend assumptions and explicit backend error-event surfacing; deferred optional router availability-surface expansion beyond scoped deliverables.
- go/no-go decision: go

### 9.2 Phase 2 Evidence

- completion date: 2026-03-23
- commit hash(es): `f99e00a`
- acceptance evidence: Pi backend fully ported to routed `IBackend` thread/turn methods (`threadStart`, `threadResume`, `threadFork`, `threadRead`, `threadArchive`, `threadSetName`, `turnStart`, `turnInterrupt`, `resolveServerRequest`); `thread/read` uses backend-neutral result shape from backend-owned hydration; stale core-only turn-history helpers removed from active code paths.
- review run IDs + triage outcomes:
  - `r_20260323194306368_1da362ea` (Gemini): accepted Pi port coverage and backend-neutral read checks; rejected legacy-thread compatibility fallback recommendations per topic rule.
  - `r_20260323195034165_f886ac51` (Pi): accepted cleanup of dead app-server turn-history abstractions and per-turn model-application correctness; deferred richer Pi historical tool-item parity as non-blocking follow-up.
- go/no-go decision: go

### 9.3 Phase 3 Evidence

- completion date: 2026-03-23
- commit hash(es): `3e8d107`
- acceptance evidence: added `packages/backend-codex` stdio proxy backend with initialize handshake, request/response/notification relay, model-id rewrite, and backend event buffering; wired Codex backend registration and startup in CLI while preserving partial availability (Codex startup failure does not poison Pi model/thread operations).
- review run IDs + triage outcomes:
  - `r_20260323194347339_150601d2` (Gemini): accepted stdio proxy scope, request-id relay, and partial availability semantics; deferred deeper process-lifecycle crash/timeout matrix coverage.
  - `r_20260323195358155_8f799b04` (Pi): accepted Codex proxy integration and backend error/disconnect surfacing direction; deferred expanded Codex `threadResume`/`threadFork`/`threadRead` coverage depth as follow-up hardening.
- go/no-go decision: go

### 9.4 Phase 4 Evidence

- completion date: 2026-03-23
- commit hash(es): `3e8d107`
- acceptance evidence: websocket transport path implemented as deterministic reject (`Codex websocket transport is deferred in this implementation`) with explicit configuration path retained and tests asserting reject behavior, including URL-qualified defer messages.
- review run IDs + triage outcomes:
  - `r_20260323194624048_53c1e18f` (Gemini): accepted defer-and-reject path as valid phase outcome; deferred reconnect/recovery semantics until websocket implementation is in scope.
  - `r_20260323195625099_1005333d` (Pi): accepted deterministic reject behavior and evidence-backed defer decision; deferred optional no-op disposal edge-case expansion (non-blocking).
- go/no-go decision: go

### 9.5 Phase 5 Evidence

- completion date: 2026-03-23
- commit hash(es): `01a0cdd`
- acceptance evidence: `CollabManager` routes child operations through owning backend across `spawn`, `sendInput`, `wait`, `resume`, and `close`; child runtime metadata persists `backendType`; invalid cross-backend selections fail deterministically; stale backend runtime transitions now surface deterministic failure paths.
- review run IDs + triage outcomes:
  - `r_20260323194731578_8294185e` (Gemini): accepted backend-aware child-operation routing and deterministic failure handling direction; deferred additional backend-crash chaos testing depth.
  - `r_20260323195834225_3006d928` (Pi): accepted backend-aware collab routing coverage and child backend ownership persistence; deferred nested-collab passthrough behavior as out-of-scope.
- go/no-go decision: go

### 9.6 Phase 6 Evidence

- completion date: 2026-03-23
- commit hash(es): `953b763`
- acceptance evidence: finalized reference docs for routed multi-backend architecture (`docs/backend-interface.md`, `docs/architecture.md`, `docs/api-mapping.md`) and implementation status index (`docs/implementation/implementation-plan.md`); completed verification suite: `npm run lint`, `npm test`, `npm run build`, and `npm run check` all green on the final branch state.
- review run IDs + triage outcomes:
  - `r_20260323194739659_024aa1f1` (Gemini): accepted final hardening direction and documentation closure; deferred extended concurrent-load soak coverage as non-blocking.
  - `r_20260323200115151_7c3a2d44` (Pi): accepted docs/test alignment closure and dead-abstraction hardening direction; deferred additional long-tail mixed-backend failure-matrix coverage for future increments.
- go/no-go decision: go
