import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  BackendModelSummary,
  BackendSessionLaunchConfig,
  IBackend,
} from "../src/backend.js";
import { InMemoryConfigStore } from "../src/config-store.js";
import { ThreadRegistry } from "../src/thread-registry.js";
import { TurnStateMachine, toThreadTokenUsage } from "../src/turn-state.js";

class TestBackend implements IBackend {
  public readonly backendType: string;
  private readonly listeners = new Map<string, Set<(event: BackendAppServerEvent) => void>>();
  private readonly machines = new Map<string, TurnStateMachine>();
  private readonly eventPipelines = new Map<string, Promise<void>>();
  private readonly threadIdsBySession = new Map<string, string>();
  private readonly activeTurns = new Map<string, string>();
  private sessionCounter = 0;
  private readonly models: readonly BackendModelSummary[];
  private readonly userMessageNotifyDefault: boolean;
  public readonly sessionHistories = new Map<string, BackendMessage[]>();
  public readonly elicitationResponses: Array<{
    sessionId: string;
    requestId: string;
    response: unknown;
  }> = [];
  public readonly setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
  public listModelsCallCount = 0;
  public readonly launchConfigs: Array<{
    threadId: string;
    launchConfig: BackendSessionLaunchConfig | undefined;
  }> = [];
  public readonly threadStartCalls: Array<Record<string, unknown>> = [];
  public readonly threadResumeCalls: Array<Record<string, unknown>> = [];
  public readonly threadForkCalls: Array<Record<string, unknown>> = [];
  public readonly turnStartCalls: Array<Record<string, unknown>> = [];

