# Backend Routing And Codex Proxy Design

Status: Locked

## Purpose

Define the backend architecture required for codapter to support:

1. Codex CLI/app-server itself as a selectable backend over stdio first and websocket second,
2. existing Pi support without regressing current behavior,
3. future runtime-stream backends such as Claude Code without forcing Codex through a Pi-shaped adapter contract,
4. Pi parent threads spawning Codex child agents through codapter-owned collaboration primitives.

## Problem Statement

The current implementation is intentionally Pi-specific. `packages/core/src/backend.ts` models a backend as:

1. session lifecycle (`createSession`, `resumeSession`, `forkSession`),
2. prompt lifecycle (`prompt`, `abort`),
3. model lifecycle (`listModels`, `setModel`),
4. normalized turn events (`text_delta`, `thinking_delta`, `tool_*`, `message_end`, `elicitation_request`, `token_usage`).

That contract fits Pi because Pi exposes a process RPC stream that codapter must translate into app-server notifications.

It does not fit Codex as a backend. Codex already speaks the app-server protocol surface that codapter exposes outward:

1. thread lifecycle,
2. turn lifecycle,
3. item lifecycle,
4. server-initiated requests such as approvals and tool user input,
5. typed collab items and dynamic tool flows.

Forcing Codex through the current contract would require lossy deconstruction and re-synthesis of protocol-identical data. That adds risk, duplicates logic codex already owns, and blocks full-fidelity support for approvals, dynamic tools, and collab-related item semantics.

At the same time, codapter still needs one client-facing process with one model picker. The user must be able to choose backends from one connection, for example:

1. `pi / Opus 4.6`
2. `codex / gpt-5.4`

This means codapter cannot solve the problem by bypassing its own app-server layer entirely for Codex. It needs a routed backend architecture inside one adapter process.

## Goals

1. Keep one codapter app-server entry point for clients.
2. Support one shared model picker whose entries encode backend selection.
3. Preserve current Pi behavior during the refactor.
4. Add Codex as a backend with protocol-preserving behavior rather than deep normalization.
5. Make the architecture explicitly capable of adding Claude later as another normalized runtime backend.
6. Support Pi parent threads invoking Codex sub-agents through codapter-owned collab APIs.
7. Avoid backward-compatibility bridges once the new contract lands; old internal shapes should be removed rather than silently supported in parallel.

## Non-Goals

1. Implementing Claude backend support in this topic. Claude is a design validation target, not an execution deliverable.
2. Implementing Codex invoking Pi subagents in this topic. That requires upstream dynamic tool mediation and is explicitly deferred.
3. Preserving the current low-level `IBackend` contract indefinitely. This design replaces it.
4. Solving remote orchestration beyond:
   1. Codex stdio support,
   2. optional Codex websocket connectivity as a secondary transport,
   3. codapter's existing outward listener modes.
5. Changing adapter-native `command/exec`. That path remains local to codapter.

## Current Baseline

### External runtime layout

Today codapter has:

1. `packages/cli`
   - bootstraps a single backend instance,
   - currently always constructs `PiBackend`,
   - serves stdio/websocket listeners.
2. `packages/core`
   - owns `AppServerConnection`,
   - owns thread registry persistence,
   - owns turn state normalization,
   - owns collab management,
   - assumes one backend contract with Pi-shaped semantics.
3. `packages/backend-pi`
   - implements the current `IBackend`,
   - launches Pi subprocesses,
   - maps Pi model/process events into normalized backend events.

### Constraints imposed by the current contract

1. `AppServerConnection` hardcodes one backend instance for the whole process.
2. `thread/start` creates a backend session before model-based routing is resolved.
3. `thread/start` and collab child-thread creation persist `backendType: "pi"` directly.
4. The current turn state machine classifies tools heuristically because it receives only normalized tool events, not authoritative app-server items.
5. The only explicit backend-to-client server-request bridge implemented today is `item/tool/requestUserInput`.

### Why Claude belongs on the Pi side of the line

Claude Code's `--print --input-format stream-json --output-format stream-json` interface emits a runtime event stream:

1. `system/init`,
2. `stream_event` with `message_start`, `content_block_*`, `message_delta`, `message_stop`,
3. `assistant`,
4. `result`,
5. `rate_limit_event`.

