import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/app-server.js";
import type { BackendEvent, IBackend } from "../src/backend.js";
import { ThreadRegistry } from "../src/thread-registry.js";

class TestBackend implements IBackend {
  private readonly listeners = new Map<string, Set<(event: BackendEvent) => void>>();
  private sessionCounter = 0;

  constructor(
    private readonly onPromptCallback?: (args: {
      sessionId: string;
      turnId: string;
      text: string;
    }) => void | Promise<void>
  ) {}

  async initialize() {}
  async dispose() {}

  isAlive() {
    return true;
  }

  async createSession() {
    this.sessionCounter += 1;
    return `session_${this.sessionCounter}`;
  }

  async resumeSession(sessionId: string) {
    return sessionId;
  }

  async forkSession(sessionId: string) {
    this.sessionCounter += 1;
    return `${sessionId}_fork_${this.sessionCounter}`;
  }

  async disposeSession() {}
  async readSessionHistory() {
    return [];
  }
  async setSessionName() {}

  async prompt(sessionId: string, turnId: string, text: string) {
    await this.onPromptCallback?.({ sessionId, turnId, text });
  }

  async abort(sessionId: string) {
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId: "ignored",
    });
  }

  async listModels() {
    return [
      {
        id: "model_1",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        description: "Fast model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: ["minimal", "medium"],
        defaultReasoningEffort: "medium",
        supportsPersonality: true,
      },
    ];
  }

  async setModel() {}

  async getCapabilities() {
    return {
      requiresAuth: false,
      supportsImages: false,
      supportsThinking: true,
      supportsParallelTools: false,
      supportedToolTypes: [],
    };
  }

  async respondToElicitation() {}

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

  emit(sessionId: string, event: BackendEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }
}

function createBackend(onPromptCallback?: ConstructorParameters<typeof TestBackend>[0]): IBackend {
  return new TestBackend(onPromptCallback);
}