  constructor(
    private readonly onPromptCallback?: (args: {
      sessionId: string;
      turnId: string;
      text: string;
    }) => void | Promise<void>,
    options: {
      backendType?: string;
      models?: readonly BackendModelSummary[];
      userMessageNotifyDefault?: boolean;
    } = {}
  ) {
    this.backendType = options.backendType ?? "pi";
    this.userMessageNotifyDefault = options.userMessageNotifyDefault ?? true;
    this.models = options.models ?? [
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
      if (this.backendType === "codex") {
        return {
          backendType: this.backendType,
          rawModelId: model,
        };
      }
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
    this.listModelsCallCount += 1;
    return this.models;
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
    launchConfig?: BackendSessionLaunchConfig;
  }) {
    this.threadStartCalls.push({ ...input });
    const sessionId = await this.createSession();
    this.threadIdsBySession.set(sessionId, input.threadId);
    this.launchConfigs.push({ threadId: input.threadId, launchConfig: input.launchConfig });
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
    launchConfig?: BackendSessionLaunchConfig;
  }) {
    this.threadResumeCalls.push({ ...input });
    const sessionId = await this.resumeSession(input.threadHandle);
    this.threadIdsBySession.set(sessionId, input.threadId);
    this.launchConfigs.push({ threadId: input.threadId, launchConfig: input.launchConfig });
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
    launchConfig?: BackendSessionLaunchConfig;
  }) {
    this.threadForkCalls.push({ ...input });
    const sessionId = await this.forkSession(input.sourceThreadHandle);
    this.threadIdsBySession.set(sessionId, input.threadId);
    this.launchConfigs.push({ threadId: input.threadId, launchConfig: input.launchConfig });
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
    emitUserMessage?: boolean;
  }) {
    this.turnStartCalls.push({ ...input });
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
      input.input.map((entry) => ({ type: "text", text: entry.text ?? "" })),
      { notify: input.emitUserMessage ?? this.userMessageNotifyDefault }
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
  public readonly threadReadOverrides = new Map<
    string,
    {
      title?: string | null;
      model?: string | null;
      path?: string | null;
      cwd?: string | null;
      agentNickname?: string | null;
      agentRole?: string | null;
    }
  >();
  constructor(private readonly threadPath = "/tmp/codex-thread.jsonl") {}

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
    if (!parsed) {
      return {
        backendType: this.backendType,
        rawModelId: model,
      };
    }
    return parsed.backendType === this.backendType ? parsed : null;
  }

  async threadStart(input: { threadId: string; model: string | null }) {
    this.threadStartCalls.push({ threadId: input.threadId, model: input.model });
    return {
      threadHandle: "codex_thread_handle",
      path: this.threadPath,
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadResume(input: { threadHandle: string; model: string | null }) {
    return {
      threadHandle: input.threadHandle,
      path: this.threadPath,
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadFork(input: { sourceThreadHandle: string; model: string | null }) {
    return {
      threadHandle: `${input.sourceThreadHandle}_fork`,
      path: this.threadPath,
      model: input.model,
      reasoningEffort: "medium",
    };
  }

  async threadRead(input: { threadHandle: string }) {
    const override = this.threadReadOverrides.get(input.threadHandle);
    return {
      threadHandle: input.threadHandle,
      title: override?.title ?? null,
      model: override?.model ?? "gpt-5.4-mini",
      path: override?.path,
      cwd: override?.cwd,
      agentNickname: override?.agentNickname,
      agentRole: override?.agentRole,
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
        requiresOpenaiAuth: false,
      },
    });

    expect(notifications.at(-1)).toEqual({
      method: "account/updated",
      params: { authMode: null, planType: null },
    });
  });

  it("reports no auth state by default", async () => {
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
        method: "account/read",
        params: { refreshToken: false },
      })
    ).resolves.toEqual({
      id: 2,
      result: {
        account: null,
        requiresOpenaiAuth: false,
      },
    });

    await expect(
      connection.handleMessage({
        id: 3,
        method: "getAuthStatus",
        params: { includeToken: true, refreshToken: false },
      })
    ).resolves.toEqual({
      id: 3,
      result: {
        authMethod: null,
        authToken: null,
        requiresOpenaiAuth: false,
      },
    });
  });

  it("writes config values and reads them back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-config-write-"));
    const configPath = join(directory, "config.toml");
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([
        new TestBackend(undefined, {
          backendType: "pi",
          models: [
            {
              id: "anthropic/claude-opus-4-6",
              model: "anthropic/claude-opus-4-6",
              displayName: "Claude Opus 4.6",
              description: "Claude Opus 4.6",
              hidden: false,
              isDefault: true,
              inputModalities: ["text", "image"],
              supportedReasoningEfforts: [
                {
                  reasoningEffort: "medium",
                  description: "Balanced reasoning",
                },
              ],
              defaultReasoningEffort: "medium",
              supportsPersonality: true,
            },
          ],
        }),
      ]),
      configStore: new InMemoryConfigStore(configPath),
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

      const writeResponse = await connection.handleMessage({
        id: 2,
        method: "config/value/write",
        params: {
          keyPath: "model",
          value: "pi::anthropic/claude-opus-4-6",
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
            model: "pi::anthropic/claude-opus-4-6",
          },
          layers: [
            {
              version: "2",
            },
          ],
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
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
    }
  });

  it("forwards desktop thread and turn settings to the backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-forwarding-"));
    const backend = new TestBackend(undefined, { backendType: "codex" });
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
          model: "gpt-5.4-mini",
          cwd: "/tmp",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          config: {
            features: {
              personality: true,
            },
            model_reasoning_effort: "medium",
          },
          serviceTier: "auto",
          serviceName: "codex_desktop",
          baseInstructions: "base instructions",
          developerInstructions: "developer instructions",
          personality: "friendly",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { id: number; result: ThreadStartResponse };

      expect(backend.threadStartCalls[0]).toMatchObject({
        model: "gpt-5.4-mini",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        config: {
          features: {
            personality: true,
          },
          model_reasoning_effort: "medium",
        },
        serviceTier: "auto",
        serviceName: "codex_desktop",
        baseInstructions: "base instructions",
        developerInstructions: "developer instructions",
        personality: "friendly",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "hello", text_elements: [] }],
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
          serviceTier: "auto",
          effort: "medium",
          summary: "none",
          personality: "friendly",
          outputSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
          },
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4-mini",
              reasoning_effort: "medium",
            },
          },
        },
      });

      expect(backend.turnStartCalls[0]).toMatchObject({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        serviceTier: "auto",
        reasoningEffort: "medium",
        summary: "none",
        personality: "friendly",
        outputSchema: {
          type: "object",
        },
        collaborationMode: {
          mode: "default",
        },
      });
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

  it("logs per-backend model/list diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-model-list-log-"));
    const logFilePath = join(directory, "debug.jsonl");
    const piBackend = new TestBackend(undefined, {
      backendType: "pi",
      models: [
        {
          id: "model_1",
          model: "openai-codex/gpt-5.4",
          displayName: "GPT-5.4",
          description: "Pi model",
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
      ],
    });
    const codexBackend = new TestBackend(undefined, {
      backendType: "codex",
      models: [],
    });
    const originalPiListModels = piBackend.listModels.bind(piBackend);
    vi.spyOn(piBackend, "listModels").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return await originalPiListModels();
    });
    vi.spyOn(codexBackend, "listModels").mockRejectedValue(new Error("codex offline"));

    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([piBackend, codexBackend]),
      debugLogFilePath: logFilePath,
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
        method: "model/list",
        params: {},
      });
      await connection.dispose();

      const logLines = (await readFile(logFilePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = logLines.find(
        (line) => line.kind === "backend-event" && line.method === "model/list"
      );

      expect(entry).toMatchObject({
        durationMs: expect.any(Number),
      });
      expect(entry?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            backendType: "pi",
            status: "ok",
            modelCount: 1,
            error: null,
          }),
          expect.objectContaining({
            backendType: "codex",
            status: "error",
            modelCount: 0,
            error: "codex offline",
          }),
        ])
      );
      expect((entry?.durationMs as number) >= 15).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lists raw Codex model ids and prefixed Pi model ids", async () => {
    const piBackend = new TestBackend(undefined, {
      backendType: "pi",
      models: [
        {
          id: "model_1",
          model: "anthropic/claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          description: "Pi model",
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
      ],
    });
    const codexBackend = new TestBackend(undefined, {
      backendType: "codex",
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Codex model",
          hidden: false,
          isDefault: false,
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
      ],
    });
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([piBackend, codexBackend]),
    });
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
            id: "gpt-5.4",
            model: "gpt-5.4",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.4",
            description: "Codex model",
            hidden: false,
            supportedReasoningEfforts: [
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
          {
            id: "pi::model_1",
            model: "pi::anthropic/claude-opus-4-6",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "pi / Claude Opus 4.6 (Anthropic)",
            description: "Pi model",
            hidden: false,
            supportedReasoningEfforts: [
              {
                reasoningEffort: "medium",
                description: "Balanced reasoning",
              },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: true,
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("injects aggregated model ids into collab launch config", async () => {
    const piBackend = new TestBackend(undefined, {
      backendType: "pi",
      models: [
        {
          id: "model_1",
          model: "anthropic/claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          description: "Pi model",
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
      ],
    });
    const codexBackend = new TestBackend(undefined, {
      backendType: "codex",
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Codex model",
          hidden: false,
          isDefault: false,
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
      ],
    });
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([piBackend, codexBackend]),
      collabEnabled: true,
    });
    await connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
    });

    try {
      await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          model: "pi::anthropic/claude-opus-4-6",
          cwd: "/repo",
        },
      });

      expect(piBackend.launchConfigs[0]?.launchConfig).toMatchObject({
        threadId: expect.any(String),
        collabSocketPath: expect.stringContaining("codapter-collab-"),
        availableModelsDescription:
          "Available models (use the model id exactly as shown):\n" +
          "- gpt-5.4: medium\n" +
          "- pi::anthropic/claude-opus-4-6: medium",
      });
    } finally {
      await connection.dispose();
    }
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

  it("returns Pi skills grouped by cwd for skills/list", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-skills-list-"));
    const globalSkillsRoot = join(root, "global-skills");
    const workspaceCwd = join(root, "workspace");
    const projectSkillsRoot = join(workspaceCwd, ".pi", "agent", "skills");
    const extraSkillsRoot = join(root, "extra-skills");

    await mkdir(join(globalSkillsRoot, "global-helper"), { recursive: true });
    await writeFile(
      join(globalSkillsRoot, "global-helper", "SKILL.md"),
      [
        "---",
        "name: global-helper",
        "description: Global helper skill",
        "---",
        "",
        "# Global helper",
      ].join("\n"),
      "utf8"
    );

    await mkdir(join(projectSkillsRoot, "project-helper"), { recursive: true });
    await writeFile(
      join(projectSkillsRoot, "project-helper", "SKILL.md"),
      [
        "---",
        "name: project-helper",
        "description: Project helper skill",
        "---",
        "",
        "# Project helper",
      ].join("\n"),
      "utf8"
    );

    await mkdir(join(extraSkillsRoot, "extra-helper"), { recursive: true });
    await writeFile(
      join(extraSkillsRoot, "extra-helper", "SKILL.md"),
      [
        "---",
        "name: extra-helper",
        "description: Extra root skill",
        "---",
        "",
        "# Extra helper",
      ].join("\n"),
      "utf8"
    );

    const connection = new AppServerConnection({
      backend: createBackend(),
      piGlobalSkillsRoot: globalSkillsRoot,
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

      const response = await connection.handleMessage({
        id: 2,
        method: "skills/list",
        params: {
          cwds: [workspaceCwd],
          forceReload: true,
          perCwdExtraUserRoots: [[extraSkillsRoot]],
        },
      });

      expect(response).toEqual({
        id: 2,
        result: {
          data: [
            {
              cwd: workspaceCwd,
              skills: expect.any(Array),
              errors: [],
            },
          ],
        },
      });

      const resultData = (response as { result: { data: Array<Record<string, unknown>> } }).result
        .data[0];
      expect(resultData).toBeDefined();
      const skills = Array.isArray(resultData?.skills) ? resultData.skills : [];
      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "global-helper",
            description: "Global helper skill",
            scope: "user",
            enabled: true,
          }),
          expect.objectContaining({
            name: "project-helper",
            description: "Project helper skill",
            scope: "project",
            enabled: true,
          }),
          expect.objectContaining({
            name: "extra-helper",
            description: "Extra root skill",
            scope: "user",
            enabled: true,
          }),
        ])
      );
      expect(skills[0]).toEqual(
        expect.objectContaining({
          interface: expect.objectContaining({
            displayName: expect.any(String),
            shortDescription: expect.any(String),
            iconSmall: null,
            iconLarge: null,
            brandColor: null,
            defaultPrompt: null,
          }),
        })
      );
    } finally {
      await connection.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports skills/config/write and plugin management for discovered Pi skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-skills-manage-"));
    const globalSkillsRoot = join(root, "global-skills");
    const workspaceCwd = join(root, "workspace");
    await mkdir(join(globalSkillsRoot, "global-helper"), { recursive: true });
    const globalSkillPath = join(globalSkillsRoot, "global-helper", "SKILL.md");
    await writeFile(
      globalSkillPath,
      [
        "---",
        "name: global-helper",
        "description: Global helper skill",
        "---",
        "",
        "# Global helper",
      ].join("\n"),
      "utf8"
    );

    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection = new AppServerConnection({
      backend: createBackend(),
      piGlobalSkillsRoot: globalSkillsRoot,
      onMessage: (message) => {
        if ("method" in message && typeof message.method === "string") {
          notifications.push({ method: message.method, params: message.params });
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

      await expect(
        connection.handleMessage({
          id: 2,
          method: "skills/config/write",
          params: {
            path: globalSkillPath,
            enabled: false,
          },
        })
      ).resolves.toEqual({
        id: 2,
        result: {
          effectiveEnabled: false,
        },
      });

      const skillsResponse = await connection.handleMessage({
        id: 3,
        method: "skills/list",
        params: {
          cwds: [workspaceCwd],
          forceReload: true,
          perCwdExtraUserRoots: null,
        },
      });
      const listedSkill = (
        (skillsResponse as { result: { data: Array<Record<string, unknown>> } }).result.data[0]
          ?.skills as Array<Record<string, unknown>>
      ).find((skill) => skill.name === "global-helper");
      expect(listedSkill).toEqual(
        expect.objectContaining({
          enabled: false,
        })
      );

      const pluginList = await connection.handleMessage({
        id: 4,
        method: "plugin/list",
        params: {
          cwds: [workspaceCwd],
          forceRemoteSync: false,
        },
      });
      expect(pluginList).toEqual({
        id: 4,
        result: expect.objectContaining({
          marketplaces: [
            expect.objectContaining({
              name: "pi-skills",
              plugins: expect.arrayContaining([
                expect.objectContaining({
                  id: "global-helper@pi-skills",
                  name: "global-helper",
                }),
              ]),
            }),
          ],
        }),
      });

      await expect(
        connection.handleMessage({
          id: 5,
          method: "plugin/read",
          params: {
            marketplacePath: globalSkillsRoot,
            pluginName: "global-helper",
          },
        })
      ).resolves.toEqual({
        id: 5,
        result: {
          plugin: expect.objectContaining({
            marketplaceName: "Pi Skills",
            skills: expect.arrayContaining([
              expect.objectContaining({
                name: "global-helper",
              }),
            ]),
          }),
        },
      });

      await expect(
        connection.handleMessage({
          id: 6,
          method: "plugin/install",
          params: {
            marketplacePath: globalSkillsRoot,
            pluginName: "global-helper",
          },
        })
      ).resolves.toEqual({
        id: 6,
        result: {
          authPolicy: "NONE",
          appsNeedingAuth: [],
        },
      });

      await expect(
        connection.handleMessage({
          id: 7,
          method: "plugin/uninstall",
          params: {
            pluginId: "global-helper@pi-skills",
          },
        })
      ).resolves.toEqual({
        id: 7,
        result: {},
      });

      const skillsAfterUninstall = await connection.handleMessage({
        id: 8,
        method: "skills/list",
        params: {
          cwds: [workspaceCwd],
          forceReload: true,
          perCwdExtraUserRoots: null,
        },
      });
      const afterSkills =
        ((skillsAfterUninstall as { result: { data: Array<Record<string, unknown>> } }).result
          .data[0]?.skills as Array<Record<string, unknown>>) ?? [];
      expect(afterSkills.some((skill) => skill.name === "global-helper")).toBe(false);

      expect(notifications.some((notification) => notification.method === "skills/changed")).toBe(
        true
      );
    } finally {
      await connection.dispose();
      await rm(root, { recursive: true, force: true });
    }
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
            name: null,
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
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("inherits desktop execution context for collab child Codex threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-context-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend(undefined, { backendType: "codex" });
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
          model: "gpt-5.4-mini",
          cwd: "/repo",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          config: {
            features: {
              personality: true,
            },
          },
          serviceTier: "auto",
          serviceName: "codex_desktop",
          developerInstructions: "developer instructions",
          personality: "friendly",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 21,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "Spawn child", text_elements: [] }],
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4-mini",
              reasoning_effort: "low",
              developer_instructions: "collab developer instructions",
            },
          },
        },
      });

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "Run date",
          model: "gpt-5.4-mini",
          reasoning_effort: "medium",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(backend.threadStartCalls.at(-1)).toMatchObject({
        cwd: "/repo",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        config: {
          features: {
            personality: true,
          },
        },
        serviceTier: "auto",
        serviceName: "codex_desktop",
        developerInstructions: "developer instructions",
        personality: "friendly",
      });
      expect(backend.turnStartCalls.at(-1)).toMatchObject({
        cwd: "/repo",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        serviceTier: "auto",
        personality: "friendly",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.4-mini",
            reasoning_effort: "medium",
            developer_instructions: "collab developer instructions",
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rewrites collab child collaborationMode to the child backend model on cross-backend spawns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-cross-backend-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const piBackend = new TestBackend(undefined, {
      backendType: "pi",
      models: [
        {
          id: "anthropic/claude-opus-4-6",
          model: "anthropic/claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          description: "Pi test model",
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
      ],
    });
    const codexBackend = new TestBackend(undefined, {
      backendType: "codex",
      models: [
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
      ],
    });
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([piBackend, codexBackend]),
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
          model: "pi::anthropic/claude-opus-4-6",
          cwd: "/repo",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "Spawn child", text_elements: [] }],
          collaborationMode: {
            mode: "default",
            settings: {
              model: "pi::anthropic/claude-opus-4-6",
              reasoning_effort: "medium",
            },
          },
        },
      });

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      await callSocket(socketPath ?? "", {
        id: 4,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "Run date",
          model: "gpt-5.4-mini",
          reasoning_effort: "medium",
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(codexBackend.threadStartCalls.at(-1)).toMatchObject({
        model: "gpt-5.4-mini",
      });
      expect(codexBackend.turnStartCalls.at(-1)).toMatchObject({
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.4-mini",
            reasoning_effort: "medium",
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses threadStart for collab fork_context spawns on Codex threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-codex-fork-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend(undefined, { backendType: "codex" });
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
          cwd: "/tmp",
          model: "gpt-5.4-mini",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      const socketPath = connection.collabSocketPath;
      expect(socketPath).toBeTruthy();

      await callSocket(socketPath ?? "", {
        id: 3,
        method: "collab/spawn",
        params: {
          parentThreadId: started.result.thread.id,
          message: "delegate with context",
          model: "gpt-5.4-mini",
          fork_context: true,
        },
      });

      expect(backend.threadForkCalls).toHaveLength(0);
      expect(backend.threadStartCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: "gpt-5.4-mini",
          }),
        ])
      );
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
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
            status: { type: "active", activeFlags: ["turn"] },
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
        error: {
          code: -32603,
          message: expect.stringContaining("not ready"),
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
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits child user messages for collab send_input when the backend suppresses ordinary live prompts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-followup-user-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = new TestBackend(
      async ({ sessionId, turnId, text }) => {
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
      },
      { userMessageNotifyDefault: false }
    );
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
          model: "pi::anthropic/claude-opus-4-6",
          reasoning_effort: "medium",
        },
      })) as { result: { agent_id: string } };

      await expect(
        callSocket(socketPath ?? "", {
          id: 4,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 100,
          },
        })
      ).resolves.toMatchObject({
        id: 4,
        result: {
          timed_out: false,
        },
      });

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
          id: 5,
          method: "collab/sendInput",
          params: {
            parentThreadId: started.result.thread.id,
            id: spawned.result.agent_id,
            message: "follow up",
          },
        })
      ).resolves.toMatchObject({
        id: 5,
        result: {
          submission_id: expect.any(String),
        },
      });

      await expect(
        callSocket(socketPath ?? "", {
          id: 6,
          method: "collab/wait",
          params: {
            parentThreadId: started.result.thread.id,
            ids: [spawned.result.agent_id],
            timeout_ms: 100,
          },
        })
      ).resolves.toMatchObject({
        id: 6,
        result: {
          timed_out: false,
        },
      });

      const childUserMessages = notifications
        .filter(
          (notification) =>
            notification.method === "item/started" &&
            notification.params?.threadId === childThreadId &&
            notification.params?.item?.type === "userMessage"
        )
        .map((notification) => {
          const content = notification.params?.item?.content as
            | Array<{ text?: string }>
            | undefined;
          return content?.[0]?.text ?? null;
        });

      expect(childUserMessages).toEqual(["initial task", "follow up"]);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
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
            modelProvider: "codex",
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
            status: { type: "active", activeFlags: ["turn"] },
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

  it("keeps a running collab child active across resume and rejects overlapping direct turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-collab-active-resume-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let childSessionId = "";
    let childTurnId = "";
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      if (text !== "initial task") {
        return;
      }

      childSessionId = sessionId;
      childTurnId = turnId;
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
          input: { command: ["sleep", "10"] },
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
      expect(childSessionId).toBeTruthy();
      expect(childTurnId).toBeTruthy();

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
            status: { type: "active", activeFlags: ["turn"] },
            turns: [
              {
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "initial task" }],
                  },
                ],
              },
            ],
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 6,
          method: "turn/start",
          params: {
            threadId: childThreadId,
            input: [{ type: "text", text: "overlapping follow-up", text_elements: [] }],
          },
        })
      ).resolves.toMatchObject({
        id: 6,
        error: {
          code: -32603,
          message: expect.stringContaining("not ready"),
        },
      });

      backend.emit(childSessionId, {
        type: "message_end",
        sessionId: childSessionId,
        turnId: childTurnId,
        text: "done:initial task",
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(
        notifications.find(
          (notification) =>
            notification.method === "turn/completed" &&
            notification.params?.threadId === childThreadId
        )
      ).toMatchObject({
        method: "turn/completed",
        params: {
          threadId: childThreadId,
          turn: {
            status: "completed",
          },
        },
      });
      expect(
        notifications.findLast(
          (notification) =>
            notification.method === "thread/status/changed" &&
            notification.params?.threadId === childThreadId
        )
      ).toMatchObject({
        method: "thread/status/changed",
        params: {
          threadId: childThreadId,
          status: { type: "idle" },
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

      const startedTurn = (await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "What is today's date?", text_elements: [] }],
        },
      })) as {
        result: {
          turn: {
            id: string;
          };
        };
      };

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
                id: startedTurn.result.turn.id,
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

  it("reuses loaded live turn ids for all completed turns when resuming a thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-app-server-live-turn-ids-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const backend = new TestBackend(async ({ sessionId, turnId, text }) => {
      if (text === "What is today's date?") {
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
            content: [{ type: "text", text: "Today's date is March 23, 2026." }],
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ]);
        queueMicrotask(() => {
          backend.emit(sessionId, {
            type: "message_end",
            sessionId,
            turnId,
            text: "Today's date is March 23, 2026.",
          });
        });
        return;
      }

      if (text === "Run the `pwd` command and tell me the output.") {
        backend.sessionHistories.set(sessionId, [
          {
            id: "message-0",
            role: "user",
            content: [{ type: "text", text: "What is today's date?" }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "message-1",
            role: "assistant",
            content: [{ type: "text", text: "Today's date is March 23, 2026." }],
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            id: "message-2",
            role: "user",
            content: [{ type: "text", text }],
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            id: "message-3",
            role: "assistant",
            content: [{ type: "text", text: "/Users/kevin/codapter" }],
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ]);
        queueMicrotask(() => {
          backend.emit(sessionId, {
            type: "message_end",
            sessionId,
            turnId,
            text: "/Users/kevin/codapter",
          });
        });
      }
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

      const firstTurn = (await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: "What is today's date?", text_elements: [] }],
        },
      })) as {
        result: {
          turn: {
            id: string;
          };
        };
      };

      await new Promise((resolve) => setTimeout(resolve, 25));

      const secondTurn = (await connection.handleMessage({
        id: 4,
        method: "turn/start",
        params: {
          threadId,
          input: [
            {
              type: "text",
              text: "Run the `pwd` command and tell me the output.",
              text_elements: [],
            },
          ],
        },
      })) as {
        result: {
          turn: {
            id: string;
          };
        };
      };

      await new Promise((resolve) => setTimeout(resolve, 25));

      await expect(
        connection.handleMessage({
          id: 5,
          method: "thread/resume",
          params: {
            threadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 5,
        result: {
          thread: {
            id: threadId,
            turns: [
              {
                id: firstTurn.result.turn.id,
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: [{ type: "text", text: "What is today's date?" }],
                  },
                  {
                    type: "agentMessage",
                    text: "Today's date is March 23, 2026.",
                  },
                ],
              },
              {
                id: secondTurn.result.turn.id,
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: [
                      {
                        type: "text",
                        text: "Run the `pwd` command and tell me the output.",
                      },
                    ],
                  },
                  {
                    type: "agentMessage",
                    text: "/Users/kevin/codapter",
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
            record.accepted === true
        )
      ).toBe(true);
      expect(
        records.some(
          (record) => record.kind === "notification" && typeof record.method === "string"
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

  it("drops aggregated command output on proxied completions after streaming deltas", async () => {
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
        model: "gpt-5.4-mini",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { thread: { id: string } } };
    const threadId = started.result.thread.id;

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
      kind: "notification",
      threadHandle: "codex_thread_handle",
      method: "item/started",
      params: {
        threadId: "codex_thread_handle",
        turnId: "turn_backend",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "/bin/zsh -lc 'pwd'",
          cwd: "/repo",
          processId: "123",
          status: "inProgress",
          commandActions: [{ type: "unknown", command: "pwd" }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });
    backend.emit("codex_thread_handle", {
      kind: "notification",
      threadHandle: "codex_thread_handle",
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "codex_thread_handle",
        turnId: "turn_backend",
        itemId: "cmd_1",
        delta: "/repo\n",
      },
    });
    backend.emit("codex_thread_handle", {
      kind: "notification",
      threadHandle: "codex_thread_handle",
      method: "item/completed",
      params: {
        threadId: "codex_thread_handle",
        turnId: "turn_backend",
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "/bin/zsh -lc 'pwd'",
          cwd: "/repo",
          processId: "123",
          status: "completed",
          commandActions: [{ type: "unknown", command: "pwd" }],
          aggregatedOutput: "/repo\n",
          exitCode: 0,
          durationMs: 10,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      outbound.find(
        (message) =>
          message.method === "item/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "commandExecution"
      )
    ).toMatchObject({
      method: "item/completed",
      params: {
        threadId,
        item: {
          id: "cmd_1",
          aggregatedOutput: null,
        },
      },
    });
  });

  it("creates local child threads for native Codex sub-agents and rewrites their ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-subagent-"));
    const sessionPath = join(directory, "parent.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_spawn_1",
            output: JSON.stringify({
              agent_id: "child_backend_handle",
              nickname: "Ptolemy",
            }),
          },
        }),
      ].join("\n"),
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(sessionPath);
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };
      const parentThreadId = started.result.thread.id;

      backend.emit("child_backend_handle", {
        kind: "notification",
        threadHandle: "child_backend_handle",
        method: "thread/started",
        params: {
          thread: {
            id: "child_backend_handle",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: { type: "idle" },
            path: "/tmp/child-thread.jsonl",
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

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the `date` command in the current workspace shell and report back.",
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            agentsStates: {
              child_backend_handle: {
                status: "pendingInit",
                message: null,
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childThreadId).not.toBe("child_backend_handle");
      expect(childStarted?.params.thread.agentNickname).toBe("Ptolemy");
      expect(childStarted?.params.thread.name).toBeNull();

      const completed = outbound.find(
        (message) =>
          message.method === "item/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "collabAgentToolCall" &&
          message.params.item.tool === "spawnAgent"
      ) as { params: { item: Record<string, unknown> } } | undefined;
      expect(completed?.params.item).toMatchObject({
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        model: "gpt-5.4-mini",
        agentsStates: {
          [childThreadId]: {
            status: "pendingInit",
            message: null,
          },
        },
      });

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_wait_1",
            tool: "wait",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {
              child_backend_handle: {
                status: "completed",
                message: "Done",
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const waitCompleted = outbound.findLast(
        (message) =>
          message.method === "item/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "collabAgentToolCall" &&
          message.params.item.tool === "wait"
      ) as { params: { item: Record<string, unknown> } } | undefined;
      expect(waitCompleted?.params.item).toMatchObject({
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        agentsStates: {
          [childThreadId]: {
            status: "completed",
            message: "Done",
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          thread: {
            id: childThreadId,
            agentNickname: "Ptolemy",
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates a native Codex child nickname from session metadata when spawn output is late", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-subagent-meta-"));
    const parentSessionPath = join(directory, "parent.jsonl");
    const childSessionPath = join(directory, "child.jsonl");
    await writeFile(parentSessionPath, "", "utf8");
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child_backend_handle",
          agent_nickname: "Feynman",
          agent_role: "worker",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "codex_thread_handle",
                depth: 1,
                agent_nickname: "Feynman",
                agent_role: "worker",
              },
            },
          },
        },
      })}\n`,
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(parentSessionPath);
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the date command.",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              child_backend_handle: {
                status: "pendingInit",
                message: null,
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBeNull();

      backend.emit("child_backend_handle", {
        kind: "notification",
        threadHandle: "child_backend_handle",
        method: "thread/started",
        params: {
          thread: {
            id: "child_backend_handle",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: { type: "idle" },
            path: childSessionPath,
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

      await new Promise((resolve) => setTimeout(resolve, 10));

      const hydrated = outbound.findLast(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          message.params.thread.id === childThreadId &&
          message.params.thread.agentNickname === "Feynman"
      ) as { params: { thread: Record<string, unknown> } } | undefined;

      expect(hydrated).toMatchObject({
        params: {
          thread: {
            id: childThreadId,
            path: childSessionPath,
            modelProvider: "codex",
            agentNickname: "Feynman",
            agentRole: "worker",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.result.thread.id,
                  agent_nickname: "Feynman",
                  agent_role: "worker",
                },
              },
            },
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates a routed Codex child nickname from thread/read metadata when no child thread started event arrives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-subagent-read-"));
    const parentSessionPath = join(directory, "parent.jsonl");
    const childSessionPath = join(directory, "child.jsonl");
    await writeFile(parentSessionPath, "", "utf8");
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child_backend_handle",
          agent_nickname: "Euler",
          agent_role: "default",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "codex_thread_handle",
                depth: 1,
                agent_nickname: "Euler",
                agent_role: "default",
              },
            },
          },
        },
      })}\n`,
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(parentSessionPath);
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the date command.",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              child_backend_handle: {
                status: "pendingInit",
                message: null,
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBeNull();

      backend.threadReadOverrides.set("child_backend_handle", {
        path: childSessionPath,
        cwd: "/repo",
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          thread: {
            id: childThreadId,
            path: childSessionPath,
            agentNickname: "Euler",
            agentRole: "default",
            name: null,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.result.thread.id,
                  agent_nickname: "Euler",
                  agent_role: "default",
                },
              },
            },
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an existing routed child nickname when later thread/read metadata is null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-subagent-preserve-"));
    const parentSessionPath = join(directory, "parent.jsonl");
    await writeFile(
      parentSessionPath,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_spawn_1",
          output: JSON.stringify({
            agent_id: "child_backend_handle",
            nickname: "Ptolemy",
          }),
        },
      })}\n`,
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(parentSessionPath);
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the date command.",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              child_backend_handle: {
                status: "pendingInit",
                message: null,
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBe("Ptolemy");

      backend.threadReadOverrides.set("child_backend_handle", {
        path: null,
        cwd: "/repo",
        agentNickname: null,
        agentRole: null,
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          thread: {
            id: childThreadId,
            agentNickname: "Ptolemy",
            agentRole: "default",
            name: null,
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: started.result.thread.id,
                  agent_nickname: "Ptolemy",
                  agent_role: "default",
                },
              },
            },
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers a routed child backend title over the local nickname placeholder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-subagent-title-"));
    const parentSessionPath = join(directory, "parent.jsonl");
    await writeFile(
      parentSessionPath,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_spawn_1",
          output: JSON.stringify({
            agent_id: "child_backend_handle",
            nickname: "Ptolemy",
          }),
        },
      })}\n`,
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(parentSessionPath);
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the date command.",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              child_backend_handle: {
                status: "pendingInit",
                message: null,
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as
        | { params: { thread: { id: string; agentNickname: string | null; name: string | null } } }
        | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBe("Ptolemy");
      expect(childStarted?.params.thread.name).toBeNull();

      backend.threadReadOverrides.set("child_backend_handle", {
        title: "Check system date",
        path: null,
        cwd: "/repo",
        agentNickname: "Ptolemy",
        agentRole: "default",
      });

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          thread: {
            id: childThreadId,
            agentNickname: "Ptolemy",
            agentRole: "default",
            name: "Check system date",
          },
        },
      });

      await expect(threadRegistry.get(childThreadId)).resolves.toMatchObject({
        name: "Check system date",
        agentNickname: "Ptolemy",
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the recovered routed child nickname as a fallback name during resume only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-child-resume-name-"));
    const childSessionPath = join(directory, "child.jsonl");
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child_backend_handle",
          agent_nickname: "Euler",
          agent_role: "default",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_nickname: "Euler",
                agent_role: "default",
              },
            },
          },
        },
      })}\n`,
      "utf8"
    );

    const backend = new CodexProxyTestBackend(childSessionPath);
    backend.threadReadOverrides.set("child_backend_handle", {
      path: childSessionPath,
      cwd: "/repo",
      agentNickname: null,
      agentRole: null,
    });

    const entry = await threadRegistry.create({
      threadId: "child-thread",
      backendSessionId: "child_backend_handle",
      backendType: "codex",
      cwd: "/repo",
      preview: "Run date",
      model: "gpt-5.4-mini",
      modelProvider: "codex",
      reasoningEffort: "medium",
      name: null,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "parent-thread",
            depth: 1,
            agent_nickname: "Euler",
            agent_role: "default",
          },
        },
      },
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      path: childSessionPath,
    });

    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
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
            path: childSessionPath,
            agentNickname: "Euler",
            agentRole: "default",
            name: "Euler",
          },
        },
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("filters parent ancestry from native Codex child resume history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-native-resume-history-"));
    const parentSessionPath = join(directory, "parent.jsonl");
    const childSessionPath = join(directory, "child.jsonl");
    await writeFile(
      parentSessionPath,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_spawn_1",
            output: JSON.stringify({
              agent_id: "child_backend_handle",
              nickname: "Ptolemy",
            }),
          },
        }),
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      childSessionPath,
      [
        JSON.stringify({
          type: "turn_context",
          payload: {
            turn_id: "child_turn_1",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            turn_id: "child_turn_2",
          },
        }),
      ].join("\n"),
      "utf8"
    );

    const outbound: Array<Record<string, unknown>> = [];
    const backend = new CodexProxyTestBackend(parentSessionPath);
    backend.threadResume = async (input: { threadHandle: string; model: string | null }) => ({
      threadHandle: input.threadHandle,
      path: input.threadHandle === "child_backend_handle" ? childSessionPath : parentSessionPath,
      model: input.model,
      reasoningEffort: "medium",
    });
    backend.threadRead = async (input: { threadHandle: string }) => ({
      threadHandle: input.threadHandle,
      title: null,
      model: "gpt-5.4-mini",
      turns:
        input.threadHandle === "child_backend_handle"
          ? [
              {
                id: "parent_turn",
                status: "completed",
                error: null,
                items: [
                  {
                    type: "userMessage",
                    id: "parent_user",
                    content: [{ type: "input_text", text: "Parent prompt" }],
                  },
                ],
              },
              {
                id: "child_turn_1",
                status: "completed",
                error: null,
                items: [
                  {
                    type: "userMessage",
                    id: "child_user_1",
                    content: [{ type: "input_text", text: "Run `date`" }],
                  },
                ],
              },
              {
                id: "child_turn_2",
                status: "completed",
                error: null,
                items: [
                  {
                    type: "agentMessage",
                    id: "child_agent_2",
                    text: "Mon Mar 23 23:59:00 CDT 2026",
                    phase: null,
                  },
                ],
              },
            ]
          : [],
    });
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const connection = new AppServerConnection({
      backendRouter: new BackendRouter([backend]),
      threadRegistry,
      onMessage(message) {
        outbound.push(message as Record<string, unknown>);
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
          cwd: "/repo",
          model: "gpt-5.4-mini",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        },
      })) as { result: { thread: { id: string } } };
      const parentThreadId = started.result.thread.id;

      backend.emit("codex_thread_handle", {
        kind: "notification",
        threadHandle: "codex_thread_handle",
        method: "item/completed",
        params: {
          threadId: "codex_thread_handle",
          turnId: "turn_backend",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn_1",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "codex_thread_handle",
            receiverThreadIds: ["child_backend_handle"],
            prompt: "Run the `date` command and report back.",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              child_backend_handle: {
                status: "completed",
                message: "Done",
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const childStarted = outbound.find(
        (message) =>
          message.method === "thread/started" &&
          isRecord(message.params) &&
          isRecord(message.params.thread) &&
          isRecord(message.params.thread.source) &&
          "subAgent" in message.params.thread.source
      ) as { params: { thread: { id: string } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();

      await expect(
        connection.handleMessage({
          id: 3,
          method: "thread/resume",
          params: {
            threadId: childThreadId,
            persistExtendedHistory: false,
          },
        })
      ).resolves.toMatchObject({
        id: 3,
        result: {
          thread: {
            id: childThreadId,
            turns: [{ id: "child_turn_1" }, { id: "child_turn_2" }],
          },
        },
      });

      const resumed = (await connection.handleMessage({
        id: 4,
        method: "thread/read",
        params: {
          threadId: childThreadId,
          includeTurns: true,
        },
      })) as { result: { thread: { turns: Array<{ id: string }> } } };
      expect(resumed.result.thread.turns.map((turn) => turn.id)).toEqual([
        "child_turn_1",
        "child_turn_2",
      ]);

      const parentWait = outbound.find(
        (message) =>
          message.method === "item/completed" &&
          isRecord(message.params) &&
          isRecord(message.params.item) &&
          message.params.item.type === "collabAgentToolCall" &&
          message.params.item.tool === "spawnAgent"
      ) as { params: { item: Record<string, unknown> } } | undefined;
      expect(parentWait?.params.item).toMatchObject({
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
      });
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
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
    expect(response.result.model).toBe("gpt-5.1-codex-mini");
    expect(response.result.thread.ephemeral).toBe(true);
  });

  it("accepts legacy prefixed Codex model ids but normalizes responses to raw ids", async () => {
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
        model: "codex::gpt-5.4-mini",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
    })) as { result: { model: string } };

    expect(codexBackend.threadStartCalls).toContainEqual({
      threadId: expect.any(String),
      model: "gpt-5.4-mini",
    });
    expect(response.result.model).toBe("gpt-5.4-mini");
  });
});