That is still below the app-server abstraction level. Claude therefore belongs with Pi in the normalized-runtime family, not with Codex in the protocol-preserving family.

## Key Decisions

### 1. Keep one backend name: `IBackend`

There will be one backend contract inside codapter: `IBackend`.

Concrete backends:

1. `PiBackend`
2. `CodexBackend`
3. `ClaudeBackend` later

We will not introduce an outward-facing split like `IAppServerBackend` vs `INormalizedBackend`. That adds type-system layers without helping the caller. The caller only needs one contract.

### 2. Move `IBackend` up to the app-server abstraction level

`IBackend` must stop being a session-event adapter contract and become a thread/turn/item/backend-request contract. That is the only level where:

1. Pi and Claude can normalize upward,
2. Codex can proxy mostly unchanged,
3. codapter can still route multiple backends from one client connection.

### 3. Codex is a protocol-preserving backend, not a normalized event backend

Codex backend behavior must default to raw proxy semantics:

1. relay upstream thread/turn/item notifications,
2. relay upstream server requests and their responses,
3. avoid local turn-state synthesis,
4. avoid tool heuristics,
5. only rewrite when codapter explicitly adds value.

Allowed rewrites:

1. picker-facing model ids and display names,
2. backend routing metadata,
3. optional future augmentation hooks such as dynamic tools.

### 4. Pi remains a normalized backend

Pi backend will continue to:

1. own Pi subprocess lifecycle,
2. normalize Pi turn events into app-server-thread semantics,
3. participate in the shared routed `IBackend` contract through a wrapper around the existing behavior.

### 5. Backend selection is based on adapter model ids, resolved before thread creation

Model ids exposed through `model/list` must become adapter-routed ids, for example:

1. `pi::anthropic/claude-opus-4-6`
2. `codex::gpt-5.4`

Display names can remain user-friendly:

1. `pi / Opus 4.6`
2. `codex / GPT-5.4`

This is required because the backend decision must happen before:

1. `thread/start`,
2. `thread/fork`,
3. collab child-thread spawn.

### 6. Thread persistence must record actual backend ownership

Thread registry entries must persist the routed backend identity rather than assuming Pi. `backendType` becomes the source of truth for:

1. resume routing,
2. fork routing,
3. collab child-thread routing,
4. archival metadata.

### 7. Pi -> Codex subagents are in scope; Codex -> Pi subagents are deferred

This topic supports:

1. Pi parent thread spawning a Codex child thread via codapter collab orchestration.

This topic defers:

1. Codex parent thread spawning a Pi child thread by dynamic tool injection.

The deferred direction remains compatible with this design, but it is not part of the initial execution plan.

### 8. Event delivery must be race-safe

The routed backend contract must not allow a backend to emit externally visible thread or turn events before codapter has a listener bound for that thread handle.

Required rule:

1. `threadStart`, `threadResume`, and `threadFork` establish the backend-owned thread handle first,
2. codapter binds the backend event listener immediately after the handle is known,
3. any backend events that arrive before the listener is bound must be buffered and replayed in order,
4. no backend may drop early events silently.

This rule applies most directly to Codex stdio/websocket proxying, where upstream notifications can arrive immediately after the downstream request resolves.

### 9. Model-id rewriting is bidirectional

Backend-prefixed model ids are an adapter contract, not just an outbound request helper.

Required behavior:

1. outbound requests rewrite `backendType::rawModelId` to the backend-native raw id,
2. inbound notifications, thread state payloads, and any backend-originated model fields rewrite raw ids back to the adapter-prefixed form before they reach the client,
3. the rewrite contract applies equally to `model/list`, `thread/*`, `turn/*`, and `thread/read` results.

### 10. Codex partial availability is acceptable

Codapter must tolerate a backend being unavailable without failing the entire adapter.

Required behavior:

1. Pi may remain available when Codex is unavailable or uninitialized,
2. aggregated `model/list` includes only healthy backends,
3. Codex-routed operations reject deterministically when Codex is unavailable,
4. backend startup failures surface in logs and diagnostics without poisoning Pi threads.

### 11. Cross-backend fork is rejected in the initial design

Fork preserves backend ownership.

Required behavior:

1. a Pi thread forks to Pi,
2. a Codex thread forks to Codex,
3. requesting a fork on one backend while selecting a model on another backend rejects deterministically,
4. backend migration between existing threads is not part of this topic.

