import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { dirname, resolve } from "node:path";
import type {
  BackendEvent,
  BackendImageInput,
  BackendMessage,
  Disposable,
  IBackend,
} from "./backend.js";
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
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
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
import { TurnStateMachine, toThreadTokenUsage } from "./turn-state.js";

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_NOT_INITIALIZED = -32002;
const JSON_RPC_ALREADY_INITIALIZED = -32003;
const ADAPTER_VERSION = "0.0.1";
const DEFAULT_APPROVAL_POLICY = "never";
const DEFAULT_APPROVALS_REVIEWER = "user";
const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";
const DEFAULT_MODEL_PROVIDER = "pi";
const INTERNAL_TITLE_THREAD_PROMPT_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task";
const INTERNAL_TITLE_THREAD_PROMPT_MARKER = "Generate a concise UI title";

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
  sessionId: string;
  status: "starting" | "ready" | "turn_active" | "forking" | "terminating";
  activeTurnId: string | null;
  latestTurnId: string | null;
  machine: TurnStateMachine | null;
  subscription: Disposable | null;
  eventQueue: Promise<void>;
  readyResolver: (() => void) | null;
  readyPromise: Promise<void> | null;
}

interface PendingToolUserInputRequest {
  threadId: string;
  turnId: string;
  sessionId: string;
  backendRequestId: string;
  resolve(response: ToolRequestUserInputResponse): void;
  reject(error: unknown): void;
}

type TextElements = Extract<UserInput, { type: "text" }>["text_elements"];
type FileUpdateChange = Extract<ThreadItem, { type: "fileChange" }>["changes"][number];
type PatchChangeKind = FileUpdateChange["kind"];

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

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function isInternalTitlePrompt(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) &&
    normalized.includes(INTERNAL_TITLE_THREAD_PROMPT_MARKER)
  );
}

function isInternalTitlePreview(preview: string | null): boolean {
  return preview?.trim().startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) ?? false;
}

function toJsonValueArray(value: unknown): JsonValue[] {
  if (Array.isArray(value)) {
    return structuredClone(value) as JsonValue[];
  }
  const text = textFromUnknown(value);
  if (!text) {
    return [];
  }
  return [{ type: "text", text }];
}

function toTextElements(value: unknown): TextElements {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const byteRange = entry.byteRange;
    if (
      !isRecord(byteRange) ||
      typeof byteRange.start !== "number" ||
      typeof byteRange.end !== "number"
    ) {
      return [];
    }

    return [
      {
        byteRange: {
          start: byteRange.start,
          end: byteRange.end,
        },
        placeholder: typeof entry.placeholder === "string" ? entry.placeholder : null,
      },
    ];
  });
}

function toUserInput(value: unknown): UserInput | null {
  if (typeof value === "string") {
    return { type: "text", text: value, text_elements: [] };
  }

  if (!isRecord(value)) {
    const text = textFromUnknown(value);
    return text ? { type: "text", text, text_elements: [] } : null;
  }

  switch (value.type) {
    case "text":
      if (typeof value.text !== "string") {
        return null;
      }
      return {
        type: "text",
        text: value.text,
        text_elements: toTextElements(value.text_elements),
      };
    case "image":
      if (typeof value.url === "string") {
        return { type: "image", url: value.url };
      }
      if (typeof value.data === "string") {
        const mimeType = typeof value.mimeType === "string" ? value.mimeType : "image/png";
        return {
          type: "image",
          url: `data:${mimeType};base64,${value.data}`,
        };
      }
      return null;
    case "localImage":
      return typeof value.path === "string" ? { type: "localImage", path: value.path } : null;
    case "skill":
      return typeof value.name === "string" && typeof value.path === "string"
        ? { type: "skill", name: value.name, path: value.path }
        : null;
    case "mention":
      return typeof value.name === "string" && typeof value.path === "string"
        ? { type: "mention", name: value.name, path: value.path }
        : null;
    default:
      return null;
  }
}

function toUserInputs(value: unknown): UserInput[] {
  if (Array.isArray(value)) {
    const content = value.flatMap((entry) => {
      const input = toUserInput(entry);
      return input ? [input] : [];
    });
    if (content.length > 0) {
      return content;
    }
  }

  const input = toUserInput(value);
  return input ? [input] : [];
}

