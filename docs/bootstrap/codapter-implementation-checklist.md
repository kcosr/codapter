# Codapter Implementation Checklist

Reference spec: `codex-protocol-analysis.md`

## Pre-Implementation Exploration

Before Milestone 1.1 begins, run a short read-only exploration pass to pin external contracts and reduce rework during implementation. This exploration is not a substitute for the implementation checklist below. It exists to produce durable supporting docs from the upstream sources the implementation depends on.

### Exploration Tracks

- [x] **E1: Codex protocol surface**
  - Owner: explorer agent
  - Sources: `../codex/` and protocol schema submodule paths when present
  - Output: `docs/bootstrap/protocol-surface.md`
  - Focus: exact v2 wire methods, request/response envelopes, notification payloads, command/exec family, initialize/config/auth/model/thread/turn surfaces

- [x] **E2: Pi backend surface**
  - Owner: explorer agent
  - Sources: `../pi-mono/` and related Pi packages
  - Output: `docs/bootstrap/pi-rpc-surface.md`
  - Focus: session lifecycle, prompt/abort, model management, token usage, tool event semantics, elicitation, opaque session handling

- [x] **E3: GUI behavior and quirks**
  - Owner: explorer agent
  - Sources: `../codex/`, extracted app notes, and related GUI-facing code paths
  - Output: `docs/bootstrap/gui-init-config-notes.md`
  - Focus: initialize/config ordering, heartbeat/keepalive, command/exec UI expectations, smoke-test priorities, explicitly out-of-scope remote/worktree behaviors

### Consolidation Rules

- [x] Main thread owns this checklist and `codex-protocol-analysis.md`
- [x] Explorer agents write findings into the supporting docs above, not into the main checklist/spec
- [x] Accepted findings are distilled back into the checklist/spec as concrete decisions or clarified milestones
- [x] Implementation starts only after the protocol source of truth is pinned locally and the exploration outputs are reviewed

## Parallelization Tracks

After Milestone 1.1 (project scaffolding) is complete, work can split into parallel tracks:

```
                    ┌─ 1.1 Scaffolding ─┐
                    │   (sequential)     │
                    └────────┬───────────┘
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                  ▼
    Track A: Core       Track B: Pi        Track C: Native
    ────────────        ──────────         ──────────────
    1.2 IBackend        2.2 PiBackend      4.2 command/exec
    1.3 Transport       (session lifecycle)
    1.4 Initialize
    1.5 Config stubs
        + unknown methods
        + heartbeat
    2.1 State mgmt
    2.3 Thread RPCs
           │                 │                  │
           └─────────────────┼──────────────────┘
                             ▼
                    Milestone 3: Turn Execution
                    (convergence — requires A + B)
                    3.1 State machine
                    3.2 Turn RPCs
                    3.3 Elicitation
                             │
                             ▼
                    Milestone 4.1: Tool Translation
                    (requires 3 complete)
                             │
                             ▼
                    Milestone 6: Integration & Polish
                    (requires all tracks)
```

**Track A (Core Protocol)**: IBackend interface, transport layer, initialize handshake, thread state management, thread RPC methods. This is the adapter's skeleton — protocol handling without any backend.

**Track B (Pi Integration)**: PiBackend class implementing IBackend. Spawning Pi processes, JSONL communication, session file parsing. Can develop against IBackend contract from Track A.

**Track C (Adapter-Native)**: Standalone command/exec (Node child_process). Fully independent of backend.

**Convergence**: Milestone 3 (turn execution) is where tracks A and B merge — the state machine translates Pi events into Codex events through the IBackend interface. Track C merges at integration testing.

---

## Milestone 1: Project Scaffolding & Transport Layer