### 12. One aggregated default model is selected by the router

The aggregated picker must expose at most one `isDefault: true` entry.

Required behavior:

1. backends may nominate local defaults internally,
2. the backend router resolves those into one adapter-level default,
3. if more than one backend claims a default, router configuration order is authoritative,
4. if no backend is healthy, no default is exposed.

## Contract / HTTP Semantics

This section describes the backend contract exposed inside codapter, not the external app-server wire protocol.

### Proposed `IBackend` shape

The new `IBackend` owns backend-specific handling for:

1. backend-prefixed model list entries,
2. thread lifecycle responses,
3. turn lifecycle responses,
4. backend-originated notifications,
5. backend-originated server requests,
6. backend-specific request resolution.

Conceptually:

```ts
interface IBackend {
  readonly backendType: string;

  initialize(): Promise<void>;
  dispose(): Promise<void>;
  isAlive(): boolean;

  listModels(): Promise<BackendModelSummary[]>;
  parseModelSelection(model: string | null | undefined): ParsedBackendSelection | null;

  threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult>;
  threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult>;
  threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult>;
  threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult>;
  threadArchive(input: BackendThreadArchiveInput): Promise<void>;
  threadSetName(input: BackendThreadSetNameInput): Promise<void>;

  turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult>;
  turnInterrupt(input: BackendTurnInterruptInput): Promise<void>;

  resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void>;

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable;
}
```

Where `BackendAppServerEvent` is no longer a Pi-shaped delta stream. It is a backend-facing representation of app-server outputs:

1. notification payloads,
2. server-request payloads,
3. explicit non-fatal backend error payloads,
4. disconnect/failure conditions,
5. backend-specific terminal lifecycle signals.

The key change is that the unit of orchestration becomes the backend-owned thread handle, not the backend-owned session plus local turn state machine.

Implementation lock requirement:

1. before Phase 2 or Phase 3 begins, this conceptual shape must be converted into concrete exported TypeScript signatures in `packages/core/src/backend.ts`,
2. the paired routing API must be locked in `packages/core/src/backend-router.ts` at the same time,
3. those concrete signatures become the code-level source of truth for the remaining execution phases,
4. if implementation discovers a mismatch large enough to change these semantics, the design docs must be amended before proceeding.

### Thread handles

Each backend returns an opaque thread handle that codapter persists in `ThreadRegistry.backendSessionId` for continuity with current storage naming. Semantically it now means:

1. Pi: opaque normalized thread/session handle,
2. Codex: opaque upstream thread handle or resume token,
3. Claude later: opaque normalized thread/session handle.

The registry field name can remain unchanged in the first pass to avoid an unnecessary storage migration, but the design treats it as an opaque backend-owned thread handle rather than specifically a "session id".

`threadResume` and `threadFork` may return an updated thread handle. Codapter must persist the returned handle whenever it changes, even if some backends usually keep the handle stable.

### Server-request semantics

The new contract must support backend-originated server requests generically. Required request types for initial Codex support:

1. `item/tool/requestUserInput`
2. command approval requests
3. file change approval requests

Initial deferred request types:

1. dynamic tool calls,
2. MCP server elicitation,
3. other experimental server requests not needed for basic Codex support.

The contract must carry request ids and resolution payloads without backend-specific branching in `AppServerConnection`.

Codapter must also maintain reverse mapping from outer-client request ids to backend-native request ids for proxied backends such as Codex so concurrent requests from multiple threads cannot collide.

### Thread-read semantics

`threadRead` must return a backend-owned representation that is already normalized to codapter's outward `thread/read` response contract.

Required behavior:

1. Pi backend converts Pi history into fully formed app-server turns and items before returning,
2. Codex backend proxies upstream `thread/read` turns/items with only the minimal adapter rewrites required by this design,
3. `AppServerConnection` does not re-run Pi-specific `buildTurns` logic on Codex-backed reads,
4. mixed-backend resume/read flows use one backend-neutral `BackendThreadReadResult` shape.

## Service / Module Design

### `packages/core`

#### `backend.ts`

Replace the current low-level interface with the new high-level routed `IBackend`.

Responsibilities:

