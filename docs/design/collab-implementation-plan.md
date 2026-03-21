# Collab Sub-Agents: Implementation Plan

> Step-by-step plan for implementing the design in `collab-subagents.md`.
> Organized into parallel tracks that can be worked by independent agents.

## Prerequisites

- Familiarity with the design spec: `docs/design/collab-subagents.md`
- The codapter codebase: `packages/core/`, `packages/backend-pi/`, `packages/cli/`
- Pi extension API: `@mariozechner/pi-coding-agent` extension types

## Tracks Overview

```
Track A: Core Types & CollabManager     (no dependencies)
Track B: Pi Extension                   (no dependencies)
Track C: CLI Flag & UDS Listener        (depends on A)
Track D: Turn State Machine Changes     (depends on A)
Track E: AppServer Integration          (depends on A, C, D)
Track F: E2E Tests & Protocol Tests     (depends on all)
```

Tracks A and B can run fully in parallel. C and D depend only on A's types.
E integrates everything. F validates.

---

## Track A: Core Types & CollabManager

### A1. Collab Protocol Types

**File:** `packages/core/src/collab-types.ts` (new)

Define TypeScript types matching the Codex protocol:

```typescript
// Agent status lifecycle
export type CollabAgentStatus =
  | "pendingInit" | "running" | "interrupted"
  | "completed" | "errored" | "shutdown" | "notFound";

export interface CollabAgentState {
  status: CollabAgentStatus;
  message: string | null;
}

// Tool call types
export type CollabAgentTool =
  | "spawnAgent" | "sendInput" | "wait" | "closeAgent" | "resumeAgent";

export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed";

// ThreadItem variant
export interface CollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool: CollabAgentTool;
  status: CollabAgentToolCallStatus;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentsStates: Record<string, CollabAgentState>;
}

// Internal agent record
export interface CollabAgent {
  agentId: string;
  nickname: string;
  role: string | null;
  threadId: string;
  sessionId: string;
  parentThreadId: string;
  depth: number;
  status: CollabAgentStatus;
  completionMessage: string | null;
}

// RPC request/response shapes (collab UDS)
export interface CollabSpawnRequest {
  parentThreadId: string;
  message: string;
  agentType?: string;
  model?: string;
  reasoningEffort?: string;
  forkContext?: boolean;
}

export interface CollabSpawnResponse {
  agent_id: string;
  nickname: string;
}

export interface CollabSendInputRequest {
  parentThreadId: string;
  id: string;
  message: string;
  interrupt?: boolean;
}

export interface CollabSendInputResponse {
  submission_id: string;
}

export interface CollabWaitRequest {
  parentThreadId: string;
  ids: string[];
  timeout_ms?: number;
}

export interface CollabWaitResponse {
  status: Record<string, CollabAgentStatus>;
  timed_out: boolean;
}

export interface CollabCloseRequest {
  parentThreadId: string;
  id: string;
}

export interface CollabCloseResponse {
  previous_status: CollabAgentStatus;
}

export interface CollabResumeRequest {
  parentThreadId: string;
  id: string;
}

export interface CollabResumeResponse {
  status: CollabAgentStatus;
}

// Config
export interface CollabConfig {
  maxAgents: number;       // default 10
  maxDepth: number;        // default 3
  defaultTimeoutMs: number; // default 30000
  minTimeoutMs: number;    // default 10000
  maxTimeoutMs: number;    // default 3600000
}
```

Also add `CollabAgentToolCallItem` to the `ThreadItem` union in
`packages/core/src/protocol.ts`.

**Tests:** Type compilation only — no runtime tests needed.

### A2. CollabManager

**File:** `packages/core/src/collab-manager.ts` (new)

Implement the `CollabManager` class:

```typescript
export class CollabManager {
  private agents = new Map<string, CollabAgent>();
  private nicknames = new Set<string>();
  private readonly config: CollabConfig;
  private readonly backend: IBackend;
  private readonly notifySink: NotificationSink;

  // --- Spawn ---
  async spawn(req: CollabSpawnRequest): Promise<CollabSpawnResponse>;

  // --- Send Input ---
  async sendInput(req: CollabSendInputRequest): Promise<CollabSendInputResponse>;

  // --- Wait ---
  async wait(req: CollabWaitRequest): Promise<CollabWaitResponse>;

  // --- Close ---
  async close(req: CollabCloseRequest): Promise<CollabCloseResponse>;

  // --- Resume ---
  async resume(req: CollabResumeRequest): Promise<CollabResumeResponse>;

  // --- Lifecycle ---
  async shutdownByParent(parentThreadId: string): Promise<void>;
  async dispose(): Promise<void>;

  // --- Internal ---
  private assignNickname(): string;
  private validateParentOwnership(parentThreadId: string, agentId: string): void;
  private handleChildEvent(agentId: string, event: BackendEvent): void;
  private resolveWaiters(agentId: string): void;
  private isFinalStatus(status: CollabAgentStatus): boolean;
}
```

