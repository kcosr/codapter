import { existsSync, readFileSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import { resolve } from "node:path";
import type { BackendMessage, IBackend } from "./backend.js";
import { InMemoryConfigStore } from "./config-store.js";
import {
  type JsonRpcMessage,
  type JsonRpcResponse,
  failure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  success,
} from "./jsonrpc.js";
import type {
  ConfigBatchWriteParams,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  GetAccountParams,
  GetAccountResponse,
  GetAuthStatusResponse,
  GitInfo,
  InitializeParams,
  InitializeResponse,
  ModelListResponse,
  PluginListResponse,
  SkillsListResponse,
  Thread,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadItem,
  ThreadListParams,
  ThreadListResponse,
  ThreadLoadedListParams,
  ThreadLoadedListResponse,
  ThreadMetadataUpdateParams,
  ThreadMetadataUpdateResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadStatus,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  Turn,
} from "./protocol.js";
import {
  ThreadRegistry,
  type ThreadRegistryEntry,
  type ThreadRegistryLogger,
} from "./thread-registry.js";

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_NOT_INITIALIZED = -32002;
const JSON_RPC_ALREADY_INITIALIZED = -32003;
const ADAPTER_VERSION = "0.1.0";
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_APPROVALS_REVIEWER = "user";
const DEFAULT_SANDBOX = { mode: "workspace-write" } as const;
const DEFAULT_MODEL_PROVIDER = "pi";

export interface AppServerIdentity {
  readonly userAgent: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export interface AppServerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface AppServerConnectionOptions {
  readonly backend?: IBackend;
  readonly configStore?: InMemoryConfigStore;
  readonly identity?: AppServerIdentity;
  readonly logger?: AppServerLogger;
  readonly threadRegistry?: ThreadRegistry;
  readonly onNotification?: (notification: AppServerNotification) => void | Promise<void>;
}

interface ConnectionState {
  initialized: boolean;
  initializedNotificationReceived: boolean;
  clientInfo: InitializeParams["clientInfo"] | null;
  optedOutNotifications: Set<string>;
  loadedThreadIds: Set<string>;
  unsubscribedThreadIds: Set<string>;
}

function detectPlatformFamily(): string {
  return process.platform === "win32" ? "windows" : "unix";
}

function detectPlatformOs(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function readEmulatedIdentityFromToml(): string | null {
  const filePath = resolve(process.cwd(), "codapter.toml");
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = readFileSync(filePath, "utf8");
  const match = raw.match(/^\s*emulateCodexIdentity\s*=\s*"([^"]+)"\s*$/m);
  return match?.[1] ?? null;
}

function createIdentity(): AppServerIdentity {
  const userAgent =
    process.env.CODAPTER_EMULATE_CODEX_IDENTITY ??
    readEmulatedIdentityFromToml() ??
    `codapter/${ADAPTER_VERSION}`;

  return {
    userAgent,
    platformFamily: detectPlatformFamily(),
    platformOs: detectPlatformOs(),
  };
}

function defaultLogger(): AppServerLogger {
  return {
    warn(message, context) {
      if (context) {
        console.warn(message, context);
        return;
      }
      console.warn(message);
    },
  };
}

function truncateForLog(value: unknown, limit = 240): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "undefined";
  }
  if (serialized.length <= limit) {
    return serialized;
  }
  return `${serialized.slice(0, limit)}...`;
}

