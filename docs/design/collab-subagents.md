# Collab Sub-Agents Design

> Emulating Codex's multi-agent collaboration protocol in codapter with a Pi backend.

## Problem

Codex Desktop GUI supports multi-agent collaboration: a parent agent can spawn
child agents that run as independent threads, each with their own conversation,
tools, and lifecycle. The GUI renders these as navigable tabs (Alt+Left/Right)
with `CollabAgentToolCall` items showing spawn/send/wait/close/resume operations
on the parent thread.

Codapter currently has no sub-agent support. Pi has no native sub-agent concept.
We need to emulate the full Codex collab surface so the Desktop GUI sees
protocol-identical behavior.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Codex Desktop GUI                                      │
│  (renders threads, collab items, Alt+L/R navigation)    │
└────────────────────┬────────────────────────────────────┘
                     │ Codex app-server protocol (NDJSON)
                     │ stdio / WebSocket / UDS
┌────────────────────▼────────────────────────────────────┐
│  Codapter                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ AppServer     │  │ CollabManager │  │ CommandExec   │ │
│  │ (JSON-RPC     │  │ (orchestrates │  │ (native shell)│ │
│  │  router)      │  │  child agents)│  │               │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
│         │                  │                             │
│         │    UDS collab    │  IBackend                   │
│         │    methods       │  interface                  │
│  ┌──────▼───────┐  ┌──────▼───────────────────────────┐ │
│  │ Parent Pi     │  │ Child Pi sessions                │ │
│  │ (session A)   │  │ (session B, C, D…)              │ │
│  └──────┬───────┘  └─────────────────────────────────┘ │
└─────────┼───────────────────────────────────────────────┘
          │
          │ Pi extension calls codapter
          │ over UDS (OOB channel)
          └──► collab/spawn, collab/sendInput,
               collab/wait, collab/close, collab/resume