Key implementation details:
- `spawn`: Validate depth/count limits → assign nickname → create session →
  create ThreadRuntime (via callback) → emit `item/started` → prompt →
  subscribe to events → emit `item/completed` → return
- `wait`: Check immediate final statuses → register waiters with
  `Promise` + `setTimeout` → resolve on child `message_end`/`error` or timeout
- `handleChildEvent`: Listen for `message_end` → capture last text →
  set status `completed`. Listen for `error` → set status `errored`.
  Resolve waiters.
- `shutdownByParent`: Cascade close all children of a given parent thread
- `dispose`: Shutdown all agents

The manager needs callbacks to:
- Create `ThreadRuntime` entries (provided by `AppServerConnection`)
- Emit notifications on parent threads (via `NotificationSink`)
- Emit `thread/started` notifications for child threads

These are injected as constructor dependencies, not direct imports.

**Tests (unit):**
- State transitions: pendingInit → running → completed
- State transitions: pendingInit → running → errored
- Spawn at maxAgents → error
- Spawn at maxDepth → error
- wait_agent: immediate final → returns immediately
- wait_agent: timeout → returns `timed_out: true`
- wait_agent: wait-any with multiple IDs → returns on first final
- close → status becomes shutdown
- resume from shutdown → status becomes running, same agentId
- resume from errored → status becomes running
- resume from running → error
- Cascade: shutdownByParent closes all children
- Nickname uniqueness: no duplicates across concurrent spawns
- Parent ownership: sendInput to wrong parent's agent → error

### A3. Nickname List

**File:** `packages/core/src/collab-nicknames.ts` (new)

A list of ~100 agent nicknames (matching Codex's style). Simple array export.

```typescript
export const AGENT_NICKNAMES = [
  "Robie", "Zara", "Pixel", "Nova", "Atlas", "Byte", "Echo",
  // ...
];
```

---

## Track B: Pi Extension

### B1. Extension Package Setup

**Directory:** `packages/collab-extension/`

```
packages/collab-extension/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:
- Name: `@codapter/collab-extension`
- Type: module
- Dependencies: `@sinclair/typebox` (for parameter schemas)
- No dependency on pi-coding-agent (extension API is passed at runtime)

### B2. Extension Implementation

**File:** `packages/collab-extension/src/index.ts`

```typescript
import { Type, type Static } from "@sinclair/typebox";

// UDS JSON-RPC client
class CollabClient {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    // Connect to UDS, send JSON-RPC request, await response
    // Wire AbortSignal to destroy socket on abort
    // Hard timeout: 3660s
    // On connection failure: throw with { error: "collab_unavailable" }
  }
}

// Tool parameter schemas (TypeBox)
const SpawnAgentParams = Type.Object({
  message: Type.String(),
  agent_type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  reasoning_effort: Type.Optional(Type.String()),
  fork_context: Type.Optional(Type.Boolean()),
});

const SendInputParams = Type.Object({
  id: Type.String(),
  message: Type.String(),
  interrupt: Type.Optional(Type.Boolean()),
});

const WaitAgentParams = Type.Object({
  ids: Type.Array(Type.String()),
  timeout_ms: Type.Optional(Type.Number()),
});

const CloseAgentParams = Type.Object({
  id: Type.String(),
});

const ResumeAgentParams = Type.Object({
  id: Type.String(),
});

