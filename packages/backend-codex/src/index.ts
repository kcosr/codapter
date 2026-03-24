import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  BackendAppServerEvent,
  BackendModelSummary,
  BackendResolveServerRequestInput,
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
  ParsedBackendSelection,
} from "@codapter/core";
import { BackendThreadEventBuffer, parseBackendModelId } from "@codapter/core";
import type { JsonRpcId } from "@codapter/core";

interface JsonRpcResponse {
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface CodexBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly transport?: "stdio" | "websocket";
  readonly websocketUrl?: string;
  readonly stderr?: NodeJS.WritableStream | null;
}

const DEFAULT_INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codapter-backend-codex",
    title: "codapter backend codex",
    version: "0.0.1",
  },
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: [],
  },
};
const WEBSOCKET_DEFERRED_MESSAGE = "Codex websocket transport is deferred in this implementation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawModelId(value: string): string {
  const parsed = parseBackendModelId(value);
  return parsed?.rawModelId ?? value;
}

function mergeConfig(
  config: Record<string, unknown> | null | undefined,
  reasoningEffort: string | null | undefined
): Record<string, unknown> | null {
  const merged = config ? { ...config } : {};
  if (reasoningEffort) {
    merged.model_reasoning_effort = reasoningEffort;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function inferThreadHandle(method: string, params: unknown): string | null {
  if (isRecord(params) && typeof params.threadId === "string" && params.threadId.length > 0) {
    return params.threadId;
  }
  if (isRecord(params) && isRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }
  if (method === "thread/started" && isRecord(params) && isRecord(params.thread)) {
    return typeof params.thread.id === "string" ? params.thread.id : null;
  }
  return null;
}

function rewriteInboundModelFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteInboundModelFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string") {
      rewritten[key] = rawModelId(entry);
      continue;
    }
    rewritten[key] = rewriteInboundModelFields(entry);
  }
  return rewritten;
}

export class CodexBackend implements IBackend {
  public readonly backendType = "codex";

  private readonly command: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly transport: "stdio" | "websocket";
  private readonly websocketUrl: string | null;
  private readonly stderrSink: NodeJS.WritableStream | null;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly eventBuffer = new BackendThreadEventBuffer();
  private readonly knownThreadHandles = new Set<string>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private alive = false;
  private disposed = false;
  private requestCounter = 0;
  private initError: string | null = null;
  private recentStderr = "";
  private processFailureHandled = false;

  constructor(options: CodexBackendOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.transport = options.transport ?? "stdio";
    this.websocketUrl = options.websocketUrl ?? null;
    this.stderrSink = options.stderr ?? null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.transport === "websocket") {
      this.initError =
        this.websocketUrl && this.websocketUrl.length > 0
          ? `${WEBSOCKET_DEFERRED_MESSAGE}: ${this.websocketUrl}`
          : WEBSOCKET_DEFERRED_MESSAGE;
      throw new Error(this.initError);
    }

