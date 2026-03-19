import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../../packages/core/src/app-server.js";
import type { BackendEvent, BackendMessage, IBackend } from "../../packages/core/src/backend.js";
import { ThreadRegistry } from "../../packages/core/src/thread-registry.js";

const describeIfSmoke = process.env.PI_SMOKE_TEST === "1" ? describe : describe.skip;

class SmokeBackend implements IBackend {
  private readonly listeners = new Map<string, Set<(event: BackendEvent) => void>>();
  public readonly activeTurns = new Map<string, string>();
  private sessionCounter = 0;
  public readonly sessionHistories = new Map<string, BackendMessage[]>();
  public readonly modelChanges: Array<{ sessionId: string; model: string }> = [];

  async initialize() {}
  async dispose() {}

  isAlive() {
    return true;
  }

  async createSession() {
    this.sessionCounter += 1;
    return `smoke_session_${this.sessionCounter}`;
  }

  async resumeSession(sessionId: string) {
    return sessionId;
  }

  async forkSession(sessionId: string) {
    this.sessionCounter += 1;
    return `${sessionId}_fork_${this.sessionCounter}`;
  }

  async disposeSession() {}
  async readSessionHistory(sessionId: string) {
    return this.sessionHistories.get(sessionId) ?? [];
  }
  async setSessionName() {}

  async setModel(sessionId: string, model: string) {
    this.modelChanges.push({ sessionId, model });
  }

  async prompt(sessionId: string, turnId: string, text: string) {
    this.activeTurns.set(sessionId, turnId);
    queueMicrotask(() => {
      if (text.startsWith("run ")) {
        this.emitToolTurn(sessionId, turnId, "bash", text.slice(4), "output");
      } else if (text.startsWith("edit ")) {
        this.emitToolTurn(sessionId, turnId, "file_edit", text.slice(5), "ok");
      } else if (text === "elicit") {
        this.emitElicitationTurn(sessionId, turnId);
      } else {
        this.emitTextTurn(sessionId, turnId, text);
      }
    });
  }

  async abort(sessionId: string) {
    const turnId = this.activeTurns.get(sessionId) ?? "unknown";
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId,
    });
  }

  async listModels() {
    return [
      {
        id: "pi/mock-default",
        model: "mock-default",
        displayName: "Mock Default",
        description: "Smoke model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        supportsPersonality: true,
      },
      {
        id: "pi/mock-large",
        model: "mock-large",
        displayName: "Mock Large",
        description: "Large smoke model",
        hidden: false,
        isDefault: false,
        inputModalities: ["text"],
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deep reasoning" },
        ],
        defaultReasoningEffort: "high",
        supportsPersonality: true,
      },
    ];
  }

  async getCapabilities() {
    return {
      requiresAuth: false,
      supportsImages: false,
      supportsThinking: true,
      supportsParallelTools: false,
      supportedToolTypes: [],
    };
  }

  async respondToElicitation(sessionId: string, _requestId: string, _response: unknown) {
    const turnId = this.activeTurns.get(sessionId) ?? "unknown";
    this.emitTokenUsageAndEnd(sessionId, turnId);
  }

  onEvent(sessionId: string, listener: (event: BackendEvent) => void) {
    const listeners = this.listeners.get(sessionId) ?? new Set<(event: BackendEvent) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  }

  private emit(sessionId: string, event: BackendEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }

  private emitTextTurn(sessionId: string, turnId: string, text: string) {
    this.emit(sessionId, {
      type: "thinking_delta",
      sessionId,
      turnId,
      delta: "reasoning about it",
    });
    this.emit(sessionId, {
      type: "text_delta",
      sessionId,
      turnId,
      delta: text,
    });
    this.emitTokenUsageAndEnd(sessionId, turnId);
  }

  private emitToolTurn(
    sessionId: string,
    turnId: string,
    toolName: string,
    command: string,
    output: string
  ) {
    this.emit(sessionId, {
      type: "tool_start",
      sessionId,
      turnId,
      toolCallId: `tool_${turnId}`,
      toolName,
      input: { command },
    });
    this.emit(sessionId, {
      type: "tool_end",
      sessionId,
      turnId,
      toolCallId: `tool_${turnId}`,
      toolName,
      output: { content: [{ type: "text", text: output }] },
      isError: false,
    });
    this.emit(sessionId, {
      type: "text_delta",
      sessionId,
      turnId,
      delta: `Done: ${command}`,
    });
    this.emitTokenUsageAndEnd(sessionId, turnId);
  }

  private emitElicitationTurn(sessionId: string, turnId: string) {
    this.emit(sessionId, {
      type: "text_delta",
      sessionId,
      turnId,
      delta: "need confirmation",
    });
    this.emit(sessionId, {
      type: "elicitation_request",
      sessionId,
      turnId,
      requestId: "smoke-elicit-1",
      payload: {
        type: "extension_ui_request",
        id: "smoke-elicit-1",
        method: "confirm",
        title: "Confirm",
        message: "Proceed?",
      },
    });
  }

  private emitTokenUsageAndEnd(sessionId: string, turnId: string) {
    this.emit(sessionId, {
      type: "token_usage",
      sessionId,
      turnId,
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        total: 30,
        modelContextWindow: 128000,
      },
    });
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId,
    });
  }
}

