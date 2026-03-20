import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BackendEvent,
  BackendImageInput,
  BackendMessage,
  BackendModelSummary,
  BackendTokenUsage,
} from "@codapter/core";
import type { ImageContent as PiImageContent } from "../../../types/pi/packages/ai/src/types.js";
import type {
  ToolExecutionEndEvent as VendoredToolExecutionEndEvent,
  ToolExecutionStartEvent as VendoredToolExecutionStartEvent,
  ToolExecutionUpdateEvent as VendoredToolExecutionUpdateEvent,
} from "../../../types/pi/packages/coding-agent/src/core/extensions/types.js";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "../../../types/pi/packages/coding-agent/src/modes/rpc/rpc-types.js";
import { attachJsonlLineReader, parseJsonLine, serializeJsonLine } from "./jsonl.js";
import type { PiBackendSessionRecord } from "./state-store.js";

export interface PiProcessLaunchOptions {
  readonly opaqueSessionId: string;
  readonly sessionDir: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface PiProcessResponse<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

type ToolExecutionStartEvent = VendoredToolExecutionStartEvent;
type ToolExecutionUpdateEvent = VendoredToolExecutionUpdateEvent;
type ToolExecutionEndEvent = VendoredToolExecutionEndEvent;

export interface PiSessionStateSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionName: string | undefined;
  readonly modelId: string | undefined;
  readonly modelContextWindow: number | null;
}

type PendingRequest = {
  resolve: (response: PiProcessResponse) => void;
  reject: (error: Error) => void;
};

interface UpstreamModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
}

interface UpstreamSessionState {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly model?: UpstreamModel;
}

interface PiLogRecord {
  readonly at: string;
  readonly component: "pi-process";
  readonly kind: "startup" | "shutdown" | "stdin" | "stdout" | "stderr" | "parsed-event";
  readonly raw: string;
  readonly eventType?: string;
  readonly assistantEventType?: string;
  readonly emittedType?: string;
  readonly delta?: string;
  readonly pid?: number;
  readonly command?: string;
  readonly sessionId?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

class PiLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly filePath: string) {}

  write(record: PiLogRecord): void {
    if (this.failed) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });

    void this.pending.catch(() => {
      this.failed = true;
    });
  }

  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      this.failed = true;
    }
  }
}

function defaultCommand(): string {
  return "npx";
}