function toUnixSeconds(isoTimestamp: string): number {
  return Math.floor(new Date(isoTimestamp).getTime() / 1000);
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

function buildTurns(history: readonly BackendMessage[]): Turn[] {
  return history.map((message) => {
    const item: ThreadItem =
      message.role === "user"
        ? {
            type: "userMessage",
            id: `${message.id}_item`,
            content: [textFromUnknown(message.content)],
          }
        : {
            type: "agentMessage",
            id: `${message.id}_item`,
            text: textFromUnknown(message.content),
            phase: null,
          };

    return {
      id: message.id,
      items: [item],
      status: "completed",
      error: null,
    };
  });
}

export class AppServerConnection {
  private readonly backend: IBackend | undefined;
  private readonly configStore: InMemoryConfigStore;
  private readonly identity: AppServerIdentity;
  private readonly logger: AppServerLogger;
  private readonly threadRegistry: ThreadRegistry;
  private readonly onNotification:
    | ((notification: AppServerNotification) => void | Promise<void>)
    | undefined;
  private readonly state: ConnectionState = {
    initialized: false,
    initializedNotificationReceived: false,
    clientInfo: null,
    optedOutNotifications: new Set(),
    loadedThreadIds: new Set(),
    unsubscribedThreadIds: new Set(),
  };

  constructor(options: AppServerConnectionOptions = {}) {
    this.backend = options.backend;
    this.configStore = options.configStore ?? new InMemoryConfigStore();
    this.identity = options.identity ?? createIdentity();
    this.logger = options.logger ?? defaultLogger();
    this.threadRegistry =
      options.threadRegistry ?? new ThreadRegistry(undefined, this.logger as ThreadRegistryLogger);
    this.onNotification = options.onNotification;
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (isJsonRpcNotification(message)) {
      return this.handleNotification(message);
    }

    if (!isJsonRpcRequest(message)) {
      return failure(null, JSON_RPC_INVALID_PARAMS, "Invalid JSON-RPC message");
    }

    const request = message;

    try {
      if (request.method === "initialize") {
        return this.handleInitialize(request.id, request.params);
      }

      if (!this.state.initialized) {
        return failure(request.id, JSON_RPC_NOT_INITIALIZED, "Not initialized");
      }

      switch (request.method) {
        case "config/read":
          return success(request.id, this.handleConfigRead(request.params));
        case "config/value/write":
          return success(request.id, this.handleConfigValueWrite(request.params));
        case "config/batchWrite":
          return success(request.id, this.handleConfigBatchWrite(request.params));
        case "configRequirements/read":
          return success(request.id, this.handleConfigRequirementsRead());
        case "account/read":
          return success(request.id, this.handleAccountRead(request.params));
        case "getAuthStatus":
          return success(request.id, this.handleGetAuthStatus());
        case "skills/list":
          return success(request.id, this.handleSkillsList());
        case "plugin/list":
          return success(request.id, this.handlePluginList());
        case "model/list":
          return success(request.id, await this.handleModelList());
        case "thread/start":
          return success(request.id, await this.handleThreadStart(request.params));
        case "thread/resume":
          return success(request.id, await this.handleThreadResume(request.params));
        case "thread/fork":
          return success(request.id, await this.handleThreadFork(request.params));
        case "thread/read":
          return success(request.id, await this.handleThreadRead(request.params));
        case "thread/list":
          return success(request.id, await this.handleThreadList(request.params));
        case "thread/loaded/list":
          return success(request.id, this.handleThreadLoadedList(request.params));
        case "thread/name/set":
          return success(request.id, await this.handleThreadSetName(request.params));
        case "thread/archive":
          return success(request.id, await this.handleThreadArchive(request.params));
        case "thread/unarchive":
          return success(request.id, await this.handleThreadUnarchive(request.params));
        case "thread/metadata/update":
          return success(request.id, await this.handleThreadMetadataUpdate(request.params));
        case "thread/unsubscribe":
          return success(request.id, this.handleThreadUnsubscribe(request.params));
        default:
          this.logger.warn("Unrecognized RPC method", {
            method: request.method,
            requestId: request.id,
            params: truncateForLog(request.params),
          });
          return failure(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method not found: ${request.method}`
          );
      }
    } catch (error) {
      return failure(
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        error instanceof Error ? error.message : "Internal error"
      );
    }
  }

  emitNotification(method: string, params?: unknown): AppServerNotification | null {
    if (this.state.optedOutNotifications.has(method)) {
      return null;
    }

    return params === undefined ? { method } : { method, params };
  }

  get clientInfo(): InitializeParams["clientInfo"] | null {
    return this.state.clientInfo;
  }

  get initializedNotificationReceived(): boolean {
    return this.state.initializedNotificationReceived;
  }

  private async publish(method: string, params?: unknown, threadId?: string): Promise<void> {
    if (!this.onNotification) {
      return;
    }

    if (threadId && this.state.unsubscribedThreadIds.has(threadId)) {
      return;
    }

    const notification = this.emitNotification(method, params);
    if (notification) {
      await this.onNotification(notification);
    }
  }

  private handleNotification(message: JsonRpcMessage): null {
    if (!this.state.initialized) {
      return null;
    }

    if (message.method === "initialized") {
      this.state.initializedNotificationReceived = true;
    }

    return null;
  }

  private handleInitialize(id: string | number, params: unknown): JsonRpcResponse {
    if (this.state.initialized) {
      return failure(id, JSON_RPC_ALREADY_INITIALIZED, "Already initialized");
    }

    const parsed = this.parseInitializeParams(params);

    try {
      validateHeaderValue("x-codapter-client", parsed.clientInfo.name);
    } catch {
      return failure(id, JSON_RPC_INVALID_PARAMS, "Invalid initialize params");
    }

    if (parsed.clientInfo.version !== ADAPTER_VERSION) {
      this.logger.warn("Client version differs from adapter version", {
        clientVersion: parsed.clientInfo.version,
        adapterVersion: ADAPTER_VERSION,
      });
    }

    this.state.initialized = true;
    this.state.clientInfo = parsed.clientInfo;
    this.state.optedOutNotifications = new Set(
      parsed.capabilities?.optOutNotificationMethods ?? []
    );

    const response: InitializeResponse = {
      userAgent: this.identity.userAgent,
      platformFamily: this.identity.platformFamily,
      platformOs: this.identity.platformOs,
    };

    return success(id, response);
  }

  private parseInitializeParams(value: unknown): InitializeParams {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid initialize params");
    }

    const candidate = value as Record<string, unknown>;
    const clientInfo = candidate.clientInfo;
    if (!clientInfo || typeof clientInfo !== "object") {
      throw new Error("Invalid initialize params");
    }

    const client = clientInfo as Record<string, unknown>;
    if (typeof client.name !== "string" || typeof client.version !== "string") {
      throw new Error("Invalid initialize params");
    }

    let capabilities: InitializeParams["capabilities"] = null;
    if (candidate.capabilities !== undefined && candidate.capabilities !== null) {
      if (typeof candidate.capabilities !== "object") {
        throw new Error("Invalid initialize params");
      }

      const raw = candidate.capabilities as Record<string, unknown>;
      capabilities = {
        experimentalApi: Boolean(raw.experimentalApi),
        optOutNotificationMethods: Array.isArray(raw.optOutNotificationMethods)
          ? raw.optOutNotificationMethods.filter(
              (entry): entry is string => typeof entry === "string"
            )
          : null,
      };
    }

    return {
      clientInfo: {
        name: client.name,
        title: typeof client.title === "string" ? client.title : null,
        version: client.version,
      },
      capabilities,
    };
  }

  private handleConfigRead(params: unknown): ConfigReadResponse {
    const parsed = (params ?? {}) as Partial<ConfigReadParams>;
    return this.configStore.read({
      includeLayers: Boolean(parsed.includeLayers),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
    });
  }

  private handleConfigValueWrite(params: unknown): ConfigWriteResponse {
    return this.configStore.writeValue(params as ConfigValueWriteParams);
  }

  private handleConfigBatchWrite(params: unknown): ConfigWriteResponse {
    return this.configStore.writeBatch(params as ConfigBatchWriteParams);
  }

  private handleConfigRequirementsRead(): ConfigRequirementsReadResponse {
    return { requirements: null };
  }

  private handleAccountRead(params: unknown): GetAccountResponse {
    const parsed = (params ?? {}) as Partial<GetAccountParams>;
    return {
      account: null,
      requiresOpenaiAuth: Boolean(parsed.refreshToken) && false,
    };
  }

  private handleGetAuthStatus(): GetAuthStatusResponse {
    return {
      authMethod: null,
      authToken: null,
      requiresOpenaiAuth: false,
    };
  }

  private handleSkillsList(): SkillsListResponse {
    return { data: [] };
  }

  private handlePluginList(): PluginListResponse {
    return {
      marketplaces: [],
      remoteSyncError: null,
    };
  }

  private async handleModelList(): Promise<ModelListResponse> {
    const models = this.backend ? await this.backend.listModels() : [];

    return {
      data: models.map((model) => ({
        id: model.id,
        model: model.model,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: model.displayName,
        description: model.description,
        hidden: model.hidden,
        supportedReasoningEfforts: [...model.supportedReasoningEfforts],
        defaultReasoningEffort: model.defaultReasoningEffort,
        inputModalities: [...model.inputModalities],
        supportsPersonality: model.supportsPersonality,
        isDefault: model.isDefault,
      })),
      nextCursor: null,
    };
  }

  private async handleThreadStart(params: unknown): Promise<ThreadStartResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadStartParams;
    const sessionId = await backend.createSession();
    const entry = await this.threadRegistry.create({
      backendSessionId: sessionId,
      backendType: "pi",
      cwd: parsed.cwd ?? process.cwd(),
      preview: "",
      modelProvider: parsed.modelProvider ?? DEFAULT_MODEL_PROVIDER,
      gitInfo: null,
    });

    this.state.loadedThreadIds.add(entry.threadId);
    const thread = this.buildThread(entry, []);
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publish(
      "thread/status/changed",
      { threadId: entry.threadId, status: thread.status },
      entry.threadId
    );
    return await this.buildThreadExecutionResponse(
      thread,
      parsed.model ?? null,
      parsed.cwd ?? null
    );
  }

  private async handleThreadResume(params: unknown): Promise<ThreadResumeResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadResumeParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    await backend.resumeSession(entry.backendSessionId);
    this.state.loadedThreadIds.add(entry.threadId);
    const history = await backend.readSessionHistory(entry.backendSessionId);
    const thread = this.buildThread(entry, buildTurns(history));
    await this.publish(
      "thread/status/changed",
      { threadId: entry.threadId, status: thread.status },
      entry.threadId
    );
    return await this.buildThreadExecutionResponse(
      thread,
      parsed.model ?? null,
      parsed.cwd ?? null
    );
  }

  private async handleThreadFork(params: unknown): Promise<ThreadForkResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadForkParams;
    const sourceEntry = await this.getThreadEntry(parsed.threadId);
    const forkedSessionId = await backend.forkSession(sourceEntry.backendSessionId);
    const entry = await this.threadRegistry.create({
      backendSessionId: forkedSessionId,
      backendType: sourceEntry.backendType,
      cwd: parsed.cwd ?? sourceEntry.cwd,
      preview: sourceEntry.preview,
      modelProvider: parsed.modelProvider ?? sourceEntry.modelProvider,
      name: sourceEntry.name,
      gitInfo: sourceEntry.gitInfo,
    });

    this.state.loadedThreadIds.add(entry.threadId);
    const history = await backend.readSessionHistory(forkedSessionId);
    const thread = this.buildThread(entry, buildTurns(history));
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publish(
      "thread/status/changed",
      { threadId: entry.threadId, status: thread.status },
      entry.threadId
    );
    return await this.buildThreadExecutionResponse(
      thread,
      parsed.model ?? null,
      parsed.cwd ?? null
    );
  }

  private async handleThreadRead(params: unknown): Promise<ThreadReadResponse> {
    const parsed = params as ThreadReadParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const turns =
      parsed.includeTurns && this.backend
        ? buildTurns(await this.backend.readSessionHistory(entry.backendSessionId))
        : [];
    return {
      thread: this.buildThread(entry, turns),
    };
  }

  private async handleThreadList(params: unknown): Promise<ThreadListResponse> {
    const parsed = (params ?? {}) as Partial<ThreadListParams>;
    const cursor = Number(parsed.cursor ?? "0");
    const limit = parsed.limit ?? 50;
    const entries = (await this.threadRegistry.list())
      .filter((entry) => {
        if (parsed.archived !== null && parsed.archived !== undefined) {
          return entry.archived === parsed.archived;
        }
        return !entry.archived;
      })
      .filter((entry) => !parsed.cwd || entry.cwd === parsed.cwd)
      .filter((entry) =>
        !parsed.searchTerm
          ? true
          : `${entry.name ?? ""} ${entry.preview ?? ""}`
              .toLowerCase()
              .includes(parsed.searchTerm.toLowerCase())
      )
      .filter((entry) =>
        !parsed.modelProviders || parsed.modelProviders.length === 0
          ? true
          : parsed.modelProviders.includes(entry.modelProvider ?? DEFAULT_MODEL_PROVIDER)
      )
      .sort((left, right) =>
        (parsed.sortKey ?? "created_at") === "updated_at"
          ? right.updatedAt.localeCompare(left.updatedAt)
          : right.createdAt.localeCompare(left.createdAt)
      );

    const start = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const slice = entries.slice(start, start + limit);

    return {
      data: slice.map((entry) => this.buildThread(entry, [])),
      nextCursor: start + limit < entries.length ? String(start + limit) : null,
    };
  }

  private handleThreadLoadedList(params: unknown): ThreadLoadedListResponse {
    const parsed = (params ?? {}) as Partial<ThreadLoadedListParams>;
    const loaded = [...this.state.loadedThreadIds.values()].sort();
    const start = Number.isFinite(Number(parsed.cursor ?? "0")) ? Number(parsed.cursor ?? "0") : 0;
    const limit = parsed.limit ?? loaded.length;
    return {
      data: loaded.slice(start, start + limit),
      nextCursor: start + limit < loaded.length ? String(start + limit) : null,
    };
  }

  private async handleThreadSetName(params: unknown): Promise<ThreadSetNameResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadSetNameParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    await backend.setSessionName(entry.backendSessionId, parsed.name);
    await this.threadRegistry.update(parsed.threadId, { name: parsed.name });
    await this.publish(
      "thread/name/updated",
      { threadId: parsed.threadId, threadName: parsed.name },
      parsed.threadId
    );
    return {};
  }

  private async handleThreadArchive(params: unknown): Promise<ThreadArchiveResponse> {
    const parsed = params as ThreadArchiveParams;
    await this.getThreadEntry(parsed.threadId);
    await this.threadRegistry.update(parsed.threadId, { archived: true });
    this.state.loadedThreadIds.delete(parsed.threadId);
    await this.publish("thread/archived", { threadId: parsed.threadId }, parsed.threadId);
    return {};
  }

  private async handleThreadUnarchive(params: unknown): Promise<ThreadUnarchiveResponse> {
    const parsed = params as ThreadUnarchiveParams;
    const updated = await this.threadRegistry.update(parsed.threadId, { archived: false });
    const thread = this.buildThread(updated, []);
    await this.publish("thread/unarchived", { threadId: parsed.threadId }, parsed.threadId);
    return { thread };
  }

  private async handleThreadMetadataUpdate(params: unknown): Promise<ThreadMetadataUpdateResponse> {
    const parsed = params as ThreadMetadataUpdateParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const gitInfo = this.applyGitInfoPatch(entry.gitInfo, parsed.gitInfo);
    const updated = await this.threadRegistry.update(parsed.threadId, { gitInfo });
    return { thread: this.buildThread(updated, []) };
  }

  private handleThreadUnsubscribe(params: unknown): ThreadUnsubscribeResponse {
    const parsed = params as ThreadUnsubscribeParams;
    if (!this.state.loadedThreadIds.has(parsed.threadId)) {
      return { status: "notLoaded" };
    }
    if (this.state.unsubscribedThreadIds.has(parsed.threadId)) {
      return { status: "notSubscribed" };
    }
    this.state.unsubscribedThreadIds.add(parsed.threadId);
    return { status: "unsubscribed" };
  }

  private applyGitInfoPatch(
    existing: GitInfo | null,
    patch: ThreadMetadataUpdateParams["gitInfo"] | undefined
  ): GitInfo | null {
    if (patch === undefined) {
      return existing;
    }
    if (patch === null) {
      return null;
    }
    return {
      sha: patch.sha ?? existing?.sha ?? null,
      branch: patch.branch ?? existing?.branch ?? null,
      originUrl: patch.originUrl ?? existing?.originUrl ?? null,
    };
  }

  private buildThread(entry: ThreadRegistryEntry, turns: Turn[]): Thread {
    return {
      id: entry.threadId,
      preview: entry.preview ?? "",
      ephemeral: false,
      modelProvider: entry.modelProvider ?? DEFAULT_MODEL_PROVIDER,
      createdAt: toUnixSeconds(entry.createdAt),
      updatedAt: toUnixSeconds(entry.updatedAt),
      status: this.buildThreadStatus(entry.threadId),
      path: null,
      cwd: entry.cwd ?? process.cwd(),
      cliVersion: ADAPTER_VERSION,
      source: "appServer",
      agentNickname: null,
      agentRole: null,
      gitInfo: entry.gitInfo,
      name: entry.name,
      turns,
    };
  }

  private buildThreadStatus(threadId: string): ThreadStatus {
    return this.state.loadedThreadIds.has(threadId) ? { type: "idle" } : { type: "notLoaded" };
  }

  private async buildThreadExecutionResponse(
    thread: Thread,
    requestedModel: string | null,
    requestedCwd: string | null
  ): Promise<ThreadStartResponse> {
    const models = this.backend ? await this.backend.listModels() : [];
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];

    return {
      thread,
      model: requestedModel ?? defaultModel?.model ?? "pi-default",
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd: requestedCwd ?? thread.cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: DEFAULT_APPROVALS_REVIEWER,
      sandbox: DEFAULT_SANDBOX,
      reasoningEffort: defaultModel?.defaultReasoningEffort ?? null,
    };
  }

  private async getThreadEntry(threadId: string): Promise<ThreadRegistryEntry> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return entry;
  }

  private requireBackend(): IBackend {
    if (!this.backend) {
      throw new Error("No backend configured");
    }
    return this.backend;
  }
}
