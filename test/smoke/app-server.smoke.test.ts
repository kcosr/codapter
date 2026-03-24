import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../../packages/core/src/app-server.js";
import {
  type BackendAppServerEvent,
  type BackendModelSummary,
  type IBackend,
  parseBackendModelId,
} from "../../packages/core/src/backend.js";
import { ThreadRegistry } from "../../packages/core/src/thread-registry.js";

const describeIfSmoke = process.env.PI_SMOKE_TEST === "1" ? describe : describe.skip;

class SmokeBackend implements IBackend {
  public readonly backendType = "pi";
  private readonly listeners = new Map<string, Set<(event: BackendAppServerEvent) => void>>();
  public readonly activeTurns = new Map<string, string>();
  private threadCounter = 0;
  public readonly modelChanges: Array<{ threadHandle: string; model: string }> = [];

  async initialize() {}
  async dispose() {}

  isAlive() {
    return true;
  }

  parseModelSelection(model: string | null | undefined) {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed || parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async threadStart(input: {
    threadId: string;
    cwd: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    this.threadCounter += 1;
    const threadHandle = `smoke_thread_${this.threadCounter}`;
    return {
      threadHandle,
      path: `/tmp/${threadHandle}.jsonl`,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadResume(input: {
    threadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    return {
      threadHandle: input.threadHandle,
      path: `/tmp/${input.threadHandle}.jsonl`,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: {
    sourceThreadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    this.threadCounter += 1;
    const threadHandle = `${input.sourceThreadHandle}_fork_${this.threadCounter}`;
    return {
      threadHandle,
      path: `/tmp/${threadHandle}.jsonl`,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadRead(input: { threadHandle: string }) {
    return {
      threadHandle: input.threadHandle,
      title: null,
      model: null,
      turns: [],
    };
  }

  async threadArchive() {}
  async threadSetName() {}

  async turnStart(input: {
    threadId: string;
    threadHandle: string;
    turnId: string;
    input: readonly Array<{ type: string; text?: string }>;
    model: string | null;
  }) {
    const text = input.input
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .join("\n");
    this.activeTurns.set(input.threadHandle, input.turnId);
    if (input.model) {
      this.modelChanges.push({ threadHandle: input.threadHandle, model: input.model });
    }

    queueMicrotask(() => {
      this.emitNotification(input.threadHandle, "turn/started", {
        threadId: input.threadId,
        turnId: input.turnId,
        turn: {
          id: input.turnId,
          items: [],
          status: "inProgress",
          error: null,
        },
      });

      if (text.startsWith("run ")) {
        const command = text.slice(4);
        this.emitNotification(input.threadHandle, "item/completed", {
          threadId: input.threadId,
          turnId: input.turnId,
          item: {
            type: "commandExecution",
            id: `${input.turnId}_cmd`,
            command,
            cwd: "/repo",
            processId: null,
            status: "completed",
            commandActions: [],
            aggregatedOutput: "output",
            exitCode: 0,
            durationMs: 1,
          },
        });
      } else if (text.startsWith("edit ")) {
        this.emitNotification(input.threadHandle, "item/completed", {
          threadId: input.threadId,
          turnId: input.turnId,
          item: {
            type: "fileChange",
            id: `${input.turnId}_file`,
            changes: [{ path: text.slice(5), kind: "update" }],
            status: "completed",
          },
        });
      } else if (text.includes("think")) {
        this.emitNotification(input.threadHandle, "item/reasoning/summaryTextDelta", {
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: `${input.turnId}_reasoning`,
          delta: "reasoning about it",
        });
        this.emitNotification(input.threadHandle, "item/agentMessage/delta", {
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: `${input.turnId}_msg`,
          delta: text,
        });
      } else {
        this.emitNotification(input.threadHandle, "item/agentMessage/delta", {
          threadId: input.threadId,
          turnId: input.turnId,
          itemId: `${input.turnId}_msg`,
          delta: text,
        });
      }

      this.emitNotification(input.threadHandle, "thread/tokenUsage/updated", {
        threadId: input.threadId,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      });
      this.emitNotification(input.threadHandle, "turn/completed", {
        threadId: input.threadId,
        turnId: input.turnId,
        turn: {
          id: input.turnId,
          items: [],
          status: "completed",
          error: null,
        },
      });
    });
    return { accepted: true as const };
  }

  async turnInterrupt(input: { threadId: string; threadHandle: string; turnId: string }) {
    this.emitNotification(input.threadHandle, "turn/completed", {
      threadId: input.threadId,
      turnId: input.turnId,
      turn: {
        id: input.turnId,
        items: [],
        status: "interrupted",
        error: null,
      },
    });
  }

  async resolveServerRequest() {}

  async listModels(): Promise<readonly BackendModelSummary[]> {
    return [
      {
        id: "mock-default",
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
        id: "mock-large",
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

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void) {
    const listeners =
      this.listeners.get(threadHandle) ?? new Set<(event: BackendAppServerEvent) => void>();
    listeners.add(listener);
    this.listeners.set(threadHandle, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  }

  private emitNotification(
    threadHandle: string,
    method: string,
    params: Record<string, unknown>
  ): void {
    const event: BackendAppServerEvent = {
      kind: "notification",
      threadHandle,
      method,
      params,
    };
    for (const listener of this.listeners.get(threadHandle) ?? []) {
      listener(event);
    }
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
  const selectedModel = opts?.model
    ? opts.model.includes("::")
      ? opts.model
      : `pi::${opts.model}`
    : undefined;
  const result = (await connection.handleMessage({
    id: requestId,
    method: "thread/start",
    params: {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      cwd: opts?.cwd ?? "/repo",
      modelProvider: "pi",
      model: selectedModel,
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
  const selectedModel = opts?.model
    ? opts.model.includes("::")
      ? opts.model
      : `pi::${opts.model}`
    : undefined;
  return connection.handleMessage({
    id: requestId,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      model: selectedModel,
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
    // Make turn start hang (no auto-complete) so we can interrupt
    vi.spyOn(backend, "turnStart").mockImplementation(async (input) => {
      backend.activeTurns.set(input.threadHandle, input.turnId);
      return { accepted: true };
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