1. top-level backend contract,
2. routed model-id utilities,
3. generic backend event and server-request types,
4. no Pi-specific event semantics.

#### `backend-router.ts` (new)

New module responsible for:

1. registering backend instances by `backendType`,
2. aggregating `model/list` across backends,
3. parsing model-prefix routing,
4. choosing the target backend for:
   1. `thread/start`,
   2. `thread/fork`,
   3. collab child spawn,
5. resolving one adapter-level default model across healthy backends,
6. exposing backend availability state for deterministic partial-service behavior.

#### `app-server.ts`

Refactor `AppServerConnection` to:

1. depend on a backend router instead of a single backend,
2. delegate thread lifecycle directly to a selected backend,
3. delegate turn lifecycle directly to the owning backend,
4. publish backend-provided notifications rather than synthesizing all turn items itself,
5. route server-request responses back to the owning backend.

What remains adapter-owned:

1. JSON-RPC framing,
2. connection initialization,
3. config/auth compatibility shims already in codapter,
4. adapter-native `command/exec`,
5. thread registry persistence for cross-backend routing and local listing,
6. collab manager.

What is removed from `AppServerConnection` for backend-owned threads:

1. hard dependency on the current turn-state machine for all backends,
2. hardcoded Pi assumptions in `thread/start`,
3. backend-specific request branching except for generic reply routing.

#### `turn-state.ts`

Becomes a Pi/Claude normalization helper, not a universal backend orchestrator.

Initial scope after refactor:

1. retained and reused by Pi backend,
2. not used by Codex backend.

#### `collab-manager.ts`

Refactor `CollabManager` to route every backend-touching operation through backend-aware child state, not just spawn-time backend selection.

Rules:

1. parent Pi thread may request a `codex::...` model and spawn a Codex child backend,
2. backend selection occurs before thread handle creation,
3. collab state stores both `agentId` and child `backendType`,
4. `spawn`, `sendInput`, `wait`, `resume`, and `close` route through the owning backend,
5. child agents must carry either a backend reference or a resolvable backend key for every subsequent operation,
6. parent-backend and child-backend identity are both retained for diagnostics and deterministic rejects.

### `packages/backend-pi`

Responsibilities remain mostly unchanged, but they move behind the higher-level backend contract.

New internal shape:

1. current Pi process/session logic remains,
2. a Pi thread adapter maps:
   1. thread start/resume/fork,
   2. thread history hydration,
   3. turn events through `TurnStateMachine`,
   4. generic server requests through codapter.

### `packages/backend-codex` (new)

New package owning Codex-as-backend integration.

Responsibilities:

1. spawn `codex app-server` over stdio by default,
2. optionally connect to an upstream Codex websocket endpoint,
3. perform initialize/initialized handshake as a downstream client,
4. proxy `thread/*`, `turn/*`, `item/*`, and server requests,
5. maintain request-id mapping between outer client and inner Codex backend where necessary,
6. rewrite model ids between:
   1. outer adapter-prefixed ids,
   2. inner raw Codex ids,
7. own Codex subprocess or websocket lifecycle, including backend-health tracking and deterministic failure when the backend is unavailable.

This backend intentionally does not:

1. run `TurnStateMachine`,
2. classify tools heuristically,
3. rebuild approval flows locally.

Boundary constraint:

1. adapter-native `command/exec` remains local to codapter and is not implicitly exposed as a Codex backend tool in this topic,
2. any future Codex augmentation by dynamic tools must be added explicitly rather than inherited accidentally from the adapter process.

### `packages/backend-claude` (future, not in this execution stream)

Documented for architectural fit only.

Expected responsibilities:

1. launch Claude Code in `--print` stream-json mode,
2. parse event stream into normalized app-server items,
3. reuse the same normalized backend helper pattern as Pi,
4. remain out of scope for the initial execution plan.

## Error Semantics

### Routing errors

Deterministic rejects:

1. unknown backend-prefixed model id -> reject before thread creation,
2. resume/fork for unknown `backendType` -> reject,
3. backend mismatch between stored thread and requested routed backend -> reject rather than silently migrating the thread.

### Codex proxy errors

Required behavior:

1. upstream app-server disconnect during active request -> fail the affected request or thread operation explicitly,
2. upstream websocket unavailable -> fail only Codex backend operations, do not poison other backends,
3. unsupported experimental upstream request -> reject explicitly if codapter has not implemented generic passthrough for that request class,
4. non-fatal upstream protocol or transport errors -> surface as explicit backend error events rather than disconnect by default.