### 1.1 Project Setup
- [x] Create `codapter/` repo directory
- [x] Initialize `package.json` (root workspace, `@codapter/` scope, version 0.1.0)
- [x] Create `tsconfig.base.json` (ES2022, NodeNext, strict, composite)
- [x] Create `biome.json` (2-space indent, 100 char width, recommended rules)
- [x] Set up Husky pre-commit hook (lint-staged + check)
- [x] Create workspace packages: `packages/core/`, `packages/backend-pi/`, `packages/cli/`
- [x] Each package: `package.json`, `tsconfig.json` extending base, `src/` directory
- [x] Add vitest config (`vitest.config.ts`)
- [ ] Add git submodules: Codex types repo, Pi mono repo — *Deferred: see follow-up task 1 (type vendoring)*
- [x] Create `scripts/build-dist.mjs` (esbuild CLI bundler)
- [x] Create `CHANGELOG.md` with initial entry
- [x] Verify: `npm run build`, `npm run lint`, `npm run test` all pass (empty)

**Done when**: Project compiles, lints, and runs empty test suite.

### 1.2 IBackend Interface
- [x] Define `IBackend` interface in `packages/core/src/backend.ts`
- [x] Methods: `initialize`, `dispose`, `isAlive`
- [x] Methods: `createSession`, `resumeSession`, `forkSession`, `disposeSession` — all use opaque `sessionId`, not file paths
- [x] Methods: `readSessionHistory`, `setSessionName`
- [x] Methods: `prompt(sessionId, turnId, text, images?)`, `abort(sessionId)`
- [x] Methods: `listModels`, `setModel`, `getCapabilities`
- [x] Methods: `respondToElicitation(sessionId, requestId, response)`
- [x] Event interface: `onEvent(sessionId, listener): Disposable`
- [x] Define `BackendEvent` union type with full correlation context:
  - Every event carries `turnId` for stale-event gating
  - `tool_start`/`tool_update`/`tool_end` carry `toolCallId` for parallel tool demuxing
  - `tool_update` has `isCumulative: boolean` flag (true = full output, adapter diffs; false = pure delta)
  - `elicitation_request` carries `requestId` for response matching
  - `token_usage` event for reporting input/output token counts