type NotificationMessage = { method: string; params?: Record<string, unknown> };

async function initConnection(
  backend: SmokeBackend,
  threadRegistry: ThreadRegistry,
  notifications: NotificationMessage[]
): Promise<AppServerConnection> {
  const connection = new AppServerConnection({
    backend,
    threadRegistry,
    onMessage(message) {
      if ("method" in message) {
        notifications.push(message as NotificationMessage);
      }
    },
  });
  await connection.handleMessage({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "codapter-smoke", title: null, version: "0.0.1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  });
  return connection;
}

async function startThread(
  connection: AppServerConnection,
  requestId: number,
  opts?: { model?: string; cwd?: string }
): Promise<string> {
  const result = (await connection.handleMessage({
    id: requestId,
    method: "thread/start",
    params: {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      cwd: opts?.cwd ?? "/repo",
      modelProvider: "pi",
      model: opts?.model,
    },
  })) as { result: { thread: { id: string } } };
  return result.result.thread.id;
}

async function startTurn(
  connection: AppServerConnection,
  requestId: number,
  threadId: string,
  text: string,
  opts?: { model?: string }
): Promise<unknown> {
  return connection.handleMessage({
    id: requestId,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      model: opts?.model,
    },
  });
}

describeIfSmoke("codapter smoke", () => {
  // 1. Basic conversation (2+2)
  it("completes a basic conversation turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      await startTurn(connection, 3, threadId, "what is 2+2?");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(notifications.some((n) => n.method === "turn/started")).toBe(true);
      expect(notifications.some((n) => n.method === "item/agentMessage/delta")).toBe(true);
      expect(notifications.some((n) => n.method === "turn/completed")).toBe(true);
      expect(notifications.some((n) => n.method === "thread/tokenUsage/updated")).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 2. Bash tool call
  it("renders a bash tool call as commandExecution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      await startTurn(connection, 3, threadId, "run date");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const completed = notifications.find(
        (n) => n.method === "item/completed" && n.params?.item?.type === "commandExecution"
      );
      expect(completed).toBeDefined();
      expect(completed?.params?.item?.command).toBe("date");
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 3. File create/edit
  it("renders a file edit tool call as fileChange", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      await startTurn(connection, 3, threadId, "edit main.ts");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const completed = notifications.find(
        (n) => n.method === "item/completed" && n.params?.item?.type === "fileChange"
      );
      expect(completed).toBeDefined();
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 4. Multi-turn context
  it("supports multi-turn context on the same thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);

      await startTurn(connection, 3, threadId, "first message");
      await new Promise((resolve) => setTimeout(resolve, 20));

      await startTurn(connection, 4, threadId, "second message");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const completions = notifications.filter((n) => n.method === "turn/completed");
      expect(completions).toHaveLength(2);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 5. Model switching
  it("switches models between turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const backend = new SmokeBackend();
    const connection = await initConnection(backend, threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2, { model: "mock-default" });

      await startTurn(connection, 3, threadId, "hello", { model: "mock-large" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(backend.modelChanges.some((c) => c.model === "mock-large")).toBe(true);
      expect(notifications.some((n) => n.method === "turn/completed")).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 6. Thinking display
  it("emits reasoning items from thinking deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      await startTurn(connection, 3, threadId, "think about this");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(notifications.some((n) => n.method === "item/reasoning/summaryTextDelta")).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 7. Session persistence
  it("persists and resumes threads across connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const backend = new SmokeBackend();
    const connection1 = await initConnection(backend, threadRegistry, notifications);

    try {
      const threadId = await startThread(connection1, 2);
      await startTurn(connection1, 3, threadId, "remember this");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await connection1.dispose();

      // New connection, same registry
      const notifications2: NotificationMessage[] = [];
      const connection2 = await initConnection(backend, threadRegistry, notifications2);

      const resumed = await connection2.handleMessage({
        id: 10,
        method: "thread/resume",
        params: {
          threadId,
          persistExtendedHistory: false,
        },
      });

      expect(resumed).toMatchObject({
        id: 10,
        result: {
          thread: { id: threadId },
        },
      });
      await connection2.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 8. Interrupt
  it("interrupts an active turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const backend = new SmokeBackend();
    // Make prompt hang (no auto-complete) so we can interrupt
    vi.spyOn(backend, "prompt").mockImplementation(async (sessionId, turnId) => {
      backend.activeTurns.set(sessionId, turnId);
    });
    const connection = await initConnection(backend, threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      const turnResult = (await startTurn(connection, 3, threadId, "long task")) as {
        result: { turn: { id: string } };
      };
      const turnId = turnResult.result.turn.id;

      await connection.handleMessage({
        id: 4,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const statusChanges = notifications.filter((n) => n.method === "thread/status/changed");
      // Should transition to active (turn) then back to idle
      expect(statusChanges.some((n) => n.params?.status?.type === "active")).toBe(true);
      expect(statusChanges.some((n) => n.params?.status?.type === "idle")).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 9. Fork
  it("forks a thread into a new thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId = await startThread(connection, 2);
      await startTurn(connection, 3, threadId, "setup context");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const forkResult = (await connection.handleMessage({
        id: 4,
        method: "thread/fork",
        params: {
          threadId,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      expect(forkResult.result.thread.id).not.toBe(threadId);
      expect(
        notifications.some(
          (n) =>
            n.method === "thread/started" && n.params?.thread?.id === forkResult.result.thread.id
        )
      ).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // 10. Standalone shell
  it("executes adapter-native commands", async () => {
    const connection = new AppServerConnection();

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-smoke", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const response = await connection.handleMessage({
        id: 2,
        method: "command/exec",
        params: {
          command: ["bash", "-lc", "printf smoke"],
        },
      });

      expect(response).toEqual({
        id: 2,
        result: {
          exitCode: 0,
          stdout: "smoke",
          stderr: "",
        },
      });
    } finally {
      await connection.dispose();
    }
  });

  // 11. Thread listing
  it("lists multiple threads in the sidebar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const connection = await initConnection(new SmokeBackend(), threadRegistry, notifications);

    try {
      const threadId1 = await startThread(connection, 2);
      const threadId2 = await startThread(connection, 3);
      const threadId3 = await startThread(connection, 4);

      const listResult = (await connection.handleMessage({
        id: 5,
        method: "thread/list",
        params: {},
      })) as { result: { data: Array<{ id: string }>; nextCursor: string | null } };

      const ids = listResult.result.data.map((t) => t.id);
      expect(ids).toContain(threadId1);
      expect(ids).toContain(threadId2);
      expect(ids).toContain(threadId3);
      expect(listResult.result.data).toHaveLength(3);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