```

### Key Design Decisions

1. **Codapter owns orchestration.** The CollabManager in codapter spawns and
   manages child Pi processes via the existing `IBackend` interface. The Pi
   extension is a thin proxy.

2. **OOB channel via UDS.** The Pi extension communicates with codapter over the
   same Unix domain socket codapter already supports. Codapter passes the socket
   path to Pi via `CODAPTER_COLLAB_UDS` environment variable.

3. **Child threads are first-class.** Each child agent appears as a full thread
   in the Codex protocol — its own `thread/started` notification, independent
   event stream, navigable in the GUI's multi-agent picker.

4. **Parent sees collab items.** The parent thread gets `CollabAgentToolCall`
   thread items showing spawn/send/wait/close/resume operations with
   `agentsStates` maps.

5. **Pi extension is ~50 lines.** Registers 5 tools, each one makes a JSON-RPC
   call over UDS and returns the result. The extension blocks on the call while
   codapter does the work.

6. **`agentId` is the canonical identifier.** A single UUID is the API-level
   handle for all tool inputs (`send_input`, `wait_agent`, `close_agent`,
   `resume_agent`), GUI correlation (`agentsStates` map keys,
   `receiverThreadIds`), and error reporting. Internally, `CollabManager`
   maps `agentId` → `threadId` (codapter thread, for GUI routing) and
   `agentId` → `sessionId` (backend session, for `IBackend` calls). Neither
   `threadId` nor `sessionId` are exposed to the Pi LLM or the collab tools.

7. **`wait_agent` uses wait-any semantics.** Matching Codex behavior: returns
   as soon as *any* agent in the `ids` list reaches a final state. Returns
   the status map for all agents that have reached a final state at that
   point. Non-final agents are omitted from the map. Callers loop if they
   need wait-all.

8. **V1: no persistence across restarts.** Child agent state is in-memory
   only. If codapter restarts, child sessions are lost. The parent Pi's
   collab tools will get `notFound` status for stale agent IDs. Thread
   registry entries for child threads are persisted (so the GUI can show
   history) but the live `CollabAgent` state and backend sessions are not
   resumable after restart. This is an explicit V1 scope cut.

## Protocol Types

### CollabAgentToolCall (ThreadItem variant)

```typescript
{
  type: "collabAgentToolCall",
  id: string,                                    // item UUID
  tool: CollabAgentTool,                         // "spawnAgent" | "sendInput" | "wait" | "closeAgent" | "resumeAgent"
  status: CollabAgentToolCallStatus,             // "inProgress" | "completed" | "failed"
  senderThreadId: string,                        // parent thread ID
  receiverThreadIds: string[],                   // child thread IDs involved
  prompt: string | null,                         // message sent (spawn/sendInput)
  model: string | null,                          // model override (spawn)
  reasoningEffort: ReasoningEffort | null,       // reasoning override (spawn)
  agentsStates: Record<string, CollabAgentState> // per-agent status snapshot
}
```

### CollabAgentState

```typescript
{
  status: "pendingInit" | "running" | "interrupted" | "completed"
        | "errored" | "shutdown" | "notFound",
  message: string | null  // completion message or error text
}
```

### Thread (with sub-agent source)

Child threads have a `source` field indicating they were spawned:

```typescript
{
  id: string,
  source: {
    type: "subAgent",
    subAgent: {
      type: "threadSpawn",
      parentThreadId: string,
      depth: number,
      agentNickname: string | null,
      agentRole: string | null
    }
  },
  agentNickname: "Robie",  // top-level for quick access
  agentRole: "worker",
  // ... rest of Thread fields
}
```

## Components

### 1. Pi Extension (`codapter-collab-extension`)

Installed as a Pi extension. Reads `CODAPTER_COLLAB_UDS` env var on init.
Registers 5 tools with TypeBox parameter schemas.

Each tool's `execute()` callback:
1. Connects to codapter UDS (or reuses connection)
2. Sends JSON-RPC request (e.g., `collab/spawn`)
3. Awaits response with **extension-level timeout** (blocks Pi's tool execution)
4. Returns result as `AgentToolResult`

**Extension-level timeout.** Every UDS call has a hard timeout independent of
the collab operation's own timeout. For `wait_agent`: 3660s (1hr + 60s buffer
above `maxTimeoutMs`). For all other calls (spawn, send, close, resume): 30s
— these are fast fire-and-forget operations that should complete in
milliseconds. If the UDS call times out, the extension returns an error
result to the Pi LLM so it can recover rather than blocking forever. The
`AbortSignal` from Pi's tool execution is also wired to cancel the UDS call.

**Error handling.** If the UDS connection fails (codapter crashed, socket gone),
the extension returns a structured error result:
`{ error: "collab_unavailable", message: "..." }`. The Pi LLM sees this as a
failed tool call and can decide to proceed without sub-agents.

**Tool definitions:**

| Tool Name       | Parameters                                           | Returns                      |
| --------------- | ---------------------------------------------------- | ---------------------------- |
| `spawn_agent`   | `message: string, agent_type?: string, model?: string, reasoning_effort?: string, fork_context?: boolean` | `{ agent_id: string, nickname: string }` |
| `send_input`    | `id: string, message: string, interrupt?: boolean`   | `{ submission_id: string }`  |
| `wait_agent`    | `ids: string[], timeout_ms?: number`                 | `{ status: Record<string, AgentStatus>, timed_out: boolean }` |
| `close_agent`   | `id: string`                                         | `{ previous_status: AgentStatus }` |
| `resume_agent`  | `id: string`                                         | `{ status: AgentStatus }`    |

**Environment variable:** `CODAPTER_COLLAB_UDS=/path/to/codapter.sock`

### 2. CollabManager (codapter core)

New module in `packages/core/src/collab-manager.ts`.

Responsibilities:
- Maintains agent registry: `Map<agentId, CollabAgent>`
- Spawns child sessions via `IBackend.createSession()` + `backend.prompt()`
- Tracks agent status (PendingInit → Running → Completed/Errored/Shutdown)
- Assigns nicknames from a predefined list
- Enforces depth limits and max concurrent agent count
- Resolves `wait_agent` calls by monitoring child session events

```typescript
interface CollabAgent {
  agentId: string;                    // UUID
  nickname: string;
  role: string | null;
  threadId: string;                   // codapter thread ID (exposed to GUI)
  sessionId: string;                  // backend session ID
  parentThreadId: string;
  depth: number;
  status: CollabAgentStatus;
  completionMessage: string | null;
  statusWaiters: Array<{              // pending wait_agent resolvers
    resolve: (status: CollabAgentStatus) => void;
    signal?: AbortSignal;
  }>;
}
```

### 3. Collab JSON-RPC Methods

Served on a **dedicated internal UDS listener** (`collab-uds.ts`). The parent
Pi extension connects here. These are NOT exposed on the main GUI transport.

**Trust boundary.** The collab UDS is:
- Created with mode `0o600` (owner-only read/write)
- Path is randomized per codapter instance (`/tmp/codapter-collab-<random>.sock`)
  to prevent multi-instance collisions
- Only shared with Pi processes spawned by this codapter instance (via env var)

**Connection binding.** When Pi spawns, codapter also passes
`CODAPTER_COLLAB_PARENT_THREAD=<threadId>` as an env var. The extension sends
this as a `parentThreadId` field in every collab RPC request. The collab UDS
handler validates:
- `parentThreadId` matches an active thread in this `AppServerConnection`
- For `sendInput`/`wait`/`close`/`resume`: the target `agentId` must belong
  to an agent whose `parentThreadId` matches the caller's bound thread
- Requests with mismatched thread IDs are rejected with a JSON-RPC error

This prevents a compromised or rogue extension from operating on agents it
didn't spawn. The binding is per-request (not per-connection) since all
parent Pi processes share the same UDS socket.

The collab UDS is a control plane — it can spawn processes and consume
resources. Socket permissions and caller validation are security-relevant.

| Method              | Handler                   | Description                                    |
| ------------------- | ------------------------- | ---------------------------------------------- |
| `collab/spawn`      | `handleCollabSpawn()`     | Create child thread + session, prompt it        |
| `collab/sendInput`  | `handleCollabSendInput()` | Send message to existing child agent            |
| `collab/wait`       | `handleCollabWait()`      | Block until child(ren) reach final status       |
| `collab/close`      | `handleCollabClose()`     | Shutdown a child agent                          |
| `collab/resume`     | `handleCollabResume()`    | Resume a previously closed child agent          |

### 4. Collab Item Emission (Ownership Model)

**CollabManager is the sole authority** for `CollabAgentToolCall` item emission.
The `TurnStateMachine` does NOT create collab items.

When Pi's tool events arrive (`tool_start` / `tool_end` for collab tool names),
the `TurnStateMachine` **suppresses** them — it does not emit `item/started` or
`item/completed` for these tool calls. Instead, the collab flow is:

1. Pi LLM calls `spawn_agent` → Pi emits `tool_start` event
2. Pi extension's `execute()` blocks on UDS call to codapter
3. `TurnStateMachine` sees `tool_start` with name `spawn_agent` → **skips item
   creation** (returns early, no `item/started` notification)
4. `CollabManager` receives the `collab/spawn` RPC over UDS
5. `CollabManager` emits `item/started` with the full `CollabAgentToolCall`
   shape (including `senderThreadId`, `receiverThreadIds`, `agentsStates`)
6. `CollabManager` does the orchestration work
7. `CollabManager` emits `item/completed` with final status and `agentsStates`
8. `CollabManager` returns result over UDS → extension unblocks → Pi emits
   `tool_end`
9. `TurnStateMachine` sees `tool_end` with name `spawn_agent` → **skips**

This avoids the dual-emission problem: `TurnStateMachine` would only have
partial information (tool name, raw output text) while `CollabManager` has
the full collab context (agent IDs, nicknames, status maps).

**Pre-RPC failure case.** If the extension fails to connect to the UDS (codapter
crashed, socket missing), the extension returns a failed tool result to Pi. Pi
emits `tool_start` + `tool_end` with `isError: true`. Since `TurnStateMachine`
suppresses collab tool events, **no `CollabAgentToolCall` item appears on the
parent thread** for this failed attempt. This is acceptable because:
- The parent Pi LLM sees the error in its tool result and can report/retry
- The GUI sees the LLM's subsequent text response explaining the failure
- No phantom "in progress" collab items are left dangling

If observability of pre-RPC failures is needed in V2, the `TurnStateMachine`
can emit a minimal `CollabAgentToolCall` item with `status: "failed"` and
`agentsStates: {}` when it sees a collab `tool_end` with `isError: true`
without a matching CollabManager emission. This is explicitly deferred to V2.

Update `turn-state.ts` to suppress collab tools:

```typescript
const COLLAB_TOOL_NAMES = new Set([
  "spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"
]);

