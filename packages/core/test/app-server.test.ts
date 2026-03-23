import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/app-server.js";
import { BackendRouter } from "../src/backend-router.js";
import { parseBackendModelId } from "../src/backend.js";
import type {
  BackendAppServerEvent,
  BackendEvent,
  BackendMessage,
  IBackend,
} from "../src/backend.js";
import { InMemoryConfigStore } from "../src/config-store.js";
import { ThreadRegistry } from "../src/thread-registry.js";
import { TurnStateMachine, toThreadTokenUsage } from "../src/turn-state.js";

class TestBackend implements IBackend {
  public readonly backendType = "pi";
  private readonly listeners = new Map<string, Set<(event: BackendAppServerEvent) => void>>();
  private readonly machines = new Map<string, TurnStateMachine>();
  private readonly eventPipelines = new Map<string, Promise<void>>();
  private readonly threadIdsBySession = new Map<string, string>();
  private readonly activeTurns = new Map<string, string>();
  private sessionCounter = 0;
  public readonly sessionHistories = new Map<string, BackendMessage[]>();
  public readonly elicitationResponses: Array<{
    sessionId: string;
    requestId: string;
    response: unknown;
  }> = [];
  public readonly setModelCalls: Array<{ sessionId: string; modelId: string }> = [];

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

  parseModelSelection(model: string | null | undefined) {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed) {
      return null;
    }
    return parsed.backendType === this.backendType ? parsed : null;
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
  async getSessionPath(sessionId: string) {
    return `/sessions/${sessionId}.jsonl`;
  }

  async prompt(sessionId: string, turnId: string, text: string) {
    this.activeTurns.set(sessionId, turnId);
    await this.onPromptCallback?.({ sessionId, turnId, text });
  }