function defaultArgs(sessionDir: string): string[] {
  return ["--yes", "@mariozechner/pi-coding-agent", "--mode", "rpc", "--session-dir", sessionDir];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isToolExecutionStartEvent(value: unknown): value is ToolExecutionStartEvent {
  return (
    isRecord(value) &&
    value.type === "tool_execution_start" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string"
  );
}

export function isToolExecutionUpdateEvent(value: unknown): value is ToolExecutionUpdateEvent {
  return (
    isRecord(value) &&
    value.type === "tool_execution_update" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    "partialResult" in value
  );
}

export function isToolExecutionEndEvent(value: unknown): value is ToolExecutionEndEvent {
  return (
    isRecord(value) &&
    value.type === "tool_execution_end" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.isError === "boolean" &&
    "result" in value
  );
}

export function isRpcExtensionUIRequest(value: unknown): value is RpcExtensionUIRequest {
  if (!isRecord(value) || value.type !== "extension_ui_request" || typeof value.id !== "string") {
    return false;
  }

  switch (value.method) {
    case "select":
      return (
        typeof value.title === "string" &&
        Array.isArray(value.options) &&
        value.options.every((option) => typeof option === "string")
      );
    case "confirm":
      return typeof value.title === "string" && typeof value.message === "string";
    case "input":
      return typeof value.title === "string";
    case "editor":
      return typeof value.title === "string";
    case "notify":
      return typeof value.message === "string";
    case "setStatus":
      return typeof value.statusKey === "string";
    case "setWidget":
      return typeof value.widgetKey === "string";
    case "setTitle":
      return typeof value.title === "string";
    case "set_editor_text":
      return typeof value.text === "string";
    default:
      return false;
  }
}

export function isElicitationRequest(
  request: RpcExtensionUIRequest
): request is Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
> {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}

function normalizeModelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function mapTokenUsage(stats: unknown): BackendTokenUsage {
  const record = isRecord(stats) ? stats : {};
  const tokens = isRecord(record.tokens)
    ? record.tokens
    : isRecord(record.tokenUsage)
      ? record.tokenUsage
      : isRecord((record as { token_usage?: unknown }).token_usage)
        ? ((record as { token_usage?: unknown }).token_usage as Record<string, unknown>)
        : isRecord((record as { statistics?: unknown }).statistics)
          ? ((record as { statistics?: unknown }).statistics as Record<string, unknown>)
          : {};

  const parseCount = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const toTokenCount = (primary: unknown, ...fallbacks: unknown[]) => {
    const fallbackKeys = [primary, ...fallbacks];
    for (const value of fallbackKeys) {
      const parsed = parseCount(value);
      if (parsed !== 0 || value === 0) {
        return parsed;
      }
    }
    return 0;
  };

  const inputTokens = toTokenCount(
    tokens.input,
    (tokens as { inputTokens?: unknown }).inputTokens,
    (tokens as { input_tokens?: unknown }).input_tokens
  );
  const outputTokens = toTokenCount(
    tokens.output,
    (tokens as { outputTokens?: unknown }).outputTokens,
    (tokens as { output_tokens?: unknown }).output_tokens
  );
  const cacheRead = toTokenCount(
    tokens.cacheRead,
    (tokens as { cachedInputTokens?: unknown }).cachedInputTokens,
    (tokens as { cache_read?: unknown }).cache_read
  );
  const cacheWrite = toTokenCount(
    tokens.cacheWrite,
    (tokens as { cachedOutputTokens?: unknown }).cachedOutputTokens,
    (tokens as { cache_write?: unknown }).cache_write
  );
  const totalTokens = toTokenCount(
    tokens.total,
    (tokens as { totalTokens?: unknown }).totalTokens,
    (tokens as { total_tokens?: unknown }).total_tokens
  );

  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead,
    cacheWrite,
    total: totalTokens,
    modelContextWindow: null,
  };
}

function mapUpstreamModel(model: unknown, index: number): BackendModelSummary | null {
  if (!isRecord(model)) {
    return null;
  }

  const provider = typeof model.provider === "string" ? model.provider : "pi";
  const id = typeof model.id === "string" ? model.id : "unknown";
  const combinedId = normalizeModelKey(provider, id);
  const displayName =
    typeof model.name === "string" && model.name.length > 0 ? model.name : combinedId;
  const reasoning = Boolean(model.reasoning);
  const inputModalities = Array.isArray(model.input)
    ? model.input.filter((value): value is string => typeof value === "string")
    : ["text"];

  return {
    id: combinedId,
    model: combinedId,
    displayName,
    description: displayName,
    hidden: false,
    isDefault: index === 0,
    inputModalities,
    supportedReasoningEfforts: reasoning
      ? [
          {
            reasoningEffort: "minimal",
            description: "Fast responses with lighter reasoning",
          },
          {
            reasoningEffort: "low",
            description: "Balances speed with some reasoning",
          },
          {
            reasoningEffort: "medium",
            description: "Provides a solid balance of reasoning depth and latency",
          },
          {
            reasoningEffort: "high",
            description: "Greater reasoning depth for complex problems",
          },
          {
            reasoningEffort: "xhigh",
            description: "Extra high reasoning depth for complex problems",
          },
        ]
      : [
          {
            reasoningEffort: "none",
            description: "No additional reasoning",
          },
        ],
    defaultReasoningEffort: reasoning ? "medium" : "none",
    supportsPersonality: false,
  };
}