// In handleToolStart:
if (COLLAB_TOOL_NAMES.has(toolName)) return; // CollabManager owns emission

// In handleToolEnd:
if (COLLAB_TOOL_NAMES.has(toolName)) return; // CollabManager owns emission
```

`CollabManager` emits items by calling the same `NotificationSink` interface
that `TurnStateMachine` uses, ensuring consistent notification delivery.

### 5. Child Thread Event Routing

When CollabManager spawns a child agent:

1. Calls `backend.createSession()` → gets `childSessionId`
2. Creates a new `ThreadRuntime` in the parent `AppServerConnection`
3. Emits `thread/started` notification with the child's `Thread` object
   (including `source: { type: "subAgent", ... }`, `agentNickname`, `agentRole`)
4. Subscribes to `backend.onEvent(childSessionId, ...)` and routes events
   through a new `TurnStateMachine` for the child thread
5. Calls `backend.prompt(childSessionId, turnId, message)` to start the child

The child thread's events (text deltas, tool calls, etc.) stream independently
to the GUI as notifications on the child's `threadId`.

## Detailed Flows

### Async Tool Model

All 5 collab tools are **non-blocking** except `wait_agent`. This matches
Codex's behavior:

- `spawn_agent`: Creates child, submits prompt, returns immediately with
  `{ agent_id, nickname }`. Child runs asynchronously.
- `send_input`: Submits message to child's queue, returns immediately.
- `wait_agent`: **Blocks** until any child reaches a final status or timeout.
  This is the only call where the parent Pi's tool execution is suspended.
- `close_agent`: Fires shutdown, returns previous status immediately.
- `resume_agent`: Re-creates session, returns current status immediately.

The parent LLM orchestrates async workflows by spawning multiple agents,
doing its own work, then calling `wait_agent` when it needs results:

```
spawn_agent("task A") → { agent_id: "abc", nickname: "Robie" }  // instant
spawn_agent("task B") → { agent_id: "def", nickname: "Zara" }   // instant
// parent does its own work here while children run...
wait_agent(["abc", "def"]) → blocks → { status: { "abc": "completed" }, timed_out: false }
```

### spawn_agent

```
Pi LLM ──tool_call──► Pi Extension ──collab/spawn──► Codapter CollabManager
                       (blocks briefly)                │
                                                       ├─ 1. Validate depth/count limits
                                                       ├─ 2. Assign nickname, agentId
                                                       ├─ 3. backend.createSession() → childSessionId
                                                       ├─ 4. Create ThreadRuntime for child
                                                       ├─ 5. Subscribe to child events → route to GUI
                                                       ├─ 6. Emit thread/started notification (GUI)
                                                       ├─ 7. Emit item/started: CollabAgentToolCall{
                                                       │      tool: "spawnAgent", status: "inProgress"
                                                       │    } on parent thread
                                                       ├─ 8. backend.prompt(childSessionId, message)
                                                       │      (fire-and-forget — child runs async)
                                                       ├─ 9. Set agent status = Running
                                                       ├─ 10. Emit item/completed: CollabAgentToolCall{
                                                       │       tool: "spawnAgent", status: "completed",
                                                       │       agentsStates: { [agentId]: { status: "running" } }
                                                       │     } on parent thread
                                                       ▼
                       ◄──{ agent_id, nickname }─────── 11. Return immediately
