import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BackendRouter, type RoutedBackendSelection } from "./backend-router.js";
import type {
  BackendAppServerEvent,
  BackendImageInput,
  BackendResolveServerRequestInput,
  BackendSessionLaunchConfig,
  BackendThreadReadResult,
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
  PluginListParams,
  PluginListResponse,
  SandboxMode,
  SandboxPolicy,
  SkillsListParams,
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
const DEFAULT_PI_GLOBAL_SKILLS_ROOT = resolve(homedir(), ".pi", "agent", "skills");
const DEFAULT_PI_PROJECT_SKILLS_RELATIVE_PATH = ".pi/agent/skills";
const PI_SKILLS_ENABLED_OVERRIDES_CONFIG_KEY = "pi_skills_enabled_overrides";
const PI_SKILLS_MARKETPLACE_NAME = "Pi Skills";

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
  readonly initialAuthState?: StoredAuthState | null;
  readonly identity?: AppServerIdentity;
  readonly logger?: AppServerLogger;
  readonly debugLogFilePath?: string | null;
  readonly threadRegistry?: ThreadRegistry;
  readonly onMessage?: (message: AppServerOutgoingMessage) => void | Promise<void>;
  readonly piGlobalSkillsRoot?: string | null;
  readonly piProjectSkillsRelativePath?: string | null;
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
  loadedTurnIds: string[];
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

interface ThreadExecutionContext {
  readonly cwd: string;
  readonly model: string | null;
  readonly approvalPolicy: string | null;
  readonly approvalsReviewer: string | null;
  readonly sandbox: SandboxMode | null;
  readonly sandboxPolicy: JsonValue | null;
  readonly config: { [key: string]: JsonValue | undefined } | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly serviceName: string | null;
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  readonly personality: string | null;
  readonly summary: string | null;
  readonly collaborationMode: JsonValue | null;
}

export type StoredAuthState =
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

function rewriteCollaborationModeSettings(
  collaborationMode: JsonValue | null,
  options: {
    model: string | null;
    reasoningEffort: string | null;
  }
): JsonValue | null {
  if (typeof collaborationMode !== "object" || collaborationMode === null) {
    return collaborationMode;
  }

  const mode = collaborationMode as Record<string, JsonValue | undefined>;
  const settings: Record<string, JsonValue | undefined> = isRecord(mode.settings)
    ? { ...(mode.settings as Record<string, JsonValue | undefined>) }
    : {};

  if (options.model) {
    settings.model = options.model;
  } else {
    settings.model = undefined;
  }

  if (options.reasoningEffort) {
    settings.reasoning_effort = options.reasoningEffort;
  } else {
    settings.reasoning_effort = undefined;
  }

  return {
    ...mode,
    settings,
  };
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
  const openaiProfile =
    payload?.["https://api.openai.com/profile"] &&
    typeof payload["https://api.openai.com/profile"] === "object"
      ? (payload["https://api.openai.com/profile"] as Record<string, unknown>)
      : null;
  const authClaims =
    payload?.["https://api.openai.com/auth"] &&
    typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as Record<string, unknown>)
      : null;
  const email =
    typeof payload?.email === "string"
      ? payload.email
      : typeof openaiProfile?.email === "string"
        ? openaiProfile.email
        : typeof profile?.email === "string"
          ? profile.email
          : null;
  return {
    email,
    planType: normalizePlanType(authClaims?.chatgpt_plan_type),
  };
}