function commandFromToolArguments(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (!isRecord(input)) {
    return "";
  }
  const command = input.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    return command.filter((value): value is string => typeof value === "string").join(" ");
  }
  return "";
}

function toolKindFromName(toolName: string): "commandExecution" | "fileChange" | "agentMessage" {
  if (/bash|shell|command/i.test(toolName)) {
    return "commandExecution";
  }
  if (/edit|write|patch|file/i.test(toolName)) {
    return "fileChange";
  }
  return "agentMessage";
}

function thinkingSummaryFromSignature(signature: string): string | null {
  try {
    const parsed = JSON.parse(signature);
    if (!isRecord(parsed) || !Array.isArray(parsed.summary)) {
      return null;
    }
    const summary = parsed.summary
      .flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.text !== "string") {
          return [];
        }
        return [entry.text];
      })
      .join("")
      .trim();
    return summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

function thinkingSummaryFromContent(content: unknown): string | null {
  if (!isRecord(content)) {
    return null;
  }
  if (typeof content.thinkingSignature === "string") {
    const summary = thinkingSummaryFromSignature(content.thinkingSignature);
    if (summary) {
      return summary;
    }
  }
  if (typeof content.thinking === "string" && content.thinking.trim().length > 0) {
    return content.thinking;
  }
  return null;
}

function textContentFromBlocks(blocks: readonly JsonValue[]): string {
  return blocks
    .map((block) => {
      if (!isRecord(block)) {
        return textFromUnknown(block);
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return textFromUnknown(block);
    })
    .join("");
}

function toPatchChangeKind(value: unknown): PatchChangeKind | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "add":
      return { type: "add" };
    case "delete":
      return { type: "delete" };
    case "update": {
      const movePath = typeof value.move_path === "string" ? value.move_path : null;
      return { type: "update", move_path: movePath };
    }
    default:
      return null;
  }
}

function toFileUpdateChange(value: unknown): FileUpdateChange | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.diff !== "string") {
    return null;
  }

  const kind = toPatchChangeKind(value.kind);
  if (!kind) {
    return null;
  }

  return {
    path: value.path,
    kind,
    diff: value.diff,
  };
}

function fileUpdateChangesFromUnknown(value: unknown): FileUpdateChange[] {
  const candidate = isRecord(value) && Array.isArray(value.changes) ? value.changes : value;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.flatMap((entry) => {
    const change = toFileUpdateChange(entry);
    return change ? [change] : [];
  });
}

function finalizeHistoricalToolItem(item: ThreadItem): void {
  if (item.type === "commandExecution" && item.status === "inProgress") {
    item.status = "completed";
    item.exitCode = item.exitCode ?? 0;
    item.durationMs = item.durationMs ?? 0;
  }
  if (item.type === "fileChange" && item.status === "inProgress") {
    item.status = "completed";
  }
}

