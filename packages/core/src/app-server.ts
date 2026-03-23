import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { dirname, resolve } from "node:path";
import { BackendRouter, type RoutedBackendSelection } from "./backend-router.js";
import type {
  BackendAppServerEvent,
  BackendImageInput,
  BackendResolveServerRequestInput,
  BackendSessionLaunchConfig,
  Disposable,
  IBackend,
} from "./backend.js";
import { parseBackendModelId } from "./backend.js";
import {
  CollabManager,
  type CollabManagerCreateChildThreadInput,
  type CollabManagerNotificationSink,
} from "./collab-manager.js";
import { CollabUdsListener } from "./collab-uds.js";
import { CommandExecManager } from "./command-exec.js";
import { InMemoryConfigStore } from "./config-store.js";
import {
  type JsonRpcEnvelope,
  type JsonRpcMessage,
  type JsonRpcResponse,
  failure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  success,
} from "./jsonrpc.js";
import type {
  AccountLoginCompletedNotification,
  AccountUpdatedNotification,
  AppListResponse,
  AuthMode,
  CancelLoginAccountParams,
  CancelLoginAccountResponse,
  CollaborationModeListResponse,
  CommandExecParams,
  CommandExecResizeParams,
  CommandExecResponse,
  CommandExecTerminateParams,
  CommandExecWriteParams,
  ConfigBatchWriteParams,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  ExperimentalFeatureListResponse,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  GetAuthStatusResponse,
  GitInfo,
  InitializeParams,
  InitializeResponse,
  JsonValue,
  LoginAccountParams,
  LoginAccountResponse,
  LogoutAccountResponse,
  McpServerStatusListResponse,
  ModelListResponse,
  PlanType,
  PluginListResponse,
  SandboxMode,
  SandboxPolicy,
  SkillsListResponse,
  Thread,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadForkParams,
  ThreadForkResponse,
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
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
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
const ADAPTER_VERSION = "0.0.3";
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_APPROVALS_REVIEWER = "user";
const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";
const DEFAULT_MODEL_PROVIDER = "unknown";
const INTERNAL_TITLE_THREAD_PROMPT_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task";
const INTERNAL_TITLE_THREAD_PROMPT_MARKER = "Generate a concise UI title";
const INTERNAL_TITLE_THREAD_PREVIEW_PREFIX = INTERNAL_TITLE_THREAD_PROMPT_PREFIX.slice(0, 120);

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

export type AppServerOutgoingMessage = JsonRpcEnvelope;

export interface AppServerConnectionOptions {
  readonly backend?: IBackend;
  readonly backendRouter?: BackendRouter;
  readonly collabEnabled?: boolean;
  readonly configStore?: InMemoryConfigStore;
  readonly identity?: AppServerIdentity;
  readonly logger?: AppServerLogger;
  readonly debugLogFilePath?: string | null;
  readonly threadRegistry?: ThreadRegistry;
  readonly onMessage?: (message: AppServerOutgoingMessage) => void | Promise<void>;
}

interface ConnectionState {
  initialized: boolean;
  initializedNotificationReceived: boolean;
  clientInfo: InitializeParams["clientInfo"] | null;
  optedOutNotifications: Set<string>;
  unsubscribedThreadIds: Set<string>;
}

interface ThreadRuntime {
  backendType: string;
  threadHandle: string;
  status: "starting" | "ready" | "turn_active" | "forking" | "terminating";
  activeTurnId: string | null;
  latestTurnId: string | null;
  subscription: Disposable | null;
  eventQueue: Promise<void>;
  readyResolver: (() => void) | null;
  readyPromise: Promise<void> | null;
  managedByCollab: boolean;
  statusOverride: ThreadStatus | null;
}

interface PendingBackendServerRequest {
  threadId: string;
  backendType: string;
  threadHandle: string;
  backendRequestId: string | number;
}

type StoredAuthState =
  | { mode: "apikey"; apiKey: string }
  | {
      mode: "chatgptAuthTokens";
      accessToken: string;
      accountId: string;
      email: string | null;
      planType: PlanType;
    };

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

function readStringRecordValue(record: unknown, key: string): string | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function resolveCollaborationModeSetting(
  collaborationMode: JsonValue | null | undefined,
  key: string
): string | null {
  if (typeof collaborationMode !== "object" || collaborationMode === null) {
    return null;
  }
  const settings = (collaborationMode as Record<string, unknown>).settings;
  return readStringRecordValue(settings, key);
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

function normalizePlanType(value: unknown): PlanType {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  switch (normalized) {
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "team":
    case "business":
    case "enterprise":
    case "edu":
    case "unknown":
      return normalized as PlanType;
    default:
      return "unknown";
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractChatgptIdentity(accessToken: string): { email: string | null; planType: PlanType } {
  const payload = decodeJwtPayload(accessToken);
  const profile =
    payload?.profile && typeof payload.profile === "object"
      ? (payload.profile as Record<string, unknown>)
      : null;
  const authClaims =
    payload?.["https://api.openai.com/auth"] &&
    typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : null;
  const email =
    typeof payload?.email === "string"
      ? payload.email
      : typeof profile?.email === "string"
        ? profile.email
        : null;
  return {
    email,
    planType: normalizePlanType(authClaims?.chatgpt_plan_type),
  };
}

function buildSandboxPolicy(mode: SandboxMode | null | undefined, cwd: string): SandboxPolicy {
  switch (mode ?? DEFAULT_SANDBOX_MODE) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
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

interface DebugLogRecord {
  readonly at: string;
  readonly component: "app-server";
  readonly kind: "startup" | "shutdown" | "backend-event" | "notification" | "state-transition";
  readonly threadId?: string;
  readonly turnId?: string;
  readonly accepted?: boolean;
  readonly method?: string;
  readonly eventType?: string;
  readonly payload?: unknown;
}

class DebugLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: AppServerLogger
  ) {}

  async write(record: DebugLogRecord): Promise<void> {
    if (this.failed) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });

    try {
      await this.pending;
    } catch (error) {
      this.failed = true;
      this.logger.warn("Failed to write debug log", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      // The logger already reported the failure path.
    }
  }
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

function isInternalTitlePrompt(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) &&
    normalized.includes(INTERNAL_TITLE_THREAD_PROMPT_MARKER)
  );
}

function isInternalTitlePreview(preview: string | null): boolean {
  const normalized = preview?.trim() ?? "";
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) ||
    normalized.startsWith(INTERNAL_TITLE_THREAD_PREVIEW_PREFIX)
  );
}

function runtimeToThreadStatus(runtime: ThreadRuntime | undefined): ThreadStatus {
  if (!runtime) {
    return { type: "notLoaded" };
  }
  if (runtime.statusOverride) {
    return runtime.statusOverride;
  }
  switch (runtime.status) {
    case "turn_active":
      return { type: "active", activeFlags: ["turn"] };
    case "starting":
      return { type: "active", activeFlags: ["starting"] };
    case "forking":
      return { type: "active", activeFlags: ["forking"] };
    case "terminating":
      return { type: "active", activeFlags: ["terminating"] };
    default:
      return { type: "idle" };
  }
}

