import type { JsonRpcId } from "./jsonrpc.js";
import type { Turn, UserInput } from "./protocol.js";

export interface Disposable {
  dispose(): void;
}

export interface BackendSessionLaunchConfig {
  readonly threadId?: string | null;
  readonly collabSocketPath?: string | null;
  readonly availableModelsDescription?: string | null;
}

export interface BackendImageInput {
  readonly type: "image" | "localImage";
  readonly mimeType?: string;
  readonly data?: string;
  readonly path?: string;
  readonly url?: string;
}

export interface BackendReasoningEffortOption {
  readonly reasoningEffort: string;
  readonly description: string;
}

export interface BackendMessage {
  readonly id: string;
  readonly role: string;
  readonly content: unknown;
  readonly createdAt: string;
}

export interface BackendTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly modelContextWindow: number | null;
}

/**
 * Model summary returned by one backend before adapter-level prefixing.
 */
export interface BackendModelSummary {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly inputModalities: readonly string[];
  readonly supportedReasoningEfforts: readonly BackendReasoningEffortOption[];
  readonly defaultReasoningEffort: string;
  readonly supportsPersonality: boolean;
}

export interface BackendCapabilities {
  readonly requiresAuth: boolean;
  readonly supportsImages: boolean;
  readonly supportsThinking: boolean;
  readonly supportsParallelTools: boolean;
  readonly supportedToolTypes: readonly string[];
}

export interface ParsedBackendSelection {
  readonly backendType: string;
  readonly rawModelId: string;
}

export interface BackendThreadStartInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly launchConfig?: BackendSessionLaunchConfig;
}

export interface BackendThreadStartResult {
  readonly threadHandle: string;
  readonly path: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface BackendThreadResumeInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly launchConfig?: BackendSessionLaunchConfig;
}

export interface BackendThreadResumeResult {
  readonly threadHandle: string;
  readonly path: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface BackendThreadForkInput {
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly sourceThreadHandle: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly launchConfig?: BackendSessionLaunchConfig;
}

export interface BackendThreadForkResult {
  readonly threadHandle: string;
  readonly path: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface BackendThreadReadInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly includeTurns: boolean;
  readonly cwd: string;
}

export interface BackendThreadReadResult {
  readonly threadHandle: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly turns: readonly Turn[];
}

export interface BackendThreadArchiveInput {
  readonly threadId: string;
  readonly threadHandle: string;
}

export interface BackendThreadSetNameInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly name: string;
}

/**
 * Legacy normalized turn-event stream used by Pi normalization helpers.
 */
export interface BackendBaseTurnEvent {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface BackendTextDeltaTurnEvent extends BackendBaseTurnEvent {
  readonly type: "text_delta";
  readonly delta: string;
}

export interface BackendThinkingDeltaTurnEvent extends BackendBaseTurnEvent {
  readonly type: "thinking_delta";
  readonly delta: string;
}

export interface BackendToolStartTurnEvent extends BackendBaseTurnEvent {
  readonly type: "tool_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface BackendToolUpdateTurnEvent extends BackendBaseTurnEvent {
  readonly type: "tool_update";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isCumulative: boolean;
}

export interface BackendToolEndTurnEvent extends BackendBaseTurnEvent {
  readonly type: "tool_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError: boolean;
}

export interface BackendMessageEndTurnEvent extends BackendBaseTurnEvent {
  readonly type: "message_end";
  readonly text?: string;
}

export interface BackendErrorTurnEvent extends BackendBaseTurnEvent {
  readonly type: "error";
  readonly message: string;
}

export interface BackendElicitationRequestTurnEvent extends BackendBaseTurnEvent {
  readonly type: "elicitation_request";
  readonly requestId: string;
  readonly payload: unknown;
}

export interface BackendTokenUsageTurnEvent extends BackendBaseTurnEvent {
  readonly type: "token_usage";
  readonly usage: BackendTokenUsage;
}

export type BackendEvent =
  | BackendTextDeltaTurnEvent
  | BackendThinkingDeltaTurnEvent
  | BackendToolStartTurnEvent
  | BackendToolUpdateTurnEvent
  | BackendToolEndTurnEvent
  | BackendMessageEndTurnEvent
  | BackendErrorTurnEvent
  | BackendElicitationRequestTurnEvent
  | BackendTokenUsageTurnEvent;

export interface BackendTurnStartInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly input: readonly UserInput[];
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface BackendTurnStartResult {
  readonly accepted: true;
  readonly turnId?: string | null;
}

export interface BackendTurnInterruptInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly turnId: string;
}