    this.disposed = false;
    this.processFailureHandled = false;
    this.recentStderr = "";
    this.process = spawn(this.command, this.args as string[], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");

    const lineReader = createInterface({
      input: this.process.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    lineReader.on("line", (line) => {
      this.handleLine(line);
    });

    const onProcessFailure = (message: string) => {
      this.handleProcessFailure(message);
    };

    const spawnError = new Promise<never>((_, reject) => {
      this.process?.once("error", (error) => {
        const wrapped = new Error(
          `Failed to spawn Codex app-server process: ${error instanceof Error ? error.message : String(error)}`
        );
        onProcessFailure(wrapped.message);
        reject(wrapped);
      });
    });

    this.process.stderr.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.appendStderr(text);
      this.stderrSink?.write(text);
    });

    this.process.once("exit", () => {
      onProcessFailure("Codex app-server process exited");
    });

    try {
      await Promise.race([this.sendRequest("initialize", DEFAULT_INITIALIZE_PARAMS), spawnError]);
      this.sendNotification("initialized");
      this.alive = true;
      this.initialized = true;
      this.initError = null;
    } catch (error) {
      this.alive = false;
      this.initialized = false;
      this.initError = error instanceof Error ? error.message : String(error);
      await this.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.alive = false;
    this.initialized = false;
    if (this.process) {
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        this.process?.once("exit", () => resolve());
        setTimeout(resolve, 2_000).unref();
      });
    }
    this.process = null;
    this.pending.clear();
  }

  isAlive(): boolean {
    return this.alive && !this.disposed;
  }

  parseModelSelection(model: string | null | undefined): ParsedBackendSelection | null {
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
    if (parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async listModels(): Promise<readonly BackendModelSummary[]> {
    this.assertReady();
    const response = (await this.sendRequest("model/list", {})) as { data?: unknown[] };
    const models = Array.isArray(response.data) ? response.data : [];
    return models
      .filter((value): value is Record<string, unknown> => isRecord(value))
      .map((model, index) => {
        const id = typeof model.id === "string" ? rawModelId(model.id) : `model-${index}`;
        const rawModel = typeof model.model === "string" ? rawModelId(model.model) : id;
        return {
          id,
          model: rawModel,
          displayName: typeof model.displayName === "string" ? model.displayName : rawModel,
          description: typeof model.description === "string" ? model.description : rawModel,
          hidden: Boolean(model.hidden),
          isDefault: Boolean(model.isDefault),
          inputModalities: Array.isArray(model.inputModalities)
            ? model.inputModalities.filter((entry): entry is string => typeof entry === "string")
            : ["text"],
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .filter((entry): entry is Record<string, unknown> => isRecord(entry))
                .map((entry) => ({
                  reasoningEffort:
                    typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "medium",
                  description: typeof entry.description === "string" ? entry.description : "",
                }))
            : [],
          defaultReasoningEffort:
            typeof model.defaultReasoningEffort === "string"
              ? model.defaultReasoningEffort
              : "medium",
          supportsPersonality: Boolean(model.supportsPersonality),
        } satisfies BackendModelSummary;
      });
  }

  async threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult> {
    this.assertReady();
    const response = (await this.sendRequest("thread/start", {
      model: input.model,
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      personality: input.personality ?? null,
      ephemeral: input.ephemeral ?? null,
      experimentalRawEvents: input.experimentalRawEvents ?? false,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id;
    if (!threadHandle) {
      throw new Error("Codex thread/start did not return thread.id");
    }
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult> {
    this.assertReady();
    const response = (await this.sendRequest("thread/resume", {
      threadId: input.threadHandle,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      personality: input.personality ?? null,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id ?? input.threadHandle;
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult> {
    this.assertReady();
    const response = (await this.sendRequest("thread/fork", {
      threadId: input.sourceThreadHandle,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
      ephemeral: input.ephemeral ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id;
    if (!threadHandle) {
      throw new Error("Codex thread/fork did not return thread.id");
    }
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult> {
    this.assertReady();
    const response = (await this.sendRequest("thread/read", {
      threadId: input.threadHandle,
      includeTurns: input.includeTurns,
    })) as {
      thread?: { id?: string; name?: string | null; turns?: unknown[]; model?: string | null };
    };
    const thread = response.thread ?? {};
    const threadHandle = typeof thread.id === "string" ? thread.id : input.threadHandle;
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      title: typeof thread.name === "string" ? thread.name : null,
      model: typeof thread.model === "string" ? rawModelId(thread.model) : null,
      turns: Array.isArray(thread.turns)
        ? (rewriteInboundModelFields(thread.turns) as BackendThreadReadResult["turns"])
        : [],
    };
  }

  async threadArchive(input: BackendThreadArchiveInput): Promise<void> {
    this.assertReady();
    await this.sendRequest("thread/archive", { threadId: input.threadHandle });
  }

  async threadSetName(input: BackendThreadSetNameInput): Promise<void> {
    this.assertReady();
    await this.sendRequest("thread/name/set", {
      threadId: input.threadHandle,
      name: input.name,
    });
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    this.assertReady();
    const response = (await this.sendRequest("turn/start", {
      threadId: input.threadHandle,
      input: input.input,
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandboxPolicy: input.sandboxPolicy ?? null,
      model: input.model,
      serviceTier: input.serviceTier ?? null,
      effort: input.reasoningEffort,
      summary: input.summary ?? null,
      personality: input.personality ?? null,
      outputSchema: input.outputSchema ?? null,
      collaborationMode: input.collaborationMode ?? null,
    })) as { turn?: { id?: string | null } };
    return {
      accepted: true,
      turnId: response.turn?.id ?? null,
    };
  }

  async turnInterrupt(input: BackendTurnInterruptInput): Promise<void> {
    this.assertReady();
    await this.sendRequest("turn/interrupt", {
      threadId: input.threadHandle,
      turnId: input.turnId,
    });
  }

  async resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void> {
    this.assertReady();
    this.sendRaw({
      id: input.requestId,
      ...(isRecord(input.response) && "error" in input.response
        ? { error: (input.response as { error: unknown }).error }
        : { result: (input.response as { result?: unknown }).result }),
    });
  }

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    return this.eventBuffer.subscribe(threadHandle, listener);
  }

  private assertReady(): void {
    if (this.transport === "websocket") {
      throw new Error(WEBSOCKET_DEFERRED_MESSAGE);
    }
    if (!this.isAlive()) {
      throw new Error(this.initError ?? "Codex backend is unavailable");
    }
  }

  private nextRequestId(): number {
    this.requestCounter += 1;
    return this.requestCounter;
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId();
    this.sendRaw({ id, method, params } satisfies JsonRpcRequest);
    return await new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
      });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.sendRaw(
      params === undefined ? { method } : ({ method, params } satisfies JsonRpcNotification)
    );
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error("Codex process is not running");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private appendStderr(text: string): void {
    if (text.length === 0) {
      return;
    }
    const combined = `${this.recentStderr}${text}`;
    this.recentStderr = combined.slice(-8_000);
  }

  private withRecentStderr(message: string): string {
    const stderr = this.recentStderr.trim();
    if (stderr.length === 0) {
      return message;
    }
    return `${message}; recent stderr: ${stderr}`;
  }

  private handleProcessFailure(message: string): void {
    if (this.processFailureHandled) {
      return;
    }
    this.processFailureHandled = true;
    this.alive = false;

    const nextMessage = this.withRecentStderr(message);
    if (!this.disposed && !this.initError) {
      this.initError = nextMessage;
    }

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(this.initError ?? nextMessage));
    }
    for (const threadHandle of this.knownThreadHandles) {
      this.eventBuffer.emit(threadHandle, {
        kind: "disconnect",
        threadHandle,
        message: this.initError ?? nextMessage,
      });
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }

    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      const id = parsed.id;
      if (typeof id !== "string" && typeof id !== "number") {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if ("error" in parsed && parsed.error !== undefined) {
        pending.reject(new Error(JSON.stringify(parsed.error)));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (
      "id" in parsed &&
      (typeof parsed.id === "string" || typeof parsed.id === "number") &&
      "method" in parsed &&
      typeof parsed.method === "string"
    ) {
      const threadHandle = inferThreadHandle(parsed.method, parsed.params);
      if (!threadHandle) {
        return;
      }
      this.knownThreadHandles.add(threadHandle);
      this.eventBuffer.emit(threadHandle, {
        kind: "serverRequest",
        threadHandle,
        requestId: parsed.id,
        method: parsed.method,
        params: rewriteInboundModelFields(parsed.params),
      });
      return;
    }

    if ("method" in parsed && typeof parsed.method === "string") {
      const threadHandle = inferThreadHandle(parsed.method, parsed.params);
      if (!threadHandle) {
        return;
      }
      this.knownThreadHandles.add(threadHandle);
      this.eventBuffer.emit(threadHandle, {
        kind: "notification",
        threadHandle,
        method: parsed.method,
        params: rewriteInboundModelFields(parsed.params),
      });
    }
  }
}

export function createCodexBackend(options: CodexBackendOptions = {}): CodexBackend {
  return new CodexBackend(options);
}
