import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/app-server.js";
import type { BackendEvent, BackendMessage, IBackend } from "../src/backend.js";
import { ThreadRegistry } from "../src/thread-registry.js";

class TestBackend implements IBackend {
  private readonly listeners = new Map<string, Set<(event: BackendEvent) => void>>();
  private readonly activeTurns = new Map<string, string>();
  private sessionCounter = 0;
  public readonly sessionHistories = new Map<string, BackendMessage[]>();
  public readonly elicitationResponses: Array<{
    sessionId: string;
    requestId: string;
    response: unknown;
  }> = [];

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
  async readSessionHistory(sessionId: string) {
    return this.sessionHistories.get(sessionId) ?? [];
  }
  async setSessionName() {}

  async prompt(sessionId: string, turnId: string, text: string) {
    this.activeTurns.set(sessionId, turnId);
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
        supportedReasoningEfforts: [
          {
            reasoningEffort: "minimal",
            description: "Fast responses with lighter reasoning",
          },
          {
            reasoningEffort: "medium",
            description: "Balanced reasoning",
          },
        ],
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

  async respondToElicitation(sessionId: string, requestId: string, response: unknown) {
    this.elicitationResponses.push({ sessionId, requestId, response });
    const turnId = this.activeTurns.get(sessionId);
    if (turnId) {
      this.emit(sessionId, {
        type: "message_end",
        sessionId,
        turnId,
      });
    }
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

  emit(sessionId: string, event: BackendEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }
}

function createBackend(onPromptCallback?: ConstructorParameters<typeof TestBackend>[0]): IBackend {
  return new TestBackend(onPromptCallback);
}

function createFakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function callSocket(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const line = lines.find((entry) => entry.trim().length > 0);
      if (!line) {
        return;
      }
      socket.end();
      resolve(JSON.parse(line) as unknown);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
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
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ["thread/started"] },
      },
    });
    const second = await connection.handleMessage({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    expect(connection.initializedNotificationReceived).toBe(false);
    await connection.handleMessage({ method: "initialized" });
    expect(connection.initializedNotificationReceived).toBe(true);
  });

  it("returns an empty account/rateLimits/read snapshot", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = await connection.handleMessage({
      id: 2,
      method: "account/rateLimits/read",
    });

    expect(response).toEqual({
      id: 2,
      result: {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: null,
      },
    });
  });

  it("stores chatgptAuthTokens login state and publishes auth notifications", async () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const connection = new AppServerConnection({
      onMessage(message) {
        notifications.push(message);
      },
    });
    const accessToken = createFakeJwt({
      email: "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-1",
        chatgpt_plan_type: "pro",
      },
    });

    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const login = await connection.handleMessage({
      id: 2,
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken,
        chatgptAccountId: "workspace-1",
        chatgptPlanType: "pro",
      },
    });

    expect(login).toEqual({
      id: 2,
      result: { type: "chatgptAuthTokens" },
    });
    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          method: "account/login/completed",
          params: { loginId: null, success: true, error: null },
        },
        {
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        },
      ])
    );

    await expect(
      connection.handleMessage({
        id: 3,
        method: "account/read",
        params: { refreshToken: false },
      })
    ).resolves.toEqual({
      id: 3,
      result: {
        account: { type: "chatgpt", email: "user@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });

    await expect(
      connection.handleMessage({
        id: 4,
        method: "getAuthStatus",
        params: { includeToken: true, refreshToken: false },
      })
    ).resolves.toEqual({
      id: 4,
      result: {
        authMethod: "chatgpt",
        authToken: accessToken,
        requiresOpenaiAuth: true,
      },
    });

    await expect(
      connection.handleMessage({
        id: 5,
        method: "account/logout",
      })
    ).resolves.toEqual({
      id: 5,
      result: {},
    });

    await expect(
      connection.handleMessage({
        id: 6,
        method: "account/read",
        params: { refreshToken: false },
      })
    ).resolves.toEqual({
      id: 6,
      result: {
        account: null,
        requiresOpenaiAuth: true,
      },
    });

    expect(notifications.at(-1)).toEqual({
      method: "account/updated",
      params: { authMode: null, planType: null },
    });
  });

  it("writes config values and reads them back", async () => {
    const connection = new AppServerConnection();
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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
            supportedReasoningEfforts: [
              {
                reasoningEffort: "minimal",
                description: "Fast responses with lighter reasoning",
              },
              {
                reasoningEffort: "medium",
                description: "Balanced reasoning",
              },
            ],
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

  it("returns empty startup list responses for desktop compatibility", async () => {
    const connection = new AppServerConnection({ backend: createBackend() });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    await expect(
      connection.handleMessage({
        id: 2,
        method: "app/list",
        params: {},
      })
    ).resolves.toEqual({
      id: 2,
      result: {
        data: [],
        nextCursor: null,
      },
    });

    await expect(
      connection.handleMessage({
        id: 3,
        method: "experimentalFeature/list",
        params: {},
      })
    ).resolves.toEqual({
      id: 3,
      result: {
        data: [],
        nextCursor: null,
      },
    });

    await expect(
      connection.handleMessage({
        id: 4,
        method: "collaborationMode/list",
        params: {},
      })
    ).resolves.toEqual({
      id: 4,
      result: {
        data: [],
      },
    });

    await expect(
      connection.handleMessage({
        id: 5,
        method: "mcpServerStatus/list",
        params: {},
      })
    ).resolves.toEqual({
      id: 5,
      result: {
        data: [],
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
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

  it("returns method-not-found for unsupported worktree RPCs", async () => {
    const connection = new AppServerConnection({
      logger: {
        warn() {},
      },
    });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    for (const [index, method] of [
      "create-worktree",
      "delete-worktree",
      "resolve-worktree-for-thread",
      "worktree-cleanup-inputs",
    ].entries()) {
      await expect(
        connection.handleMessage({
          id: index + 2,
          method,
          params: {},
        })
      ).resolves.toEqual({
        id: index + 2,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      });
    }
  });

  it("starts threads, persists them in the registry, and emits notifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: unknown[] = [];
    const connection = new AppServerConnection({
      backend: createBackend(),
      threadRegistry,
      onMessage(message) {
        notifications.push(message);
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "danger-full-access",
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
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "dangerFullAccess" },
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

  it("spawns collab child threads over the internal UDS and exposes them in thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: `done:${text}`,
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
      collabEnabled: true,
      threadRegistry,
      onMessage(message) {
        notifications.push(message as { method: string; params?: Record<string, unknown> });
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      const spawned = (await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "review this",
          agent_type: "worker",
        },
      })) as { result: { agent_id: string; nickname: string } };

      expect(spawned.result.agent_id).toEqual(expect.any(String));
      expect(spawned.result.nickname).toEqual(expect.any(String));

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childStarted = notifications.find(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread &&
          notification.params.thread.id !== started.result.thread.id
      );
      expect(childStarted).toMatchObject({
        method: "thread/started",
        params: {
          thread: {
            source: {
              type: "subAgent",
              subAgent: {
                type: "threadSpawn",
                parentThreadId: started.result.thread.id,
              },
            },
            agentRole: "worker",
          },
        },
      });

      const listed = (await connection.handleMessage({
        id: 4,
        method: "thread/list",
        params: {},
      })) as { id: number; result: { data: Array<Record<string, unknown>> } };
      expect(listed.id).toBe(4);
      expect(listed.result.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: started.result.thread.id,
            source: "appServer",
          }),
          expect.objectContaining({
            source: expect.objectContaining({
              type: "subAgent",
            }),
          }),
        ])
      );

      await expect(
        callSocket(socketPath ?? "", {
          id: 5,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 10,
          },
        })
      ).resolves.toEqual({
        id: 5,
        result: {
          status: {
            [spawned.result.agent_id]: "completed",
          },
          timed_out: false,
        },
      });

      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.item?.type === "collabAgentToolCall" &&
            notification.params.item.tool === "spawnAgent"
        )
      ).toBeTruthy();
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.item?.type === "collabAgentToolCall" &&
            notification.params.item.tool === "wait"
        )
      ).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("manages collab child close, resume, and send_input lifecycle over the internal UDS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-lifecycle-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const prompts: Array<{ sessionId: string; turnId: string; text: string }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      prompts.push({ sessionId, turnId, text });
      if (text !== "after resume") {
        return;
      }
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: `done:${text}`,
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
      collabEnabled: true,
      threadRegistry,
      onMessage(message) {
        notifications.push(message as { method: string; params?: Record<string, unknown> });
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      const spawned = (await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "initial task",
          agent_type: "worker",
        },
      })) as { result: { agent_id: string } };

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childStarted = notifications.find(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread &&
          notification.params.thread.id !== started.result.thread.id
      ) as { params: { thread: { id: string } } } | undefined;
      expect(childStarted).toBeDefined();
      const childThreadId = childStarted?.params.thread.id ?? "";

      const childRead = (await connection.handleMessage({
        id: 4,
        method: "thread/read",
        params: {
          threadId: childThreadId,
          includeTurns: false,
        },
      })) as { result: { thread: { status: { type: string }; source: { type: string } } } };
      expect(childRead.result.thread.status).toEqual({ type: "active", activeFlags: ["turn"] });
      expect(childRead.result.thread.source).toMatchObject({ type: "subAgent" });

      await expect(
        connection.handleMessage({
          id: 5,
          method: "turn/start",
          params: {
            threadId: childThreadId,
            input: [{ type: "text", text: "illegal", text_elements: [] }],
          },
        })
      ).resolves.toMatchObject({
        id: 5,
        error: {
          message: expect.stringContaining("send_input"),
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 6,
          method: "collab/close",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
          },
        })
      ).resolves.toEqual({
        id: 6,
        result: {
          previous_status: "running",
        },
      });

      const childAfterClose = (await connection.handleMessage({
        id: 7,
        method: "thread/read",
        params: {
          threadId: childThreadId,
          includeTurns: false,
        },
      })) as { result: { thread: { status: { type: string } } } };
      expect(childAfterClose.result.thread.status).toEqual({ type: "idle" });

      await expect(
        callSocket(socketPath ?? "", {
          id: 8,
          method: "collab/resume",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
          },
        })
      ).resolves.toEqual({
        id: 8,
        result: {
          status: "running",
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 9,
          method: "collab/sendInput",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
            message: "after resume",
          },
        })
      ).resolves.toMatchObject({
        id: 9,
        result: {
          submission_id: expect.any(String),
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 10,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 50,
          },
        })
      ).resolves.toEqual({
        id: 10,
        result: {
          status: {
            [spawned.result.agent_id]: "completed",
          },
          timed_out: false,
        },
      });

      expect(prompts.map((prompt) => prompt.text)).toEqual(["initial task", "after resume"]);
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.item?.type === "collabAgentToolCall" &&
            notification.params.item.tool === "resumeAgent"
        )
      ).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("cascades collab child shutdown when the parent thread is archived", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-archive-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(async () => {});
    const connection = new AppServerConnection({
      backend,
      collabEnabled: true,
      threadRegistry,
      onMessage(message) {
        notifications.push(message as { method: string; params?: Record<string, unknown> });
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "long running",
          agent_type: "worker",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childStarted = notifications.find(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread &&
          notification.params.thread.id !== started.result.thread.id
      ) as { params: { thread: { id: string } } } | undefined;
      expect(childStarted).toBeDefined();
      const childThreadId = childStarted?.params.thread.id ?? "";

      const subAgents = (await connection.handleMessage({
        id: 4,
        method: "thread/list",
        params: { sourceKinds: ["subAgent"] },
      })) as { result: { data: Array<{ id: string; source: { type: string } }> } };
      expect(subAgents.result.data).toEqual([
        expect.objectContaining({
          id: childThreadId,
          source: expect.objectContaining({ type: "subAgent" }),
        }),
      ]);

      await expect(
        connection.handleMessage({
          id: 5,
          method: "thread/archive",
          params: { threadId: started.result.thread.id },
        })
      ).resolves.toEqual({
        id: 5,
        result: {},
      });

      const childRead = (await connection.handleMessage({
        id: 6,
        method: "thread/read",
        params: {
          threadId: childThreadId,
          includeTurns: false,
        },
      })) as {
        result: {
          thread: {
            status: { type: string };
            source: { type: string; subAgent: { parentThreadId: string } };
          };
        };
      };
      expect(childRead.result.thread.status).toEqual({ type: "idle" });
      expect(childRead.result.thread.source).toMatchObject({
        type: "subAgent",
        subAgent: {
          parentThreadId: started.result.thread.id,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("interrupts the active collab child turn before starting a replacement turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-interrupt-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const prompts: string[] = [];
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      prompts.push(text);
      if (text !== "replacement task") {
        return;
      }
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "done",
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
      collabEnabled: true,
      threadRegistry,
      onMessage(message) {
        notifications.push(message as { method: string; params?: Record<string, unknown> });
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      const spawned = (await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "long running task",
          agent_type: "worker",
        },
      })) as { result: { agent_id: string } };

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childStarted = notifications.find(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread &&
          notification.params.thread.id !== started.result.thread.id
      ) as { params: { thread: { id: string } } } | undefined;
      expect(childStarted).toBeDefined();
      const childThreadId = childStarted?.params.thread.id ?? "";

      await expect(
        callSocket(socketPath ?? "", {
          id: 4,
          method: "collab/sendInput",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
            message: "replacement task",
            interrupt: true,
          },
        })
      ).resolves.toMatchObject({
        id: 4,
        result: {
          submission_id: expect.any(String),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(prompts).toEqual(["long running task", "replacement task"]);
      expect(
        notifications.find(
          (notification) =>
            notification.method === "turn/completed" &&
            notification.params?.threadId === childThreadId &&
            notification.params.turn?.status === "interrupted"
        )
      ).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
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
          type: "message_end",
          sessionId,
          turnId,
        });
        setTimeout(() => {
          backend.emit(sessionId, {
            type: "token_usage",
            sessionId,
            turnId,
            usage: {
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              total: 10,
              modelContextWindow: 272000,
            },
          });
        }, 0);
      });
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage(message) {
        notifications.push(message);
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      await new Promise((resolve) => setTimeout(resolve, 30));

      const methods = notifications.map((notification) => notification.method);
      expect(methods).toContain("turn/started");
      expect(methods).toContain("item/reasoning/summaryTextDelta");
      expect(methods).toContain("item/agentMessage/delta");
      expect(methods).toContain("item/commandExecution/outputDelta");
      expect(methods).toContain("thread/tokenUsage/updated");
      expect(methods).toContain("turn/completed");
      expect(methods.indexOf("thread/tokenUsage/updated")).toBeGreaterThan(
        methods.indexOf("turn/completed")
      );
      expect(
        notifications.find((notification) => notification.method === "thread/tokenUsage/updated")
      ).toMatchObject({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          tokenUsage: {
            modelContextWindow: 272000,
            last: {
              inputTokens: 1,
              outputTokens: 2,
              cachedInputTokens: 3,
              cachedOutputTokens: 4,
              totalTokens: 10,
            },
          },
        },
      });
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.item?.type === "commandExecution"
        )
      ).toMatchObject({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            aggregatedOutput: "ok",
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves backend event order when item startup notifications are slow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "`",
        });
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "date",
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
      onMessage: async (message) => {
        if ("method" in message && message.method === "item/started") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if ("method" in message) {
          notifications.push(message as { method: string; params?: Record<string, unknown> });
        }
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "run date", text_elements: [] }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const agentItemStartedIndex = notifications.findIndex(
        (notification) =>
          notification.method === "item/started" &&
          notification.params?.item?.type === "agentMessage"
      );
      const deltaNotifications = notifications.filter(
        (notification) => notification.method === "item/agentMessage/delta"
      );
      const firstDeltaIndex = notifications.findIndex(
        (notification) => notification.method === "item/agentMessage/delta"
      );

      expect(agentItemStartedIndex).toBeGreaterThan(-1);
      expect(firstDeltaIndex).toBeGreaterThan(agentItemStartedIndex);
      expect(deltaNotifications.map((notification) => notification.params?.delta)).toEqual([
        "`",
        "date",
      ]);
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.item?.type === "agentMessage"
        )
      ).toMatchObject({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: "`date",
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hides internal title-generator threads from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backend: createBackend(),
      threadRegistry,
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [
            {
              type: "text",
              text: "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task.\nGenerate a concise UI title.\nUser prompt: hi",
              text_elements: [],
            },
          ],
        },
      });

      await expect(
        connection.handleMessage({
          id: 4,
          method: "thread/list",
          params: {},
        })
      ).resolves.toEqual({
        id: 4,
        result: {
          data: [],
          nextCursor: null,
        },
      });

      expect(await threadRegistry.get(started.result.thread.id)).toMatchObject({
        hidden: true,
        preview: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconstructs structured history for resumed threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend();
    const entry = await threadRegistry.create({
      backendSessionId: "session_1",
      backendType: "pi",
      cwd: "/repo",
      preview: "run pwd",
      modelProvider: "pi",
      gitInfo: null,
    });
    backend.sessionHistories.set("session_1", [
      {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "run pwd" }],
        createdAt: new Date().toISOString(),
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "**Identifying need for bash command execution**",
          },
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
        createdAt: new Date().toISOString(),
      },
      {
        id: "tool-result-1",
        role: "toolResult",
        content: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          content: [{ type: "text", text: "/home/kevin\n" }],
          isError: false,
        },
        createdAt: new Date().toISOString(),
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: [{ type: "text", text: "`pwd` -> `/home/kevin`" }],
        createdAt: new Date().toISOString(),
      },
    ]);
    const connection = new AppServerConnection({
      backend,
      threadRegistry,
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const resumed = await connection.handleMessage({
        id: 2,
        method: "thread/resume",
        params: {
          threadId: entry.threadId,
          persistExtendedHistory: false,
        },
      });

      expect(resumed).toMatchObject({
        id: 2,
        result: {
          thread: {
            id: entry.threadId,
            turns: [
              {
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "run pwd" }],
                  },
                  {
                    type: "reasoning",
                    summary: ["**Identifying need for bash command execution**"],
                  },
                  {
                    type: "commandExecution",
                    command: "pwd",
                    cwd: "/repo",
                    status: "completed",
                    aggregatedOutput: "/home/kevin\n",
                    exitCode: 0,
                  },
                  {
                    type: "agentMessage",
                    text: "`pwd` -> `/home/kevin`",
                  },
                ],
              },
            ],
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("supports buffered and streaming command execution", async () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const connection = new AppServerConnection({
      onMessage(message) {
        notifications.push(message);
      },
    });

    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

  it("writes upstream backend events and emitted notifications to a file log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-upstream-log-"));
    const logFilePath = join(directory, "upstream.jsonl");
    const backend = new TestBackend(async ({ sessionId, turnId }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "hello from pi",
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
      debugLogFilePath: logFilePath,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      await connection.dispose();
      const lines = (await readFile(logFilePath, "utf8")).trim().split("\n");
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(
        records.some(
          (record) =>
            record.kind === "backend-event" &&
            record.eventType === "text_delta" &&
            record.accepted === true
        )
      ).toBe(true);
      expect(
        records.some(
          (record) => record.kind === "notification" && record.method === "item/agentMessage/delta"
        )
      ).toBe(true);
      expect(
        records.some((record) => record.component === "app-server" && record.kind === "startup")
      ).toBe(true);
      expect(
        records.some((record) => record.component === "app-server" && record.kind === "shutdown")
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported tty command execution", async () => {
    const connection = new AppServerConnection();

    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    await expect(
      connection.handleMessage({
        id: 2,
        method: "command/exec",
        params: {
          command: ["bash"],
          tty: true,
          processId: "tty_proc",
          size: { cols: 80, rows: 24 },
        },
      })
    ).resolves.toEqual({
      id: 2,
      error: {
        code: -32603,
        message: "TTY command/exec requests are not supported",
      },
    });
  });

  it("round-trips Pi elicitation through item/tool/requestUserInput", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const outgoing: Array<{ id?: string | number; method: string; params?: unknown }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "elicitation_request",
          sessionId,
          turnId,
          requestId: "pi-request-1",
          payload: {
            type: "extension_ui_request",
            id: "pi-request-1",
            method: "confirm",
            title: "Confirm",
            message: "Proceed?",
          },
        });
      });
    });
    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage(message) {
        if ("method" in message) {
          outgoing.push(message);
        }
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const request = outgoing.find((message) => message.method === "item/tool/requestUserInput") as
        | { id: string | number; params: { questions: Array<{ id: string }> } }
        | undefined;
      expect(request).toBeDefined();

      const questionId = request?.params.questions[0]?.id;
      await connection.handleMessage({
        id: request?.id ?? "missing",
        result: {
          answers: {
            [questionId ?? "confirmed"]: {
              answers: ["Yes"],
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(backend.elicitationResponses).toEqual([
        {
          sessionId: "session_1",
          requestId: "pi-request-1",
          response: { confirmed: true },
        },
      ]);
      expect(outgoing.some((message) => message.method === "serverRequest/resolved")).toBe(true);
      expect(outgoing.some((message) => message.method === "turn/completed")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("buffers turn/start during starting state and executes after ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    let resolveResume!: () => void;
    const backend = new TestBackend();
    const originalResume = backend.resumeSession.bind(backend);
    vi.spyOn(backend, "resumeSession").mockImplementation(async (sessionId: string) => {
      await new Promise<void>((resolve) => {
        resolveResume = resolve;
      });
      return originalResume(sessionId);
    });

    const entry = await threadRegistry.create({
      backendSessionId: "session_1",
      backendType: "pi",
      cwd: "/repo",
      preview: "hello",
      modelProvider: "pi",
      gitInfo: null,
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      // Start resume (blocks on slow resumeSession)
      const resumePromise = connection.handleMessage({
        id: 2,
        method: "thread/resume",
        params: {
          threadId: entry.threadId,
          persistExtendedHistory: false,
        },
      });

      // Give the resume handler time to enter starting state
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send turn/start while thread is still starting — should buffer
      const turnPromise = connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: entry.threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      // Unblock the resume
      resolveResume();

      const [resumed, turnStarted] = await Promise.all([resumePromise, turnPromise]);

      expect(resumed).toMatchObject({
        id: 2,
        result: {
          thread: { id: entry.threadId },
        },
      });

      expect(turnStarted).toMatchObject({
        id: 3,
        result: {
          turn: {
            id: expect.any(String),
            status: "inProgress",
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects turn/start during forking state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    let resolveFork!: () => void;
    const backend = new TestBackend();
    const originalFork = backend.forkSession.bind(backend);
    vi.spyOn(backend, "forkSession").mockImplementation(async (sessionId: string) => {
      await new Promise<void>((resolve) => {
        resolveFork = resolve;
      });
      return originalFork(sessionId);
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      // Start fork (blocks on slow forkSession)
      const forkPromise = connection.handleMessage({
        id: 3,
        method: "thread/fork",
        params: {
          threadId,
          persistExtendedHistory: false,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // turn/start on the source thread during forking should fail
      const turnResult = await connection.handleMessage({
        id: 4,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      expect(turnResult).toMatchObject({
        id: 4,
        error: {
          code: -32603,
          message: expect.stringContaining("forking"),
        },
      });

      resolveFork();
      await forkPromise;
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects turn/start during terminating state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    let resolveDispose!: () => void;
    const backend = new TestBackend();
    vi.spyOn(backend, "disposeSession").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveDispose = resolve;
      });
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
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

      // Start archive (blocks on slow disposeSession — sets terminating state)
      const archivePromise = connection.handleMessage({
        id: 3,
        method: "thread/archive",
        params: { threadId },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // turn/start during terminating should fail
      const turnResult = await connection.handleMessage({
        id: 4,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      expect(turnResult).toMatchObject({
        id: 4,
        error: {
          code: -32603,
          message: expect.stringContaining("terminating"),
        },
      });

      resolveDispose();
      await archivePromise;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("unblocks buffered turn/start with an error when resume fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    let rejectResume!: (error: Error) => void;
    const backend = new TestBackend();
    vi.spyOn(backend, "resumeSession").mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectResume = reject;
        })
    );

    const entry = await threadRegistry.create({
      backendSessionId: "session_1",
      backendType: "pi",
      cwd: "/repo",
      preview: "hello",
      modelProvider: "pi",
      gitInfo: null,
    });

    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      // Start resume (will fail)
      const resumePromise = connection.handleMessage({
        id: 2,
        method: "thread/resume",
        params: {
          threadId: entry.threadId,
          persistExtendedHistory: false,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send turn/start while thread is starting — will buffer
      const turnPromise = connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: entry.threadId,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      // Now reject the resume — unblocks the buffered turn/start
      rejectResume(new Error("backend unavailable"));

      const [resumed, turnResult] = await Promise.all([resumePromise, turnPromise]);

      // Resume returns the backend error
      expect(resumed).toMatchObject({
        id: 2,
        error: {
          code: -32603,
          message: "backend unavailable",
        },
      });

      // Buffered turn/start gets unblocked with an error
      expect(turnResult).toMatchObject({
        id: 3,
        error: {
          code: -32603,
          message: expect.stringContaining("not ready"),
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs state transitions to the debug log file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-state-log-"));
    const logFilePath = join(directory, "debug.jsonl");
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend();
    const connection = new AppServerConnection({
      backend,
      threadRegistry,
      debugLogFilePath: logFilePath,
      onMessage() {},
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "pi",
        },
      });

      await connection.dispose();

      const lines = (await readFile(logFilePath, "utf8")).trim().split("\n");
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const transitions = records.filter((r) => r.kind === "state-transition");

      expect(transitions.length).toBeGreaterThanOrEqual(2);
      expect(transitions[0]).toMatchObject({
        kind: "state-transition",
        payload: { from: "none", to: "starting" },
      });
      expect(transitions[1]).toMatchObject({
        kind: "state-transition",
        payload: { from: "starting", to: "ready" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