function buildTurns(history: readonly BackendMessage[], cwd: string): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let pendingTools = new Map<string, ThreadItem>();

  const ensureTurn = (id: string) => {
    if (currentTurn) {
      return currentTurn;
    }
    currentTurn = {
      id,
      items: [],
      status: "completed",
      error: null,
    };
    turns.push(currentTurn);
    pendingTools = new Map<string, ThreadItem>();
    return currentTurn;
  };

  const finalizeTurn = () => {
    for (const item of pendingTools.values()) {
      finalizeHistoricalToolItem(item);
    }
    currentTurn = null;
    pendingTools = new Map<string, ThreadItem>();
  };

  for (const message of history) {
    if (message.role === "user") {
      finalizeTurn();
      const turn = ensureTurn(message.id);
      turn.items.push({
        type: "userMessage",
        id: `${message.id}_item`,
        content: toUserInputs(message.content),
      });
      continue;
    }

    const turn = ensureTurn(message.id);
    if (message.role === "assistant") {
      const content = toJsonValueArray(message.content);
      for (const [index, block] of content.entries()) {
        if (!isRecord(block)) {
          const text = textFromUnknown(block);
          if (text) {
            turn.items.push({
              type: "agentMessage",
              id: `${message.id}_item_${index}`,
              text,
              phase: null,
              memoryCitation: null,
            });
          }
          continue;
        }

        if (block.type === "thinking") {
          const summary = thinkingSummaryFromContent(block);
          if (summary) {
            turn.items.push({
              type: "reasoning",
              id: `${message.id}_reasoning_${index}`,
              summary: [summary],
              content: [],
            });
          }
          continue;
        }

        if (block.type === "toolCall") {
          const toolName = typeof block.name === "string" ? block.name : "tool";
          const toolCallId =
            typeof block.id === "string" && block.id.length > 0
              ? block.id
              : `${message.id}_tool_${index}`;
          const toolKind = toolKindFromName(toolName);
          const item: ThreadItem =
            toolKind === "commandExecution"
              ? {
                  type: "commandExecution",
                  id: `${message.id}_tool_${index}`,
                  command: commandFromToolArguments(block.arguments),
                  cwd,
                  processId: null,
                  source: "agent",
                  status: "inProgress",
                  commandActions: [],
                  aggregatedOutput: null,
                  exitCode: null,
                  durationMs: null,
                }
              : toolKind === "fileChange"
                ? {
                    type: "fileChange",
                    id: `${message.id}_tool_${index}`,
                    changes: [],
                    status: "inProgress",
                  }
                : {
                    type: "agentMessage",
                    id: `${message.id}_tool_${index}`,
                    text: "",
                    phase: null,
                    memoryCitation: null,
                  };
          turn.items.push(item);
          pendingTools.set(toolCallId, item);
          continue;
        }

        const text =
          block.type === "text" && typeof block.text === "string"
            ? block.text
            : textFromUnknown(block);
        if (text) {
          turn.items.push({
            type: "agentMessage",
            id: `${message.id}_item_${index}`,
            text,
            phase: null,
            memoryCitation: null,
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const record = isRecord(message.content) ? message.content : {};
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : `${message.id}_toolResult`;
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const blocks = toJsonValueArray(record.content);
      const outputText = textContentFromBlocks(blocks);
      const isError = Boolean(record.isError);
      const existingItem = pendingTools.get(toolCallId);
      if (existingItem) {
        if (existingItem.type === "commandExecution") {
          existingItem.aggregatedOutput = outputText || existingItem.aggregatedOutput;
          existingItem.status = isError ? "failed" : "completed";
          existingItem.exitCode = isError ? 1 : 0;
          existingItem.durationMs = existingItem.durationMs ?? 0;
        } else if (existingItem.type === "fileChange") {
          existingItem.changes = fileUpdateChangesFromUnknown(record.content);
          existingItem.status = isError ? "failed" : "completed";
        } else if (existingItem.type === "agentMessage") {
          existingItem.text = outputText;
        }
        pendingTools.delete(toolCallId);
        continue;
      }

      const toolKind = toolKindFromName(toolName);
      if (toolKind === "commandExecution") {
        turn.items.push({
          type: "commandExecution",
          id: `${message.id}_toolResult`,
          command: "",
          cwd,
          processId: null,
          source: "agent",
          status: isError ? "failed" : "completed",
          commandActions: [],
          aggregatedOutput: outputText || null,
          exitCode: isError ? 1 : 0,
          durationMs: 0,
        });
        continue;
      }

      if (toolKind === "fileChange") {
        turn.items.push({
          type: "fileChange",
          id: `${message.id}_toolResult`,
          changes: fileUpdateChangesFromUnknown(record.content),
          status: isError ? "failed" : "completed",
        });
        continue;
      }

      if (outputText) {
        turn.items.push({
          type: "agentMessage",
          id: `${message.id}_toolResult`,
          text: outputText,
          phase: null,
          memoryCitation: null,
        });
      }
      continue;
    }

    const text = textFromUnknown(message.content);
    if (text) {
      turn.items.push({
        type: "agentMessage",
        id: `${message.id}_item`,
        text,
        phase: null,
        memoryCitation: null,
      });
    }
  }

  finalizeTurn();
  return turns;
}

function runtimeToThreadStatus(
  runtime: ThreadRuntime | undefined,
  waitingOnUserInput: boolean
): ThreadStatus {
  if (!runtime) {
    return { type: "notLoaded" };
  }

  if (runtime.status === "ready") {
    return { type: "idle" };
  }

  return {
    type: "active",
    activeFlags: waitingOnUserInput ? ["waitingOnUserInput"] : [],
  };
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

function toQuestionOptions(options: unknown): ToolRequestUserInputQuestion["options"] {
  if (!Array.isArray(options)) {
    return null;
  }

  return options
    .filter((value): value is string => typeof value === "string")
    .map((label) => ({
      label,
      description: label,
    }));
}

function buildToolRequestUserInput(
  threadId: string,
  turnId: string,
  itemId: string,
  payload: unknown
): ToolRequestUserInputParams | null {
  if (!isRecord(payload) || typeof payload.method !== "string") {
    return null;
  }

  const header = typeof payload.title === "string" ? payload.title : "Input required";
  switch (payload.method) {
    case "select":
      return {
        threadId,
        turnId,
        itemId,
        questions: [
          {
            id: "value",
            header,
            question: header,
            isOther: false,
            isSecret: false,
            options: toQuestionOptions(payload.options),
          },
        ],
      };
    case "confirm":
      return {
        threadId,
        turnId,
        itemId,
        questions: [
          {
            id: "confirmed",
            header,
            question: typeof payload.message === "string" ? payload.message : header,
            isOther: false,
            isSecret: false,
            options: [
              { label: "Yes", description: "Approve this request." },
              { label: "No", description: "Decline this request." },
            ],
          },
        ],
      };
    case "input":
      return {
        threadId,
        turnId,
        itemId,
        questions: [
          {
            id: "value",
            header,
            question: typeof payload.placeholder === "string" ? payload.placeholder : header,
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      };
    case "editor":
      return {
        threadId,
        turnId,
        itemId,
        questions: [
          {
            id: "value",
            header,
            question: header,
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      };
    default:
      return null;
  }
}

function firstAnswer(
  response: ToolRequestUserInputResponse,
  questionId: string
): string | undefined {
  return response.answers[questionId]?.answers[0];
}

function mapToolRequestUserInputResponse(
  payload: unknown,
  response: ToolRequestUserInputResponse
): unknown {
  if (!isRecord(payload) || typeof payload.method !== "string") {
    return { cancelled: true as const };
  }

  switch (payload.method) {
    case "select": {
      const value = firstAnswer(response, "value");
      return value ? { value } : { cancelled: true as const };
    }
    case "confirm": {
      const value = firstAnswer(response, "confirmed");
      if (!value) {
        return { cancelled: true as const };
      }
      return { confirmed: /^y(es)?$/i.test(value) || /^true$/i.test(value) };
    }
    case "input":
    case "editor": {
      const value = firstAnswer(response, "value");
      return value !== undefined ? { value } : { cancelled: true as const };
    }
    default:
      return { cancelled: true as const };
  }
}

export class AppServerConnection {
  private readonly backend: IBackend | undefined;
  private readonly configStore: InMemoryConfigStore;
  private readonly identity: AppServerIdentity;
  private readonly logger: AppServerLogger;
  private readonly debugLogWriter: DebugLogWriter | null;
  private readonly threadRegistry: ThreadRegistry;
  private readonly onMessage:
    | ((message: AppServerOutgoingMessage) => void | Promise<void>)
    | undefined;
  private readonly commandExecManager: CommandExecManager;
  private readonly threadRuntimes = new Map<string, ThreadRuntime>();
  private readonly pendingToolUserInputRequests = new Map<
    string | number,
    PendingToolUserInputRequest
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
    this.backend = options.backend;
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
    this.commandExecManager = new CommandExecManager({
      onNotification: async (notification) => {
        await this.publish(notification.method, notification.params);
      },
    });
    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "startup",
    });
  }

  async dispose(): Promise<void> {
    for (const runtime of this.threadRuntimes.values()) {
      runtime.status = "terminating";
      runtime.readyResolver?.();
      runtime.readyResolver = null;
      runtime.readyPromise = null;
      runtime.subscription?.dispose();
    }
    for (const request of this.pendingToolUserInputRequests.values()) {
      request.reject(new Error("Connection closed before server request resolved"));
    }
    this.pendingToolUserInputRequests.clear();
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
      return await this.handleResponse(message);
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

  private async handleResponse(message: JsonRpcResponse): Promise<null> {
    if (message.id === null) {
      return null;
    }

    const pending = this.pendingToolUserInputRequests.get(message.id);
    if (!pending) {
      return null;
    }

    this.pendingToolUserInputRequests.delete(message.id);
    await this.publishThreadStatus(pending.threadId);
    if ("error" in message) {
      pending.reject(message.error);
      return null;
    }

    pending.resolve(message.result as ToolRequestUserInputResponse);
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
    const models = this.backend ? await this.backend.listModels() : [];

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
    const backend = this.requireBackend();
    const parsed = params as ThreadStartParams;
    const sessionId = await backend.createSession();
    if (parsed.model) {
      await backend.setModel(sessionId, parsed.model);
    }
    const entry = await this.threadRegistry.create({
      backendSessionId: sessionId,
      backendType: "pi",
      cwd: parsed.cwd ?? process.cwd(),
      preview: "",
      modelProvider: parsed.modelProvider ?? DEFAULT_MODEL_PROVIDER,
      gitInfo: null,
    });

    const runtime = this.initRuntime(entry.threadId, sessionId);
    this.transitionToReady(entry.threadId, runtime);

    const thread = this.buildThread(entry, []);
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publishThreadStatus(entry.threadId);
    return await this.buildThreadExecutionResponse(
      thread,
      parsed.model ?? null,
      parsed.cwd ?? null,
      parsed.approvalPolicy ?? null,
      parsed.approvalsReviewer ?? null,
      parsed.sandbox ?? null
    );
  }

  private async handleThreadResume(params: unknown): Promise<ThreadResumeResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadResumeParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const existing = this.threadRuntimes.get(parsed.threadId);
    if (existing) {
      throw new Error(`Thread ${parsed.threadId} is already loaded (status: ${existing.status})`);
    }

    const runtime = this.initRuntime(parsed.threadId, entry.backendSessionId);

    try {
      const sessionId = await backend.resumeSession(entry.backendSessionId);
      if (parsed.model) {
        await backend.setModel(sessionId, parsed.model);
      }
      runtime.sessionId = sessionId;

      const history = await backend.readSessionHistory(sessionId);
      const thread = this.buildThread(entry, buildTurns(history, entry.cwd ?? process.cwd()));
      this.transitionToReady(parsed.threadId, runtime);
      await this.publishThreadStatus(parsed.threadId);
      return await this.buildThreadExecutionResponse(
        thread,
        parsed.model ?? null,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null
      );
    } catch (error) {
      runtime.status = "terminating";
      runtime.readyResolver?.();
      this.threadRuntimes.delete(parsed.threadId);
      throw error;
    }
  }

  private async handleThreadFork(params: unknown): Promise<ThreadForkResponse> {
    const backend = this.requireBackend();
    const parsed = params as ThreadForkParams;
    const sourceEntry = await this.getThreadEntry(parsed.threadId);
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
      const sessionId = await backend.forkSession(sourceEntry.backendSessionId);
      if (parsed.model) {
        await backend.setModel(sessionId, parsed.model);
      }
      const entry = await this.threadRegistry.create({
        backendSessionId: sessionId,
        backendType: sourceEntry.backendType,
        cwd: parsed.cwd ?? sourceEntry.cwd,
        preview: sourceEntry.preview,
        modelProvider: parsed.modelProvider ?? sourceEntry.modelProvider,
        name: sourceEntry.name,
        gitInfo: sourceEntry.gitInfo,
      });

      forkThreadId = entry.threadId;
      const forkRuntime = this.initRuntime(entry.threadId, sessionId);
      this.transitionToReady(entry.threadId, forkRuntime);

      const history = await backend.readSessionHistory(sessionId);
      const thread = this.buildThread(entry, buildTurns(history, entry.cwd ?? process.cwd()));
      await this.publish("thread/started", { thread }, entry.threadId);
      await this.publishThreadStatus(entry.threadId);
      return await this.buildThreadExecutionResponse(
        thread,
        parsed.model ?? null,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null
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
    const entry = await this.getThreadEntry(parsed.threadId);
    const runtime = this.threadRuntimes.get(parsed.threadId);
    const turns =
      parsed.includeTurns && this.backend
        ? buildTurns(
            await this.backend.readSessionHistory(entry.backendSessionId),
            entry.cwd ?? process.cwd()
          )
        : [];
    if (runtime?.machine && parsed.includeTurns) {
      turns.push(runtime.machine.snapshot);
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
    const backend = this.requireBackend();
    const parsed = params as ThreadArchiveParams;
    const entry = await this.getThreadEntry(parsed.threadId);
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
    await backend.disposeSession(entry.backendSessionId);
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
    const backend = this.requireBackend();
    const parsed = params as TurnStartParams;
    const runtime = await this.getReadyThreadRuntime(parsed.threadId);
    let entry = await this.getThreadEntry(parsed.threadId);
    const { text, images, preview } = this.normalizeUserInputs(parsed.input);
    if (parsed.model) {
      await backend.setModel(runtime.sessionId, parsed.model);
    }
    const threadPatch: {
      hidden?: boolean;
      preview?: string | null;
      cwd?: string | null;
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
    if (Object.keys(threadPatch).length > 0) {
      entry = await this.threadRegistry.update(parsed.threadId, threadPatch);
    }

    const turnId = randomUUID();
    const cwd = parsed.cwd ?? entry.cwd ?? process.cwd();
    const machine = new TurnStateMachine(parsed.threadId, turnId, cwd, {
      notify: async (method, payload) => {
        await this.publish(method, payload, parsed.threadId);
      },
    });

    runtime.status = "turn_active";
    runtime.activeTurnId = turnId;
    runtime.latestTurnId = turnId;
    runtime.machine = machine;
    runtime.subscription?.dispose();
    runtime.subscription = backend.onEvent(runtime.sessionId, (event) => {
      this.enqueueBackendEvent(parsed.threadId, turnId, event);
    });

    await this.publishThreadStatus(parsed.threadId);
    await machine.emitStarted();

    try {
      await backend.prompt(runtime.sessionId, turnId, text, images);
    } catch (error) {
      const turn = await machine.handleEvent({
        type: "error",
        sessionId: runtime.sessionId,
        turnId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (turn) {
        await this.finishTurn(parsed.threadId, turnId);
      }
      throw error;
    }

    return {
      turn: machine.snapshot,
    };
  }

  private async handleTurnInterrupt(params: unknown): Promise<TurnInterruptResponse> {
    const backend = this.requireBackend();
    const parsed = params as TurnInterruptParams;
    const runtime = this.threadRuntimes.get(parsed.threadId);
    if (!runtime || runtime.status !== "turn_active" || runtime.activeTurnId !== parsed.turnId) {
      throw new Error(`No active turn ${parsed.turnId} for thread ${parsed.threadId}`);
    }

    await backend.abort(runtime.sessionId);
    if (runtime.machine) {
      await runtime.machine.interrupt();
    }
    await this.finishTurn(parsed.threadId, parsed.turnId);
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

  private async handleBackendEvent(
    threadId: string,
    turnId: string,
    event: BackendEvent
  ): Promise<void> {
    const runtime = this.threadRuntimes.get(threadId);
    const machine = runtime?.machine;
    const acceptsTurnStream =
      runtime !== undefined &&
      machine !== null &&
      runtime.activeTurnId === turnId &&
      event.turnId === turnId;
    const acceptsLateTokenUsage =
      runtime !== undefined &&
      event.type === "token_usage" &&
      runtime.latestTurnId === turnId &&
      event.turnId === turnId;
    const accepted = acceptsTurnStream || acceptsLateTokenUsage;

    await this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "backend-event",
      threadId,
      turnId,
      accepted,
      eventType: event.type,
      payload: event,
    });

    if (!accepted) {
      return;
    }

    if (event.type === "token_usage") {
      await this.publish(
        "thread/tokenUsage/updated",
        {
          threadId,
          turnId,
          tokenUsage: toThreadTokenUsage(event.usage),
        },
        threadId
      );
      return;
    }

    if (!machine) {
      return;
    }

    if (event.type === "elicitation_request") {
      await this.handleToolUserInputRequest(
        threadId,
        turnId,
        runtime.sessionId,
        event.requestId,
        event.payload
      );
      return;
    }

    const completedTurn = await machine.handleEvent(event);
    if (completedTurn) {
      await this.finishTurn(threadId, turnId);
    }
  }

  private enqueueBackendEvent(threadId: string, turnId: string, event: BackendEvent): void {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime) {
      return;
    }

    const run = async () => {
      await this.handleBackendEvent(threadId, turnId, event);
    };

    runtime.eventQueue = runtime.eventQueue.then(run, run).catch((error) => {
      this.logger.warn("Failed to handle backend event", {
        threadId,
        turnId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleToolUserInputRequest(
    threadId: string,
    turnId: string,
    sessionId: string,
    backendRequestId: string,
    payload: unknown
  ): Promise<void> {
    const runtime = this.threadRuntimes.get(threadId);
    const itemId = runtime?.machine?.snapshot.items.at(-1)?.id ?? backendRequestId;
    const params = buildToolRequestUserInput(threadId, turnId, itemId, payload);
    if (!params) {
      return;
    }

    const requestId = randomUUID();
    const response = await new Promise<ToolRequestUserInputResponse>((resolve, reject) => {
      this.pendingToolUserInputRequests.set(requestId, {
        threadId,
        turnId,
        sessionId,
        backendRequestId,
        resolve,
        reject,
      });
      void this.publishThreadStatus(threadId);

      void this.send({
        id: requestId,
        method: "item/tool/requestUserInput",
        params,
      }).catch((error) => {
        this.pendingToolUserInputRequests.delete(requestId);
        void this.publishThreadStatus(threadId);
        reject(error);
      });
    }).catch(() => ({ answers: {} }));

    await this.requireBackend().respondToElicitation(
      sessionId,
      backendRequestId,
      mapToolRequestUserInputResponse(payload, response)
    );
    await this.publish(
      "serverRequest/resolved",
      {
        threadId,
        requestId,
      },
      threadId
    );
  }

  private async finishTurn(threadId: string, turnId: string): Promise<void> {
    const runtime = this.threadRuntimes.get(threadId);
    if (!runtime || runtime.activeTurnId !== turnId) {
      return;
    }
    runtime.machine = null;
    runtime.activeTurnId = null;
    runtime.status = "ready";
    await this.publishThreadStatus(threadId);
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
      ephemeral: false,
      modelProvider: entry.modelProvider ?? DEFAULT_MODEL_PROVIDER,
      createdAt: toUnixSeconds(entry.createdAt),
      updatedAt: toUnixSeconds(entry.updatedAt),
      status: this.getThreadStatus(entry.threadId),
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

  private async buildThreadExecutionResponse(
    thread: Thread,
    requestedModel: string | null,
    requestedCwd: string | null,
    requestedApprovalPolicy: string | null,
    requestedApprovalsReviewer: string | null,
    requestedSandboxMode: SandboxMode | null
  ): Promise<ThreadStartResponse> {
    const models = this.backend ? await this.backend.listModels() : [];
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    const cwd = requestedCwd ?? thread.cwd;

    return {
      thread,
      model: requestedModel ?? defaultModel?.model ?? "pi-default",
      modelProvider: thread.modelProvider,
      serviceTier: null,
      cwd,
      approvalPolicy: requestedApprovalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: requestedApprovalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: buildSandboxPolicy(requestedSandboxMode, cwd),
      reasoningEffort: defaultModel?.defaultReasoningEffort ?? null,
    };
  }

  private async publishThreadStatus(threadId: string): Promise<void> {
    await this.publish(
      "thread/status/changed",
      {
        threadId,
        status: this.getThreadStatus(threadId),
      },
      threadId
    );
  }

  private getThreadStatus(threadId: string): ThreadStatus {
    return runtimeToThreadStatus(
      this.threadRuntimes.get(threadId),
      this.hasPendingToolUserInputRequest(threadId)
    );
  }

  private hasPendingToolUserInputRequest(threadId: string): boolean {
    for (const request of this.pendingToolUserInputRequests.values()) {
      if (request.threadId === threadId) {
        return true;
      }
    }
    return false;
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

  private initRuntime(threadId: string, sessionId: string): ThreadRuntime {
    let readyResolver: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      readyResolver = resolve;
    });
    const runtime: ThreadRuntime = {
      sessionId,
      status: "starting",
      activeTurnId: null,
      latestTurnId: null,
      machine: null,
      subscription: null,
      eventQueue: Promise.resolve(),
      readyResolver,
      readyPromise,
    };
    this.threadRuntimes.set(threadId, runtime);
    this.logTransition(threadId, "none", "starting");
    return runtime;
  }

  private transitionToReady(threadId: string, runtime: ThreadRuntime): void {
    const from = runtime.status;
    runtime.status = "ready";
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

  private requireBackend(): IBackend {
    if (!this.backend) {
      throw new Error("No backend configured");
    }
    return this.backend;
  }
}