// Extension factory
export default function collabExtension(pi: any /* ExtensionAPI */) {
  const socketPath = process.env.CODAPTER_COLLAB_UDS;
  if (!socketPath) return; // No-op if not running under codapter

  const parentThreadId = process.env.CODAPTER_COLLAB_PARENT_THREAD;
  if (!parentThreadId) return;

  const client = new CollabClient(socketPath);

  // Helper: make collab RPC call, return as AgentToolResult
  async function collabCall(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    try {
      const result = await client.call(method, {
        parentThreadId,
        ...params,
      }, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    } catch (err: any) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.code ?? "collab_error",
            message: err.message ?? String(err),
          }),
        }],
        details: { error: true },
      };
    }
  }

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn a sub-agent for a well-scoped task. Returns the agent id and nickname.",
    promptSnippet: "spawn_agent: Spawn a sub-agent for parallel or delegated work",
    promptGuidelines: [
      "Only use spawn_agent if the user explicitly asks for sub-agents, delegation, or parallel agent work.",
      "Prefer doing the work yourself unless the task is clearly parallelizable.",
    ],
    parameters: SpawnAgentParams,
    execute: (toolCallId, params, signal) =>
      collabCall("collab/spawn", params, signal),
  });

  pi.registerTool({
    name: "send_input",
    label: "Send Input",
    description: "Send a message to an existing agent. Use interrupt=true to redirect work immediately.",
    parameters: SendInputParams,
    execute: (toolCallId, params, signal) =>
      collabCall("collab/sendInput", params, signal),
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description: "Wait for one or more agents to finish. Returns status map and whether timeout occurred.",
    parameters: WaitAgentParams,
    execute: (toolCallId, params, signal) =>
      collabCall("collab/wait", params, signal),
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description: "Close an agent when no longer needed. Returns its previous status.",
    parameters: CloseAgentParams,
    execute: (toolCallId, params, signal) =>
      collabCall("collab/close", params, signal),
  });

  pi.registerTool({
    name: "resume_agent",
    label: "Resume Agent",
    description: "Resume a previously closed agent so it can receive new messages.",
    parameters: ResumeAgentParams,
    execute: (toolCallId, params, signal) =>
      collabCall("collab/resume", params, signal),
  });
}
```

**Tests (unit):**
- `CollabClient.call` sends valid JSON-RPC and parses response
- `CollabClient.call` returns structured error on connection failure
- `CollabClient.call` respects AbortSignal
- Extension no-ops when env vars missing
- Each tool's execute wraps result correctly

---

## Track C: CLI Flag & UDS Listener

### C1. `--collab` CLI Flag

**File:** `packages/cli/src/index.ts` (modify)

Add `--collab` flag parsing alongside existing `--listen`:

```typescript
// In parseArgs:
if (arg === "--collab") {
  collabEnabled = true;
  continue;
}
```

Update `AppServerArgs`:
```typescript
export interface AppServerArgs {
  readonly listenTargets: readonly string[];
  readonly collabEnabled: boolean;
  readonly analyticsDefaultEnabledSeen: boolean;
}
```

### C2. Collab UDS Listener

**File:** `packages/core/src/collab-uds.ts` (new)

Internal UDS server that handles collab JSON-RPC methods:

```typescript
export class CollabUdsListener {
  private server: net.Server;
  readonly socketPath: string;

  constructor(collabManager: CollabManager) {
    this.socketPath = `/tmp/codapter-collab-${randomUUID().slice(0, 8)}.sock`;
    // Create UDS server with mode 0o600
    // On connection: parse JSON-RPC requests, route to CollabManager methods
    // Validate parentThreadId in every request
  }