function mapMessage(message: unknown, index: number): BackendMessage {
  const record = isRecord(message) ? message : {};
  const timestamp =
    typeof record.timestamp === "number"
      ? new Date(record.timestamp).toISOString()
      : typeof record.timestamp === "string"
        ? new Date(record.timestamp).toISOString()
        : new Date().toISOString();

  return {
    id:
      typeof record.id === "string"
        ? record.id
        : typeof record.entryId === "string"
          ? record.entryId
          : `message-${index}`,
    role: typeof record.role === "string" ? record.role : "unknown",
    content:
      record.role === "toolResult"
        ? structuredClone(record)
        : typeof record.content === "string" ||
            Array.isArray(record.content) ||
            isRecord(record.content)
          ? structuredClone(record.content)
          : structuredClone(record),
    createdAt: timestamp,
    ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
    ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
  };
}

function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") {
    return null;
  }
  return message.role;
}

function messageStopReason(message: unknown): string | null {
  if (!isRecord(message) || typeof message.stopReason !== "string") {
    return null;
  }
  return message.stopReason;
}

function isToolUseAssistantMessage(message: unknown): boolean {
  return messageRole(message) === "assistant" && messageStopReason(message) === "toolUse";
}

export function mapAvailableModelsToSummaries(models: unknown): BackendModelSummary[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((model, index) => mapUpstreamModel(model, index))
    .filter((model): model is BackendModelSummary => model !== null);
}

export function mapBackendMessages(messages: unknown): BackendMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message, index) => mapMessage(message, index));
}