function isSubAgentThreadSource(source: ThreadRegistryEntry["source"]): boolean {
  return "subAgent" in source;
}

function threadSourceKinds(source: ThreadRegistryEntry["source"]): string[] {
  if ("type" in source) {
    return ["appServer"];
  }

  if ("thread_spawn" in source.subAgent) {
    return ["subAgent", "subAgentThreadSpawn"];
  }

  return ["subAgent"];
}

function turnErrorFromUnknown(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    codexErrorInfo: null,
    additionalDetails: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function backendEventTurnId(event: BackendAppServerEvent): string | null {
  if (!("params" in event) || !isRecord(event.params)) {
    return null;
  }
  if (typeof event.params.turnId === "string") {
    return event.params.turnId;
  }
  if (isRecord(event.params.turn) && typeof event.params.turn.id === "string") {
    return event.params.turn.id;
  }
  return null;
}

export class AppServerConnection {
  private readonly backendRouter: BackendRouter;
  private readonly configStore: InMemoryConfigStore;
  private readonly identity: AppServerIdentity;
  private readonly logger: AppServerLogger;
  private readonly debugLogWriter: DebugLogWriter | null;
  private readonly threadRegistry: ThreadRegistry;
  private readonly onMessage:
    | ((message: AppServerOutgoingMessage) => void | Promise<void>)
    | undefined;
  private readonly commandExecManager: CommandExecManager;
  private readonly collabEnabled: boolean;
  private readonly collabManager: CollabManager | null;
  private readonly collabUdsListener: CollabUdsListener | null;
  private readonly collabReady: Promise<void>;
  private readonly threadRuntimes = new Map<string, ThreadRuntime>();
  private readonly pendingBackendServerRequests = new Map<
    string | number,
    PendingBackendServerRequest
  >();
  private authState: StoredAuthState | null = {
    mode: "chatgptAuthTokens",
    accessToken: "codapter",
    accountId: "codapter",
    email: "codapter@localhost",
    planType: "pro",
  };
  private readonly state: ConnectionState = {
    initialized: false,
    initializedNotificationReceived: false,
    clientInfo: null,
    optedOutNotifications: new Set(),
    unsubscribedThreadIds: new Set(),
  };

  constructor(options: AppServerConnectionOptions = {}) {
    this.backendRouter =
      options.backendRouter ??
      (options.backend ? new BackendRouter([options.backend]) : new BackendRouter());
    this.configStore = options.configStore ?? new InMemoryConfigStore();
    this.identity = options.identity ?? createIdentity();
    this.logger = options.logger ?? defaultLogger();
    const debugLogFilePath =
      options.debugLogFilePath ?? process.env.CODAPTER_DEBUG_LOG_FILE ?? null;
    this.debugLogWriter =
      debugLogFilePath && debugLogFilePath.length > 0
        ? new DebugLogWriter(debugLogFilePath, this.logger)
        : null;
    this.threadRegistry =
      options.threadRegistry ?? new ThreadRegistry(undefined, this.logger as ThreadRegistryLogger);
    this.onMessage = options.onMessage;
    this.collabEnabled = Boolean(options.collabEnabled);
    this.commandExecManager = new CommandExecManager({
      onNotification: async (notification) => {
        await this.publish(notification.method, notification.params);
      },
    });
    if (this.collabEnabled) {
      const notifySink: CollabManagerNotificationSink = {
        notify: async (method, params, threadId) => {
          await this.publish(method, params, threadId);
        },
      };
      this.collabManager = new CollabManager({
        backendRouter: this.backendRouter,
        notifySink,
        resolveParentTurnId: (parentThreadId) =>
          this.threadRuntimes.get(parentThreadId)?.latestTurnId ??
          this.threadRuntimes.get(parentThreadId)?.activeTurnId ??
          "unknown",
        resolveThreadHandle: (threadId) => {
          const runtime = this.threadRuntimes.get(threadId);
          if (!runtime) {
            throw new Error(`Thread ${threadId} is not loaded`);
          }
          return runtime.threadHandle;
        },
        resolveThreadBackendType: (threadId) => {
          const runtime = this.threadRuntimes.get(threadId);
          if (!runtime) {
            throw new Error(`Thread ${threadId} is not loaded`);
          }
          return runtime.backendType;
        },
        createSessionLaunchConfig: (threadId) => this.createBackendSessionLaunchConfig(threadId),
        createChildThread: async (input) => {
          await this.createCollabChildThread(input);
        },
        startChildTurn: async ({ agent, message }) =>
          await this.startCollabChildTurn(agent, message),
        onChildAgentEvent: async ({ agent, event }) => {
          this.enqueueBackendEvent(agent.threadId, event);
        },
        onChildAgentStatusChanged: async ({ agent }) => {
          this.syncCollabRuntimeState(agent);
          await this.publishThreadStatus(agent.threadId);
        },
      });
      this.collabUdsListener = new CollabUdsListener({
        collabManager: this.collabManager,
        validateParentThread: (parentThreadId) => {
          if (!this.threadRuntimes.has(parentThreadId)) {
            throw new Error(`Thread ${parentThreadId} is not loaded`);
          }
        },
      });
      this.collabReady = this.collabUdsListener.start().catch((error) => {
        this.logger.warn("Failed to start collab UDS listener", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    } else {
      this.collabManager = null;
      this.collabUdsListener = null;
      this.collabReady = Promise.resolve();
    }
    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "startup",
    });
  }

  async dispose(): Promise<void> {
    await this.collabUdsListener?.close().catch(() => {});
    await this.collabManager?.dispose().catch(() => {});
    for (const runtime of this.threadRuntimes.values()) {
      runtime.status = "terminating";
      runtime.readyResolver?.();
      runtime.readyResolver = null;
      runtime.readyPromise = null;
      runtime.subscription?.dispose();
    }
    this.pendingBackendServerRequests.clear();
    this.threadRuntimes.clear();
    await this.commandExecManager.dispose();
    await this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "shutdown",
    });
    await this.debugLogWriter?.flush();
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (isJsonRpcResponse(message)) {
      return this.handleResponse(message);
    }

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
        case "account/login/start":
          return success(request.id, await this.handleAccountLoginStart(request.params));
        case "account/login/cancel":
          return success(request.id, this.handleAccountLoginCancel(request.params));
        case "account/logout":
          return success(request.id, await this.handleAccountLogout());
        case "account/rateLimits/read":
          return success(request.id, this.handleAccountRateLimitsRead());
        case "getAuthStatus":
          return success(request.id, this.handleGetAuthStatus(request.params));
        case "skills/list":
          return success(request.id, this.handleSkillsList());
        case "plugin/list":
          return success(request.id, this.handlePluginList());
        case "app/list":
          return success(request.id, this.handleAppList(request.params));
        case "model/list":
          return success(request.id, await this.handleModelList());
        case "experimentalFeature/list":
          return success(request.id, this.handleExperimentalFeatureList(request.params));
        case "collaborationMode/list":
          return success(request.id, this.handleCollaborationModeList());
        case "mcpServerStatus/list":
          return success(request.id, this.handleMcpServerStatusList(request.params));
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
        case "turn/start":
          return success(request.id, await this.handleTurnStart(request.params));
        case "turn/interrupt":
          return success(request.id, await this.handleTurnInterrupt(request.params));
        case "command/exec":
          return success(request.id, await this.handleCommandExec(request.params));
        case "command/exec/write":
          return success(request.id, await this.handleCommandExecWrite(request.params));
        case "command/exec/resize":
          return success(request.id, await this.handleCommandExecResize(request.params));
        case "command/exec/terminate":
          return success(request.id, await this.handleCommandExecTerminate(request.params));
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

  private handleResponse(message: JsonRpcResponse): null {
    if (message.id === null) {
      return null;
    }

    const pending = this.pendingBackendServerRequests.get(message.id);
    if (!pending) {
      return null;
    }

    this.pendingBackendServerRequests.delete(message.id);
    const backend = this.backendRouter.getBackend(pending.backendType);
    if (!backend) {
      return null;
    }
    const responsePayload =
      "error" in message ? { error: message.error } : { result: message.result };
    const resolveInput: BackendResolveServerRequestInput = {
      threadId: pending.threadId,
      threadHandle: pending.threadHandle,
      requestId: pending.backendRequestId,
      response: responsePayload,
    };
    void backend.resolveServerRequest(resolveInput).catch((error) => {
      this.logger.warn("Failed to resolve backend server request", {
        threadId: pending.threadId,
        backendType: pending.backendType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void this.publish(
      "serverRequest/resolved",
      {
        threadId: pending.threadId,
        requestId: message.id,
      },
      pending.threadId
    );
    return null;
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
    if (!this.onMessage) {
      return;
    }

    if (threadId && this.state.unsubscribedThreadIds.has(threadId)) {
      return;
    }

    const notification = this.emitNotification(method, params);
    if (notification) {
      await this.debugLogWriter?.write({
        at: new Date().toISOString(),
        component: "app-server",
        kind: "notification",
        threadId,
        method,
        payload: params,
      });
      await this.send(notification);
    }
  }

  private async send(message: AppServerOutgoingMessage): Promise<void> {
    await this.onMessage?.(message);
  }

  private handleNotification(message: JsonRpcMessage): null {
    if (!this.state.initialized) {
      return null;
    }

    if (message.method === "initialized") {
      this.state.initializedNotificationReceived = true;
      if (this.authState) {
        void this.publishAccountLoginCompleted({
          loginId: null,
          success: true,
          error: null,
        });
        void this.publishAccountUpdated();
      }
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

  private readEffectiveConfig(cwd: string | null): ConfigReadResponse["config"] {
    return this.configStore.read({ includeLayers: false, cwd }).config;
  }

  private resolveRequestedModel(
    cwd: string | null,
    requestedModel: string | null | undefined,
    collaborationMode?: JsonValue | null,
    persistedModel?: string | null
  ): string | null {
    return (
      requestedModel ??
      resolveCollaborationModeSetting(collaborationMode, "model") ??
      persistedModel ??
      this.readEffectiveConfig(cwd).model
    );
  }

  private resolveRequestedReasoningEffort(
    cwd: string | null,
    requestedEffort: string | null | undefined,
    collaborationMode?: JsonValue | null,
    persistedEffort?: string | null
  ): string | null {
    return (
      requestedEffort ??
      resolveCollaborationModeSetting(collaborationMode, "reasoning_effort") ??
      persistedEffort ??
      this.readEffectiveConfig(cwd).model_reasoning_effort
    );
  }

  private handleConfigRequirementsRead(): ConfigRequirementsReadResponse {
    return { requirements: null };
  }

  private handleAccountRead(_params: unknown): GetAccountResponse {
    const account =
      this.authState?.mode === "apikey"
        ? { type: "apiKey" as const }
        : this.authState?.mode === "chatgptAuthTokens" && this.authState.email
          ? {
              type: "chatgpt" as const,
              email: this.authState.email,
              planType: this.authState.planType,
            }
          : null;
    return {
      account,
      requiresOpenaiAuth: true,
    };
  }

  private async handleAccountLoginStart(params: unknown): Promise<LoginAccountResponse> {
    const parsed = params as LoginAccountParams;
    switch (parsed?.type) {
      case "apiKey":
        this.authState = { mode: "apikey", apiKey: parsed.apiKey };
        await this.publishAccountLoginCompleted({
          loginId: null,
          success: true,
          error: null,
        });
        await this.publishAccountUpdated();
        return { type: "apiKey" };
      case "chatgptAuthTokens": {
        const identity = extractChatgptIdentity(parsed.accessToken);
        this.authState = {
          mode: "chatgptAuthTokens",
          accessToken: parsed.accessToken,
          accountId: parsed.chatgptAccountId,
          email: identity.email,
          planType:
            parsed.chatgptPlanType === null || parsed.chatgptPlanType === undefined
              ? identity.planType
              : normalizePlanType(parsed.chatgptPlanType),
        };
        await this.publishAccountLoginCompleted({
          loginId: null,
          success: true,
          error: null,
        });
        await this.publishAccountUpdated();
        return { type: "chatgptAuthTokens" };
      }
      case "chatgpt":
        throw new Error(
          "Interactive ChatGPT login is not supported by codapter; use chatgptAuthTokens instead."
        );
      default:
        throw new Error("Invalid account/login/start params");
    }
  }

  private handleAccountLoginCancel(params: unknown): CancelLoginAccountResponse {
    const parsed = params as Partial<CancelLoginAccountParams>;
    if (typeof parsed?.loginId !== "string") {
      throw new Error("Invalid account/login/cancel params");
    }
    return { status: "notFound" };
  }

  private async handleAccountLogout(): Promise<LogoutAccountResponse> {
    this.authState = null;
    await this.publishAccountUpdated();
    return {};
  }

  private handleAccountRateLimitsRead(): GetAccountRateLimitsResponse {
    return {
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
      },
      rateLimitsByLimitId: null,
    };
  }

  private get effectiveAuthMode(): AuthMode | null {
    if (!this.authState) {
      return null;
    }
    return this.authState.mode === "chatgptAuthTokens" ? "chatgpt" : this.authState.mode;
  }

  private handleGetAuthStatus(params: unknown): GetAuthStatusResponse {
    const parsed = (params ?? {}) as { includeToken?: boolean | null } | null;
    const includeToken = Boolean(parsed?.includeToken);
    const authToken =
      !includeToken || !this.authState
        ? null
        : this.authState.mode === "apikey"
          ? this.authState.apiKey
          : this.authState.accessToken;
    return {
      authMethod: this.effectiveAuthMode,
      authToken,
      requiresOpenaiAuth: this.authState !== null,
    };
  }

  private currentAccountUpdatedNotification(): AccountUpdatedNotification {
    return {
      authMode: this.effectiveAuthMode,
      planType: this.authState?.mode === "chatgptAuthTokens" ? this.authState.planType : null,
    };
  }

  private async publishAccountLoginCompleted(
    payload: AccountLoginCompletedNotification
  ): Promise<void> {
    await this.publish("account/login/completed", payload);
  }

  private async publishAccountUpdated(): Promise<void> {
    await this.publish("account/updated", this.currentAccountUpdatedNotification());
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

  private handleAppList(_params: unknown): AppListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private handleExperimentalFeatureList(_params: unknown): ExperimentalFeatureListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private handleCollaborationModeList(): CollaborationModeListResponse {
    return {
      data: [],
    };
  }

  private handleMcpServerStatusList(_params: unknown): McpServerStatusListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private async handleModelList(): Promise<ModelListResponse> {
    const models = await this.backendRouter.listModels();

    const response: ModelListResponse = {
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

    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "backend-event",
      method: "model/list",
      payload: response,
    });

    return response;
  }

  private async handleThreadStart(params: unknown): Promise<ThreadStartResponse> {
    const parsed = params as ThreadStartParams;
    await this.collabReady;
    const threadId = randomUUID();
    const ephemeral = parsed.ephemeral ?? false;
    const effectiveModel = this.resolveRequestedModel(parsed.cwd ?? null, parsed.model, null, null);
    const effectiveReasoningEffort = this.resolveRequestedReasoningEffort(
      parsed.cwd ?? null,
      parsed.config?.model_reasoning_effort as string | null | undefined,
      null,
      null
    );
    const selection = await this.resolveThreadStartSelection(effectiveModel, ephemeral);
    const backend = selection.backend;
    const threadStart = await backend.threadStart({
      threadId,
      cwd: parsed.cwd ?? process.cwd(),
      model: selection.selection.rawModelId,
      reasoningEffort: effectiveReasoningEffort,
      launchConfig: await this.createBackendSessionLaunchConfig(threadId),
    });
    const selectedModel =
      effectiveModel && parseBackendModelId(effectiveModel)
        ? effectiveModel
        : `${selection.selection.backendType}::${selection.selection.rawModelId}`;

    const entry = await this.threadRegistry.create({
      threadId,
      backendSessionId: threadStart.threadHandle,
      backendType: backend.backendType,
      ephemeral,
      hidden: ephemeral,
      path: ephemeral ? null : threadStart.path,
      cwd: parsed.cwd ?? process.cwd(),
      preview: "",
      model: selectedModel,
      modelProvider: parsed.modelProvider ?? backend.backendType,
      reasoningEffort: threadStart.reasoningEffort ?? effectiveReasoningEffort,
      gitInfo: null,
    });

    const runtime = this.initRuntime(entry.threadId, backend.backendType, threadStart.threadHandle);
    this.bindRuntimeSubscription(entry.threadId, runtime);
    this.transitionToReady(entry.threadId, runtime);

    const thread = this.buildThread(entry, []);
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publishThreadStatus(entry.threadId);
    return await this.buildThreadExecutionResponse(
      thread,
      entry.model,
      entry.reasoningEffort,
      selectedModel,
      parsed.cwd ?? null,
      parsed.approvalPolicy ?? null,
      parsed.approvalsReviewer ?? null,
      parsed.sandbox ?? null,
      threadStart.reasoningEffort ?? effectiveReasoningEffort
    );
  }

  private async handleThreadResume(params: unknown): Promise<ThreadResumeResponse> {
    const parsed = params as ThreadResumeParams;
    let entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    const effectiveModel = this.resolveRequestedModel(
      parsed.cwd ?? entry.cwd,
      parsed.model,
      null,
      entry.model
    );
    const effectiveReasoningEffort = this.resolveRequestedReasoningEffort(
      parsed.cwd ?? entry.cwd,
      parsed.config?.model_reasoning_effort as string | null | undefined,
      null,
      entry.reasoningEffort
    );
    const collabAgent = isSubAgentThreadSource(entry.source)
      ? (this.collabManager?.getAgentByThreadId(parsed.threadId) ?? null)
      : null;
    const needsCollabResume =
      collabAgent?.status === "shutdown" || collabAgent?.status === "errored";
    const existing = this.threadRuntimes.get(parsed.threadId);
    const previousLatestTurnId = existing?.latestTurnId ?? null;
    const runtime = existing
      ? this.prepareRuntimeForResume(parsed.threadId, existing)
      : this.createRuntime(
          parsed.threadId,
          entry.backendType,
          entry.backendSessionId,
          isSubAgentThreadSource(entry.source)
        );

    try {
      await this.collabReady;
      const requestedSelection =
        effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
      if (requestedSelection && requestedSelection.selection.backendType !== entry.backendType) {
        throw new Error(
          `Cannot resume thread ${entry.threadId} on backend ${requestedSelection.selection.backendType}; thread belongs to ${entry.backendType}`
        );
      }
      const resumed = await backend.threadResume({
        threadId: parsed.threadId,
        threadHandle: entry.backendSessionId,
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
        launchConfig: await this.createBackendSessionLaunchConfig(parsed.threadId),
      });
      runtime.backendType = entry.backendType;
      runtime.threadHandle = resumed.threadHandle;
      this.bindRuntimeSubscription(parsed.threadId, runtime);
      if (isSubAgentThreadSource(entry.source)) {
        this.collabManager?.syncExternalResume(
          parsed.threadId,
          resumed.threadHandle,
          entry.backendType
        );
      }
      if (
        entry.backendSessionId !== resumed.threadHandle ||
        entry.path !== resumed.path ||
        entry.model !== effectiveModel ||
        entry.reasoningEffort !== effectiveReasoningEffort
      ) {
        entry = await this.threadRegistry.update(parsed.threadId, {
          backendSessionId: resumed.threadHandle,
          path: entry.ephemeral ? null : resumed.path,
          model: effectiveModel,
          reasoningEffort: effectiveReasoningEffort,
        });
      }

      const readResult = await backend.threadRead({
        threadId: parsed.threadId,
        threadHandle: runtime.threadHandle,
        includeTurns: true,
        cwd: entry.cwd ?? process.cwd(),
      });
      if (readResult.threadHandle !== runtime.threadHandle) {
        runtime.threadHandle = readResult.threadHandle;
        entry = await this.threadRegistry.update(parsed.threadId, {
          backendSessionId: readResult.threadHandle,
        });
        this.bindRuntimeSubscription(parsed.threadId, runtime);
      }
      if (previousLatestTurnId && readResult.turns.length > 0) {
        const latestTurn = readResult.turns.at(-1);
        if (latestTurn) {
          latestTurn.id = previousLatestTurnId;
        }
      }
      this.transitionToReady(parsed.threadId, runtime);
      const thread = this.buildThread(entry, [...readResult.turns]);
      await this.publishThreadStatus(parsed.threadId);
      return await this.buildThreadExecutionResponse(
        thread,
        entry.model,
        entry.reasoningEffort,
        effectiveModel,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null,
        readResult.model ? effectiveReasoningEffort : effectiveReasoningEffort
      );
    } catch (error) {
      runtime.status = "terminating";
      runtime.readyResolver?.();
      this.threadRuntimes.delete(parsed.threadId);
      throw error;
    }
  }

  private async handleThreadFork(params: unknown): Promise<ThreadForkResponse> {
    const parsed = params as ThreadForkParams;
    const sourceEntry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(sourceEntry.backendType);
    const sourceRuntime = this.threadRuntimes.get(parsed.threadId);
    if (sourceRuntime && sourceRuntime.status !== "ready") {
      throw new Error(`Cannot fork thread ${parsed.threadId} (status: ${sourceRuntime.status})`);
    }

    if (sourceRuntime) {
      sourceRuntime.status = "forking";
      this.logTransition(parsed.threadId, "ready", "forking");
    }

    let forkThreadId: string | null = null;
    try {
      forkThreadId = randomUUID();
      await this.collabReady;
      const effectiveModel = this.resolveRequestedModel(
        parsed.cwd ?? sourceEntry.cwd,
        parsed.model,
        null,
        sourceEntry.model
      );
      const effectiveReasoningEffort = this.resolveRequestedReasoningEffort(
        parsed.cwd ?? sourceEntry.cwd,
        parsed.config?.model_reasoning_effort as string | null | undefined,
        null,
        sourceEntry.reasoningEffort
      );
      const requestedSelection =
        effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
      if (
        requestedSelection &&
        requestedSelection.selection.backendType !== sourceEntry.backendType
      ) {
        throw new Error(
          `Cannot fork thread ${parsed.threadId} across backends (${sourceEntry.backendType} -> ${requestedSelection.selection.backendType})`
        );
      }
      const forked = await backend.threadFork({
        threadId: forkThreadId,
        sourceThreadId: parsed.threadId,
        sourceThreadHandle: sourceEntry.backendSessionId,
        cwd: parsed.cwd ?? sourceEntry.cwd ?? process.cwd(),
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
        launchConfig: await this.createBackendSessionLaunchConfig(forkThreadId),
      });
      const ephemeral = parsed.ephemeral ?? false;
      const entry = await this.threadRegistry.create({
        threadId: forkThreadId,
        backendSessionId: forked.threadHandle,
        backendType: sourceEntry.backendType,
        ephemeral,
        hidden: ephemeral,
        path: ephemeral ? null : forked.path,
        cwd: parsed.cwd ?? sourceEntry.cwd,
        preview: sourceEntry.preview,
        model: effectiveModel,
        modelProvider: parsed.modelProvider ?? sourceEntry.backendType,
        reasoningEffort: forked.reasoningEffort ?? effectiveReasoningEffort,
        name: sourceEntry.name,
        gitInfo: sourceEntry.gitInfo,
      });

      const forkRuntime = this.initRuntime(
        entry.threadId,
        sourceEntry.backendType,
        forked.threadHandle
      );
      this.bindRuntimeSubscription(entry.threadId, forkRuntime);
      this.transitionToReady(entry.threadId, forkRuntime);

      const readResult = await backend.threadRead({
        threadId: entry.threadId,
        threadHandle: forkRuntime.threadHandle,
        includeTurns: true,
        cwd: entry.cwd ?? process.cwd(),
      });
      const thread = this.buildThread(entry, [...readResult.turns]);
      await this.publish("thread/started", { thread }, entry.threadId);
      await this.publishThreadStatus(entry.threadId);
      return await this.buildThreadExecutionResponse(
        thread,
        entry.model,
        entry.reasoningEffort,
        effectiveModel,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null,
        forked.reasoningEffort ?? effectiveReasoningEffort
      );
    } catch (error) {
      if (forkThreadId) {
        this.threadRuntimes.delete(forkThreadId);
      }
      throw error;
    } finally {
      if (sourceRuntime && sourceRuntime.status === "forking") {
        sourceRuntime.status = "ready";
        this.logTransition(parsed.threadId, "forking", "ready");
      }
    }
  }

  private async handleThreadRead(params: unknown): Promise<ThreadReadResponse> {
    const parsed = params as ThreadReadParams;
    let entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    const readResult = await backend.threadRead({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
      includeTurns: parsed.includeTurns,
      cwd: entry.cwd ?? process.cwd(),
    });
    if (readResult.threadHandle !== entry.backendSessionId) {
      entry = await this.threadRegistry.update(parsed.threadId, {
        backendSessionId: readResult.threadHandle,
      });
      const runtime = this.threadRuntimes.get(parsed.threadId);
      if (runtime) {
        runtime.threadHandle = readResult.threadHandle;
        this.bindRuntimeSubscription(parsed.threadId, runtime);
      }
    }
    const turns = parsed.includeTurns ? [...readResult.turns] : [];
    return { thread: this.buildThread(entry, turns) };
  }

  private async handleThreadList(params: unknown): Promise<ThreadListResponse> {
    const parsed = (params ?? {}) as Partial<ThreadListParams>;
    const cursor = Number(parsed.cursor ?? "0");
    const limit = parsed.limit ?? 50;
    const entries = [];
    for (const entry of await this.threadRegistry.list()) {
      if (!entry.hidden && isInternalTitlePreview(entry.preview)) {
        entries.push(
          await this.threadRegistry.update(entry.threadId, {
            hidden: true,
            preview: null,
          })
        );
        continue;
      }
      entries.push(entry);
    }

    const visibleEntries = entries
      .filter((entry) => !entry.hidden)
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
        !parsed.sourceKinds || parsed.sourceKinds.length === 0
          ? true
          : threadSourceKinds(entry.source).some((kind) => parsed.sourceKinds?.includes(kind))
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
    const slice = visibleEntries.slice(start, start + limit);
    return {
      data: slice.map((entry) => this.buildThread(entry, [])),
      nextCursor: start + limit < visibleEntries.length ? String(start + limit) : null,
    };
  }

  private handleThreadLoadedList(params: unknown): ThreadLoadedListResponse {
    const parsed = (params ?? {}) as Partial<ThreadLoadedListParams>;
    const loaded = [...this.threadRuntimes.keys()].sort();
    const start = Number.isFinite(Number(parsed.cursor ?? "0")) ? Number(parsed.cursor ?? "0") : 0;
    const limit = parsed.limit ?? loaded.length;
    return {
      data: loaded.slice(start, start + limit),
      nextCursor: start + limit < loaded.length ? String(start + limit) : null,
    };
  }

  private async handleThreadSetName(params: unknown): Promise<ThreadSetNameResponse> {
    const parsed = params as ThreadSetNameParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    await backend.threadSetName({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
      name: parsed.name,
    });
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
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    if (this.collabManager) {
      const collabAgent = this.collabManager.getAgentByThreadId(parsed.threadId);
      if (collabAgent) {
        await this.collabManager.close({
          parentThreadId: collabAgent.parentThreadId,
          id: collabAgent.agentId,
        });
      } else {
        await this.collabManager.shutdownByParent(parsed.threadId);
      }
    }
    const runtime = this.threadRuntimes.get(parsed.threadId);
    if (runtime) {
      const from = runtime.status;
      runtime.status = "terminating";
      runtime.readyResolver?.();
      runtime.readyResolver = null;
      runtime.readyPromise = null;
      this.logTransition(parsed.threadId, from, "terminating");
    }
    runtime?.subscription?.dispose();
    await backend.threadArchive({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
    });
    this.threadRuntimes.delete(parsed.threadId);
    await this.threadRegistry.update(parsed.threadId, { archived: true });
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
    if (!this.threadRuntimes.has(parsed.threadId)) {
      return { status: "notLoaded" };
    }
    if (this.state.unsubscribedThreadIds.has(parsed.threadId)) {
      return { status: "notSubscribed" };
    }
    this.state.unsubscribedThreadIds.add(parsed.threadId);
    return { status: "unsubscribed" };
  }

  private async handleTurnStart(params: unknown): Promise<TurnStartResponse> {
    const parsed = params as TurnStartParams;
    const runtime = await this.getReadyThreadRuntime(parsed.threadId);
    let entry = await this.getThreadEntry(parsed.threadId);
    const { text, preview } = this.normalizeUserInputs(parsed.input);
    const backend = this.requireBackend(entry.backendType);
    const effectiveModel = this.resolveRequestedModel(
      parsed.cwd ?? entry.cwd,
      parsed.model,
      parsed.collaborationMode ?? null,
      entry.model
    );
    const effectiveReasoningEffort = this.resolveRequestedReasoningEffort(
      parsed.cwd ?? entry.cwd,
      parsed.effort,
      parsed.collaborationMode ?? null,
      entry.reasoningEffort
    );
    const requestedSelection =
      effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
    if (requestedSelection && requestedSelection.selection.backendType !== entry.backendType) {
      throw new Error(
        `Cannot run turn on backend ${requestedSelection.selection.backendType}; thread belongs to ${entry.backendType}`
      );
    }
    const threadPatch: {
      hidden?: boolean;
      preview?: string | null;
      cwd?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
    } = {};
    if (!entry.preview && preview) {
      if (isInternalTitlePrompt(text)) {
        threadPatch.hidden = true;
        threadPatch.preview = null;
      } else {
        threadPatch.preview = preview;
      }
    }
    if (parsed.cwd) {
      threadPatch.cwd = parsed.cwd;
    }
    if (entry.model !== effectiveModel) {
      threadPatch.model = effectiveModel;
    }
    if (entry.reasoningEffort !== effectiveReasoningEffort) {
      threadPatch.reasoningEffort = effectiveReasoningEffort;
    }
    if (Object.keys(threadPatch).length > 0) {
      entry = await this.threadRegistry.update(parsed.threadId, threadPatch);
    }

    const turnId = randomUUID();
    runtime.status = "turn_active";
    runtime.activeTurnId = turnId;
    runtime.latestTurnId = turnId;
    runtime.subscription?.dispose();
    const collabAgent = isSubAgentThreadSource(entry.source)
      ? (this.collabManager?.getAgentByThreadId(parsed.threadId) ?? null)
      : null;
    if (collabAgent) {
      runtime.subscription = null;
      this.collabManager?.syncExternalTurnStart(parsed.threadId, turnId);
    } else {
      this.bindRuntimeSubscription(parsed.threadId, runtime);
    }

    await this.publishThreadStatus(parsed.threadId);

    let backendTurnId: string = turnId;
    try {
      const startedTurn = await backend.turnStart({
        threadId: parsed.threadId,
        threadHandle: runtime.threadHandle,
        turnId,
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        input: parsed.input,
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
      });
      if (startedTurn.turnId) {
        backendTurnId = startedTurn.turnId;
        runtime.activeTurnId = startedTurn.turnId;
        runtime.latestTurnId = startedTurn.turnId;
      }
    } catch (error) {
      await this.finishTurn(parsed.threadId, turnId);
      throw error;
    }

    return {
      turn: {
        id: backendTurnId,
        status: "inProgress",
        error: null,
        items: [],
      },
    };
  }

  private async handleTurnInterrupt(params: unknown): Promise<TurnInterruptResponse> {
    const parsed = params as TurnInterruptParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    const runtime = this.threadRuntimes.get(parsed.threadId);
    if (!runtime || runtime.status !== "turn_active" || runtime.activeTurnId !== parsed.turnId) {
      throw new Error(`No active turn ${parsed.turnId} for thread ${parsed.threadId}`);
    }

    await backend.turnInterrupt({
      threadId: parsed.threadId,
      threadHandle: runtime.threadHandle,
      turnId: parsed.turnId,
    });
    await this.finishTurn(parsed.threadId, parsed.turnId);
    if (
      isSubAgentThreadSource(entry.source) &&
      this.collabManager?.getAgentByThreadId(parsed.threadId)
    ) {
      this.collabManager?.syncExternalTurnInterrupt(parsed.threadId);
    }
    return {};
  }

  private async handleCommandExec(params: unknown): Promise<CommandExecResponse> {
    return await this.commandExecManager.execute(params as CommandExecParams);
  }

  private async handleCommandExecWrite(params: unknown): Promise<Record<string, never>> {
    await this.commandExecManager.write(params as CommandExecWriteParams);
    return {};
  }

  private async handleCommandExecResize(params: unknown): Promise<Record<string, never>> {
    await this.commandExecManager.resize(params as CommandExecResizeParams);
    return {};
  }

  private async handleCommandExecTerminate(params: unknown): Promise<Record<string, never>> {
    await this.commandExecManager.terminate(params as CommandExecTerminateParams);
    return {};
  }

  private async handleBackendEvent(threadId: string, event: BackendAppServerEvent): Promise<void> {
    const runtime = this.threadRuntimes.get(threadId);
    const turnId = backendEventTurnId(event);
    await this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "backend-event",
      threadId,
      ...(turnId ? { turnId } : {}),
      accepted: true,
      eventType: event.kind,
      payload: event,
    });

    switch (event.kind) {
      case "notification": {
        const params = await this.rewriteBackendNotification(
          threadId,
          event.threadHandle,
          event.method,
          event.params
        );
        await this.publish(event.method, params, threadId);
        if (event.method === "turn/started" && turnId && runtime) {
          runtime.status = "turn_active";
          runtime.activeTurnId = turnId;
          runtime.latestTurnId = turnId;
          await this.publishThreadStatus(threadId);
        }
        if (event.method === "turn/completed" && turnId) {
          await this.finishTurn(threadId, turnId);
        }
        return;
      }
      case "serverRequest": {
        const requestId = randomUUID();
        this.pendingBackendServerRequests.set(requestId, {
          threadId,
          backendType: runtime?.backendType ?? "unknown",
          threadHandle: runtime?.threadHandle ?? event.threadHandle,
          backendRequestId: event.requestId,
        });
        await this.send({
          id: requestId,
          method: event.method,
          params: this.rewriteBackendThreadReferences(threadId, event.threadHandle, event.params),
        }).catch(() => {
          this.pendingBackendServerRequests.delete(requestId);
        });
        return;
      }
      case "error":
        await this.publish(
          "backend/error",
          {
            threadId,
            backendType: runtime?.backendType ?? "unknown",
            code: event.code,
            message: event.message,
            retryable: event.retryable,
          },
          threadId
        );
        return;
      case "disconnect":
        await this.publish(
          "backend/disconnect",
          {
            threadId,
            backendType: runtime?.backendType ?? "unknown",
            message: event.message,
          },
          threadId
        );
        if (runtime?.activeTurnId) {
          await this.finishTurn(threadId, runtime.activeTurnId);
        }
        return;
    }
  }

  private enqueueBackendEvent(threadId: string, event: BackendAppServerEvent): void {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime) {
      return;
    }

    const run = async () => {
      await this.handleBackendEvent(threadId, event);
    };

    runtime.eventQueue = runtime.eventQueue.then(run, run).catch((error) => {
      this.logger.warn("Failed to handle backend event", {
        threadId,
        eventKind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async finishTurn(threadId: string, turnId: string): Promise<void> {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime || runtime.activeTurnId !== turnId) {
      return;
    }
    runtime.activeTurnId = null;
    runtime.status = "ready";
    runtime.statusOverride = null;
    await this.publishThreadStatus(threadId);
  }

  private syncCollabRuntimeState(agent: {
    threadId: string;
    threadHandle: string;
    backendType: string;
    status: string;
  }): void {
    const runtime = this.threadRuntimes.get(agent.threadId);
    if (!runtime || !runtime.managedByCollab) {
      return;
    }

    runtime.backendType = agent.backendType;
    runtime.threadHandle = agent.threadHandle;

    if (agent.status === "completed" || agent.status === "errored" || agent.status === "shutdown") {
      runtime.activeTurnId = null;
      runtime.status = "ready";
      runtime.statusOverride = null;
    }
    if (agent.status === "errored" || agent.status === "shutdown") {
      this.rejectPendingBackendServerRequests(
        agent.threadId,
        `Collab agent thread ${agent.threadId} closed before server request resolved`
      );
    }
  }

  private rejectPendingBackendServerRequests(threadId: string, _message: string): void {
    for (const [requestId, request] of this.pendingBackendServerRequests) {
      if (request.threadId !== threadId) {
        continue;
      }
      this.pendingBackendServerRequests.delete(requestId);
    }
  }

  private normalizeUserInputs(input: readonly UserInput[]): {
    text: string;
    images: BackendImageInput[];
    preview: string;
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
          throw new Error(`Unsupported user input type: ${item.type}`);
      }
    }

    const text = textParts.join("\n").trim();
    return {
      text,
      images,
      preview: text.slice(0, 120),
    };
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
      ephemeral: entry.ephemeral,
      modelProvider: entry.modelProvider ?? entry.backendType ?? DEFAULT_MODEL_PROVIDER,
      createdAt: toUnixSeconds(entry.createdAt),
      updatedAt: toUnixSeconds(entry.updatedAt),
      status: runtimeToThreadStatus(this.threadRuntimes.get(entry.threadId)),
      path: entry.path,
      cwd: entry.cwd ?? process.cwd(),
      cliVersion: ADAPTER_VERSION,
      source: "type" in entry.source ? "appServer" : entry.source,
      agentNickname: entry.agentNickname,
      agentRole: entry.agentRole,
      gitInfo: entry.gitInfo,
      name: entry.name,
      turns,
    };
  }

  private async buildThreadExecutionResponse(
    thread: Thread,
    persistedModel: string | null,
    persistedReasoningEffort: string | null,
    requestedModel: string | null,
    requestedCwd: string | null,
    requestedApprovalPolicy: string | null,
    requestedApprovalsReviewer: string | null,
    requestedSandboxMode: SandboxMode | null,
    requestedReasoningEffort: string | null
  ): Promise<ThreadStartResponse> {
    const models = await this.backendRouter.listModels();
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    const cwd = requestedCwd ?? thread.cwd;

    return {
      thread,
      model: requestedModel ?? persistedModel ?? defaultModel?.model ?? "unknown::default",
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd,
      approvalPolicy: requestedApprovalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: requestedApprovalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: buildSandboxPolicy(requestedSandboxMode, cwd),
      reasoningEffort:
        requestedReasoningEffort ??
        persistedReasoningEffort ??
        defaultModel?.defaultReasoningEffort ??
        null,
    };
  }

  private async publishThreadStatus(threadId: string): Promise<void> {
    await this.publish(
      "thread/status/changed",
      {
        threadId,
        status: runtimeToThreadStatus(this.threadRuntimes.get(threadId)),
      },
      threadId
    );
  }

  private async getReadyThreadRuntime(threadId: string): Promise<ThreadRuntime> {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime) {
      throw new Error(`Thread ${threadId} is not loaded`);
    }
    if (runtime.status === "starting" && runtime.readyPromise) {
      await runtime.readyPromise;
    }
    if (runtime.status !== "ready") {
      throw new Error(`Thread ${threadId} is not ready (status: ${runtime.status})`);
    }
    return runtime;
  }

  private async resolveThreadStartSelection(
    model: string | null,
    ephemeral: boolean
  ): Promise<RoutedBackendSelection> {
    try {
      return await this.backendRouter.resolveModelSelection(model);
    } catch (error) {
      if (!ephemeral || !model || parseBackendModelId(model)) {
        throw error;
      }
      const codexBackend = this.backendRouter.getBackend("codex");
      if (!codexBackend || !codexBackend.isAlive()) {
        throw error;
      }
      return {
        backend: codexBackend,
        selection: {
          backendType: codexBackend.backendType,
          rawModelId: model,
        },
      };
    }
  }

  private rewriteBackendThreadReferences(
    threadId: string,
    threadHandle: string,
    value: unknown
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        this.rewriteBackendThreadReferences(threadId, threadHandle, entry)
      );
    }
    if (!isRecord(value)) {
      return value;
    }

    const rewritten: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      rewritten[key] = this.rewriteBackendThreadReferences(threadId, threadHandle, entry);
    }

    if (rewritten.threadId === threadHandle) {
      rewritten.threadId = threadId;
    }

    if (isRecord(rewritten.thread) && rewritten.thread.id === threadHandle) {
      rewritten.thread = {
        ...rewritten.thread,
        id: threadId,
      };
    }

    return rewritten;
  }

  private async rewriteBackendNotification(
    threadId: string,
    threadHandle: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const rewritten = this.rewriteBackendThreadReferences(threadId, threadHandle, params);
    if (method !== "thread/started" || !isRecord(rewritten) || !isRecord(rewritten.thread)) {
      return rewritten;
    }

    const entry = await this.threadRegistry.get(threadId);
    if (!entry || !isSubAgentThreadSource(entry.source)) {
      return rewritten;
    }

    const thread = rewritten.thread;
    rewritten.thread = {
      ...thread,
      preview:
        typeof thread.preview === "string" && thread.preview.length > 0
          ? thread.preview
          : (entry.preview ?? ""),
      cwd: typeof thread.cwd === "string" ? thread.cwd : (entry.cwd ?? process.cwd()),
      path:
        typeof thread.path === "string" || thread.path === null
          ? thread.path
          : (entry.path ?? null),
      source: entry.source,
      agentNickname: entry.agentNickname,
      agentRole: entry.agentRole,
    };
    return rewritten;
  }

  private shouldUseDirectBackendSubscription(threadId: string, runtime: ThreadRuntime): boolean {
    if (!runtime.managedByCollab) {
      return true;
    }
    return this.collabManager?.getAgentByThreadId(threadId) === null;
  }

  private initRuntime(threadId: string, backendType: string, threadHandle: string): ThreadRuntime {
    return this.createRuntime(threadId, backendType, threadHandle, false);
  }

  private prepareRuntimeForResume(threadId: string, runtime: ThreadRuntime): ThreadRuntime {
    const from = runtime.status;
    runtime.status = "starting";
    runtime.activeTurnId = null;
    runtime.subscription?.dispose();
    runtime.subscription = null;
    runtime.statusOverride = null;
    runtime.readyPromise = new Promise<void>((resolve) => {
      runtime.readyResolver = resolve;
    });
    this.logTransition(threadId, from, "starting");
    return runtime;
  }

  private createRuntime(
    threadId: string,
    backendType: string,
    threadHandle: string,
    managedByCollab: boolean
  ): ThreadRuntime {
    let readyResolver: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolver = resolve;
    });
    const runtime: ThreadRuntime = {
      backendType,
      threadHandle,
      status: "starting",
      activeTurnId: null,
      latestTurnId: null,
      subscription: null,
      eventQueue: Promise.resolve(),
      readyResolver,
      readyPromise,
      managedByCollab,
      statusOverride: null,
    };
    this.threadRuntimes.set(threadId, runtime);
    this.logTransition(threadId, "none", "starting");
    return runtime;
  }

  private bindRuntimeSubscription(threadId: string, runtime: ThreadRuntime): void {
    runtime.subscription?.dispose();
    if (!this.shouldUseDirectBackendSubscription(threadId, runtime)) {
      runtime.subscription = null;
      return;
    }
    const backend = this.requireBackend(runtime.backendType);
    runtime.subscription = backend.onEvent(runtime.threadHandle, (event) => {
      this.enqueueBackendEvent(threadId, event);
    });
  }

  private transitionToReady(threadId: string, runtime: ThreadRuntime): void {
    const from = runtime.status;
    runtime.status = "ready";
    runtime.statusOverride = null;
    runtime.readyResolver?.();
    runtime.readyResolver = null;
    runtime.readyPromise = null;
    this.logTransition(threadId, from, "ready");
  }

  private logTransition(threadId: string, from: string, to: string): void {
    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "state-transition",
      threadId,
      payload: { from, to },
    });
  }

  private async getThreadEntry(threadId: string): Promise<ThreadRegistryEntry> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return entry;
  }

  private requireBackend(backendType: string): IBackend {
    return this.backendRouter.requireBackend(backendType);
  }

  get collabSocketPath(): string | null {
    return this.collabUdsListener?.socketPath ?? null;
  }

  private async createBackendSessionLaunchConfig(
    threadId: string
  ): Promise<BackendSessionLaunchConfig> {
    if (!this.collabEnabled || !this.collabUdsListener) {
      return {};
    }

    return {
      threadId,
      collabSocketPath: this.collabUdsListener.socketPath,
      availableModelsDescription: await this.createCollabAvailableModelsDescription(),
    };
  }

  private async createCollabAvailableModelsDescription(): Promise<string | null> {
    let models: Awaited<ReturnType<BackendRouter["listModels"]>>;
    try {
      models = await this.backendRouter.listModels();
    } catch {
      return null;
    }

    if (models.length === 0) {
      return null;
    }

    const lines = models.flatMap((model) => {
      const name = typeof model.model === "string" ? model.model : null;
      if (!name) {
        return [];
      }

      const efforts = model.supportedReasoningEfforts
        .map((entry) => entry.reasoningEffort)
        .filter((entry) => entry.length > 0)
        .join(", ");
      return [`- ${name}${efforts ? `: ${efforts}` : ""}`];
    });

    if (lines.length === 0) {
      return null;
    }

    return `Available models (use the backend-prefixed model id exactly as shown):\n${lines.join("\n")}`;
  }

  private async createCollabChildThread(input: CollabManagerCreateChildThreadInput): Promise<void> {
    const parentEntry = await this.getThreadEntry(input.parentThreadId);
    const entry = await this.threadRegistry.create({
      threadId: input.threadId,
      backendSessionId: input.threadHandle,
      backendType: input.backendType,
      path: input.path,
      cwd: parentEntry.cwd ?? process.cwd(),
      preview: input.preview,
      model: input.model,
      modelProvider: input.backendType,
      reasoningEffort: input.reasoningEffort,
      name: null,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: input.parentThreadId,
            depth: input.depth,
            agent_nickname: input.nickname,
            agent_role: input.role,
          },
        },
      },
      agentNickname: input.nickname,
      agentRole: input.role,
      gitInfo: null,
    });
    const runtime = this.createRuntime(entry.threadId, input.backendType, input.threadHandle, true);
    this.transitionToReady(entry.threadId, runtime);

    const thread = this.buildThread(entry, []);
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publishThreadStatus(entry.threadId);
  }

  private async startCollabChildTurn(
    agent: { threadId: string },
    _message: string
  ): Promise<string> {
    const runtime = this.threadRuntimes.get(agent.threadId);
    if (!runtime) {
      throw new Error(`Thread ${agent.threadId} is not loaded`);
    }

    const turnId = randomUUID();
    runtime.status = "turn_active";
    runtime.statusOverride = null;
    runtime.activeTurnId = turnId;
    runtime.latestTurnId = turnId;
    await this.publishThreadStatus(agent.threadId);
    return turnId;
  }
}