  async start(): Promise<void>;
  async close(): Promise<void>;
}
```

Route table:
- `collab/spawn` → `collabManager.spawn()`
- `collab/sendInput` → `collabManager.sendInput()`
- `collab/wait` → `collabManager.wait()`
- `collab/close` → `collabManager.close()`
- `collab/resume` → `collabManager.resume()`

### C3. Pass Env Vars to Pi

**File:** `packages/backend-pi/src/pi-process.ts` (modify)

When spawning Pi child process, if collab is enabled, add to env:
- `CODAPTER_COLLAB_UDS=<socketPath>`
- `CODAPTER_COLLAB_PARENT_THREAD=<threadId>`

Also add `--extension <path-to-collab-extension>` to Pi's CLI args.

**Tests:**
- UDS listener accepts connections and routes requests
- UDS listener rejects invalid parentThreadId
- Socket created with 0o600 permissions
- Env vars passed correctly to Pi process

---

## Track D: Turn State Machine Changes

### D1. Suppress Collab Tool Events

**File:** `packages/core/src/turn-state.ts` (modify)

Add collab tool name set and suppress logic:

```typescript
const COLLAB_TOOL_NAMES = new Set([
  "spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"
]);
```

In `handleToolStart`: if tool name is in `COLLAB_TOOL_NAMES`, return early.
In `handleToolEnd`: if tool name is in `COLLAB_TOOL_NAMES`, return early.
In `handleToolUpdate`: if tool name is in `COLLAB_TOOL_NAMES`, return early.

### D2. Add CollabAgentToolCall to Protocol Types

**File:** `packages/core/src/protocol.ts` (modify)

Add `CollabAgentToolCallItem` to the `ThreadItem` union type.

**Tests:**
- Collab tool names suppressed: no `item/started`/`item/completed`
- Non-collab tools unaffected (bash → commandExecution, edit → fileChange)
- `handleToolUpdate` for collab names is also suppressed

---

## Track E: AppServer Integration

### E1. Wire CollabManager into AppServer

**File:** `packages/core/src/app-server.ts` (modify)

In `AppServerConnection` constructor (or factory):
- If collab enabled: create `CollabManager` with backend, notification sink,
  and thread runtime factory callback
- Provide a callback for CollabManager to create `ThreadRuntime` entries
  (reuse `initRuntime()` logic)
- Provide a callback to emit `thread/started` notifications

### E2. Wire Collab UDS Startup

**File:** `packages/cli/src/index.ts` (modify)

When `--collab` is passed:
1. Create `CollabUdsListener` with the `CollabManager`
2. Start the UDS listener
3. Pass `collabUdsListener.socketPath` to the backend (for env var injection)
4. On shutdown: close the collab UDS listener

### E3. Cascade Shutdown on Thread Close

**File:** `packages/core/src/app-server.ts` (modify)

When a parent thread is closed/terminated, call
`collabManager.shutdownByParent(threadId)`.

### E4. Child Thread in thread/list and thread/read

Child threads created by CollabManager are registered in the `ThreadRegistry`
with `source: { type: "subAgent", ... }` metadata. The existing `thread/list`
and `thread/read` handlers should return them alongside normal threads.

Verify that the GUI filters/groups correctly by checking the `source` field.

**Tests:**
- E2E: spawn agent, verify child appears in `thread/list`
- E2E: child thread has correct `source.subAgent` metadata
- E2E: closing parent thread cascades to children

---

## Track F: E2E & Protocol Tests

### F1. Spawn Flow

Assert exact NDJSON notification sequence:
1. `thread/started` for child thread (with `source.subAgent` metadata)
2. `item/started` on parent thread with `CollabAgentToolCall{tool:"spawnAgent", status:"inProgress"}`
3. Child event stream active (text deltas on child threadId)
4. `item/completed` on parent thread with `agentsStates`

### F2. Wait Flow

1. Spawn agent, send it a prompt
2. Call `wait_agent`
3. Assert `item/started` with `tool:"wait"`
4. Assert blocks until child `message_end`
5. Assert `item/completed` with status map

### F3. Send Input Flow

1. Spawn agent
2. Call `send_input` with follow-up message
3. Assert child receives new prompt
4. Assert `item/started`/`item/completed` on parent

### F4. Close/Resume Lifecycle

1. Spawn → close → verify `thread/status/changed` to idle
2. Resume → verify same threadId, `thread/status/changed` to active
3. Send input after resume → verify agent works

### F5. Error Matrix

- Spawn failure (backend.createSession fails)
- send_input to nonexistent ID → notFound
- wait_agent with invalid UUID → error
- close already-closed → returns shutdown
- Child crash → errored, waiters resolve
- Parent close → children cascade
- Cross-parent access → rejected
- UDS connection failure → extension returns collab_unavailable

### F6. Pre-RPC Failure

- Kill collab UDS, call spawn_agent from Pi extension
- Verify Pi LLM gets error tool result
- Verify no phantom CollabAgentToolCall items on parent thread

---

## Implementation Order (for serial execution)

If working serially rather than in parallel tracks:

1. A1 (types) — foundation for everything
2. A3 (nicknames) — trivial, unblocks A2
3. A2 (CollabManager) — core logic, largest piece
4. B1 + B2 (Pi extension) — can be done anytime after A1
5. D1 + D2 (turn state changes) — small, unblocks E
6. C1 + C2 + C3 (CLI flag + UDS + env vars) — wiring
7. E1 + E2 + E3 + E4 (AppServer integration) — ties everything together
8. F1–F6 (E2E tests) — validation

Estimated total: ~1500–2000 lines of new code across all tracks.
