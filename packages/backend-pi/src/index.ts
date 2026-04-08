import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BackendAppServerEvent,
  BackendCapabilities,
  BackendEvent,
  BackendImageInput,
  BackendMessage,
  BackendModelSummary,
  BackendResolveServerRequestInput,
  BackendSessionLaunchConfig,
  BackendThreadArchiveInput,
  BackendThreadForkInput,
  BackendThreadForkResult,
  BackendThreadReadInput,
  BackendThreadReadResult,
  BackendThreadResumeInput,
  BackendThreadResumeResult,
  BackendThreadSetNameInput,
  BackendThreadStartInput,
  BackendThreadStartResult,
  BackendTurnInterruptInput,
  BackendTurnStartInput,
  BackendTurnStartResult,
  Disposable,
  IBackend,
} from "@codapter/core";
import {
  BackendThreadEventBuffer,
  TurnStateMachine,
  parseBackendModelId,
  toThreadTokenUsage,
} from "@codapter/core";
import {
  type PiProcessLaunchOptions,
  PiProcessSession,
  type PiSessionStateSnapshot,
  mapAvailableModelsToSummaries,
  mapSessionRecordFromSnapshot,
} from "./pi-process.js";
import { type PiBackendSessionRecord, PiBackendStateStore } from "./state-store.js";

export interface PiBackendOptions {
  readonly sessionDir?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly debugLogFilePath?: string | null;
  readonly idleTimeoutMs?: number;
  readonly collabExtensionPath?: string | null;
  readonly staticAvailableModelsPath?: string | null;
}

interface ManagedSession {
  readonly process: PiProcessSession;
  record: PiBackendSessionRecord;
}

interface PiThreadRuntime {
  threadId: string;
  activeTurnId: string | null;
  machine: TurnStateMachine | null;
  pendingElicitationPayloads: Map<string, unknown>;
  processSubscription: Disposable | null;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  requiresAuth: false,
  supportsImages: true,
  supportsThinking: true,
  supportsParallelTools: true,
  supportedToolTypes: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSessionDir(): string {
  return join(homedir(), ".local", "share", "codapter", "backend-pi");
}

function cloneMessage(message: BackendMessage): BackendMessage {
  return {
    ...message,
    content: structuredClone(message.content),
  };
}

function cloneMessages(messages: readonly BackendMessage[]): BackendMessage[] {
  return messages.map(cloneMessage);
}

function cloneModels(models: readonly BackendModelSummary[]): BackendModelSummary[] {
  return models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
}

function cloneCapabilities(capabilities: BackendCapabilities): BackendCapabilities {
  return {
    ...capabilities,
    supportedToolTypes: [...capabilities.supportedToolTypes],
  };
}

function opaqueSessionId(): string {
  return `pi_session_${randomUUID()}`;
}

function toRequestedModelCandidates(modelId: string): string[] {
  if (modelId.includes("/")) {
    return [modelId];
  }

  return [modelId, `openai-codex/${modelId}`];
}

function toUserMessageContent(input: BackendTurnStartInput["input"]) {
  return input.map((item) => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text };
      case "image":
        return { type: "image", url: item.url };
      case "localImage":
        return { type: "localImage", path: item.path };
      case "skill":
        return { type: "skill", name: item.name, path: item.path };
      case "mention":
        return { type: "mention", name: item.name, path: item.path };
    }
  });
}

function normalizeTurnInput(input: BackendTurnStartInput["input"]): {
  text: string;
  images: BackendImageInput[];
} {
  const textParts: string[] = [];
  const images: BackendImageInput[] = [];
  for (const item of input) {
    switch (item.type) {
      case "text":
        textParts.push(item.text);
        break;
      case "image":
        images.push({ type: "image", url: item.url });
        break;
      case "localImage":
        images.push({ type: "localImage", path: item.path });
        break;
      case "skill":
      case "mention":
        throw new Error(`Unsupported Pi turn input type: ${item.type}`);
    }
  }
  return {
    text: textParts.join("\n").trim(),
    images,
  };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeHistoryContentEntry(entry: unknown): Record<string, unknown> {
  if (isRecord(entry)) {
    return structuredClone(entry);
  }
  return {
    type: "text",
    text: textFromUnknown(entry),
  };
}

function userMessageContentFromHistory(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeHistoryContentEntry(entry));
  }
  if (isRecord(value)) {
    return [structuredClone(value)];
  }
  return [
    {
      type: "text",
      text: textFromUnknown(value),
    },
  ];
}

function textFromHistoryContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => textFromHistoryContent(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  if (Array.isArray(value.content)) {
    return textFromHistoryContent(value.content);
  }
  return "";
}

function inferToolCommand(input: unknown): string {
  if (isRecord(input)) {
    const command = input.command;
    if (typeof command === "string") {
      return command;
    }
    if (Array.isArray(command)) {
      return command.filter((entry): entry is string => typeof entry === "string").join(" ");
    }
  }
  return textFromUnknown(input);
}

function toolCallCommandFromHistory(block: Record<string, unknown>): string {
  const fallbackName = typeof block.name === "string" ? block.name : "tool";
  const command = inferToolCommand(block.arguments);
  if (command.length === 0) {
    return fallbackName;
  }
  if (isRecord(block.arguments) && "command" in block.arguments) {
    return command;
  }
  return `${fallbackName} ${command}`;
}

function mapHistoryToTurns(history: readonly BackendMessage[]) {
  const turns: Array<{
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  }> = [];
  let current: {
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  } | null = null;
  const pendingToolItems = new Map<string, Record<string, unknown>>();

  const ensureTurn = (fallbackId: string) => {
    if (current) {
      return current;
    }
    current = {
      id: fallbackId,
      items: [],
      status: "completed",
      error: null,
    };
    turns.push(current);
    pendingToolItems.clear();
    return current;
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
    current = null;
  };

  for (const message of history) {
    if (message.role === "user") {
      finalizeTurn();
      const turn = ensureTurn(message.id);
      turn.items.push({
        type: "userMessage",
        id: `${message.id}_user`,
        content: userMessageContentFromHistory(message.content),
      });
      continue;
    }

    const turn = ensureTurn(message.id);
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      for (const [index, block] of blocks.entries()) {
        if (!isRecord(block)) {
          const text = textFromHistoryContent(block);
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
            command: toolCallCommandFromHistory(block),
            cwd: "",
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

        const text = textFromHistoryContent(block);
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
      const outputText = textFromHistoryContent(payload.content);
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

    const text = textFromHistoryContent(message.content);
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

function userMessageContentFromTurn(turn: {
  readonly items?: readonly Record<string, unknown>[];
}): unknown[] | null {
  const item = turn.items?.find((entry) => entry.type === "userMessage");
  if (!item || !Array.isArray(item.content)) {
    return null;
  }
  return item.content;
}

function historyTailDuplicatesLiveTurn(
  turns: readonly {
    readonly items: readonly Record<string, unknown>[];
    readonly status: string;
  }[],
  liveTurn: {
    readonly items?: readonly Record<string, unknown>[];
    readonly status?: string;
  }
): boolean {
  if (liveTurn.status !== "inProgress") {
    return false;
  }

  const trailingTurn = turns.at(-1);
  if (!trailingTurn || trailingTurn.status !== "completed") {
    return false;
  }

  if (trailingTurn.items.some((item) => item.type !== "userMessage")) {
    return false;
  }

  const trailingUserContent = userMessageContentFromTurn(trailingTurn);
  const liveUserContent = userMessageContentFromTurn(liveTurn);
  if (!trailingUserContent || !liveUserContent) {
    return false;
  }

  return JSON.stringify(trailingUserContent) === JSON.stringify(liveUserContent);
}

function mergeHistoryTurnsWithLiveTurn(
  turns: Array<{
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  }>,
  liveTurn: {
    readonly items?: readonly Record<string, unknown>[];
    readonly status?: string;
  }
): typeof turns {
  if (historyTailDuplicatesLiveTurn(turns, liveTurn)) {
    return turns.slice(0, -1);
  }
  return turns;
}

export class PiBackend implements IBackend {
  public readonly backendType = "pi";
  public readonly sessionDir: string;

  private readonly launchOptions: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  };
  private readonly idleTimeoutMs: number;
  private readonly stateStore: PiBackendStateStore;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly modelCache = new Map<string, BackendModelSummary>();
  private modelListPromise: Promise<BackendModelSummary[]> | null = null;
  private readonly launchConfigs = new Map<string, BackendSessionLaunchConfig>();
  private readonly eventBuffer = new BackendThreadEventBuffer();
  private readonly threadRuntimes = new Map<string, PiThreadRuntime>();
  private initialized = false;
  private disposed = false;
  private capabilities: BackendCapabilities | null = null;
  private readonly collabExtensionPath: string | null;
  private readonly staticAvailableModelsPath: string | null;

  constructor(options: PiBackendOptions = {}) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    const launchOptions: {
      command?: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    } = {};
    if (options.command !== undefined) {
      launchOptions.command = options.command;
    }
    if (options.args !== undefined) {
      launchOptions.args = options.args;
    }
    if (options.env !== undefined) {
      launchOptions.env = options.env;
    }
    if (options.cwd !== undefined) {
      launchOptions.cwd = options.cwd;
    }
    if (options.debugLogFilePath !== undefined) {
      launchOptions.env = {
        ...(launchOptions.env ?? {}),
        CODAPTER_DEBUG_LOG_FILE: options.debugLogFilePath ?? "",
      };
    }
    this.launchOptions = launchOptions;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.collabExtensionPath = options.collabExtensionPath ?? null;
    this.staticAvailableModelsPath = options.staticAvailableModelsPath ?? null;
    this.stateStore = new PiBackendStateStore(this.sessionDir);
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    await this.stateStore.load();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    const disposals = Array.from(this.sessions.values(), async (session) => {
      await session.process.dispose().catch(() => {});
    });
    await Promise.all(disposals);

    this.sessions.clear();
    this.modelCache.clear();
    this.modelListPromise = null;
    for (const runtime of this.threadRuntimes.values()) {
      runtime.processSubscription?.dispose();
    }
    this.threadRuntimes.clear();
  }

  isAlive(): boolean {
    return this.initialized && !this.disposed;
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

  async threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.createSession(launchConfig);
    if (input.model) {
      await this.setModel(threadHandle, input.model);
    }
    this.ensureThreadRuntime(threadHandle, input.threadId);
    return {
      threadHandle,
      path: await this.getSessionPath(threadHandle),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.resumeSession(input.threadHandle, launchConfig);
    if (input.model) {
      await this.setModel(threadHandle, input.model);
    }
    this.ensureThreadRuntime(threadHandle, input.threadId);
    return {
      threadHandle,
      path: await this.getSessionPath(threadHandle),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.forkSession(input.sourceThreadHandle, launchConfig);
    if (input.model) {
      await this.setModel(threadHandle, input.model);
    }
    this.ensureThreadRuntime(threadHandle, input.threadId);
    return {
      threadHandle,
      path: await this.getSessionPath(threadHandle),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult> {
    let turns = input.includeTurns
      ? mapHistoryToTurns(await this.readSessionHistory(input.threadHandle))
      : [];
    const runtime = this.threadRuntimes.get(input.threadHandle);
    if (input.includeTurns && runtime?.machine) {
      turns = mergeHistoryTurnsWithLiveTurn(
        turns,
        runtime.machine.snapshot as unknown as {
          readonly items?: readonly Record<string, unknown>[];
          readonly status?: string;
        }
      );
      turns.push(runtime.machine.snapshot as unknown as (typeof turns)[number]);
    }
    const record = await this.requireRecord(input.threadHandle);
    return {
      threadHandle: input.threadHandle,
      title: record.sessionName,
      model: record.modelId,
      turns: turns as unknown as BackendThreadReadResult["turns"],
    };
  }

  async threadArchive(input: BackendThreadArchiveInput): Promise<void> {
    await this.disposeSession(input.threadHandle);
    const runtime = this.threadRuntimes.get(input.threadHandle);
    runtime?.processSubscription?.dispose();
    this.threadRuntimes.delete(input.threadHandle);
  }

  async threadSetName(input: BackendThreadSetNameInput): Promise<void> {
    await this.setSessionName(input.threadHandle, input.name);
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    const runtime = this.ensureThreadRuntime(input.threadHandle, input.threadId);
    runtime.activeTurnId = input.turnId;
    runtime.machine = new TurnStateMachine(input.threadId, input.turnId, input.cwd, {
      notify: async (method, params) => {
        this.eventBuffer.emit(input.threadHandle, {
          kind: "notification",
          threadHandle: input.threadHandle,
          method,
          params,
        });
      },
    });
    await runtime.machine.emitStarted();
    const userContent = toUserMessageContent(input.input);
    if (userContent.length > 0) {
      await runtime.machine.emitUserMessage(userContent as never, {
        notify: input.emitUserMessage ?? false,
      });
    }

    if (input.model) {
      await this.setModel(input.threadHandle, input.model);
    }

    const normalized = normalizeTurnInput(input.input);
    await this.prompt(input.threadHandle, input.turnId, normalized.text, normalized.images);
    return {
      accepted: true,
      turnId: input.turnId,
    };
  }

  async turnInterrupt(input: BackendTurnInterruptInput): Promise<void> {
    await this.abort(input.threadHandle);
    const runtime = this.threadRuntimes.get(input.threadHandle);
    if (runtime?.machine && runtime.activeTurnId === input.turnId) {
      await runtime.machine.interrupt();
      runtime.machine = null;
      runtime.activeTurnId = null;
    }
  }

  async resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void> {
    const runtime = this.threadRuntimes.get(input.threadHandle);
    const payload = runtime?.pendingElicitationPayloads.get(String(input.requestId));
    runtime?.pendingElicitationPayloads.delete(String(input.requestId));
    await this.respondToElicitation(
      input.threadHandle,
      String(input.requestId),
      (input.response as { result?: unknown })?.result ?? payload ?? { cancelled: true }
    );
  }

  async createSession(config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const sessionId = opaqueSessionId();
    const process = this.createProcess(sessionId, config);
    const snapshot = await process.startFresh();
    const record = await this.persistSnapshot(sessionId, snapshot);
    const session = { process, record };
    this.sessions.set(sessionId, session);
    if (config) {
      this.launchConfigs.set(sessionId, config);
    }
    this.resetIdleTimer(sessionId);

    return sessionId;
  }

  async resumeSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    if (config) {
      this.launchConfigs.set(sessionId, config);
    }
    await this.ensureActiveSession(sessionId);
    this.resetIdleTimer(sessionId);
    return sessionId;
  }

  async forkSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const source = await this.ensureActiveSession(sessionId);
    if (!source.record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const forkedSessionId = opaqueSessionId();
    const process = this.createProcess(forkedSessionId, config);
    await process.attachSession(source.record.sessionFile);

    const anchors = await process.getForkMessages();
    const entryId = anchors.at(-1)?.entryId;
    if (!entryId) {
      throw new Error(`Pi session has no fork anchor: ${sessionId}`);
    }

    const forkResult = await process.forkSession(entryId);
    if (forkResult.cancelled) {
      throw new Error(`Pi fork was cancelled for session ${sessionId}`);
    }

    const snapshot = await process.getState();
    const record = await this.persistSnapshot(forkedSessionId, snapshot, source.record.createdAt);
    const session = { process, record };
    this.sessions.set(forkedSessionId, session);
    if (config) {
      this.launchConfigs.set(forkedSessionId, config);
    }
    this.resetIdleTimer(forkedSessionId);
    return forkedSessionId;
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.assertReady();
    await this.requireRecord(sessionId);
    this.clearIdleTimer(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      await session.process.dispose().catch(() => {});
      this.sessions.delete(sessionId);
    }
    this.launchConfigs.delete(sessionId);
    const runtime = this.threadRuntimes.get(sessionId);
    runtime?.processSubscription?.dispose();
    this.threadRuntimes.delete(sessionId);
  }

  async readSessionHistory(sessionId: string): Promise<BackendMessage[]> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session?.process.isRunning()) {
      this.resetIdleTimer(sessionId);
      return cloneMessages(await session.process.getMessages());
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const reader = this.createProcess(`read:${sessionId}`);
    try {
      await reader.attachSession(record.sessionFile);
      return cloneMessages(await reader.getMessages());
    } finally {
      await reader.dispose().catch(() => {});
    }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setSessionName(name);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      sessionName: name,
      updatedAt: nowIso(),
    });
  }

  async getSessionPath(sessionId: string): Promise<string | null> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.record.sessionFile;
    }

    const record = await this.requireRecord(sessionId);
    return record.sessionFile;
  }

  async prompt(
    sessionId: string,
    turnId: string,
    text: string,
    images?: readonly BackendImageInput[]
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);

    await session.process.prompt(turnId, text, images);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async abort(sessionId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.abort();
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async listModels(): Promise<BackendModelSummary[]> {
    this.assertReady();
    if (this.modelCache.size > 0) {
      return cloneModels([...this.modelCache.values()]);
    }

    if (this.modelListPromise) {
      return cloneModels(await this.modelListPromise);
    }

    try {
      this.modelListPromise = this.loadAvailableModels();
      return cloneModels(await this.modelListPromise);
    } finally {
      this.modelListPromise = null;
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    const resolved = await this.resolveModel(modelId);
    await session.process.setModel(resolved.provider, resolved.modelId);
  }

  async getCapabilities(): Promise<BackendCapabilities> {
    this.assertReady();
    if (!this.capabilities) {
      this.capabilities = cloneCapabilities(DEFAULT_CAPABILITIES);
    }
    return cloneCapabilities(this.capabilities);
  }

  async respondToElicitation(
    sessionId: string,
    requestId: string,
    response: unknown
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.respondToElicitation(requestId, response);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    this.assertReady();
    this.ensureThreadRuntime(threadHandle);
    return this.eventBuffer.subscribe(threadHandle, listener);
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    if (this.idleTimeoutMs <= 0 || this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      void this.disposeIdleSession(sessionId);
    }, this.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(sessionId);
    }
  }

  private async disposeIdleSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    console.error(`[codapter] Idle timeout: disposing Pi session ${sessionId}`);
    await session.process.dispose().catch(() => {});
    this.sessions.delete(sessionId);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Pi backend has been disposed");
    }
  }

  private assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) {
      throw new Error("Pi backend must be initialized before use");
    }
  }

  private createProcess(
    sessionId: string,
    launchConfig?: BackendSessionLaunchConfig
  ): PiProcessSession {
    const effectiveLaunchConfig = launchConfig ?? this.launchConfigs.get(sessionId);
    const options: PiProcessLaunchOptions = {
      sessionDir: this.sessionDir,
      opaqueSessionId: sessionId,
      ...this.launchOptions,
      ...(effectiveLaunchConfig?.cwd ? { cwd: effectiveLaunchConfig.cwd } : {}),
      ...(this.collabExtensionPath !== null
        ? { collabExtensionPath: this.collabExtensionPath }
        : {}),
      ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
    };

    return new PiProcessSession(options);
  }

  private async ensureActiveSession(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing?.process.isRunning()) {
      return existing;
    }

    if (existing) {
      await existing.process.dispose().catch(() => {});
      this.sessions.delete(sessionId);
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const process = this.createProcess(sessionId);
    await process.attachSession(record.sessionFile);
    const snapshot = await process.getState();
    const nextRecord = await this.persistSnapshot(sessionId, snapshot, record.createdAt);
    const session = { process, record: nextRecord };
    this.sessions.set(sessionId, session);

    return session;
  }

  private ensureThreadRuntime(threadHandle: string, threadId = threadHandle): PiThreadRuntime {
    const existing = this.threadRuntimes.get(threadHandle);
    if (existing) {
      existing.threadId = threadId;
      if (!existing.processSubscription) {
        existing.processSubscription = this.subscribeProcessEvents(threadHandle);
      }
      return existing;
    }

    const runtime: PiThreadRuntime = {
      threadId,
      activeTurnId: null,
      machine: null,
      pendingElicitationPayloads: new Map(),
      processSubscription: null,
    };
    this.threadRuntimes.set(threadHandle, runtime);
    runtime.processSubscription = this.subscribeProcessEvents(threadHandle);
    return runtime;
  }

  private subscribeProcessEvents(threadHandle: string): Disposable {
    const wrappedListener = (event: BackendEvent) => {
      this.resetIdleTimer(threadHandle);
      void this.handleProcessEvent(threadHandle, event);
    };

    const session = this.sessions.get(threadHandle);
    if (session?.process.isRunning()) {
      return session.process.addListener(wrappedListener);
    }

    let disposed = false;
    let listenerDisposable: Disposable | null = null;
    const disposable: Disposable = {
      dispose(): void {
        disposed = true;
        listenerDisposable?.dispose();
      },
    };

    void this.ensureActiveSession(threadHandle).then((active) => {
      if (!disposed) {
        listenerDisposable = active.process.addListener(wrappedListener);
      } else {
        listenerDisposable?.dispose();
      }
    });

    return disposable;
  }

  private async handleProcessEvent(threadHandle: string, event: BackendEvent): Promise<void> {
    const runtime = this.threadRuntimes.get(threadHandle);
    if (!runtime) {
      return;
    }

    if (event.type === "token_usage") {
      this.eventBuffer.emit(threadHandle, {
        kind: "notification",
        threadHandle,
        method: "thread/tokenUsage/updated",
        params: {
          threadId: runtime.threadId,
          turnId: event.turnId,
          tokenUsage: toThreadTokenUsage(event.usage),
        },
      });
      return;
    }

    if (event.type === "elicitation_request") {
      runtime.pendingElicitationPayloads.set(event.requestId, event.payload);
      this.eventBuffer.emit(threadHandle, {
        kind: "serverRequest",
        threadHandle,
        requestId: event.requestId,
        method: "item/tool/requestUserInput",
        params: event.payload,
      });
      return;
    }

    if (!runtime.machine || runtime.activeTurnId !== event.turnId) {
      return;
    }

    const completed = await runtime.machine.handleEvent(event);
    if (completed) {
      runtime.machine = null;
      runtime.activeTurnId = null;
    }
  }

  private async requireRecord(sessionId: string): Promise<PiBackendSessionRecord> {
    const record = await this.stateStore.get(sessionId);
    if (!record) {
      throw new Error(`Unknown Pi session: ${sessionId}`);
    }
    return record;
  }

  private async persistSnapshot(
    sessionId: string,
    snapshot: PiSessionStateSnapshot,
    createdAt?: string
  ): Promise<PiBackendSessionRecord> {
    const record = mapSessionRecordFromSnapshot(sessionId, snapshot, createdAt ?? nowIso());
    await this.stateStore.upsert(record);
    return record;
  }

  private async updateRecord(
    sessionId: string,
    patch: Partial<Omit<PiBackendSessionRecord, "opaqueSessionId" | "createdAt">>
  ): Promise<PiBackendSessionRecord> {
    return await this.stateStore.update(sessionId, patch);
  }

  private async resolveModel(
    modelId: string
  ): Promise<{ id: string; provider: string; modelId: string }> {
    if (this.modelCache.size === 0) {
      await this.listModels();
    }

    const model = toRequestedModelCandidates(modelId)
      .map((candidate) => this.modelCache.get(candidate))
      .find((candidate) => candidate !== undefined);
    if (!model) {
      throw new Error(`Unknown Pi model: ${modelId}`);
    }

    const provider = model.model.split("/")[0] ?? "";
    const rawModelId = model.model.split("/")[1] ?? model.model;
    return {
      id: model.id,
      provider,
      modelId: rawModelId,
    };
  }

  private async loadStaticModels(filePath: string): Promise<BackendModelSummary[]> {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const models = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : [];
    return mapAvailableModelsToSummaries(models);
  }

  private async loadAvailableModels(): Promise<BackendModelSummary[]> {
    if (this.staticAvailableModelsPath) {
      const summaries = await this.loadStaticModels(this.staticAvailableModelsPath);
      this.replaceModelCache(summaries);
      return summaries;
    }

    const probe = this.createProcess(`models:${randomUUID()}`);
    try {
      const models = await probe.getAvailableModels();
      const summaries = mapAvailableModelsToSummaries(models);
      this.replaceModelCache(summaries);
      return summaries;
    } finally {
      await probe.dispose().catch(() => {});
    }
  }

  private replaceModelCache(models: readonly BackendModelSummary[]): void {
    this.modelCache.clear();
    for (const model of models) {
      this.modelCache.set(model.id, model);
    }
  }
}

export function createPiBackend(options: PiBackendOptions = {}): PiBackend {
  return new PiBackend(options);
}