export function mapSessionRecordFromSnapshot(
  opaqueSessionId: string,
  snapshot: PiSessionStateSnapshot,
  createdAt: string
): PiBackendSessionRecord {
  if (!snapshot.sessionFile) {
    throw new Error("Pi session snapshot did not include a session file");
  }

  return {
    opaqueSessionId,
    sessionFile: snapshot.sessionFile,
    sessionName: snapshot.sessionName ?? null,
    modelId: snapshot.modelId ?? null,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export class PiProcessSession {
  private readonly opaqueSessionId: string;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stopReadingStdout: (() => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private requestCounter = 0;
  private currentTurnId: string | null = null;
  private currentSessionFile: string | undefined;
  private currentSessionName: string | undefined;
  private currentModelContextWindow: number | null = null;
  private readonly logWriter: PiLogWriter | null;
  private lastExitCode: number | null = null;
  private lastExitSignal: NodeJS.Signals | null = null;
  private stderr = "";

  constructor(options: PiProcessLaunchOptions) {
    this.opaqueSessionId = options.opaqueSessionId;
    this.command = options.command ?? defaultCommand();
    this.args = options.args
      ? [...options.args, "--session-dir", options.sessionDir]
      : defaultArgs(options.sessionDir);
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    const logFilePath = this.env.CODAPTER_DEBUG_LOG_FILE;
    this.logWriter =
      typeof logFilePath === "string" && logFilePath.length > 0
        ? new PiLogWriter(logFilePath)
        : null;
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  addListener(listener: (event: BackendEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  get sessionFile(): string | undefined {
    return this.currentSessionFile;
  }

  get sessionName(): string | undefined {
    return this.currentSessionName;
  }

  async startFresh(parentSession?: string): Promise<PiSessionStateSnapshot> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ cancelled: boolean }>({
      type: "new_session",
      parentSession,
    });
    if (response.data?.cancelled) {
      throw new Error("Pi new_session was cancelled");
    }

    const snapshot = await this.getState();
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async attachSession(sessionPath: string): Promise<PiSessionStateSnapshot> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ cancelled: boolean }>({
      type: "switch_session",
      sessionPath,
    });
    if (response.data?.cancelled) {
      throw new Error(`Pi switch_session was cancelled for ${sessionPath}`);
    }

    const snapshot = await this.getState();
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async forkSession(entryId: string): Promise<{ cancelled: boolean; text?: string }> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ cancelled: boolean; text?: string }>({
      type: "fork",
      entryId,
    });
    return response.data?.text === undefined
      ? { cancelled: Boolean(response.data?.cancelled) }
      : { cancelled: Boolean(response.data?.cancelled), text: response.data.text };
  }

  async prompt(
    turnId: string,
    message: string,
    images?: readonly BackendImageInput[]
  ): Promise<void> {
    await this.ensureStarted();
    this.currentTurnId = turnId;
    await this.sendRequest({ type: "prompt", message, images: await this.convertImages(images) });
  }

  async abort(): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest({ type: "abort" });
  }

  async getState(): Promise<PiSessionStateSnapshot> {
    const response = await this.sendRequest<UpstreamSessionState>({ type: "get_state" });
    const state = response.data;

    return {
      sessionId: typeof state?.sessionId === "string" ? state.sessionId : this.opaqueSessionId,
      sessionFile: typeof state?.sessionFile === "string" ? state.sessionFile : undefined,
      sessionName: typeof state?.sessionName === "string" ? state.sessionName : undefined,
      modelId: parseStateModelId(state?.model),
      modelContextWindow: parseStateModelContextWindow(state?.model),
    };
  }

  async setSessionName(name: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest({ type: "set_session_name", name });
    this.currentSessionName = name;
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ model?: UpstreamModel }>({
      type: "set_model",
      provider,
      modelId,
    });
    const model = parseUpstreamModelFromResponse(response.data);
    this.currentModelContextWindow = model
      ? parseStateModelContextWindow(model)
      : this.currentModelContextWindow;
    return response.data;
  }

  async getAvailableModels(): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ models: unknown[] }>({
      type: "get_available_models",
    });
    return response.data?.models ?? [];
  }

  async getMessages(): Promise<BackendMessage[]> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ messages: unknown[] }>({ type: "get_messages" });
    return mapBackendMessages(response.data?.messages ?? []);
  }

  async getSessionStats(): Promise<BackendTokenUsage> {
    await this.ensureStarted();
    const response = await this.sendRequest<unknown>({ type: "get_session_stats" });
    return {
      ...mapTokenUsage(response.data),
      modelContextWindow: this.currentModelContextWindow,
    };
  }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ messages: Array<{ entryId: string; text: string }> }>(
      {
        type: "get_fork_messages",
      }
    );
    return response.data?.messages ?? [];
  }

  async respondToElicitation(requestId: string, responseValue: unknown): Promise<void> {
    await this.ensureStarted();
    const response = normalizeElicitationResponse(requestId, responseValue);
    this.writeLine(response);
  }

  async dispose(): Promise<void> {
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    if (this.process) {
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5000);

        this.process?.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.process = null;
    this.pending.clear();
    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "shutdown",
      raw: "",
      exitCode: this.lastExitCode,
      signal: this.lastExitSignal,
      sessionId: this.opaqueSessionId,
    });
    await this.logWriter?.flush();
  }

  getStderr(): string {
    return this.stderr;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.command, this.args as string[], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "stderr",
        raw: chunk.toString(),
      });
    });

    this.process.once("exit", (code, signal) => {
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      const error = new Error(
        `Pi process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.process = null;
      this.stopReadingStdout?.();
      this.stopReadingStdout = null;
    });

    this.stopReadingStdout = attachJsonlLineReader(this.process.stdout, (line) => {
      void this.handleLine(line);
    });

    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "startup",
      ...(this.process.pid !== undefined ? { pid: this.process.pid } : {}),
      command: this.command,
      sessionId: this.opaqueSessionId,
      raw: "",
    });

    await this.sendRequest({ type: "get_state" });
  }

  private async handleLine(line: string): Promise<void> {
    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "stdout",
      raw: line,
    });

    let parsed: unknown;
    try {
      parsed = parseJsonLine(line);
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    if (parsed.type === "response" && typeof parsed.command === "string") {
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      if (!id) {
        return;
      }

      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }

      this.pending.delete(id);
      if (parsed.success) {
        pending.resolve({ success: true, data: parsed.data });
      } else {
        pending.reject(
          new Error(typeof parsed.error === "string" ? parsed.error : "Pi RPC failed")
        );
      }
      return;
    }

    this.handleEvent(parsed);
  }

  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "turn_start":
        return;
      case "turn_end":
        if (isToolUseAssistantMessage(event.message)) {
          return;
        }
        this.emitTokenUsage(this.currentTurnId ?? "unknown");
        this.currentTurnId = null;
        return;
      case "message_update":
        this.emitMessageUpdate(event);
        return;
      case "message_end":
        if (messageRole(event.message) !== "assistant") {
          return;
        }
        if (isToolUseAssistantMessage(event.message)) {
          return;
        }
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "message_end",
        });
        return;
      case "tool_execution_start":
        if (!isToolExecutionStartEvent(event)) {
          this.logWriter?.write({
            at: new Date().toISOString(),
            component: "pi-process",
            kind: "parsed-event",
            eventType: "tool_execution_start",
            raw: JSON.stringify(event),
          });
          return;
        }
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
        });
        return;
      case "tool_execution_update":
        if (!isToolExecutionUpdateEvent(event)) {
          this.logWriter?.write({
            at: new Date().toISOString(),
            component: "pi-process",
            kind: "parsed-event",
            eventType: "tool_execution_update",
            raw: JSON.stringify(event),
          });
          return;
        }
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.partialResult,
          isCumulative: true,
        });
        return;
      case "tool_execution_end":
        if (!isToolExecutionEndEvent(event)) {
          this.logWriter?.write({
            at: new Date().toISOString(),
            component: "pi-process",
            kind: "parsed-event",
            eventType: "tool_execution_end",
            raw: JSON.stringify(event),
          });
          return;
        }
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.result,
          isError: event.isError,
        });
        return;
      case "extension_ui_request":
        if (isRpcExtensionUIRequest(event) && isElicitationRequest(event)) {
          this.emit({
            sessionId: this.opaqueSessionId,
            turnId: this.currentTurnId ?? "unknown",
            type: "elicitation_request",
            requestId: event.id,
            payload: event,
          });
        }
        return;
      case "extension_error":
      case "error":
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "error",
          message: String(event.error ?? event.message ?? "Pi runtime error"),
        });
        return;
      case "agent_end":
        this.currentTurnId = null;
        return;
      default:
        return;
    }
  }

  private emitMessageUpdate(event: Record<string, unknown>): void {
    const assistantEvent = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : undefined;
    if (!assistantEvent || typeof assistantEvent.type !== "string") {
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        raw: JSON.stringify(event),
      });
      return;
    }

    if (assistantEvent.type === "text_delta") {
      const delta = String(assistantEvent.delta ?? "");
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "text_delta",
        delta,
        raw: JSON.stringify(event),
      });
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId ?? "unknown",
        type: "text_delta",
        delta,
      });
      return;
    }

    if (assistantEvent.type === "thinking_delta") {
      const delta = String(assistantEvent.delta ?? "");
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "thinking_delta",
        delta,
        raw: JSON.stringify(event),
      });
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId ?? "unknown",
        type: "thinking_delta",
        delta,
      });
      return;
    }

    if (assistantEvent.type === "error") {
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "error",
        raw: JSON.stringify(event),
      });
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId ?? "unknown",
        type: "error",
        message: String(assistantEvent.errorMessage ?? "Pi assistant error"),
      });
      return;
    }

    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "parsed-event",
      eventType: "message_update",
      assistantEventType: assistantEvent.type,
      raw: JSON.stringify(event),
    });
  }

  private emitTokenUsage(turnId: string): void {
    void this.getSessionStats()
      .then((usage) => {
        this.logWriter?.write({
          at: new Date().toISOString(),
          component: "pi-process",
          kind: "parsed-event",
          eventType: "token_usage",
          raw: JSON.stringify({ turnId, usage }),
        });
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId,
          type: "token_usage",
          usage,
        });
      })
      .catch(() => {
        this.logWriter?.write({
          at: new Date().toISOString(),
          component: "pi-process",
          kind: "parsed-event",
          eventType: "token_usage",
          raw: JSON.stringify({
            turnId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
              modelContextWindow: this.currentModelContextWindow,
            },
            fallback: true,
          }),
        });
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId,
          type: "token_usage",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            modelContextWindow: this.currentModelContextWindow,
          },
        });
      });
  }

  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async sendRequest<T = unknown>(
    command: Record<string, unknown>
  ): Promise<PiProcessResponse<T>> {
    await this.ensureStarted();
    const id = `${Date.now()}-${++this.requestCounter}-${randomUUID()}`;
    const payload = { id, ...command };

    return await new Promise<PiProcessResponse<T>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) => resolve(response as PiProcessResponse<T>),
        reject,
      });

      try {
        this.writeLine(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeLine(value: unknown): void {
    if (!this.process) {
      throw new Error("Pi process is not running");
    }

    const line = serializeJsonLine(value);
    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "stdin",
      raw: line.trimEnd(),
    });
    this.process.stdin.write(line);
  }

  private applySnapshot(snapshot: PiSessionStateSnapshot): void {
    this.currentSessionFile = snapshot.sessionFile;
    this.currentSessionName = snapshot.sessionName;
    this.currentModelContextWindow = snapshot.modelContextWindow;
  }

  private async convertImages(
    images?: readonly BackendImageInput[]
  ): Promise<readonly PiImageContent[] | undefined> {
    if (!images || images.length === 0) {
      return undefined;
    }

    const converted = await Promise.all(
      images.map(async (image) => {
        if (typeof image.data === "string" && image.data.length > 0) {
          return {
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType ?? "image/png",
          };
        }

        if (typeof image.path === "string" && image.path.length > 0) {
          const buffer = await readFile(image.path);
          return {
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType: image.mimeType ?? "image/png",
          };
        }

        if (typeof image.url === "string" && image.url.length > 0) {
          const response = await fetch(image.url);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType: image.mimeType ?? response.headers.get("content-type") ?? "image/png",
          };
        }

        throw new Error("Pi backend requires image data, file path, or URL");
      })
    );

    return converted;
  }
}

function parseStateModelId(model: UpstreamModel | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  return normalizeModelKey(model.provider, model.id);
}

function parseStateModelContextWindow(model: UpstreamModel | undefined): number | null {
  if (!model) {
    return null;
  }
  return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
    ? model.contextWindow
    : null;
}

function isUpstreamModel(value: unknown): value is UpstreamModel {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}

function parseUpstreamModelFromResponse(value: unknown): UpstreamModel | undefined {
  if (isRecord(value) && isUpstreamModel(value.model)) {
    return value.model;
  }
  if (isUpstreamModel(value)) {
    return value;
  }
  return undefined;
}

export function normalizeElicitationResponse(
  requestId: string,
  responseValue: unknown
): RpcExtensionUIResponse {
  if (typeof responseValue === "string") {
    return { type: "extension_ui_response", id: requestId, value: responseValue };
  }

  if (typeof responseValue === "boolean") {
    return { type: "extension_ui_response", id: requestId, confirmed: responseValue };
  }

  if (isRecord(responseValue)) {
    if (responseValue.cancelled === true) {
      return { type: "extension_ui_response", id: requestId, cancelled: true as const };
    }

    if (typeof responseValue.value === "string") {
      return { type: "extension_ui_response", id: requestId, value: responseValue.value };
    }

    if (typeof responseValue.confirmed === "boolean") {
      return { type: "extension_ui_response", id: requestId, confirmed: responseValue.confirmed };
    }
  }

  throw new Error("Unsupported Pi elicitation response shape");
}