Pi LLM ◄──tool_result──
         (child continues running independently)
```

Note: `spawn_agent` only blocks long enough to create the session and submit
the prompt (~milliseconds). It does NOT wait for the child to finish. The
child runs asynchronously; CollabManager monitors its events in the background.

### wait_agent (only blocking call)

This is the **only collab tool that blocks for a significant duration**. The
parent Pi's tool execution is suspended until a child reaches a final state
or the timeout expires.

```
Pi LLM ──tool_call──► Pi Extension ──collab/wait──► Codapter CollabManager
                       (BLOCKS)                      │
                                                     ├─ 1. Emit item/started: CollabAgentToolCall{
                                                     │      tool: "wait", status: "inProgress"
                                                     │    } on parent thread
                                                     ├─ 2. For each agentId in ids:
                                                     │      if agent.status is final → collect immediately
                                                     │      else → add to agent.statusWaiters
                                                     ├─ 3. If any already final → return immediately
                                                     │    Else → await: any waiter resolves OR timeout
                                                     │    (this is where the real blocking happens)
                                                     ├─ 4. Emit item/completed: CollabAgentToolCall{
                                                     │      tool: "wait", status: "completed",
                                                     │      agentsStates: { ... per-agent status }
                                                     │    }
                                                     ▼
                       ◄──{ status, timed_out }────── 5. Return to extension
