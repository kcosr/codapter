export interface BackendImageInput {
  readonly type: "image" | "localImage";
  readonly mimeType?: string;
  readonly data?: string;
  readonly path?: string;
  readonly url?: string;
}

export interface BackendMessage {
  readonly id: string;
  readonly role: string;
  readonly content: unknown;
  readonly createdAt: string;
}

export interface BackendSessionSummary {
  readonly sessionId: string;
  readonly name: string | null;
  readonly path: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BackendReasoningEffortOption {
  readonly reasoningEffort: string;
  readonly description: string;
}

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

export interface BackendTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly modelContextWindow: number | null;
}

export interface BackendBaseEvent {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface BackendTextDeltaEvent extends BackendBaseEvent {
  readonly type: "text_delta";
  readonly delta: string;
}

export interface BackendThinkingDeltaEvent extends BackendBaseEvent {
  readonly type: "thinking_delta";
  readonly delta: string;
}

export interface BackendToolStartEvent extends BackendBaseEvent {
  readonly type: "tool_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface BackendToolUpdateEvent extends BackendBaseEvent {
  readonly type: "tool_update";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isCumulative: boolean;
}

export interface BackendToolEndEvent extends BackendBaseEvent {
  readonly type: "tool_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError: boolean;
}

export interface BackendMessageEndEvent extends BackendBaseEvent {
  readonly type: "message_end";
  readonly text?: string;
}

export interface BackendErrorEvent extends BackendBaseEvent {
  readonly type: "error";
  readonly message: string;
}

export interface BackendElicitationRequestEvent extends BackendBaseEvent {
  readonly type: "elicitation_request";
  readonly requestId: string;
  readonly payload: unknown;
}

export interface BackendTokenUsageEvent extends BackendBaseEvent {
  readonly type: "token_usage";
  readonly usage: BackendTokenUsage;
}

export type BackendEvent =
  | BackendTextDeltaEvent
  | BackendThinkingDeltaEvent
  | BackendToolStartEvent
  | BackendToolUpdateEvent
  | BackendToolEndEvent
  | BackendMessageEndEvent
  | BackendErrorEvent
  | BackendElicitationRequestEvent
  | BackendTokenUsageEvent;

export interface Disposable {
  dispose(): void;
}

export interface BackendSessionLaunchConfig {
  readonly threadId?: string | null;
  readonly collabSocketPath?: string | null;
}

/**
 * Adapter-to-model contract.
 *
 * `command/exec` is intentionally excluded because the adapter owns that path.
 */
export interface IBackend {
  /** Prepare the backend for use. Called once during adapter startup. */
  initialize(): Promise<void>;

  /** Release backend resources and terminate child processes. */
  dispose(): Promise<void>;

  /** Return whether the backend can still accept requests. */
  isAlive(): boolean;

  /** Start a new backend session and return its opaque session identifier. */
  createSession(config?: BackendSessionLaunchConfig): Promise<string>;

  /** Reattach to an existing backend session and return the canonical session identifier. */
  resumeSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string>;

  /** Fork a backend session and return the new opaque session identifier. */
  forkSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string>;

  /** Dispose a backend session when the adapter no longer needs it. */
  disposeSession(sessionId: string): Promise<void>;

  /** Read the persisted message history for a backend session. */
  readSessionHistory(sessionId: string): Promise<BackendMessage[]>;

  /** Persist a human-readable name for a backend session. */
  setSessionName(sessionId: string, name: string): Promise<void>;

  /** Return the persisted transcript path for a backend session, if any. */
  getSessionPath(sessionId: string): Promise<string | null>;

  /** Submit a user prompt to the backend for the current turn. */
  prompt(
    sessionId: string,
    turnId: string,
    text: string,
    images?: readonly BackendImageInput[]
  ): Promise<void>;

  /** Interrupt any active generation for the session. */
  abort(sessionId: string): Promise<void>;

  /** List models that the backend can expose through `model/list`. */
  listModels(): Promise<BackendModelSummary[]>;

  /** Update the active model for a session. */
  setModel(sessionId: string, modelId: string): Promise<void>;

  /** Return stable backend capability flags for feature-gating. */
  getCapabilities(): Promise<BackendCapabilities>;

  /** Respond to a previously emitted elicitation request. */
  respondToElicitation(sessionId: string, requestId: string, response: unknown): Promise<void>;

  /** Subscribe to backend events for one session. */
  onEvent(sessionId: string, listener: (event: BackendEvent) => void): Disposable;
}