- [x] Define `BackendCapabilities` type (supportsImages, supportsThinking, supportsParallelTools, supportedToolTypes)
- [x] Note: `command/exec` is NOT part of IBackend — adapter-native (Decision #35)
- [x] Write `docs/backend-interface.md` with full contract documentation
- [ ] Reference Codex protocol types from submodule for exact payload shapes — *Deferred: see follow-up task 1*

**Done when**: Interface compiles, JSDoc on all methods, documentation written. Event payloads have explicit contracts for correlation, delta semantics, and terminal markers.

### 1.3 Transport Layer
- [x] Implement NDJSON framing: `parseNdjsonLine()`, `serializeNdjsonLine()`
- [x] Implement stdio transport: read stdin line-by-line, write to stdout
- [x] Implement WebSocket transport (TCP): `--listen ws://host:port`
- [x] Implement WebSocket transport (UDS): `--listen unix:///path/to/adapter.sock`
- [x] UDS lifecycle: create parent dir (`0700`), remove stale socket on start, set socket `0600`, cleanup on shutdown
- [x] All transports share a common `ITransport` interface (send/receive messages)
- [x] Support multiple `--listen` flags (e.g., TCP + UDS simultaneously)
- [x] `CODAPTER_LISTEN` env var as alternative to `--listen` flag (comma-separated for multiple)
- [x] CLI entry point: accept `app-server` subcommand, `--listen` flag
- [x] Ignore `--analytics-default-enabled` flag gracefully
- [x] Fallback to stdio if no `--listen` and no `CODAPTER_LISTEN` set
- [x] Unit tests: NDJSON parsing (valid, malformed, empty lines, Unicode)
- [x] Unit tests: transport send/receive round-trip
- [x] Unit tests: UDS lifecycle (create, permissions, stale cleanup, non-socket exists → error)

**Done when**: `codapter app-server` starts on stdio; `--listen ws://...` starts TCP WebSocket; `--listen unix://...` starts UDS WebSocket. All serve `/rpc` with same protocol.

### 1.4 Initialize Handshake
- [x] Parse `InitializeParams` from incoming request (note: initialize remains v1-typed even though most of the external protocol surface is v2)
- [x] Extract `clientInfo.name`, `clientInfo.version`, `capabilities`
- [x] Store client capabilities (experimentalApi, optOutNotificationMethods)
- [x] Enforce `optOutNotificationMethods` — filter outgoing notifications accordingly
- [x] Handle `initialized` client notification after handshake
- [x] Return `InitializeResponse` with userAgent, platformFamily, platformOs
- [x] Configurable identity: `emulateCodexIdentity` from TOML or env
- [x] Log client version, warn on version mismatch
- [x] Reject all RPC methods before initialize completes
- [x] Unit test: valid initialize → correct response
- [x] Unit test: RPC before initialize → error
- [x] Unit test: optOutNotificationMethods filtering

**Done when**: Codex Desktop connects, completes handshake, no errors in GUI.

### 1.5 Config Stubs, Unknown Methods & Heartbeat (moved from Milestone 5)

The GUI calls `config/read` immediately after `initialize`. These must be in Milestone 1 or the GUI won't load.

- [x] `config/read` → return typed shape `{ config, origins, layers }`; merge sensible defaults with in-memory overrides
- [x] `config/value/write` / `config/batchWrite` → return typed `ConfigWriteResponse` shape (`status`, `version`, `filePath`, `overriddenMetadata`)
- [x] `configRequirements/read` → return `{ requirements: null }`
- [x] `account/read` → return typed account/auth shape
- [x] `getAuthStatus` → implement deprecated method for compatibility
- [x] `skills/list` → return empty or map from backend
- [x] `plugin/list` → return empty
- [x] RPC router catch-all: unrecognized methods → JSON-RPC `-32601 Method not found`
- [x] Log unrecognized methods at warn level (method name, request ID, truncated params)
- [x] Do not invent an app-level heartbeat RPC; rely on stdio silence and WebSocket transport ping/pong only
- [x] Unit tests: config write → read back → same value
- [x] Unit test: unknown method → proper error response
- [x] Unit test: pre-init request rejection
- [x] Unit test: second initialize rejected

**Done when**: GUI loads fully after initialize without config/method errors.

---

## Milestone 2: Thread Lifecycle

### 2.1 Thread Registry (Single Source of Truth)

The adapter-owned thread registry is authoritative for all thread identity, metadata, and lifecycle state. Backend session locators are internal metadata within the registry. `thread/list`, archive state, names, and cwd all come from this registry, never from backend session scans.

- [x] Create adapter state directory (`~/.local/share/codapter/`)
- [x] Implement thread registry (`threads.json`)
- [x] Thread ID generation (UUID)
- [x] Registry entry: `threadId → {backendSessionId, backendType, name, createdAt, updatedAt, archived, cwd, preview, modelProvider}`
- [x] `backendSessionId` is opaque — the backend maps it internally to its own locator (e.g., Pi session file path)
- [x] `thread/list` reads exclusively from registry, not from backend
- [ ] Optional: backend session import/reconciliation for sessions created outside the adapter
- [x] Handle registry corruption: validate on load, skip invalid entries, log warnings
- [x] Atomic writes (write to temp file + rename) to prevent torn writes
- [x] Note: v0.1 assumes single adapter instance per state directory. Multi-window/multi-process write safety (locking or CAS) is deferred.
- [x] Unit tests: create, read, update, delete entries
- [x] Unit tests: corrupt file recovery

**Done when**: Thread registry persists across adapter restarts. All thread metadata queries read from registry.

### 2.2 Pi Backend Implementation (session lifecycle)
- [x] Implement `PiBackend` class implementing `IBackend`
- [x] Internal mapping: opaque `sessionId` ↔ Pi session file path (managed inside PiBackend, not exposed)
- [x] `createSession`: spawn Pi process (`--mode rpc`), send `new_session`, return opaque sessionId
- [x] `resumeSession`: spawn Pi process, resolve sessionId → file path internally, send `switch_session`
- [x] `forkSession`: spawn Pi process, load parent session, call `fork`, return new sessionId
- [x] `disposeSession`: terminate Pi process, clean up internal mapping
- [x] `readSessionHistory`: resolve sessionId → file path, parse Pi JSONL session file → BackendMessage[]
- [x] `setSessionName`: call Pi `set_session_name`
- [x] `getCapabilities`: return Pi's supported features (images, thinking, parallel tools, tool types)
- [x] Pi process lifecycle: spawn, track, idle timeout, terminate
- [x] Configurable idle timeout (env var, default 5 min) — *CODAPTER_PI_IDLE_TIMEOUT_MS*
- [ ] Max concurrent process limit (default 10) — *Not implemented*
- [x] Child process orphan cleanup: SIGINT/SIGTERM handler kills all Pi children on adapter exit
- [x] Handle Pi `cancelled: true` responses from `new_session`/`switch_session`/`fork`
- [x] Handle Pi `tool_execution_update` as cumulative output — set `isCumulative: true` on BackendEvent, adapter diffs
- [x] Robust NDJSON line-buffering for Pi stdout (handle OS pipe buffer fragmentation)
- [x] Emit BackendEvents with `turnId` and `toolCallId` correlation from Pi event stream
- [x] Unit tests with mock Pi process (mock stdin/stdout)

**Done when**: Can create, resume, fork, and dispose sessions through PiBackend. SessionIds are opaque. Clean shutdown kills all children.

### 2.3 Thread RPC Methods
- [x] `thread/start` → populate required protocol fields, call `backend.createSession()`, register in thread registry, return Thread object
- [x] `thread/resume` → populate required protocol fields, look up sessionId from registry, call `backend.resumeSession()`, return Thread with turns
- [x] `thread/read` → look up sessionId from registry, call `backend.readSessionHistory()`, translate to ThreadItems
- [x] `thread/fork` → reject if turn active; call `backend.forkSession()`, register new thread in registry, return new Thread
- [x] `thread/name/set` → call `backend.setSessionName()`, update registry
- [x] `thread/list` → read from thread registry (not backend), return paginated list
- [x] `thread/archive` / `thread/unarchive` → update registry archive flag
- [x] Per-thread state machine: `starting → ready → turn_active → forking → terminating`
- [x] Request queue: buffer turn/start until thread state is `ready`
- [x] Thread title generation from first user message
- [x] `thread/metadata/update` → update cwd/git info in thread registry
- [x] `thread/loaded/list` → return list of currently loaded (process-active) threads
- [x] `thread/unsubscribe` → stop sending notifications for a thread to this connection
- [x] Token usage: emit `thread/tokenUsage/updated` from Pi `get_session_stats` on turn completion
- [x] Stale event gating: ignore late Pi events that arrive after a turn has been completed/interrupted (compare turnId)
- [x] Unit tests: each method with mock backend
- [x] Unit tests: state machine transitions
- [x] Unit tests: request buffering during `starting` state
- [ ] Unit tests: idle timeout eviction doesn't race with incoming turn/start — *Not tested*

**Done when**: Threads appear in Codex Desktop sidebar, can be created/resumed/forked.

---

## Milestone 3: Turn Execution & Streaming

### 3.1 Message Decomposition State Machine
- [x] Design state machine: tracks current item type (text, thinking, tool)
- [x] On text_delta: if no open agentMessage item, emit item/started; emit delta
- [x] On thinking_delta: emit agent_reasoning_delta (or reasoning item)
- [x] On tool_start: close any open text item (emit item/completed); emit new item/started
- [x] On tool_update: emit item delta (commandExecution output or fileChange diff)
- [x] On tool_end: emit item/completed with full result
- [x] On message_end: close any open items, emit turn/completed
- [x] On error: close open items, emit turn/completed(failed)
- [x] Handle parallel tool calls (multiple open tool items)
- [x] Unit tests: text only → single agentMessage item
- [x] Unit tests: text then tool → two items
- [x] Unit tests: tool then text → two items
- [x] Unit tests: parallel tools → concurrent items
- [x] Unit tests: error mid-stream → proper cleanup
- [x] Unit tests: abort → synthesize item/completed for open items

**Done when**: All interleaving patterns produce correct Codex event sequences.

### 3.2 Turn RPC Methods
- [x] `turn/start` → validate thread state is `ready`; transition to `turn_active`
- [x] Map `UserInput[]` to Pi prompt format (at minimum text + image/localImage; decide explicit v0.1 behavior for unsupported `skill` / `mention` inputs)
- [x] Call `backend.prompt(sessionId, turnId, text, images)`
- [x] Emit `turn/started` notification
- [x] Route backend events through decomposition state machine
- [x] On completion: transition thread to `ready`, emit `turn/completed`
- [x] `turn/interrupt` → call `backend.abort()`, synthesize cleanup events
- [x] Handle Pi prompt ack vs actual completion (ack is "accepted", not "done")
- [x] Handle late Pi error responses after initial ack
- [x] Emit `thread/status/changed` on state transitions
- [x] Image input mapping: Codex UserInput image/localImage → Pi ImageContent
- [x] Unit tests: full turn lifecycle (start → deltas → complete)
- [x] Unit tests: interrupt mid-turn
- [x] Unit tests: Pi error after ack
- [x] Unit tests: image inputs

**Done when**: Send message in Codex Desktop, see streamed response with thinking.

### 3.3 Elicitation Support

The v2 protocol defines two server-request methods for user input:

- **`item/tool/requestUserInput`** (EXPERIMENTAL) — structured questions with options. Params: `{threadId, turnId, itemId, questions: [{id, header, question, isOther, isSecret, options}]}`. Response: `{answers: {[questionId]: answer}}`.
- **`mcpServer/elicitation/request`** — MCP server elicitation with form schema or URL. Params: `{threadId, turnId?, serverName, mode: "form"|"url", message, requestedSchema|url}`. Response: `{action: "approve"|"deny"|"dismiss", content?}`.

The GUI also recognizes legacy `codex/event/elicitation_request` and `codex/event/request_user_input` names (these are the Electron mapping layer names for the same v2 methods).

**Pi mapping**: Pi `extension_ui_request` methods map to `item/tool/requestUserInput`:
- Pi `select` (options list) → question with `options` array
- Pi `confirm` (yes/no) → question with two options
- Pi `input` (free text) → question with `isOther: true`, no options
- Pi `editor` (multi-line) → question with `isOther: true`, no options

Tasks:
- [x] Map Pi `extension_ui_request` (select, confirm, input, editor) → `item/tool/requestUserInput` server request
- [x] Translate Pi question format to `ToolRequestUserInputQuestion` shape (id, header, question, options)
- [x] Wait for GUI response (`ToolRequestUserInputResponse` with answers map)
- [x] Translate GUI answers back → Pi `extension_ui_response`
- [x] Ignore non-elicitation Pi UI events (notify, setStatus, setWidget, setTitle) — log at debug level
- [ ] Unit tests: select → requestUserInput round-trip
- [ ] Unit tests: confirm → requestUserInput round-trip
- [ ] Unit tests: input/editor → requestUserInput round-trip
- [ ] Unit test: non-elicitation UI events are silently ignored

**Done when**: Pi extension prompts appear as inline forms in Codex Desktop.

---

## Milestone 4: Tool Call Display & Command Execution

### 4.1 Tool Call Translation
- [x] Map Pi bash tool → Codex `commandExecution` ThreadItem
  - command, cwd, output streaming, exit code, duration
- [x] Map Pi edit/write tool → Codex `fileChange` ThreadItem
  - changes array with path, kind (add/delete/update), diff
- [x] Map Pi read/grep/find/ls tools → Codex `agentMessage` items (output as text)
- [x] Verify parallel tool call event correlation (Pi tool IDs)
- [x] Unit tests: each tool type mapping
- [x] Unit tests: parallel tool calls

**Done when**: Tool calls render correctly in Codex Desktop with proper icons/formatting.

### 4.2 Standalone Command Execution (adapter-native)
- [x] Implement `command/exec` using Node.js `child_process.spawn`
- [ ] Support PTY mode (node-pty or raw spawn) — *Not supported; documented as limitation*
- [x] Stream stdout/stderr as `command/exec/outputDelta` (base64 encoded)
- [x] `command/exec/write` → write to process stdin
- [ ] `command/exec/resize` → resize PTY — *N/A: PTY not supported*
- [x] `command/exec/terminate` → kill process
- [x] Process tracking: map processId → child process
- [x] Cleanup on disconnect
- [x] Unit tests: spawn, stream output, write stdin, terminate
- [x] Unit tests: process cleanup on adapter shutdown

**Done when**: Codex Desktop integrated terminal works for running commands.

---

## Milestone 5: Model & Config Management

### 5.1 Model Management
- [x] `model/list` → call `backend.listModels()`, translate to Codex Model format
- [x] Model selection on `thread/start` → pass to backend
- [x] Model selection on `turn/start` → call `backend.setModel()`
- [x] Unit tests: model listing, selection

### 5.2 Worktree Method Stubs
- [x] `create-worktree` → return `-32601` (not supported, but documented)
- [x] `delete-worktree` → return `-32601`
- [x] `resolve-worktree-for-thread` → return `-32601`
- [x] `worktree-cleanup-inputs` → return `-32601`
- [x] Document worktree limitations for users

**Done when**: Model picker works, worktree methods fail gracefully.

---

## Milestone 6: Integration Testing & Polish

### 6.1 End-to-End with Codex Desktop
- [x] Configure Codex Desktop: set `CODEX_CLI_PATH` to codapter dist binary
- [x] Test: start thread, send message, see streamed response
- [x] Test: tool calls display (bash command, file edit)
- [x] Test: interrupt active turn
- [x] Test: resume thread after restart
- [x] Test: fork thread
- [x] Test: model switching
- [x] Test: standalone command execution in terminal
- [x] Test: thread listing in sidebar
- [x] Test: thinking/reasoning display

### 6.2 Remote Mode
- [x] Test: `codapter app-server --listen ws://127.0.0.1:9234`
- [x] Test: SSH tunnel connection from Codex Desktop
- [ ] Test: reconnect after disconnect
- [ ] Test: session persistence across reconnects

### 6.3 Smoke Test Suite (automated)
- [x] Smoke test: basic conversation (2+2)
- [x] Smoke test: bash tool call
- [x] Smoke test: file create/edit
- [x] Smoke test: multi-turn context
- [x] Smoke test: model switching
- [x] Smoke test: thinking display
- [x] Smoke test: session persistence
- [x] Smoke test: interrupt
- [x] Smoke test: fork
- [x] Smoke test: standalone shell
- [x] Smoke test: thread listing
- [x] All smoke tests pass with `PI_SMOKE_TEST=1 npm run test:smoke`

### 6.4 Documentation & Release
- [x] Complete `docs/api-mapping.md` (validated against real GUI)
- [x] Complete `docs/architecture.md`
- [x] Complete `docs/integration.md` (setup guide)
- [x] Update CHANGELOG.md
- [x] Build dist: `npm run build:dist`
- [ ] Tag v0.1.0

**Done when**: Full coding assistant experience works through Codex Desktop GUI powered by Pi.