export function readStoredAuthState(): StoredAuthState | null {
  const authPath = resolve(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : null;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : null;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : null;
    if (accessToken && accountId) {
      const identity = extractChatgptIdentity(accessToken);
      return {
        mode: "chatgptAuthTokens",
        accessToken,
        accountId,
        email: identity.email,
        planType: identity.planType,
      };
    }

    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
    if (apiKey && apiKey.length > 0) {
      return {
        mode: "apikey",
        apiKey,
      };
    }
  } catch {
    return null;
  }

  return null;
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
  readonly diagnostics?: unknown;
  readonly durationMs?: number;
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

function isSubAgentThreadSource(
  source: ThreadRegistryEntry["source"]
): source is Extract<ThreadRegistryEntry["source"], { subAgent: unknown }> {
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

function titleCaseFromSlug(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed.charAt(0);
    const last = trimmed.charAt(trimmed.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseSkillFrontmatter(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return {
      name: null,
      description: null,
    };
  }

  let name: string | null = null;
  let description: string | null = null;
  for (const line of frontmatterMatch[1].split(/\r?\n/g)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    const value = parseFrontmatterValue(match[2]);
    if (value.length === 0) {
      continue;
    }

    if (key === "name") {
      name = value;
      continue;
    }
    if (key === "description") {
      description = value;
    }
  }

  return {
    name,
    description,
  };
}

async function discoverSkillFiles(rootPath: string): Promise<string[]> {
  const skillFiles: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name === "SKILL.md") {
          skillFiles.push(entryPath);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return skillFiles;
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = resolve(rootPath);
  const normalizedTarget = resolve(targetPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

interface NativeSubAgentInfo {
  readonly localThreadId: string;
  readonly backendThreadId: string;
  readonly nickname: string | null;
}

interface DiscoveredSkillInterface {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly iconSmall: string | null;
  readonly iconLarge: string | null;
  readonly brandColor: string | null;
  readonly defaultPrompt: string | null;
  readonly [key: string]: JsonValue | undefined;
}

interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly interface: DiscoveredSkillInterface;
  readonly path: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly [key: string]: JsonValue | undefined;
}

interface SkillsConfigWriteParams {
  readonly path: string;
  readonly enabled: boolean;
}

interface PluginReadParams {
  readonly marketplacePath: string;
  readonly pluginName: string;
}

interface PluginInstallParams {
  readonly marketplacePath: string;
  readonly pluginName: string;
}

interface PluginUninstallParams {
  readonly pluginId: string;
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
  private readonly piGlobalSkillsRoot: string | null;
  private readonly piProjectSkillsRelativePath: string | null;
  private readonly collabManager: CollabManager | null;
  private readonly collabUdsListener: CollabUdsListener | null;
  private readonly collabReady: Promise<void>;
  private readonly threadRuntimes = new Map<string, ThreadRuntime>();
  private readonly threadExecutionContexts = new Map<string, ThreadExecutionContext>();
  private readonly streamedCommandItemsByThread = new Map<string, Set<string>>();
  private readonly pendingBackendServerRequests = new Map<
    string | number,
    PendingBackendServerRequest
  >();
  private authState: StoredAuthState | null = null;
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
    this.piGlobalSkillsRoot = options.piGlobalSkillsRoot ?? DEFAULT_PI_GLOBAL_SKILLS_ROOT;
    this.piProjectSkillsRelativePath =
      options.piProjectSkillsRelativePath ?? DEFAULT_PI_PROJECT_SKILLS_RELATIVE_PATH;
    this.commandExecManager = new CommandExecManager({
      onNotification: async (notification) => {
        await this.publish(notification.method, notification.params);
      },
    });
    this.authState = options.initialAuthState ?? null;
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
        resolveThreadExecutionContext: (threadId) => this.cloneThreadExecutionContext(threadId),
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
    const pendingEventQueues: Promise<void>[] = [];
    for (const runtime of this.threadRuntimes.values()) {
      runtime.status = "terminating";
      runtime.readyResolver?.();
      runtime.readyResolver = null;
      runtime.readyPromise = null;
      runtime.subscription?.dispose();
      pendingEventQueues.push(runtime.eventQueue.catch(() => {}));
    }
    await Promise.all(pendingEventQueues);
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
          return success(request.id, await this.handleSkillsList(request.params));
        case "skills/config/write":
          return success(request.id, await this.handleSkillsConfigWrite(request.params));
        case "plugin/list":
          return success(request.id, await this.handlePluginList(request.params));
        case "plugin/read":
          return success(request.id, await this.handlePluginRead(request.params));
        case "plugin/install":
          return success(request.id, await this.handlePluginInstall(request.params));
        case "plugin/uninstall":
          return success(request.id, await this.handlePluginUninstall(request.params));
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
    const model =
      requestedModel ??
      resolveCollaborationModeSetting(collaborationMode, "model") ??
      persistedModel ??
      this.readEffectiveConfig(cwd).model;
    return this.backendRouter.canonicalizeModelSelection(model);
  }

  private coerceModelToRequestedProvider(
    model: string | null,
    modelProvider: string | null | undefined,
    explicitlyRequestedModel: string | null | undefined
  ): string | null {
    if (!model) {
      return model;
    }
    if (!explicitlyRequestedModel && !this.backendRouter.parseModelSelection(model)) {
      return null;
    }
    if (explicitlyRequestedModel || !modelProvider) {
      return model;
    }
    const parsed = this.backendRouter.parseModelSelection(model);
    if (!parsed || parsed.selection.backendType !== modelProvider) {
      return null;
    }
    return model;
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
      requiresOpenaiAuth: this.authState !== null,
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

  private parseSkillsListCwds(params: SkillsListParams): string[] {
    const cwds = Array.isArray(params.cwds)
      ? params.cwds.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
      : [];
    return cwds.length > 0 ? cwds : [process.cwd()];
  }

  private parsePerCwdExtraSkillRoots(
    perCwdExtraUserRoots: JsonValue[] | null | undefined,
    cwdCount: number
  ): string[][] {
    const rootsByCwd = Array.from({ length: cwdCount }, () => [] as string[]);
    if (!Array.isArray(perCwdExtraUserRoots)) {
      return rootsByCwd;
    }

    for (let index = 0; index < Math.min(cwdCount, perCwdExtraUserRoots.length); index += 1) {
      const entry = perCwdExtraUserRoots[index];
      if (typeof entry === "string" && entry.length > 0) {
        rootsByCwd[index]?.push(entry);
        continue;
      }
      if (Array.isArray(entry)) {
        for (const root of entry) {
          if (typeof root === "string" && root.length > 0) {
            rootsByCwd[index]?.push(root);
          }
        }
        continue;
      }
      if (isRecord(entry) && Array.isArray(entry.roots)) {
        for (const root of entry.roots) {
          if (typeof root === "string" && root.length > 0) {
            rootsByCwd[index]?.push(root);
          }
        }
      }
    }

    return rootsByCwd;
  }

  private readSkillEnabledOverrides(): Record<string, boolean> {
    const config = this.configStore.read({ includeLayers: false }).config;
    const raw = config[PI_SKILLS_ENABLED_OVERRIDES_CONFIG_KEY];
    if (!isRecord(raw)) {
      return {};
    }

    const overrides: Record<string, boolean> = {};
    for (const [path, enabled] of Object.entries(raw)) {
      if (typeof enabled === "boolean") {
        overrides[path] = enabled;
      }
    }
    return overrides;
  }

  private writeSkillEnabledOverrides(overrides: Record<string, boolean>): void {
    this.configStore.writeValue({
      keyPath: PI_SKILLS_ENABLED_OVERRIDES_CONFIG_KEY,
      value: overrides,
      mergeStrategy: "replace",
    });
  }

  private async collectPiSkillsForRoots(
    roots: readonly { path: string; scope: string }[],
    enabledOverrides: Readonly<Record<string, boolean>>
  ): Promise<{ skills: DiscoveredSkill[]; errors: JsonValue[] }> {
    const skills: DiscoveredSkill[] = [];
    const errors: JsonValue[] = [];
    const seenPaths = new Set<string>();

    for (const root of roots) {
      let skillPaths: string[];
      try {
        skillPaths = await discoverSkillFiles(root.path);
      } catch (error) {
        errors.push({
          root: root.path,
          scope: root.scope,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      skillPaths.sort((left, right) => left.localeCompare(right));
      for (const skillPath of skillPaths) {
        if (seenPaths.has(skillPath)) {
          continue;
        }
        seenPaths.add(skillPath);

        let markdown: string;
        try {
          markdown = await readFile(skillPath, "utf8");
        } catch (error) {
          errors.push({
            root: root.path,
            scope: root.scope,
            path: skillPath,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const frontmatter = parseSkillFrontmatter(markdown);
        const fallbackName = basename(dirname(skillPath));
        const name = frontmatter.name ?? fallbackName;
        const description = frontmatter.description ?? `Pi skill available at ${skillPath}`;
        const enabled = enabledOverrides[skillPath] ?? true;

        skills.push({
          name,
          description,
          interface: {
            displayName: titleCaseFromSlug(name),
            shortDescription: description,
            iconSmall: null,
            iconLarge: null,
            brandColor: null,
            defaultPrompt: null,
          },
          path: skillPath,
          scope: root.scope,
          enabled,
        });
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name));
    return {
      skills,
      errors,
    };
  }

  private async listDiscoveredSkillsByCwd(
    cwds: readonly string[],
    extraRootsByCwd: readonly string[][]
  ): Promise<Array<{ cwd: string; skills: DiscoveredSkill[]; errors: JsonValue[] }>> {
    const enabledOverrides = this.readSkillEnabledOverrides();
    const results: Array<{ cwd: string; skills: DiscoveredSkill[]; errors: JsonValue[] }> = [];

    for (const [index, cwd] of cwds.entries()) {
      const rawRoots: Array<{ path: string; scope: string }> = [];
      if (this.piGlobalSkillsRoot) {
        rawRoots.push({
          path: this.piGlobalSkillsRoot,
          scope: "user",
        });
      }
      if (this.piProjectSkillsRelativePath) {
        rawRoots.push({
          path: join(cwd, this.piProjectSkillsRelativePath),
          scope: "project",
        });
      }
      for (const extraRoot of extraRootsByCwd[index] ?? []) {
        rawRoots.push({
          path: resolve(cwd, extraRoot),
          scope: "user",
        });
      }

      const seenRoots = new Set<string>();
      const uniqueRoots: Array<{ path: string; scope: string }> = [];
      for (const root of rawRoots) {
        const resolvedPath = resolve(root.path);
        if (seenRoots.has(resolvedPath)) {
          continue;
        }
        seenRoots.add(resolvedPath);
        uniqueRoots.push({
          path: resolvedPath,
          scope: root.scope,
        });
      }

      const { skills, errors } = await this.collectPiSkillsForRoots(uniqueRoots, enabledOverrides);
      results.push({
        cwd,
        skills,
        errors,
      });
    }

    return results;
  }

  private async handleSkillsList(params: unknown): Promise<SkillsListResponse> {
    const parsed = (params ?? {}) as SkillsListParams;
    const cwds = this.parseSkillsListCwds(parsed);
    const extraRootsByCwd = this.parsePerCwdExtraSkillRoots(
      parsed.perCwdExtraUserRoots,
      cwds.length
    );

    const rows = await this.listDiscoveredSkillsByCwd(cwds, extraRootsByCwd);
    return {
      data: rows.map((row) => ({
        cwd: row.cwd,
        skills: row.skills,
        errors: row.errors,
      })),
    };
  }

  private async handleSkillsConfigWrite(params: unknown): Promise<{ effectiveEnabled: boolean }> {
    if (
      !isRecord(params) ||
      typeof params.path !== "string" ||
      typeof params.enabled !== "boolean"
    ) {
      throw new Error("Invalid skills/config/write params");
    }

    const path = resolve(params.path);
    const enabled = params.enabled;
    const overrides = this.readSkillEnabledOverrides();
    overrides[path] = enabled;
    this.writeSkillEnabledOverrides(overrides);
    await this.publish("skills/changed", {
      path,
      enabled,
    });
    return {
      effectiveEnabled: enabled,
    };
  }

  private parsePluginListCwds(params: PluginListParams): string[] {
    const cwds = Array.isArray(params.cwds)
      ? params.cwds.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
      : [];
    return cwds.length > 0 ? cwds : [process.cwd()];
  }

  private toPluginSummary(skill: DiscoveredSkill): JsonValue {
    const pluginId = `${skill.name}@pi-skills`;
    return {
      id: pluginId,
      name: skill.name,
      source: {
        type: "local",
        path: dirname(skill.path),
      },
      installed: true,
      enabled: skill.enabled,
      installPolicy: "INSTALLED",
      authPolicy: "NONE",
      interface: {
        displayName: skill.interface.displayName,
        shortDescription: skill.interface.shortDescription,
        longDescription: skill.description,
        developerName: "Pi",
        category: "Skills",
        capabilities: [],
        websiteUrl: null,
        privacyPolicyUrl: null,
        termsOfServiceUrl: null,
        defaultPrompt:
          skill.interface.defaultPrompt !== null
            ? [skill.interface.defaultPrompt]
            : [skill.description],
        brandColor: skill.interface.brandColor,
        composerIcon: skill.interface.iconSmall,
        logo: skill.interface.iconLarge,
        screenshots: [],
      },
    };
  }

  private async handlePluginList(params: unknown): Promise<PluginListResponse> {
    const parsed = (params ?? {}) as PluginListParams;
    const cwds = this.parsePluginListCwds(parsed);
    const discoveredByCwd = await this.listDiscoveredSkillsByCwd(
      cwds,
      Array.from({ length: cwds.length }, () => [])
    );

    const skillsByName = new Map<string, DiscoveredSkill>();
    for (const entry of discoveredByCwd) {
      for (const skill of entry.skills) {
        if (!skillsByName.has(skill.name)) {
          skillsByName.set(skill.name, skill);
        }
      }
    }

    return {
      marketplaces: [
        {
          name: "pi-skills",
          path: this.piGlobalSkillsRoot ?? DEFAULT_PI_GLOBAL_SKILLS_ROOT,
          interface: {
            displayName: PI_SKILLS_MARKETPLACE_NAME,
          },
          plugins: [...skillsByName.values()].map((skill) => this.toPluginSummary(skill)),
        },
      ],
      remoteSyncError: null,
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    } as PluginListResponse;
  }

  private async handlePluginRead(params: unknown): Promise<{ plugin: JsonValue }> {
    if (
      !isRecord(params) ||
      typeof params.marketplacePath !== "string" ||
      typeof params.pluginName !== "string"
    ) {
      throw new Error("Invalid plugin/read params");
    }

    const skillsRows = await this.listDiscoveredSkillsByCwd([process.cwd()], [[]]);
    const skills = skillsRows.flatMap((row) => row.skills);
    const skill = skills.find((candidate) => candidate.name === params.pluginName);
    if (!skill) {
      throw new Error(`Unknown plugin: ${params.pluginName}`);
    }

    return {
      plugin: {
        marketplaceName: PI_SKILLS_MARKETPLACE_NAME,
        marketplacePath: params.marketplacePath,
        summary: this.toPluginSummary(skill),
        description: skill.description,
        skills: [skill],
        apps: [],
        mcpServers: [],
      },
    };
  }

  private async handlePluginInstall(
    params: unknown
  ): Promise<{ authPolicy: string; appsNeedingAuth: JsonValue[] }> {
    if (
      !isRecord(params) ||
      typeof params.marketplacePath !== "string" ||
      typeof params.pluginName !== "string"
    ) {
      throw new Error("Invalid plugin/install params");
    }

    const skillsRows = await this.listDiscoveredSkillsByCwd([process.cwd()], [[]]);
    const skills = skillsRows.flatMap((row) => row.skills);
    const skill = skills.find((candidate) => candidate.name === params.pluginName);
    if (!skill) {
      throw new Error(`Unknown plugin: ${params.pluginName}`);
    }

    await this.publish("skills/changed", {
      pluginName: skill.name,
      action: "install",
    });
    return {
      authPolicy: "NONE",
      appsNeedingAuth: [],
    };
  }

  private async handlePluginUninstall(params: unknown): Promise<Record<string, never>> {
    const parsed = params as PluginUninstallParams;
    if (!parsed || typeof parsed.pluginId !== "string") {
      throw new Error("Invalid plugin/uninstall params");
    }

    const pluginName = parsed.pluginId.split("@")[0] ?? parsed.pluginId;
    const skillsRows = await this.listDiscoveredSkillsByCwd([process.cwd()], [[]]);
    const skills = skillsRows.flatMap((row) => row.skills);
    const skill = skills.find((candidate) => candidate.name === pluginName);
    if (!skill) {
      return {};
    }

    if (skill.scope === "system") {
      throw new Error(`Cannot uninstall system skill: ${skill.name}`);
    }

    const skillDirectory = dirname(skill.path);
    if (
      !isPathWithin(this.piGlobalSkillsRoot ?? DEFAULT_PI_GLOBAL_SKILLS_ROOT, skillDirectory) &&
      !skill.path.includes(`/${DEFAULT_PI_PROJECT_SKILLS_RELATIVE_PATH}/`)
    ) {
      throw new Error(`Refusing to uninstall skill outside managed roots: ${skill.path}`);
    }

    await rm(skillDirectory, { recursive: true, force: true });

    const overrides = this.readSkillEnabledOverrides();
    for (const knownPath of Object.keys(overrides)) {
      if (isPathWithin(skillDirectory, knownPath)) {
        delete overrides[knownPath];
      }
    }
    this.writeSkillEnabledOverrides(overrides);
    await this.publish("skills/changed", {
      pluginId: parsed.pluginId,
      action: "uninstall",
    });
    return {};
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
    const { models, diagnostics, totalDurationMs } = await this.backendRouter.listModelsDetailed();

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
      diagnostics,
      durationMs: totalDurationMs,
    });

    return response;
  }

  private async handleThreadStart(params: unknown): Promise<ThreadStartResponse> {
    const parsed = params as ThreadStartParams;
    await this.collabReady;
    const threadId = randomUUID();
    const ephemeral = parsed.ephemeral ?? false;
    const effectiveModel = this.coerceModelToRequestedProvider(
      this.resolveRequestedModel(parsed.cwd ?? null, parsed.model, null, null),
      parsed.modelProvider,
      parsed.model
    );
    const effectiveReasoningEffort = this.resolveRequestedReasoningEffort(
      parsed.cwd ?? null,
      parsed.config?.model_reasoning_effort as string | null | undefined,
      null,
      null
    );
    const selection = await this.resolveThreadStartSelection(
      effectiveModel,
      parsed.modelProvider,
      ephemeral
    );
    const backend = selection.backend;
    const threadStart = await backend.threadStart({
      threadId,
      cwd: parsed.cwd ?? process.cwd(),
      model: selection.selection.rawModelId,
      reasoningEffort: effectiveReasoningEffort,
      approvalPolicy: parsed.approvalPolicy ?? null,
      approvalsReviewer: parsed.approvalsReviewer ?? null,
      sandbox: parsed.sandbox ?? null,
      config: parsed.config ?? null,
      serviceTier: parsed.serviceTier ?? null,
      serviceName: parsed.serviceName ?? null,
      baseInstructions: parsed.baseInstructions ?? null,
      developerInstructions: parsed.developerInstructions ?? null,
      personality: parsed.personality ?? null,
      ephemeral: parsed.ephemeral ?? null,
      experimentalRawEvents: parsed.experimentalRawEvents,
      persistExtendedHistory: parsed.persistExtendedHistory,
      launchConfig: await this.createBackendSessionLaunchConfig(threadId),
    });
    const selectedModel = this.backendRouter.toClientModelId(
      selection.selection.backendType,
      selection.selection.rawModelId
    );

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
    this.recordThreadExecutionContext(entry.threadId, {
      cwd: parsed.cwd ?? process.cwd(),
      model: entry.model,
      approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: parsed.sandbox ?? null,
      sandboxPolicy: buildSandboxPolicy(parsed.sandbox ?? null, parsed.cwd ?? process.cwd()),
      config: parsed.config ?? null,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: parsed.serviceTier ?? null,
      serviceName: parsed.serviceName ?? null,
      baseInstructions: parsed.baseInstructions ?? null,
      developerInstructions: parsed.developerInstructions ?? null,
      personality: parsed.personality ?? null,
      summary: null,
      collaborationMode: null,
    });
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
    const collabRuntimeState = collabAgent
      ? (this.collabManager?.getAgentRuntimeStateByThreadId(parsed.threadId) ?? null)
      : null;
    const needsCollabResume =
      collabAgent?.status === "shutdown" || collabAgent?.status === "errored";
    const existing = this.threadRuntimes.get(parsed.threadId);
    const existingActiveTurnId = existing?.activeTurnId ?? null;
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
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandbox: parsed.sandbox ?? null,
        config: parsed.config ?? null,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: parsed.personality ?? null,
        persistExtendedHistory: parsed.persistExtendedHistory,
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
      entry =
        (await this.syncCanonicalThreadRead(parsed.threadId, readResult, {
          allowRecoveredNicknameNameFallback: true,
        })) ?? entry;
      const turns = this.normalizeReadTurns(entry, [...readResult.turns]);
      this.reconcileLoadedTurnIds(parsed.threadId, turns);
      const resumedActiveTurnId = collabRuntimeState?.activeTurnId ?? existingActiveTurnId;
      const shouldRemainActive =
        collabRuntimeState?.status === "running" || collabRuntimeState?.status === "pendingInit";
      if (shouldRemainActive) {
        const from = runtime.status;
        runtime.status = "turn_active";
        runtime.statusOverride = null;
        runtime.readyResolver?.();
        runtime.readyResolver = null;
        runtime.readyPromise = null;
        runtime.activeTurnId = resumedActiveTurnId;
        runtime.latestTurnId = resumedActiveTurnId ?? runtime.latestTurnId;
        this.logTransition(parsed.threadId, from, "turn_active");
      } else {
        this.transitionToReady(parsed.threadId, runtime);
      }
      const thread = this.buildThread(entry, turns);
      this.recordThreadExecutionContext(entry.threadId, {
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        model: entry.model,
        approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
        sandbox: parsed.sandbox ?? null,
        sandboxPolicy: buildSandboxPolicy(parsed.sandbox ?? null, parsed.cwd ?? thread.cwd),
        config: parsed.config ?? null,
        reasoningEffort: entry.reasoningEffort,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: parsed.personality ?? null,
        summary: null,
        collaborationMode: null,
      });
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
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandbox: parsed.sandbox ?? null,
        config: parsed.config ?? null,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        ephemeral: parsed.ephemeral ?? null,
        persistExtendedHistory: parsed.persistExtendedHistory,
        launchConfig: await this.createBackendSessionLaunchConfig(forkThreadId),
      });
      const ephemeral = parsed.ephemeral ?? false;
      let entry = await this.threadRegistry.create({
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
      entry = (await this.syncCanonicalThreadRead(entry.threadId, readResult)) ?? entry;
      const turns = [...readResult.turns];
      this.reconcileLoadedTurnIds(entry.threadId, turns);
      const thread = this.buildThread(entry, turns);
      this.recordThreadExecutionContext(entry.threadId, {
        cwd: parsed.cwd ?? sourceEntry.cwd ?? process.cwd(),
        model: entry.model,
        approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
        sandbox: parsed.sandbox ?? null,
        sandboxPolicy: buildSandboxPolicy(
          parsed.sandbox ?? null,
          parsed.cwd ?? sourceEntry.cwd ?? process.cwd()
        ),
        config: parsed.config ?? null,
        reasoningEffort: entry.reasoningEffort,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: null,
        summary: null,
        collaborationMode: null,
      });
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
    entry = (await this.syncCanonicalThreadRead(parsed.threadId, readResult)) ?? entry;
    const turns = parsed.includeTurns ? this.normalizeReadTurns(entry, [...readResult.turns]) : [];
    if (parsed.includeTurns) {
      this.reconcileLoadedTurnIds(parsed.threadId, turns);
    }
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
    this.threadExecutionContexts.delete(parsed.threadId);
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

    const existingExecutionContext = this.cloneThreadExecutionContext(parsed.threadId);
    this.recordThreadExecutionContext(parsed.threadId, {
      cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
      model: entry.model,
      approvalPolicy:
        parsed.approvalPolicy ??
        existingExecutionContext?.approvalPolicy ??
        DEFAULT_APPROVAL_POLICY,
      approvalsReviewer:
        parsed.approvalsReviewer ??
        existingExecutionContext?.approvalsReviewer ??
        DEFAULT_APPROVALS_REVIEWER,
      sandbox: existingExecutionContext?.sandbox ?? null,
      sandboxPolicy:
        parsed.sandboxPolicy ??
        existingExecutionContext?.sandboxPolicy ??
        buildSandboxPolicy(
          existingExecutionContext?.sandbox ?? null,
          parsed.cwd ?? entry.cwd ?? process.cwd()
        ),
      config: existingExecutionContext?.config ?? null,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: parsed.serviceTier ?? existingExecutionContext?.serviceTier ?? null,
      serviceName: existingExecutionContext?.serviceName ?? null,
      baseInstructions: existingExecutionContext?.baseInstructions ?? null,
      developerInstructions: existingExecutionContext?.developerInstructions ?? null,
      personality: parsed.personality ?? existingExecutionContext?.personality ?? null,
      summary: parsed.summary ?? existingExecutionContext?.summary ?? null,
      collaborationMode:
        parsed.collaborationMode ?? existingExecutionContext?.collaborationMode ?? null,
    });

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
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandboxPolicy: parsed.sandboxPolicy ?? null,
        serviceTier: parsed.serviceTier ?? null,
        summary: parsed.summary ?? null,
        personality: parsed.personality ?? null,
        outputSchema: parsed.outputSchema ?? null,
        collaborationMode: parsed.collaborationMode ?? null,
      });
      if (startedTurn.turnId) {
        backendTurnId = startedTurn.turnId;
        runtime.activeTurnId = startedTurn.turnId;
        runtime.latestTurnId = startedTurn.turnId;
      }
      this.recordLoadedTurnId(runtime, backendTurnId, turnId);
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
        if (event.method === "thread/started") {
          const updatedThread = await this.syncCanonicalThreadStarted(threadId, event.params);
          if (updatedThread) {
            await this.publish("thread/started", { thread: updatedThread }, threadId);
          }
          return;
        }
        const params = await this.rewriteBackendNotification(
          threadId,
          event.threadHandle,
          event.method,
          event.params
        );
        this.trackStreamedCommandItem(threadId, event.method, params);
        await this.publish(event.method, params, threadId);
        if (event.method === "turn/started" && turnId && runtime) {
          const previousTurnId = runtime.activeTurnId;
          runtime.status = "turn_active";
          runtime.activeTurnId = turnId;
          runtime.latestTurnId = turnId;
          this.recordLoadedTurnId(runtime, turnId, previousTurnId);
          await this.publishThreadStatus(threadId);
        }
        if (event.method === "turn/completed" && turnId) {
          if (runtime) {
            this.recordLoadedTurnId(runtime, turnId, runtime.activeTurnId);
          }
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

  private recordThreadExecutionContext(threadId: string, context: ThreadExecutionContext): void {
    this.threadExecutionContexts.set(threadId, structuredClone(context));
  }

  private cloneThreadExecutionContext(threadId: string): ThreadExecutionContext | null {
    const context = this.threadExecutionContexts.get(threadId);
    return context ? structuredClone(context) : null;
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
    modelProvider: string | null | undefined,
    ephemeral: boolean
  ): Promise<RoutedBackendSelection> {
    try {
      return await this.backendRouter.resolveModelSelection(model, modelProvider);
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

  private readNativeSubAgentNickname(
    parentPath: string | null,
    toolCallId: string,
    backendThreadId: string
  ): string | null {
    if (!parentPath) {
      return null;
    }

    try {
      const lines = readFileSync(parentPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(lines[index] ?? "");
        if (
          !isRecord(parsed) ||
          parsed.type !== "response_item" ||
          !isRecord(parsed.payload) ||
          parsed.payload.type !== "function_call_output" ||
          parsed.payload.call_id !== toolCallId ||
          typeof parsed.payload.output !== "string"
        ) {
          continue;
        }
        const output = JSON.parse(parsed.payload.output);
        if (!isRecord(output) || output.agent_id !== backendThreadId) {
          continue;
        }
        return typeof output.nickname === "string" && output.nickname.length > 0
          ? output.nickname
          : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private readNativeSubAgentSessionMetadata(sessionPath: string | null): {
    agentNickname: string | null;
    agentRole: string | null;
  } | null {
    if (!sessionPath) {
      return null;
    }

    try {
      const lines = readFileSync(sessionPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
          continue;
        }

        const payload = parsed.payload;
        const subagent =
          isRecord(payload.source) && isRecord(payload.source.subagent)
            ? payload.source.subagent
            : null;
        const threadSpawn =
          subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
        return {
          agentNickname:
            typeof payload.agent_nickname === "string"
              ? payload.agent_nickname
              : typeof threadSpawn?.agent_nickname === "string"
                ? threadSpawn.agent_nickname
                : null,
          agentRole:
            typeof payload.agent_role === "string"
              ? payload.agent_role
              : typeof threadSpawn?.agent_role === "string"
                ? threadSpawn.agent_role
                : null,
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  private readNativeSessionTurnIds(sessionPath: string | null): string[] | null {
    if (!sessionPath) {
      return null;
    }

    try {
      const turnIds: string[] = [];
      const seen = new Set<string>();
      const lines = readFileSync(sessionPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed)) {
          continue;
        }

        let turnId: string | null = null;
        if (parsed.type === "turn_context" && isRecord(parsed.payload)) {
          turnId = typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : null;
        } else if (
          parsed.type === "event_msg" &&
          isRecord(parsed.payload) &&
          parsed.payload.type === "task_started"
        ) {
          turnId = typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : null;
        }

        if (!turnId || seen.has(turnId)) {
          continue;
        }
        seen.add(turnId);
        turnIds.push(turnId);
      }

      return turnIds;
    } catch {
      return null;
    }
  }

  private normalizeReadTurns(entry: ThreadRegistryEntry, turns: Turn[]): Turn[] {
    if (entry.backendType !== "codex" || turns.length === 0) {
      return turns;
    }

    const sessionTurnIds = this.readNativeSessionTurnIds(entry.path);
    if (!sessionTurnIds || sessionTurnIds.length === 0) {
      return turns;
    }

    const allowedTurnIds = new Set(sessionTurnIds);
    const filtered = turns.filter((turn) => allowedTurnIds.has(turn.id));
    return filtered.length > 0 ? filtered : turns;
  }

  private trackStreamedCommandItem(threadId: string, method: string, params: unknown): void {
    if (
      method === "item/commandExecution/outputDelta" &&
      isRecord(params) &&
      typeof params.itemId === "string"
    ) {
      const streamed = this.streamedCommandItemsByThread.get(threadId) ?? new Set<string>();
      streamed.add(params.itemId);
      this.streamedCommandItemsByThread.set(threadId, streamed);
      return;
    }

    if (
      method === "item/completed" &&
      isRecord(params) &&
      isRecord(params.item) &&
      params.item.type === "commandExecution" &&
      typeof params.item.id === "string"
    ) {
      this.streamedCommandItemsByThread.get(threadId)?.delete(params.item.id);
      return;
    }

    if (method !== "turn/completed") {
      return;
    }

    if (!isRecord(params) || !isRecord(params.turn) || typeof params.turn.id !== "string") {
      return;
    }

    const streamed = this.streamedCommandItemsByThread.get(threadId);
    if (streamed && streamed.size === 0) {
      this.streamedCommandItemsByThread.delete(threadId);
    }
  }

  private rewriteCompletedCommandOutput(
    threadId: string,
    method: string,
    rewritten: unknown
  ): unknown {
    if (
      method !== "item/completed" ||
      !isRecord(rewritten) ||
      !isRecord(rewritten.item) ||
      rewritten.item.type !== "commandExecution" ||
      typeof rewritten.item.id !== "string"
    ) {
      return rewritten;
    }

    const streamed = this.streamedCommandItemsByThread.get(threadId);
    if (!streamed?.has(rewritten.item.id)) {
      return rewritten;
    }

    if (!("aggregatedOutput" in rewritten.item) || rewritten.item.aggregatedOutput === null) {
      return rewritten;
    }

    return {
      ...rewritten,
      item: {
        ...rewritten.item,
        aggregatedOutput: null,
      },
    };
  }

  private async syncCanonicalThreadStarted(
    threadId: string,
    params: unknown
  ): Promise<Thread | null> {
    if (!isRecord(params) || !isRecord(params.thread)) {
      return null;
    }

    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      return null;
    }

    const backendThread = params.thread;
    const path = typeof backendThread.path === "string" ? backendThread.path : entry.path;
    const cwd = typeof backendThread.cwd === "string" ? backendThread.cwd : entry.cwd;
    const sessionMetadata = this.readNativeSubAgentSessionMetadata(path);
    const agentNickname = sessionMetadata?.agentNickname ?? entry.agentNickname;
    const agentRole = sessionMetadata?.agentRole ?? entry.agentRole;
    const backendName =
      typeof backendThread.name === "string" && backendThread.name.trim().length > 0
        ? backendThread.name.trim()
        : null;

    let source = entry.source;
    if (isSubAgentThreadSource(entry.source)) {
      source = {
        subAgent: {
          thread_spawn: {
            ...entry.source.subAgent.thread_spawn,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      };
    }

    const name = backendName ?? entry.name;

    if (
      path === entry.path &&
      cwd === entry.cwd &&
      agentNickname === entry.agentNickname &&
      agentRole === entry.agentRole &&
      name === entry.name &&
      source === entry.source
    ) {
      return null;
    }

    const updated = await this.threadRegistry.update(threadId, {
      path,
      cwd,
      source,
      agentNickname,
      agentRole,
      name,
    });
    return this.buildThread(updated, []);
  }

  private async syncCanonicalThreadRead(
    threadId: string,
    readResult: BackendThreadReadResult,
    options: {
      allowRecoveredNicknameNameFallback?: boolean;
    } = {}
  ): Promise<ThreadRegistryEntry | null> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      return null;
    }

    const path = readResult.path === undefined ? entry.path : readResult.path;
    const cwd = readResult.cwd ?? entry.cwd;
    const sessionMetadata =
      entry.backendType === "codex" ? this.readNativeSubAgentSessionMetadata(path) : null;
    const preserveExistingSubAgentIdentity = isSubAgentThreadSource(entry.source);
    const readAgentNickname =
      readResult.agentNickname === null && preserveExistingSubAgentIdentity
        ? entry.agentNickname
        : readResult.agentNickname;
    const readAgentRole =
      readResult.agentRole === null && preserveExistingSubAgentIdentity
        ? entry.agentRole
        : readResult.agentRole;
    const agentNickname =
      sessionMetadata?.agentNickname ??
      (readAgentNickname === undefined ? entry.agentNickname : readAgentNickname);
    const agentRole =
      sessionMetadata?.agentRole ?? (readAgentRole === undefined ? entry.agentRole : readAgentRole);
    const backendTitle =
      typeof readResult.title === "string" && readResult.title.trim().length > 0
        ? readResult.title.trim()
        : null;
    const allowRecoveredNicknameNameFallback = options.allowRecoveredNicknameNameFallback ?? false;

    let source = entry.source;
    if (isSubAgentThreadSource(entry.source)) {
      source = {
        subAgent: {
          thread_spawn: {
            ...entry.source.subAgent.thread_spawn,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      };
    }

    const name =
      backendTitle ??
      entry.name ??
      (allowRecoveredNicknameNameFallback &&
      preserveExistingSubAgentIdentity &&
      typeof agentNickname === "string"
        ? agentNickname
        : null);

    if (
      path === entry.path &&
      cwd === entry.cwd &&
      agentNickname === entry.agentNickname &&
      agentRole === entry.agentRole &&
      name === entry.name &&
      source === entry.source
    ) {
      return null;
    }

    return await this.threadRegistry.update(threadId, {
      path,
      cwd,
      source,
      agentNickname,
      agentRole,
      name,
    });
  }

  private async ensureNativeSubAgentThreads(
    parentThreadId: string,
    item: Record<string, unknown>
  ): Promise<NativeSubAgentInfo[]> {
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (receiverThreadIds.length === 0) {
      return [];
    }

    const parentEntry = await this.threadRegistry.get(parentThreadId);
    if (!parentEntry) {
      return [];
    }

    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    const model =
      typeof item.model === "string"
        ? this.backendRouter.canonicalizeModelSelection(item.model)
        : null;
    const reasoningEffort = typeof item.reasoningEffort === "string" ? item.reasoningEffort : null;
    const toolCallId = typeof item.id === "string" ? item.id : "";
    const nativeChildren: NativeSubAgentInfo[] = [];

    for (const backendThreadId of receiverThreadIds) {
      const existing = await this.threadRegistry.findByBackendSessionId(
        backendThreadId,
        parentEntry.backendType
      );
      if (existing) {
        nativeChildren.push({
          localThreadId: existing.threadId,
          backendThreadId,
          nickname: existing.agentNickname,
        });
        continue;
      }

      const nickname = this.readNativeSubAgentNickname(
        parentEntry.path,
        toolCallId,
        backendThreadId
      );
      const entry = await this.threadRegistry.create({
        backendSessionId: backendThreadId,
        backendType: parentEntry.backendType,
        path: null,
        cwd: parentEntry.cwd ?? process.cwd(),
        preview: prompt.slice(0, 120),
        model,
        modelProvider: parentEntry.backendType,
        reasoningEffort,
        name: null,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_nickname: nickname,
              agent_role: "default",
            },
          },
        },
        agentNickname: nickname,
        agentRole: "default",
        gitInfo: null,
      });
      const runtime = this.initRuntime(entry.threadId, entry.backendType, backendThreadId);
      this.bindRuntimeSubscription(entry.threadId, runtime);
      this.transitionToReady(entry.threadId, runtime);

      const thread = this.buildThread(entry, []);
      await this.publish("thread/started", { thread }, entry.threadId);
      await this.publishThreadStatus(entry.threadId);

      nativeChildren.push({
        localThreadId: entry.threadId,
        backendThreadId,
        nickname,
      });
    }

    return nativeChildren;
  }

  private async rewriteNativeSubAgentToolItem(
    parentThreadId: string,
    parentThreadHandle: string,
    backendType: string,
    item: Record<string, unknown>,
    nativeChildren: readonly NativeSubAgentInfo[]
  ): Promise<Record<string, unknown>> {
    const childThreadIdByBackendId = new Map(
      nativeChildren.map((child) => [child.backendThreadId, child.localThreadId])
    );

    const resolveThreadReference = async (value: unknown): Promise<unknown> => {
      if (typeof value !== "string") {
        return value;
      }
      if (value === parentThreadId || value === parentThreadHandle) {
        return parentThreadId;
      }
      const existingThreadId = childThreadIdByBackendId.get(value);
      if (existingThreadId) {
        return existingThreadId;
      }
      const existing = await this.threadRegistry.findByBackendSessionId(value, backendType);
      return existing?.threadId ?? value;
    };

    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? await Promise.all(item.receiverThreadIds.map((entry) => resolveThreadReference(entry)))
      : item.receiverThreadIds;

    const rewritten: Record<string, unknown> = {
      ...item,
      senderThreadId: await resolveThreadReference(item.senderThreadId),
      receiverThreadIds,
      model:
        typeof item.model === "string"
          ? this.backendRouter.canonicalizeModelSelection(item.model)
          : item.model,
    };

    if (isRecord(item.agentsStates)) {
      rewritten.agentsStates = Object.fromEntries(
        await Promise.all(
          Object.entries(item.agentsStates).map(async ([key, value]) => [
            (await resolveThreadReference(key)) as string,
            value,
          ])
        )
      );
    }

    return rewritten;
  }

  private async rewriteBackendNotification(
    threadId: string,
    threadHandle: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    let rewritten = this.rewriteBackendThreadReferences(threadId, threadHandle, params);
    const entry = await this.threadRegistry.get(threadId);

    if (
      isRecord(rewritten) &&
      isRecord(rewritten.item) &&
      rewritten.item.type === "collabAgentToolCall" &&
      entry?.backendType === "codex"
    ) {
      const nativeChildren =
        rewritten.item.tool === "spawnAgent" && rewritten.item.status === "completed"
          ? await this.ensureNativeSubAgentThreads(threadId, rewritten.item)
          : [];
      rewritten.item = await this.rewriteNativeSubAgentToolItem(
        threadId,
        threadHandle,
        entry.backendType,
        rewritten.item,
        nativeChildren
      );
    }

    rewritten = this.rewriteCompletedCommandOutput(threadId, method, rewritten);

    if (method !== "thread/started" || !isRecord(rewritten) || !isRecord(rewritten.thread)) {
      return rewritten;
    }

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
      loadedTurnIds: [],
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

  private recordLoadedTurnId(
    runtime: ThreadRuntime,
    turnId: string,
    previousTurnId: string | null = null
  ): void {
    if (previousTurnId) {
      const previousIndex = runtime.loadedTurnIds.lastIndexOf(previousTurnId);
      if (previousIndex >= 0) {
        runtime.loadedTurnIds[previousIndex] = turnId;
      }
    }

    if (runtime.loadedTurnIds.at(-1) !== turnId && !runtime.loadedTurnIds.includes(turnId)) {
      runtime.loadedTurnIds.push(turnId);
    }

    runtime.latestTurnId = turnId;
  }

  private reconcileLoadedTurnIds(threadId: string, turns: Turn[]): void {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime || turns.length === 0) {
      return;
    }

    if (runtime.loadedTurnIds.length > 0) {
      const suffixLength = Math.min(turns.length, runtime.loadedTurnIds.length);
      const loadedSuffix = runtime.loadedTurnIds.slice(-suffixLength);
      for (const [offset, turnId] of loadedSuffix.entries()) {
        const turn = turns[turns.length - suffixLength + offset];
        if (turn) {
          turn.id = turnId;
        }
      }
    }

    runtime.loadedTurnIds = turns.map((turn) => turn.id);
    runtime.latestTurnId = runtime.loadedTurnIds.at(-1) ?? runtime.latestTurnId;
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

    return `Available models (use the model id exactly as shown):\n${lines.join("\n")}`;
  }

  private async createCollabChildThread(input: CollabManagerCreateChildThreadInput): Promise<void> {
    const parentEntry = await this.getThreadEntry(input.parentThreadId);
    const parentContext = this.cloneThreadExecutionContext(input.parentThreadId);
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
    if (parentContext) {
      this.recordThreadExecutionContext(entry.threadId, {
        ...parentContext,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        collaborationMode: rewriteCollaborationModeSettings(parentContext.collaborationMode, {
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        }),
      });
    }

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