### Pi normalization errors

Current behavior preserved:

1. malformed Pi event stream -> thread failure,
2. stale turn events gated by turn id,
3. normalization helper remains authoritative for diffing cumulative tool output.

### Collab errors

Required behavior:

1. Pi parent requesting Codex child with unknown Codex model -> immediate tool-call failure,
2. child backend shutdown while wait/send/resolve is pending -> deterministic collab failure state,
3. parent and child backend types recorded in collab state for debugging and recovery,
4. process restart with stale child backend handles -> deterministic failure on next collab operation rather than implicit recreation.

## Migration Strategy

### Code migration

1. Introduce backend router and new `IBackend` contract.
2. Port Pi to the new contract first without semantic changes.
3. Delete the old Pi-shaped `IBackend` contract after Pi is moved.
4. Add Codex backend on top of the new contract.
5. Add routed model ids and backend-aware thread persistence.
6. Make collab backend-aware for Pi -> Codex spawn.

No compatibility bridge:

1. do not support both old and new backend contracts indefinitely,
2. do not add fallback parsing for old unprefixed model ids beyond a short-lived migration helper if absolutely required,
3. prefer one clean routed model-id format in the final state.

### Storage migration

Thread registry:

1. existing Pi threads keep `backendType: "pi"`,
2. existing Pi `backendSessionId` values remain valid as opaque thread handles,
3. new Codex threads persist `backendType: "codex"` and Codex-owned thread handles.

No thread data rewrite is required beyond preserving the stored backend type.

### User-visible migration

Model picker entries change from backend-native names to adapter-routed names:

1. display name becomes backend-prefixed human label,
2. internal model id becomes adapter-prefixed stable id.

This is intentional. The picker must make backend selection explicit.

## Test Strategy

### Unit

1. backend-router model-id parsing and backend selection,
2. registry routing based on `backendType`,
3. Codex model id rewrite logic,
4. bidirectional request-id relay mapping,
5. backend availability and aggregated default-model selection,
6. collab backend routing for Pi -> Codex child creation,
7. deterministic reject rules for cross-backend fork and unavailable backend selection.

### Integration

1. Pi backend on new `IBackend` contract with existing smoke coverage preserved,
2. Codex backend stdio proxy using a mock app-server child process,
3. Codex websocket proxy using a local mock websocket app-server,
4. mixed `model/list` aggregation returning both Pi and Codex entries,
5. `thread/start` and `turn/start` on:
   1. Pi thread,
   2. Codex thread,
   3. resumed and forked variants for both,
6. `thread/read` on:
   1. Pi thread,
   2. Codex thread,
   3. resumed variants for both,
7. generic server-request relay covering success, cancellation, and timeout paths,
8. Codex backend unavailable at startup while Pi remains healthy.

### Collaboration

1. Pi parent thread spawning Codex child thread with routed model id,
2. child thread lifecycle reflected in registry and notifications,
3. `sendInput`, `wait`, `resume`, `close` routed to the child backend,
4. explicit failure paths for invalid model/backend combinations,
5. explicit failure path for stale child backend handles after restart or child-backend exit.

### Regression

1. current Pi smoke tests stay green after port,
2. `command/exec` behavior unchanged,
3. thread list/read/archive semantics preserved across mixed backend types,
4. no dropped early backend events during thread start/resume/fork.

## Acceptance Criteria

1. The repo contains one top-level `IBackend` contract that can represent both normalized and Codex-proxy backends.
2. Pi is migrated to that contract without changing existing observable Pi behavior.
3. A new `CodexBackend` supports stdio-backed app-server proxying.
4. Codex websocket support exists as an optional secondary transport or is explicitly stubbed with deterministic rejects if deferred by phase gating.
5. `model/list` returns adapter-routed ids and backend-prefixed display names.
6. `thread/start`, `thread/resume`, and `thread/fork` route by backend correctly and persist `backendType`.
7. Pi parent threads can spawn Codex child agents through collab routing.
8. Codex -> Pi child-agent spawning is explicitly deferred and documented as such.
9. Design, schema, and phase plan artifacts are internally consistent and execution-ready.