describe("AppServerConnection", () => {
  it("rejects requests before initialize", async () => {
    const connection = new AppServerConnection();
    const response = await connection.handleMessage({
      id: 1,
      method: "config/read",
      params: { includeLayers: false },
    });

    expect(response).toEqual({
      id: 1,
      error: {
        code: -32002,
        message: "Not initialized",
      },
    });
  });

  it("initializes once and rejects a second initialize", async () => {
    const connection = new AppServerConnection();

    const first = await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ["thread/started"] },
      },
    });
    const second = await connection.handleMessage({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    expect(first).toMatchObject({
      id: 1,
      result: {
        userAgent: expect.any(String),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
    expect(second).toEqual({
      id: 2,
      error: {
        code: -32003,
        message: "Already initialized",
      },
    });
    expect(connection.emitNotification("thread/started", { threadId: "thr_1" })).toBeNull();
  });

  it("tracks the initialized client notification", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    expect(connection.initializedNotificationReceived).toBe(false);
    await connection.handleMessage({ method: "initialized" });
    expect(connection.initializedNotificationReceived).toBe(true);
  });

  it("writes config values and reads them back", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const writeResponse = await connection.handleMessage({
      id: 2,
      method: "config/value/write",
      params: {
        keyPath: "model",
        value: "gpt-5.4-mini",
        mergeStrategy: "replace",
        expectedVersion: "1",
      },
    });
    const readResponse = await connection.handleMessage({
      id: 3,
      method: "config/read",
      params: { includeLayers: true },
    });

    expect(writeResponse).toMatchObject({
      id: 2,
      result: {
        status: "ok",
        version: "2",
        filePath: expect.any(String),
      },
    });
    expect(readResponse).toMatchObject({
      id: 3,
      result: {
        config: {
          model: "gpt-5.4-mini",
        },
        layers: [
          {
            version: "2",
          },
        ],
      },
    });
  });

  it("returns model/list data from the backend", async () => {
    const connection = new AppServerConnection({ backend: createBackend() });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = await connection.handleMessage({
      id: 2,
      method: "model/list",
      params: {},
    });

    expect(response).toEqual({
      id: 2,
      result: {
        data: [
          {
            id: "model_1",
            model: "gpt-5.4-mini",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.4 Mini",
            description: "Fast model",
            hidden: false,
            supportedReasoningEfforts: ["minimal", "medium"],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: true,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("returns method-not-found and logs unrecognized methods", async () => {
    const warn = vi.fn();
    const connection = new AppServerConnection({ logger: { warn } });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = await connection.handleMessage({
      id: 2,
      method: "does/not/exist",
      params: { noisy: true },
    });

    expect(response).toEqual({
      id: 2,
      error: {
        code: -32601,
        message: "Method not found: does/not/exist",
      },
    });
    expect(warn).toHaveBeenCalledWith("Unrecognized RPC method", {
      method: "does/not/exist",
      requestId: 2,
      params: '{"noisy":true}',
    });
  });

  it("starts threads, persists them in the registry, and emits notifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: unknown[] = [];
    const connection = new AppServerConnection({
      backend: createBackend(),
      threadRegistry,
      onNotification(notification) {
        notifications.push(notification);
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const started = await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "pi",
        },
      });
      expect(started).toMatchObject({
        id: 2,
        result: {
          thread: {
            id: expect.any(String),
            cwd: "/repo",
            modelProvider: "pi",
            status: { type: "idle" },
          },
        },
      });

      const listed = await connection.handleMessage({
        id: 3,
        method: "thread/list",
        params: {},
      });
      expect(listed).toMatchObject({
        id: 3,
        result: {
          data: [
            {
              id: expect.any(String),
              cwd: "/repo",
            },
          ],
          nextCursor: null,
        },
      });

      expect(notifications).toHaveLength(2);
      expect(notifications[0]).toMatchObject({
        method: "thread/started",
        params: {
          thread: {
            id: expect.any(String),
          },
        },
      });
      expect(notifications[1]).toMatchObject({
        method: "thread/status/changed",
        params: {
          threadId: expect.any(String),
          status: { type: "idle" },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams a full turn lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "thinking_delta",
          sessionId,
          turnId,
          delta: "thinking",
        });
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "hello",
        });
        backend.emit(sessionId, {
          type: "tool_start",
          sessionId,
          turnId,
          toolCallId: "tool_1",
          toolName: "bash",
          input: { command: ["echo", "ok"] },
        });
        backend.emit(sessionId, {
          type: "tool_update",
          sessionId,
          turnId,
          toolCallId: "tool_1",
          toolName: "bash",
          output: { content: [{ type: "text", text: "ok" }] },
          isCumulative: true,
        });
        backend.emit(sessionId, {
          type: "tool_end",
          sessionId,
          turnId,
          toolCallId: "tool_1",
          toolName: "bash",
          output: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        });
        backend.emit(sessionId, {
          type: "token_usage",
          sessionId,
          turnId,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        });
        backend.emit(sessionId, {
          type: "message_end",
          sessionId,
          turnId,
        });
      });
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onNotification(notification) {
        notifications.push(notification);
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const started = (await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "pi",
        },
      })) as { result: { thread: { id: string } } };
      const threadId = started.result.thread.id;

      const response = await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      expect(response).toMatchObject({
        id: 3,
        result: {
          turn: {
            id: expect.any(String),
            status: "inProgress",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const methods = notifications.map((notification) => notification.method);
      expect(methods).toContain("turn/started");
      expect(methods).toContain("item/reasoning/textDelta");
      expect(methods).toContain("item/agentMessage/delta");
      expect(methods).toContain("item/commandExecution/outputDelta");
      expect(methods).toContain("thread/tokenUsage/updated");
      expect(methods).toContain("turn/completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports buffered and streaming command execution", async () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const connection = new AppServerConnection({
      onNotification(notification) {
        notifications.push(notification);
      },
    });

    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const buffered = await connection.handleMessage({
      id: 2,
      method: "command/exec",
      params: {
        command: ["bash", "-lc", "printf hello"],
      },
    });
    expect(buffered).toEqual({
      id: 2,
      result: {
        exitCode: 0,
        stdout: "hello",
        stderr: "",
      },
    });

    const streamingPromise = connection.handleMessage({
      id: 3,
      method: "command/exec",
      params: {
        command: ["bash", "-lc", 'read line; printf "reply:%s" "$line"'],
        processId: "proc_1",
        streamStdin: true,
        streamStdoutStderr: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await connection.handleMessage({
      id: 4,
      method: "command/exec/write",
      params: {
        processId: "proc_1",
        deltaBase64: Buffer.from("world\n", "utf8").toString("base64"),
        closeStdin: true,
      },
    });

    const streaming = await streamingPromise;
    expect(streaming).toEqual({
      id: 3,
      result: {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    });
    expect(
      notifications.some((notification) => notification.method === "command/exec/outputDelta")
    ).toBe(true);
  });
});