Pi LLM ◄──tool_result──
```

### send_input

```
Pi LLM ──tool_call──► Pi Extension ──collab/sendInput──► CollabManager
                       (blocks briefly)                    │
                                                           ├─ 1. Look up agent by ID, validate parent ownership
                                                           ├─ 2. If interrupt: backend.abort(sessionId)
                                                           ├─ 3. Emit item/started on parent thread
                                                           ├─ 4. backend.prompt(sessionId, message)
                                                           │      (fire-and-forget — agent processes async)
                                                           ├─ 5. Update agent status = Running
                                                           ├─ 6. Emit item/completed on parent thread
                                                           ▼
                       ◄──{ submission_id }─────────────── 7. Return immediately
Pi LLM ◄──tool_result──
         (child processes the message independently)
```

Note: Like `spawn_agent`, `send_input` returns as soon as the message is
submitted. It does NOT wait for the child to process the message.

### Child Agent Completion Detection

When a child's backend session emits `message_end`:

1. CollabManager captures the child's last assistant text
2. Updates `agent.status = "completed"` and `agent.completionMessage`
3. Resolves any pending `statusWaiters` for this agent
4. The child thread's `TurnStateMachine` finishes normally (GUI sees turn complete)

When a child's backend session emits `error`:

1. CollabManager updates `agent.status = "errored"` with error message
2. Resolves pending waiters

### close_agent Semantics

`close_agent` performs a **full teardown** of the child agent:

1. Captures current agent status as `previous_status`
2. Calls `backend.abort(sessionId)` to cancel any active generation
3. Calls `backend.disposeSession(sessionId)` to terminate the child process
4. Sets `agent.status = "shutdown"`
5. Emits `thread/status/changed` with `{ type: "idle" }` on the child thread
   (the thread stays in `thread/list` but is no longer active)
6. Removes the backend event subscription
7. Returns `{ previous_status }` to caller

After close, the `CollabAgent` record remains in the registry with status
`shutdown`. The `threadId` is preserved. The backend session is gone.

### resume_agent Semantics

`resume_agent` **re-creates the backend session** for a previously closed or
errored agent, reusing the same `agentId` and `threadId`:

1. Validates agent exists and status is resumable (`shutdown`, `errored`,
   `completed`). Non-resumable statuses (`running`, `pendingInit`) return
   an error.
2. Calls `backend.resumeSession(agent.sessionId)` to re-attach to the
   persisted Pi session (conversation history is preserved on disk by Pi)
3. If `resumeSession` fails (session file missing/corrupt), falls back to
   `backend.createSession()` — the agent restarts with a fresh session
4. Updates `agent.sessionId` to the new/reattached session ID
5. Re-subscribes to `backend.onEvent(newSessionId, ...)`
6. Creates a new `TurnStateMachine` for the child thread
7. Sets `agent.status = "running"`
8. Emits `thread/status/changed` with `{ type: "active", activeFlags: [] }`
9. Does NOT emit a new `thread/started` — the original `threadId` is reused,
   the GUI sees the existing thread become active again
10. Returns `{ status: "running" }` to caller

**Errored vs shutdown vs completed resume behavior is identical** — all three
attempt `resumeSession` first, fall back to `createSession`. The distinction
is only in `previous_status` reporting.

### Cascade Shutdown & Lifecycle

When a parent thread is closed or the parent Pi process dies:

1. `CollabManager` iterates all agents where `parentThreadId` matches
2. For each child: calls `backend.abort(sessionId)` then
   `backend.disposeSession(sessionId)`
3. Updates agent status to `shutdown`
4. Resolves any pending `statusWaiters`
5. Emits `thread/status/changed` for each child thread (GUI sees them close)

When codapter itself shuts down (`dispose()`):

1. `CollabManager.dispose()` shuts down ALL child agents (all parents)
2. Same abort + dispose sequence as above
3. Pending UDS responses are rejected with a connection-closed error

When a child Pi process crashes unexpectedly:

1. `backend.onEvent()` stream closes or emits an error
2. `CollabManager` detects this via the event subscription
3. Updates agent status to `errored` with crash message
4. Resolves pending waiters
5. Does NOT automatically restart — parent LLM can call `resume_agent`

### Idle Detection Strategy

Pi has no explicit "turn complete" signal — we infer it from backend events:

- `message_end` event → agent completed this turn
- `error` event → agent errored

These are already events in the `BackendEvent` type. The CollabManager
subscribes to child session events via `backend.onEvent()` and watches for
these terminal events.

For `wait_agent`, the CollabManager does NOT poll `get_state`. Instead, it
relies on the `message_end` / `error` events from the child session's event
stream — the same mechanism codapter already uses for turn completion
detection. This is reliable and has no race condition.

## Configuration

| Setting                   | Default | Description                              |
| ------------------------- | ------- | ---------------------------------------- |
| `--collab` CLI flag       | false   | Enable sub-agent collaboration; auto-creates the collab UDS |
| `CODAPTER_COLLAB_UDS`     | (auto)  | UDS path for collab extension → codapter (auto-generated: `/tmp/codapter-collab-<random>.sock`) |
| `CODAPTER_COLLAB_PARENT_THREAD` | (auto) | Parent thread ID passed to each Pi process for auth binding |
| `collab.maxAgents`        | 10      | Max concurrent child agents              |
| `collab.maxDepth`         | 3       | Max spawn nesting depth                  |
| `collab.defaultTimeoutMs` | 30000   | Default wait_agent timeout               |
| `collab.minTimeoutMs`     | 10000   | Minimum wait_agent timeout               |
| `collab.maxTimeoutMs`     | 3600000 | Maximum wait_agent timeout               |

## File Changes

### New Files

| File                                                  | Description                            |
| ----------------------------------------------------- | -------------------------------------- |
| `packages/core/src/collab-manager.ts`                 | CollabManager class                    |
| `packages/core/src/collab-types.ts`                   | Collab protocol types                  |
| `packages/core/src/collab-uds.ts`                     | Internal UDS listener for collab RPCs  |
| `packages/collab-extension/src/index.ts`              | Pi extension (thin proxy)              |
| `packages/collab-extension/package.json`              | Extension package                      |

### Modified Files

| File                                                  | Change                                 |
| ----------------------------------------------------- | -------------------------------------- |
| `packages/core/src/app-server.ts`                     | Initialize CollabManager, wire UDS     |
| `packages/core/src/turn-state.ts`                     | Add `collabAgentToolCall` classification |
| `packages/core/src/protocol.ts`                       | Add CollabAgentToolCall ThreadItem type |
| `packages/backend-pi/src/index.ts`                    | Pass `CODAPTER_COLLAB_UDS` env to Pi   |
| `packages/cli/src/index.ts`                           | Start collab UDS listener              |

## Resolved Design Decisions

### Agent Types / Roles

The `agent_type` parameter maps to a **system prompt prefix** injected before
the user's message when prompting the child session. V1 ships with no built-in
role definitions — `agent_type` is passed as-is in a prefix line:

```
You are a sub-agent with role: {agent_type}.
```

Future versions may support role configuration files with custom system prompts,
tool restrictions, or model overrides per role. For V1, the parent LLM is
responsible for describing the role in its spawn message.

### Fork Context

When `fork_context: true`, `CollabManager` calls `backend.forkSession(parentSessionId)`
instead of `backend.createSession()`. This creates a child session with the
parent's full conversation history. The child's initial prompt is appended after
the fork marker. Pi's existing `fork` RPC command handles the session cloning.

### Model Overrides

When `spawn_agent` includes `model` or `reasoning_effort`:
1. `CollabManager` calls `backend.setModel(childSessionId, model)` after
   creating the session but before prompting
2. Available models are whatever `backend.listModels()` returns — same set
   the parent sees
3. If the requested model is invalid, `collab/spawn` returns an error result
   (not a crash) so the Pi LLM can retry with a valid model

### Collab UDS Lifecycle

Separate dedicated listener. Created during codapter startup, path passed to Pi
via env var. Destroyed on codapter shutdown. The GUI transport never sees collab
methods. This prevents the GUI from directly invoking collab operations.

### Extension Distribution

V1: bundled in the codapter repo as `packages/collab-extension/`. Codapter
auto-installs it by passing the extension path to Pi's `--extension` CLI flag
when spawning the parent Pi process. No manual `pi install` required.

### Thread Persistence

V1: out of scope (see Key Design Decision #8). Child thread registry entries
are persisted for GUI history display. Live agent state is not resumable
across codapter restarts.

## Testing Strategy

### Unit Tests (`packages/core/`)

- **CollabManager state transitions:** PendingInit → Running → Completed,
  PendingInit → Running → Errored, spawn at depth limit returns error,
  spawn at max agents returns error, concurrent spawns respect limits
- **Nickname assignment:** no duplicates, exhaustion handling
- **wait_agent semantics:** wait-any returns on first final, timeout returns
  `timed_out: true`, already-final agents return immediately, mixed
  final/non-final returns the final ones
- **Cascade shutdown:** parent close triggers child shutdown, all waiters
  resolve, no zombie processes
- **Item emission:** CollabManager emits correct `CollabAgentToolCall` shapes
  for each tool type (spawn, send, wait, close, resume)

### Unit Tests (`turn-state.ts`)

- **Collab tool suppression:** `tool_start`/`tool_end` for collab tool names
  produce NO `item/started`/`item/completed` notifications
- **Non-collab tools unaffected:** bash, edit, etc. still classified correctly

### Integration Tests

- **UDS round-trip:** Extension sends `collab/spawn` over UDS, receives
  `{ agent_id, nickname }` response
- **Extension timeout:** UDS call returns error after timeout, Pi LLM sees
  failed tool result
- **UDS connection failure:** Extension returns `collab_unavailable` error
  when socket is gone

### Close/Resume Lifecycle Tests

- **Close → resume roundtrip:** Close agent, verify `thread/status/changed`
  to idle, resume agent, verify same `threadId` reused (no new
  `thread/started`), verify `thread/status/changed` back to active, verify
  agent can receive `send_input` after resume
- **Resume errored agent:** Child crashes, status becomes `errored`, resume
  succeeds with same `threadId`, new backend session created
- **Resume running agent → error:** Attempting `resume_agent` on a running
  agent returns error result
- **Close already-closed agent:** Returns `previous_status: "shutdown"`,
  no crash
- **Double resume:** Resume an already-running resumed agent → error

### UDS Authorization Tests

- **Valid parent thread:** Extension sends correct `parentThreadId` → request
  succeeds
- **Wrong parent thread:** Extension sends mismatched `parentThreadId` →
  JSON-RPC error, request rejected
- **Cross-parent agent access:** Parent A tries to `send_input` to an agent
  spawned by Parent B → rejected
- **Invalid agent ID:** `send_input`/`close`/`resume` with nonexistent UUID
  → `notFound` error result

### Protocol / E2E Tests

- **Spawn flow:** Assert exact NDJSON sequence: `thread/started` for child,
  `item/started` with `CollabAgentToolCall{tool:"spawnAgent"}` on parent,
  child event stream active, `item/completed` with `agentsStates`
- **Wait flow:** Assert `item/started` with `tool:"wait"`, blocks until
  child `message_end`, then `item/completed` with status map
- **Child in thread/list:** Child threads appear in `thread/list` response
  with correct `source.subAgent` metadata
- **Error matrix:**
  - Spawn failure after `thread/started` (backend.createSession fails)
  - `send_input` to nonexistent agent → `notFound` error result
  - `wait_agent` with invalid UUID → error result
  - `close_agent` on already-closed agent → returns `shutdown` status
  - Child process crash → agent status `errored`, waiters resolve
  - Parent close → children cascade shutdown
  - Codapter restart → stale agent IDs return `notFound`

## Open Questions (V2+)

1. **Role configuration files.** Should `agent_type` map to structured role
   definitions with system prompts, tool restrictions, and model preferences?

2. **Cross-restart resume.** Should `resume_agent` work across codapter
   restarts by persisting `CollabAgent` state and using
   `backend.resumeSession()`?

3. **Parallel tool calls.** Codex disables parallel tool calls for collab
   tools. Should codapter enforce this, or let Pi's LLM decide?

4. **Nested collab.** Should child agents be able to spawn their own
   children? The depth limit supports this, but the child Pi process would
   also need the collab extension and UDS access.