export interface BackendResolveServerRequestInput {
  readonly threadId: string;
  readonly threadHandle: string;
  readonly requestId: JsonRpcId;
  readonly response: unknown;
}

export interface BackendNotificationEvent {
  readonly kind: "notification";
  readonly threadHandle: string;
  readonly method: string;
  readonly params: unknown;
}

export interface BackendServerRequestEvent {
  readonly kind: "serverRequest";
  readonly threadHandle: string;
  readonly requestId: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface BackendErrorEvent {
  readonly kind: "error";
  readonly threadHandle: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface BackendDisconnectEvent {
  readonly kind: "disconnect";
  readonly threadHandle: string;
  readonly message: string;
}

export type BackendAppServerEvent =
  | BackendNotificationEvent
  | BackendServerRequestEvent
  | BackendErrorEvent
  | BackendDisconnectEvent;

/**
 * Thread-safe event buffer that prevents drops when backend events arrive
 * before the adapter has bound a listener for a specific thread handle.
 */
export class BackendThreadEventBuffer {
  private readonly listeners = new Map<string, Set<(event: BackendAppServerEvent) => void>>();
  private readonly queued = new Map<string, BackendAppServerEvent[]>();

  emit(threadHandle: string, event: BackendAppServerEvent): void {
    const listeners = this.listeners.get(threadHandle);
    if (!listeners || listeners.size === 0) {
      const queue = this.queued.get(threadHandle) ?? [];
      queue.push(event);
      this.queued.set(threadHandle, queue);
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  subscribe(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    const listeners =
      this.listeners.get(threadHandle) ?? new Set<(event: BackendAppServerEvent) => void>();
    listeners.add(listener);
    this.listeners.set(threadHandle, listeners);

    const queued = this.queued.get(threadHandle);
    if (queued && queued.length > 0) {
      this.queued.delete(threadHandle);
      for (const event of queued) {
        listener(event);
      }
    }

    return {
      dispose: () => {
        const existing = this.listeners.get(threadHandle);
        if (!existing) {
          return;
        }
        existing.delete(listener);
        if (existing.size === 0) {
          this.listeners.delete(threadHandle);
        }
      },
    };
  }
}

export const BACKEND_MODEL_ID_SEPARATOR = "::";

export function encodeBackendModelId(backendType: string, rawModelId: string): string {
  return `${backendType}${BACKEND_MODEL_ID_SEPARATOR}${rawModelId}`;
}

export function parseBackendModelId(modelId: string): ParsedBackendSelection | null {
  const separatorIndex = modelId.indexOf(BACKEND_MODEL_ID_SEPARATOR);
  if (separatorIndex <= 0) {
    return null;
  }
  const backendType = modelId.slice(0, separatorIndex).trim();
  const rawModelId = modelId.slice(separatorIndex + BACKEND_MODEL_ID_SEPARATOR.length).trim();
  if (!backendType || !rawModelId) {
    return null;
  }
  return {
    backendType,
    rawModelId,
  };
}

/**
 * Routed backend contract. `command/exec` remains adapter-native.
 */
export interface IBackend {
  readonly backendType: string;

  initialize(): Promise<void>;
  dispose(): Promise<void>;
  isAlive(): boolean;

  listModels(): Promise<readonly BackendModelSummary[]>;
  parseModelSelection(model: string | null | undefined): ParsedBackendSelection | null;

  threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult>;
  threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult>;
  threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult>;
  threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult>;
  threadArchive(input: BackendThreadArchiveInput): Promise<void>;
  threadSetName(input: BackendThreadSetNameInput): Promise<void>;

  turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult>;
  turnInterrupt(input: BackendTurnInterruptInput): Promise<void>;

  resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void>;

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable;
}