  async abort(sessionId: string) {
    const turnId = this.activeTurns.get(sessionId) ?? "ignored";
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId,
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

  async setModel(sessionId: string, modelId: string) {
    this.setModelCalls.push({ sessionId, modelId });
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

  async threadStart(input: {
    threadId: string;
    cwd: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    const sessionId = await this.createSession();
    this.threadIdsBySession.set(sessionId, input.threadId);
    if (input.model) {
      await this.setModel(sessionId, input.model);
    }
    return {
      threadHandle: sessionId,
      path: await this.getSessionPath(sessionId),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadResume(input: {
    threadId: string;
    threadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    const sessionId = await this.resumeSession(input.threadHandle);
    this.threadIdsBySession.set(sessionId, input.threadId);
    if (input.model) {
      await this.setModel(sessionId, input.model);
    }
    return {
      threadHandle: sessionId,
      path: await this.getSessionPath(sessionId),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: {
    threadId: string;
    sourceThreadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    const sessionId = await this.forkSession(input.sourceThreadHandle);
    this.threadIdsBySession.set(sessionId, input.threadId);
    if (input.model) {
      await this.setModel(sessionId, input.model);
    }
    return {
      threadHandle: sessionId,
      path: await this.getSessionPath(sessionId),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadRead(input: { threadHandle: string; includeTurns: boolean }) {
    const history = await this.readSessionHistory(input.threadHandle);
    const turns = input.includeTurns ? historyToTurns(history, "/repo") : [];
    return {
      threadHandle: input.threadHandle,
      title: null,
      model: null,
      turns,
    };
  }

  async threadArchive(input: { threadHandle: string }) {
    await this.disposeSession(input.threadHandle);
  }

  async threadSetName(input: { threadHandle: string; name: string }) {
    await this.setSessionName(input.threadHandle, input.name);
  }

  async turnStart(input: {
    threadId: string;
    threadHandle: string;
    turnId: string;
    cwd: string;
    input: Array<{ type: string; text?: string }>;
    model?: string | null;
  }) {
    this.threadIdsBySession.set(input.threadHandle, input.threadId);
    if (input.model) {
      await this.setModel(input.threadHandle, input.model);
    }
    const machine = new TurnStateMachine(input.threadId, input.turnId, input.cwd, {
      notify: async (method, params) => {
        this.dispatchEvent(input.threadHandle, {
          kind: "notification",
          threadHandle: input.threadHandle,
          method,
          params,
        });
      },
    });
    this.machines.set(input.threadHandle, machine);
    await machine.emitStarted();
    await machine.emitUserMessage(
      input.input.map((entry) => ({ type: "text", text: entry.text ?? "" }))
    );
    const text = input.input
      .filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text ?? "")
      .join("\n");
    await this.prompt(input.threadHandle, input.turnId, text);
    return { accepted: true as const };
  }

  async turnInterrupt(input: { threadHandle: string; turnId: string }) {
    await this.abort(input.threadHandle);
    const machine = this.machines.get(input.threadHandle);
    if (machine) {
      await machine.interrupt();
      this.machines.delete(input.threadHandle);
    }
    if (this.activeTurns.get(input.threadHandle) === input.turnId) {
      this.activeTurns.delete(input.threadHandle);
    }
  }

  async resolveServerRequest(input: {
    threadHandle: string;
    requestId: string | number;
    response: unknown;
  }) {
    await this.respondToElicitation(input.threadHandle, String(input.requestId), input.response);
  }

  onEvent(sessionId: string, listener: (event: BackendAppServerEvent) => void) {
    const listeners =
      this.listeners.get(sessionId) ?? new Set<(event: BackendAppServerEvent) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  }

  emit(sessionId: string, event: BackendEvent) {
    if (event.type === "token_usage") {
      this.dispatchEvent(sessionId, {
        kind: "notification",
        threadHandle: sessionId,
        method: "thread/tokenUsage/updated",
        params: {
          threadId: this.threadIdsBySession.get(sessionId) ?? sessionId,
          turnId: event.turnId,
          tokenUsage: toThreadTokenUsage(event.usage),
        },
      });
      return;
    }

    if (event.type === "elicitation_request") {
      this.dispatchEvent(sessionId, {
        kind: "serverRequest",
        threadHandle: sessionId,
        requestId: event.requestId,
        method: "item/tool/requestUserInput",
        params:
          isRecord(event.payload) && "threadId" in event.payload
            ? event.payload
            : {
                threadId: this.threadIdsBySession.get(sessionId) ?? sessionId,
                turnId: event.turnId,
                itemId: event.requestId,
                questions: [
                  {
                    id: "value",
                    header: "Input required",
                    question: "Input required",
                    isOther: true,
                    isSecret: false,
                    options: null,
                  },
                ],
              },
      });
      return;
    }

    const machine = this.machines.get(sessionId);
    if (!machine) {
      return;
    }
    const previous = this.eventPipelines.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const turn = await machine.handleEvent(event);
      if (turn) {
        this.machines.delete(sessionId);
      }
    });
    this.eventPipelines.set(
      sessionId,
      next
        .catch(() => {})
        .finally(() => {
          if (this.eventPipelines.get(sessionId) === next) {
            this.eventPipelines.delete(sessionId);
          }
        })
    );
  }

  private dispatchEvent(sessionId: string, event: BackendAppServerEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }
}

function createBackend(onPromptCallback?: ConstructorParameters<typeof TestBackend>[0]): IBackend {
  return new TestBackend(onPromptCallback);
}

class CodexProxyTestBackend implements IBackend {
  public readonly backendType = "codex";
  private readonly listeners = new Map<string, Set<(event: BackendAppServerEvent) => void>>();
  public readonly threadStartCalls: Array<{ model: string | null; threadId: string }> = [];
  public readonly resolvedServerRequests: Array<{ requestId: string | number; response: unknown }> =
    [];

  async initialize() {}
  async dispose() {}

  isAlive() {
    return true;
  }

  async listModels() {
    return [
      {
        id: "gpt-5.4-mini",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        description: "Codex test model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: [
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

  parseModelSelection(model: string | null | undefined) {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    return parsed?.backendType === this.backendType ? parsed : null;
  }

  async threadStart(input: { threadId: string; model: string | null }) {
    this.threadStartCalls.push({ threadId: input.threadId, model: input.model });
    return {
      threadHandle: "codex_thread_handle",
      path: "/tmp/codex-thread.jsonl",
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadResume(input: { threadHandle: string; model: string | null }) {
    return {
      threadHandle: input.threadHandle,
      path: "/tmp/codex-thread.jsonl",
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadFork(input: { sourceThreadHandle: string; model: string | null }) {
    return {
      threadHandle: `${input.sourceThreadHandle}_fork`,
      path: "/tmp/codex-thread-fork.jsonl",
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadRead(input: { threadHandle: string }) {
    return {
      threadHandle: input.threadHandle,
      title: null,
      model: "gpt-5.4-mini",
      turns: [],
    };
  }

  async threadArchive() {}
  async threadSetName() {}

  async turnStart() {
    return {
      accepted: true as const,
      turnId: "turn_backend",
    };
  }

  async turnInterrupt() {}

  async resolveServerRequest(input: { requestId: string | number; response: unknown }) {
    this.resolvedServerRequests.push({
      requestId: input.requestId,
      response: input.response,
    });
  }

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void) {
    const listeners = this.listeners.get(threadHandle) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadHandle, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.listeners.delete(threadHandle);
        }
      },
    };
  }

  emit(threadHandle: string, event: BackendAppServerEvent) {
    for (const listener of this.listeners.get(threadHandle) ?? []) {
      listener(event);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!isRecord(entry)) {
          return typeof entry === "string" ? entry : "";
        }
        if (entry.type === "text" && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .join("");
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    return textFromContent(value.content);
  }
  return "";
}

function inferToolCommand(input: unknown): string {
  if (!isRecord(input)) {
    return "";
  }
  if (typeof input.command === "string") {
    return input.command;
  }
  if (Array.isArray(input.command)) {
    return input.command.filter((entry): entry is string => typeof entry === "string").join(" ");
  }
  return "";
}

function historyToTurns(history: readonly BackendMessage[], cwd: string) {
  const turns: Array<{
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  }> = [];
  let currentTurn: {
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  } | null = null;
  const pendingToolItems = new Map<string, Record<string, unknown>>();

  const ensureTurn = (fallbackId: string) => {
    if (currentTurn) {
      return currentTurn;
    }
    currentTurn = {
      id: fallbackId,
      items: [],
      status: "completed",
      error: null,
    };
    turns.push(currentTurn);
    pendingToolItems.clear();
    return currentTurn;
  };

  const finalizeTurn = () => {
    for (const pending of pendingToolItems.values()) {
      if (pending.type === "commandExecution" && pending.status === "inProgress") {
        pending.status = "completed";
        pending.exitCode = pending.exitCode ?? 0;
        pending.durationMs = pending.durationMs ?? 0;
      }
    }
    pendingToolItems.clear();
    currentTurn = null;
  };

  for (const message of history) {
    if (message.role === "user") {
      finalizeTurn();
      const turn = ensureTurn(message.id);
      turn.items.push({
        type: "userMessage",
        id: `${message.id}_user`,
        content: [{ type: "text", text: textFromContent(message.content) }],
      });
      continue;
    }

    const turn = ensureTurn(message.id);
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      for (const [index, block] of blocks.entries()) {
        if (!isRecord(block)) {
          const text = textFromContent(block);
          if (text.length > 0) {
            turn.items.push({
              type: "agentMessage",
              id: `${message.id}_agent_${index}`,
              text,
              phase: null,
            });
          }
          continue;
        }

        if (block.type === "thinking" && typeof block.thinking === "string") {
          turn.items.push({
            type: "reasoning",
            id: `${message.id}_reasoning_${index}`,
            summary: [block.thinking],
            content: [],
          });
          continue;
        }

        if (block.type === "toolCall") {
          const toolCallId =
            typeof block.id === "string" && block.id.length > 0
              ? block.id
              : `${message.id}_tool_${index}`;
          const commandItem: Record<string, unknown> = {
            type: "commandExecution",
            id: `${message.id}_tool_${index}`,
            command: inferToolCommand(block.arguments),
            cwd,
            processId: null,
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          turn.items.push(commandItem);
          pendingToolItems.set(toolCallId, commandItem);
          continue;
        }

        const text = textFromContent(block);
        if (text.length > 0) {
          turn.items.push({
            type: "agentMessage",
            id: `${message.id}_agent_${index}`,
            text,
            phase: null,
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const payload = isRecord(message.content) ? message.content : {};
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      const pending = toolCallId ? pendingToolItems.get(toolCallId) : null;
      const outputText = textFromContent(payload.content);
      if (pending) {
        pending.aggregatedOutput = outputText || null;
        pending.status = payload.isError ? "failed" : "completed";
        pending.exitCode = payload.isError ? 1 : 0;
        pending.durationMs = 0;
        if (toolCallId) {
          pendingToolItems.delete(toolCallId);
        }
      }
      continue;
    }

    const text = textFromContent(message.content);
    if (text.length > 0) {
      turn.items.push({
        type: "agentMessage",
        id: `${message.id}_agent`,
        text,
        phase: null,
      });
    }
  }

  finalizeTurn();
  return turns;
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
        value: "pi::gpt-5.4-mini",
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
          model: "pi::gpt-5.4-mini",
        },
        layers: [
          {
            version: "2",
          },
        ],
      },
    });
  });

  it("uses persisted config model for thread start and resume when request model is omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-config-"));
    const configPath = join(directory, "config.toml");
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const configStore = new InMemoryConfigStore(configPath);
    configStore.writeBatch({
      edits: [
        {
          keyPath: "model",
          value: "pi::openai-codex/gpt-5.4",
          mergeStrategy: "upsert",
        },
        {
          keyPath: "model_reasoning_effort",
          value: "medium",
          mergeStrategy: "upsert",
        },
      ],
      filePath: null,
      expectedVersion: null,
    });

    const backend = new TestBackend();
    const firstConnection = new AppServerConnection({
      backend,
      configStore,
      threadRegistry,
    });

    try {
      await firstConnection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const started = (await firstConnection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          cwd: "/tmp",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { id: number; result: ThreadStartResponse };

      expect(started.result.model).toBe("pi::openai-codex/gpt-5.4");
      expect(started.result.reasoningEffort).toBe("medium");
      expect(backend.setModelCalls).toContainEqual({
        sessionId: "session_1",
        modelId: "openai-codex/gpt-5.4",
      });

      await firstConnection.dispose();

      const resumedBackend = new TestBackend();
      const resumedConnection = new AppServerConnection({
        backend: resumedBackend,
        configStore: new InMemoryConfigStore(configPath),
        threadRegistry,
      });

      try {
        await resumedConnection.handleMessage({
          id: 3,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        });

        const resumed = (await resumedConnection.handleMessage({
          id: 4,
          method: "thread/resume",
          params: {
            threadId: started.result.thread.id,
            history: null,
            path: started.result.thread.path,
            model: null,
            modelProvider: null,
            serviceTier: null,
            cwd: "/tmp",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            config: {},
            baseInstructions: null,
            developerInstructions: null,
            personality: null,
            persistExtendedHistory: false,
          },
        })) as { id: number; result: ThreadResumeResponse };

        expect(resumed.result.model).toBe("pi::openai-codex/gpt-5.4");
        expect(resumed.result.reasoningEffort).toBe("medium");
        expect(resumedBackend.setModelCalls).toContainEqual({
          sessionId: "session_1",
          modelId: "openai-codex/gpt-5.4",
        });
      } finally {
        await resumedConnection.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses collaborationMode.settings.model for turn/start when model is omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-turn-model-"));
    const backend = new TestBackend();
    const connection = new AppServerConnection({
      backend,
      threadRegistry: new ThreadRegistry(join(directory, "threads.json")),
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
          model: "pi::anthropic/claude-opus-4-6",
          cwd: "/tmp",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { id: number; result: ThreadStartResponse };

      expect(started.result.thread.id).toEqual(expect.any(String));

      backend.setModelCalls.length = 0;

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "what model are you" }],
          cwd: "/tmp",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/tmp"],
            readOnlyAccess: { type: "fullAccess" },
            networkAccess: false,
            excludeSlashTmp: false,
            excludeTmpdirEnvVar: false,
          },
          model: null,
          serviceTier: null,
          effort: null,
          summary: "none",
          personality: "friendly",
          outputSchema: null,
          collaborationMode: {
            mode: "default",
            settings: {
              model: "pi::openai-codex/gpt-5.4",
              reasoning_effort: "medium",
            },
          },
        },
      });

      expect(backend.setModelCalls).toEqual([
        {
          sessionId: "session_1",
          modelId: "openai-codex/gpt-5.4",
        },
      ]);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
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
            id: "pi::model_1",
            model: "pi::gpt-5.4-mini",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "pi / GPT-5.4 Mini",
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

  it("starts ephemeral threads as hidden with no persisted path", async () => {
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

      const started = await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "pi",
          ephemeral: true,
        },
      });

      expect(started).toMatchObject({
        id: 2,
        result: {
          thread: {
            id: expect.any(String),
            cwd: "/repo",
            modelProvider: "pi",
            ephemeral: true,
            path: null,
            status: { type: "idle" },
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/list",
          params: {},
        })
      ).resolves.toEqual({
        id: 3,
        result: {
          data: [],
          nextCursor: null,
        },
      });

      expect(
        await threadRegistry.get(
          (started as { result: { thread: { id: string } } }).result.thread.id
        )
      ).toMatchObject({
        hidden: true,
        ephemeral: true,
        path: null,
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
      const childThreadId =
        childStarted && typeof childStarted.params?.thread?.id === "string"
          ? childStarted.params.thread.id
          : "";
      expect(childStarted).toMatchObject({
        method: "thread/started",
        params: {
          thread: {
            id: expect.any(String),
            preview: "review this",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.result.thread.id,
                },
              },
            },
            agentRole: "worker",
          },
        },
      });
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/started" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.item?.type === "userMessage" &&
            Array.isArray(notification.params.item.content) &&
            notification.params.item.content[0]?.text === "review this"
        )
      ).toBeTruthy();
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.item?.type === "userMessage" &&
            Array.isArray(notification.params.item.content) &&
            notification.params.item.content[0]?.text === "review this"
        )
      ).toBeTruthy();

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
              subAgent: expect.objectContaining({
                thread_spawn: expect.any(Object),
              }),
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
          messages: {
            [spawned.result.agent_id]: "done:review this",
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
      expect(
        notifications.find(
          (notification) =>
            notification.method === "turn/completed" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.turn?.status === "completed"
        )
      ).toBeTruthy();
      expect(
        notifications.filter(
          (notification) =>
            notification.method === "turn/started" &&
            notification.params?.threadId === childThreadId
        )
      ).toHaveLength(1);
      expect(
        notifications.filter(
          (notification) =>
            notification.method === "item/started" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.item?.type === "userMessage"
        )
      ).toHaveLength(1);
      expect(
        notifications.filter(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.item?.type === "agentMessage"
        )
      ).toHaveLength(1);
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
          model: "pi::anthropic/claude-opus-4-6",
          reasoning_effort: "medium",
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
      })) as {
        result: {
          thread: {
            status: { type: string };
            source: { subAgent: { thread_spawn: { parent_thread_id: string } } };
          };
        };
      };
      expect(childRead.result.thread.status).toEqual({ type: "active", activeFlags: ["turn"] });
      expect(childRead.result.thread.source).toMatchObject({
        subAgent: {
          thread_spawn: {
            parent_thread_id: started.result.thread.id,
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 5,
          method: "thread/resume",
          params: {
            threadId: childThreadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 5,
        result: {
          thread: {
            id: childThreadId,
            status: { type: "idle" },
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 6,
          method: "turn/start",
          params: {
            threadId: childThreadId,
            input: [{ type: "text", text: "illegal", text_elements: [] }],
          },
        })
      ).resolves.toMatchObject({
        id: 6,
        result: {
          turn: {
            status: "inProgress",
          },
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 7,
          method: "collab/close",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
          },
        })
      ).resolves.toEqual({
        id: 7,
        result: {
          previous_status: "running",
        },
      });

      const childAfterClose = (await connection.handleMessage({
        id: 8,
        method: "thread/read",
        params: {
          threadId: childThreadId,
          includeTurns: false,
        },
      })) as { result: { thread: { status: { type: string } } } };
      expect(childAfterClose.result.thread.status).toEqual({ type: "idle" });

      await expect(
        callSocket(socketPath ?? "", {
          id: 9,
          method: "collab/resume",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
          },
        })
      ).resolves.toEqual({
        id: 9,
        result: {
          status: "running",
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 10,
          method: "collab/sendInput",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
            message: "after resume",
          },
        })
      ).resolves.toMatchObject({
        id: 10,
        result: {
          submission_id: expect.any(String),
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 11,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 50,
          },
        })
      ).resolves.toEqual({
        id: 11,
        result: {
          status: {
            [spawned.result.agent_id]: "completed",
          },
          messages: {
            [spawned.result.agent_id]: "done:after resume",
          },
          timed_out: false,
        },
      });

      expect(prompts.map((prompt) => prompt.text)).toEqual([
        "initial task",
        "illegal",
        "after resume",
      ]);
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

  it("preserves sub-agent metadata when a proxied child backend emits thread/started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-codex-child-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const parentBackend = new TestBackend();
    const childBackend = new CodexProxyTestBackend();
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([parentBackend, childBackend]),
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
          model: "codex::gpt-5.4-mini",
        },
      })) as { result: { nickname: string } };

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childStarted = notifications.find(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread &&
          notification.params.thread.id !== started.result.thread.id
      ) as { params: { thread: { id: string } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();

      childBackend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "thread/started",
        params: {
          thread: {
            id: "codex_thread_handle",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: { type: "idle" },
            path: "/tmp/codex-thread.jsonl",
            cwd: "/repo",
            cliVersion: "0.116.0",
            source: "vscode",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      const childNotifications = notifications.filter(
        (notification) =>
          notification.method === "thread/started" &&
          notification.params?.thread?.id === childThreadId
      );
      expect(childNotifications.at(-1)).toMatchObject({
        method: "thread/started",
        params: {
          thread: {
            id: childThreadId,
            preview: "review this",
            modelProvider: "openai",
            path: "/tmp/codex-thread.jsonl",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.result.thread.id,
                },
              },
            },
            agentNickname: spawned.result.nickname,
            agentRole: "default",
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("supports native thread resume and turn/start for a collab child thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-native-resume-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const prompts: string[] = [];
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      prompts.push(text);
      if (text !== "after native resume") {
        return;
      }
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "done:after native resume",
        });
        backend.emit(sessionId, {
          type: "message_end",
          sessionId,
          turnId,
          text: "done:after native resume",
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
          model: "pi::anthropic/claude-opus-4-6",
          reasoning_effort: "medium",
        },
      })) as { result: { agent_id: string } };

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childThreadStarted = (await connection.handleMessage({
        id: 4,
        method: "thread/list",
        params: { sourceKinds: ["subAgent"] },
      })) as { result: { data: Array<{ id: string }> } };
      const childThreadId = childThreadStarted.result.data[0]?.id ?? "";
      expect(childThreadId).toBeTruthy();

      await expect(
        callSocket(socketPath ?? "", {
          id: 5,
          method: "collab/close",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
          },
        })
      ).resolves.toEqual({
        id: 5,
        result: {
          previous_status: "running",
        },
      });

      await expect(
        connection.handleMessage({
          id: 6,
          method: "thread/resume",
          params: {
            threadId: childThreadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 6,
        result: {
          model: "pi::anthropic/claude-opus-4-6",
          reasoningEffort: "medium",
          thread: {
            id: childThreadId,
            status: { type: "idle" },
            path: expect.stringContaining(".jsonl"),
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 7,
          method: "turn/start",
          params: {
            threadId: childThreadId,
            input: [{ type: "text", text: "after native resume", text_elements: [] }],
          },
        })
      ).resolves.toMatchObject({
        id: 7,
        result: {
          turn: {
            status: "inProgress",
          },
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 8,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 50,
          },
        })
      ).resolves.toEqual({
        id: 8,
        result: {
          status: {
            [spawned.result.agent_id]: "completed",
          },
          messages: {
            [spawned.result.agent_id]: "done:after native resume",
          },
          timed_out: false,
        },
      });

      expect(prompts).toEqual(["initial task", "after native resume"]);
      expect(backend.setModelCalls).toContainEqual({
        sessionId: "session_2",
        modelId: "anthropic/claude-opus-4-6",
      });
      expect(
        notifications.filter(
          (notification) =>
            notification.method === "item/agentMessage/delta" &&
            notification.params?.threadId === childThreadId
        )
      ).toEqual([
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: childThreadId,
            turnId: expect.any(String),
            itemId: expect.any(String),
            delta: "done:after native resume",
          },
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("falls back to direct backend events for resumed sub-agent threads without a live collab agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-orphan-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      if (text !== "run pwd") {
        return;
      }
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "tool_start",
          sessionId,
          turnId,
          toolCallId: "tool-pwd",
          toolName: "bash",
          input: { command: "pwd" },
        });
        backend.emit(sessionId, {
          type: "tool_update",
          sessionId,
          turnId,
          toolCallId: "tool-pwd",
          toolName: "bash",
          output: {
            content: [{ type: "text", text: "/repo\n" }],
          },
          isCumulative: true,
        });
        backend.emit(sessionId, {
          type: "tool_end",
          sessionId,
          turnId,
          toolCallId: "tool-pwd",
          toolName: "bash",
          output: {
            content: [{ type: "text", text: "/repo\n" }],
          },
          isError: false,
        });
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "Current working directory is `/repo`.",
        });
        backend.emit(sessionId, {
          type: "message_end",
          sessionId,
          turnId,
          text: "Current working directory is `/repo`.",
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
      const entry = await threadRegistry.create({
        threadId: "child-thread",
        backendSessionId: "session_1",
        backendType: "pi",
        cwd: "/repo",
        preview: "run pwd",
        model: "pi::anthropic/claude-opus-4-6",
        modelProvider: "pi",
        reasoningEffort: "medium",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "parent-thread",
              depth: 1,
              agent_nickname: "Robie",
              agent_role: "default",
            },
          },
        },
        agentNickname: "Robie",
        agentRole: "default",
        gitInfo: null,
      });

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
          method: "thread/resume",
          params: {
            threadId: entry.threadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 2,
        result: {
          thread: {
            id: entry.threadId,
            status: { type: "idle" },
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "turn/start",
          params: {
            threadId: entry.threadId,
            input: [{ type: "text", text: "run pwd", text_elements: [] }],
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          turn: {
            status: "inProgress",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/commandExecution/outputDelta" &&
            notification.params?.threadId === entry.threadId
        )
      ).toMatchObject({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: entry.threadId,
          delta: "/repo\n",
        },
      });
      expect(
        notifications.find(
          (notification) =>
            notification.method === "item/completed" &&
            notification.params?.threadId === entry.threadId &&
            notification.params?.item?.type === "commandExecution"
        )
      ).toMatchObject({
        method: "item/completed",
        params: {
          threadId: entry.threadId,
          item: {
            type: "commandExecution",
            aggregatedOutput: null,
            status: "completed",
          },
        },
      });
      expect(
        notifications.find(
          (notification) =>
            notification.method === "turn/completed" &&
            notification.params?.threadId === entry.threadId
        )
      ).toMatchObject({
        method: "turn/completed",
        params: {
          threadId: entry.threadId,
          turn: {
            status: "completed",
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("hydrates an active collab child resume as a single turn with the user message first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-hydrate-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      if (text !== "initial task") {
        return;
      }

      backend.sessionHistories.set(sessionId, [
        {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "tool_start",
          sessionId,
          turnId,
          toolCallId: "tool-1",
          toolName: "bash",
          input: { command: ["echo", "hi"] },
        });
      });
    });
    const connection = new AppServerConnection({
      backend,
      collabEnabled: true,
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

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "initial task",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      const childThreads = (await connection.handleMessage({
        id: 4,
        method: "thread/list",
        params: { sourceKinds: ["subAgent"] },
      })) as { result: { data: Array<{ id: string }> } };
      const childThreadId = childThreads.result.data[0]?.id ?? "";
      expect(childThreadId).toBeTruthy();

      await expect(
        connection.handleMessage({
          id: 5,
          method: "thread/resume",
          params: {
            threadId: childThreadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 5,
        result: {
          thread: {
            id: childThreadId,
            status: { type: "idle" },
            turns: [
              {
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "initial task" }],
                  },
                ],
                status: "completed",
              },
            ],
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await connection.dispose();
    }
  });

  it("reuses the loaded live turn id when resuming a completed thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-live-turn-id-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      backend.sessionHistories.set(sessionId, [
        {
          id: "message-0",
          role: "user",
          content: [{ type: "text", text }],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "Today's date is 2026-03-22." }],
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ]);

      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "message_end",
          sessionId,
          turnId,
          text: "Today's date is 2026-03-22.",
        });
      });
    });
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
          input: [{ type: "text", text: "What is today's date?", text_elements: [] }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      await expect(
        connection.handleMessage({
          id: 4,
          method: "thread/resume",
          params: {
            threadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 4,
        result: {
          thread: {
            id: threadId,
            turns: [
              {
                id: "message-0",
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "What is today's date?" }],
                  },
                  {
                    type: "agentMessage",
                    text: "Today's date is 2026-03-22.",
                  },
                ],
              },
            ],
          },
        },
      });
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
      })) as {
        result: {
          data: Array<{ id: string; source: { subAgent: { thread_spawn: object } } }>;
        };
      };
      expect(subAgents.result.data).toEqual([
        expect.objectContaining({
          id: childThreadId,
          source: expect.objectContaining({
            subAgent: expect.objectContaining({
              thread_spawn: expect.any(Object),
            }),
          }),
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
            source: { subAgent: { thread_spawn: { parent_thread_id: string } } };
          };
        };
      };
      expect(childRead.result.thread.status).toEqual({ type: "idle" });
      expect(childRead.result.thread.source).toMatchObject({
        subAgent: {
          thread_spawn: {
            parent_thread_id: started.result.thread.id,
          },
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
    const abortSpy = vi.spyOn(backend, "abort");
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
      expect(abortSpy).toHaveBeenCalledWith("session_2");
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
            aggregatedOutput: null,
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

  it("hides legacy title-generator threads with truncated previews from thread/list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backend: createBackend(),
      threadRegistry,
    });

    try {
      await threadRegistry.create({
        threadId: "legacy-title-thread",
        backendSessionId: "pi_session_legacy",
        backendType: "pi",
        cwd: "/repo",
        modelProvider: "pi",
        preview:
          "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a ta",
      });

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
          method: "thread/list",
          params: {},
        })
      ).resolves.toEqual({
        id: 2,
        result: {
          data: [],
          nextCursor: null,
        },
      });

      expect(await threadRegistry.get("legacy-title-thread")).toMatchObject({
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
            record.eventType === "notification" &&
            isRecord(record.payload) &&
            record.payload.method === "item/agentMessage/delta" &&
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
          response: {
            result: {
              answers: {
                value: {
                  answers: ["Yes"],
                },
              },
            },
          },
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

  it("rewrites proxied backend thread ids before publishing to the client", async () => {
    const backend = new CodexProxyTestBackend();
    const outbound: Array<Record<string, unknown>> = [];
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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

    const started = (await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/repo",
        model: "codex::gpt-5.4-mini",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;

    backend.emit("codex_thread_handle", {
      kind: "notification",
      threadHandle: "codex_thread_handle",
      method: "thread/started",
      params: {
        thread: {
          id: "codex_thread_handle",
          turns: [],
        },
      },
    });
    backend.emit("codex_thread_handle", {
      kind: "notification",
      threadHandle: "codex_thread_handle",
      method: "turn/started",
      params: {
        threadId: "codex_thread_handle",
        turn: {
          id: "turn_backend",
          items: [],
          status: "inProgress",
          error: null,
        },
      },
    });
    backend.emit("codex_thread_handle", {
      kind: "serverRequest",
      threadHandle: "codex_thread_handle",
      requestId: "backend-request-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "codex_thread_handle",
        turnId: "turn_backend",
        itemId: "item_1",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outbound.find((message) => message.method === "thread/started")).toMatchObject({
      method: "thread/started",
      params: {
        thread: {
          id: threadId,
        },
      },
    });
    expect(
      outbound.find(
        (message) =>
          message.method === "turn/started" &&
          isRecord(message.params) &&
          message.params.turnId === undefined
      )
    ).toMatchObject({
      method: "turn/started",
      params: {
        threadId,
        turn: {
          id: "turn_backend",
        },
      },
    });
    const serverRequest = outbound.find(
      (message) =>
        message.method === "item/tool/requestUserInput" &&
        isRecord(message.params) &&
        message.params.turnId === "turn_backend"
    );
    expect(serverRequest).toMatchObject({
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: "turn_backend",
      },
    });

    await connection.handleMessage({
      id: String((serverRequest as { id: string }).id),
      result: { answers: {} },
    });

    expect(backend.resolvedServerRequests).toContainEqual({
      requestId: "backend-request-1",
      response: { result: { answers: {} } },
    });
  });

  it("does not synthesize user message items in turn/start responses", async () => {
    const backend = createBackend();
    const connection = new AppServerConnection({ backend });

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
        cwd: "/repo",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { thread: { id: string } } };

    await expect(
      connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      })
    ).resolves.toMatchObject({
      id: 3,
      result: {
        turn: {
          items: [],
        },
      },
    });
  });

  it("allows Pi follow-up turns after completion and omits completed turn items in notifications", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const backend = new TestBackend(async ({ sessionId, turnId }) => {
      queueMicrotask(() => {
        backend.emit(sessionId, {
          type: "text_delta",
          sessionId,
          turnId,
          delta: "hello",
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
      onMessage(message) {
        notifications.push(message as Record<string, unknown>);
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

    const started = (await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/repo",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;

    await connection.handleMessage({
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const completed = notifications.find(
      (message) =>
        message.method === "turn/completed" &&
        isRecord(message.params) &&
        message.params.threadId === threadId
    );
    expect(completed).toMatchObject({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          items: [],
        },
      },
    });

    await expect(
      connection.handleMessage({
        id: 4,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "second", text_elements: [] }],
        },
      })
    ).resolves.toMatchObject({
      id: 4,
      result: {
        turn: {
          items: [],
        },
      },
    });
  });

  it("uses backend turn ids in turn/start responses for proxied backends", async () => {
    const backend = new CodexProxyTestBackend();
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
    });

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
        cwd: "/repo",
        model: "codex::gpt-5.4-mini",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { thread: { id: string } } };

    await expect(
      connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      })
    ).resolves.toMatchObject({
      id: 3,
      result: {
        turn: {
          id: "turn_backend",
          items: [],
        },
      },
    });
  });

  it("routes raw-model ephemeral thread starts to the Codex backend", async () => {
    const codexBackend = new CodexProxyTestBackend();
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([codexBackend]),
    });

    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    const response = (await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: {
        cwd: "/repo",
        model: "gpt-5.1-codex-mini",
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { model: string; thread: { ephemeral: boolean } } };

    expect(codexBackend.threadStartCalls).toContainEqual({
      threadId: expect.any(String),
      model: "gpt-5.1-codex-mini",
    });
    expect(response.result.model).toBe("codex::gpt-5.1-codex-mini");
    expect(response.result.thread.ephemeral).toBe(true);
  });
});
