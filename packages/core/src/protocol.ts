import type { GitInfo as VendoredGitInfo } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/GitInfo.js";
import type { JsonRpcId } from "./jsonrpc.js";

export type ClientInfo = {
  name: string;
  title: string | null;
  version: string;
};

export type InitializeCapabilities = {
  experimentalApi: boolean;
  optOutNotificationMethods?: string[] | null;
};

export type InitializeParams = {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
};

export type InitializeResponse = {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
};

export type JsonValue =
  | number
  | string
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type ConfigReadParams = {
  includeLayers: boolean;
  cwd?: string | null;
};

export type ConfigLayerSource =
  | { type: "mdm"; domain: string; key: string }
  | { type: "system"; file: string }
  | { type: "user"; file: string }
  | { type: "project"; dotCodexFolder: string }
  | { type: "sessionFlags" }
  | { type: "legacyManagedConfigTomlFromFile"; file: string }
  | { type: "legacyManagedConfigTomlFromMdm" };

export type ConfigLayerMetadata = {
  name: ConfigLayerSource;
  version: string;
};

export type Config = {
  model: string | null;
  review_model: string | null;
  model_context_window: number | null;
  model_auto_compact_token_limit: number | null;
  model_provider: string | null;
  approval_policy: string | null;
  approvals_reviewer: string | null;
  sandbox_mode: string | null;
  sandbox_workspace_write: JsonValue | null;
  forced_chatgpt_workspace_id: string | null;
  forced_login_method: string | null;
  web_search: string | null;
  tools: JsonValue | null;
  profile: string | null;
  profiles: { [key: string]: JsonValue | undefined };
  instructions: string | null;
  developer_instructions: string | null;
  compact_prompt: string | null;
  model_reasoning_effort: string | null;
  model_reasoning_summary: string | null;
  model_verbosity: string | null;
  service_tier: string | null;
  analytics: JsonValue | null;
  [key: string]: JsonValue | undefined;
};

export type ConfigLayer = {
  name: ConfigLayerSource;
  version: string;
  config: JsonValue;
  disabledReason: string | null;
};

export type ConfigReadResponse = {
  config: Config;
  origins: { [key: string]: ConfigLayerMetadata | undefined };
  layers: ConfigLayer[] | null;
};

export type MergeStrategy = "replace" | "upsert";

export type ConfigValueWriteParams = {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: MergeStrategy;
  filePath?: string | null;
  expectedVersion?: string | null;
};

export type ConfigEdit = {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: MergeStrategy;
};

export type ConfigBatchWriteParams = {
  edits: ConfigEdit[];
  filePath?: string | null;
  expectedVersion?: string | null;
  reloadUserConfig?: boolean;
};

export type WriteStatus = "ok" | "okOverridden";

export type OverriddenMetadata = {
  message: string;
  overridingLayer: ConfigLayerMetadata;
  effectiveValue: JsonValue;
};

export type ConfigWriteResponse = {
  status: WriteStatus;
  version: string;
  filePath: string;
  overriddenMetadata: OverriddenMetadata | null;
};

export type ConfigRequirementsReadResponse = {
  requirements: JsonValue | null;
};

export type GetAccountParams = {
  refreshToken: boolean;
};

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string; planType: PlanType };

export type GetAccountResponse = {
  account: Account | null;
  requiresOpenaiAuth: boolean;
};

export type LoginAccountParams =
  | { type: "apiKey"; apiKey: string }
  | { type: "chatgpt" }
  | {
      type: "chatgptAuthTokens";
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType?: string | null;
    };

export type LoginAccountResponse =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: "chatgptAuthTokens" };

export type CancelLoginAccountParams = {
  loginId: string;
};

export type CancelLoginAccountStatus = "canceled" | "notFound";

export type CancelLoginAccountResponse = {
  status: CancelLoginAccountStatus;
};

export type LogoutAccountResponse = Record<string, never>;

export type AccountUpdatedNotification = {
  authMode: AuthMode | null;
  planType: PlanType | null;
};

export type AccountLoginCompletedNotification = {
  loginId: string | null;
  success: boolean;
  error: string | null;
};

export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: PlanType | null;
};

export type GetAccountRateLimitsResponse = {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: { [key: string]: RateLimitSnapshot | undefined } | null;
};

export type GetAuthStatusParams = {
  includeToken: boolean | null;
  refreshToken: boolean | null;
};

export type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens";

export type GetAuthStatusResponse = {
  authMethod: AuthMode | null;
  authToken: string | null;
  requiresOpenaiAuth: boolean | null;
};

export type SkillsListParams = {
  cwds?: string[];
  forceReload?: boolean;
  perCwdExtraUserRoots?: JsonValue[] | null;
};

export type SkillsListResponse = {
  data: JsonValue[];
};

export type PluginListParams = {
  cwds?: string[] | null;
  forceRemoteSync?: boolean;
};

export type PluginListResponse = {
  marketplaces: JsonValue[];
  remoteSyncError: string | null;
};

export type AppListParams = {
  cursor?: string | null;
  limit?: number | null;
  threadId?: string | null;
  forceRefetch?: boolean;
};

export type AppListResponse = {
  data: JsonValue[];
  nextCursor: string | null;
};

export type CollaborationModeMask = {
  name: string;
  mode: string | null;
  model: string | null;
  reasoning_effort: string | null;
};

export type CollaborationModeListResponse = {
  data: CollaborationModeMask[];
};

export type ExperimentalFeatureListParams = {
  cursor?: string | null;
  limit?: number | null;
};

export type ExperimentalFeature = {
  name: string;
  stage: string;
  displayName: string | null;
  description: string | null;
  announcement: string | null;
  enabled: boolean;
  defaultEnabled: boolean;
};

export type ExperimentalFeatureListResponse = {
  data: ExperimentalFeature[];
  nextCursor: string | null;
};

export type McpServerStatusListParams = {
  cursor?: string | null;
  limit?: number | null;
};

export type McpServerStatusListResponse = {
  data: JsonValue[];
  nextCursor: string | null;
};

export type Model = {
  id: string;
  model: string;
  upgrade: string | null;
  upgradeInfo: JsonValue | null;
  availabilityNux: JsonValue | null;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
};

export type ReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type ModelListParams = {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
};

export type ModelListResponse = {
  data: Model[];
  nextCursor: string | null;
};

export type GitInfo = VendoredGitInfo;

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export type UserInput =
  | { type: "text"; text: string; text_elements: JsonValue[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type ThreadItem =
  | { type: "userMessage"; id: string; content: JsonValue[] }
  | { type: "agentMessage"; id: string; text: string; phase: string | null }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      status: string;
      commandActions: JsonValue[];
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { type: "fileChange"; id: string; changes: JsonValue[]; status: string };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type TurnError = {
  message: string;
  codexErrorInfo: JsonValue | null;
  additionalDetails: string | null;
};

export type Turn = {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
};

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandboxPolicy?: JsonValue | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: string | null;
  personality?: string | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: JsonValue | null;
};

export type TurnStartResponse = {
  turn: Turn;
};

export type TurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type TurnInterruptResponse = Record<string, never>;

export type SessionSource = "appServer";

export type Thread = {
  id: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: SessionSource;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: GitInfo | null;
  name: string | null;
  turns: Turn[];
};

export type ThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandbox?: SandboxMode | null;
  config?: { [key: string]: JsonValue | undefined } | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean | null;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
};

export type ThreadStartResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
  reasoningEffort: string | null;
};

export type ThreadResumeParams = {
  threadId: string;
  history?: JsonValue[] | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandbox?: SandboxMode | null;
  config?: { [key: string]: JsonValue | undefined } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  persistExtendedHistory: boolean;
};

export type ThreadResumeResponse = ThreadStartResponse;

export type ThreadForkParams = {
  threadId: string;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandbox?: SandboxMode | null;
  config?: { [key: string]: JsonValue | undefined } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean;
  persistExtendedHistory: boolean;
};

export type ThreadForkResponse = ThreadStartResponse;

export type ThreadListParams = {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | null;
  modelProviders?: string[] | null;
  sourceKinds?: string[] | null;
  archived?: boolean | null;
  cwd?: string | null;
  searchTerm?: string | null;
};

export type ThreadListResponse = {
  data: Thread[];
  nextCursor: string | null;
};

export type ThreadLoadedListParams = {
  cursor?: string | null;
  limit?: number | null;
};

export type ThreadLoadedListResponse = {
  data: string[];
  nextCursor: string | null;
};

export type ThreadReadParams = {
  threadId: string;
  includeTurns: boolean;
};

export type ThreadReadResponse = {
  thread: Thread;
};

export type ThreadSetNameParams = {
  threadId: string;
  name: string;
};

export type ThreadMetadataGitInfoUpdateParams = {
  sha?: string | null;
  branch?: string | null;
  originUrl?: string | null;
};

export type ThreadMetadataUpdateParams = {
  threadId: string;
  gitInfo?: ThreadMetadataGitInfoUpdateParams | null;
};

export type ThreadArchiveParams = {
  threadId: string;
};

export type ThreadUnarchiveParams = {
  threadId: string;
};

export type ThreadUnsubscribeParams = {
  threadId: string;
};

export type ThreadSetNameResponse = Record<string, never>;
export type ThreadArchiveResponse = Record<string, never>;
export type ThreadUnarchiveResponse = { thread: Thread };
export type ThreadMetadataUpdateResponse = { thread: Thread };
export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";
export type ThreadUnsubscribeResponse = { status: ThreadUnsubscribeStatus };

export type ThreadTokenUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cachedOutputTokens: number;
  totalTokens: number;
};

export type ThreadTokenUsage = {
  modelContextWindow: number | null;
  last: ThreadTokenUsageTotals;
};

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ReadOnlyAccess =
  | { type: "restricted"; includePlatformDefaults: boolean; readableRoots: string[] }
  | { type: "fullAccess" };

export type NetworkAccess = "restricted" | "enabled";

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; access: ReadOnlyAccess; networkAccess: boolean }
  | {
      type: "externalSandbox";
      networkAccess: NetworkAccess;
    }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      readOnlyAccess: ReadOnlyAccess;
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CommandExecTerminalSize = {
  cols: number;
  rows: number;
};

export type CommandExecParams = {
  command: string[];
  processId?: string | null;
  tty?: boolean;
  streamStdin?: boolean;
  streamStdoutStderr?: boolean;
  outputBytesCap?: number | null;
  disableOutputCap?: boolean;
  disableTimeout?: boolean;
  timeoutMs?: number | null;
  cwd?: string | null;
  env?: { [key: string]: string | null | undefined } | null;
  size?: CommandExecTerminalSize | null;
  sandboxPolicy?: JsonValue | null;
};

export type CommandExecResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandExecWriteParams = {
  processId: string;
  deltaBase64?: string | null;
  closeStdin?: boolean;
};

export type CommandExecResizeParams = {
  processId: string;
  size: CommandExecTerminalSize;
};

export type CommandExecTerminateParams = {
  processId: string;
};

export type ToolRequestUserInputOption = {
  label: string;
  description: string;
};

export type ToolRequestUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
};

export type ToolRequestUserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
};

export type ToolRequestUserInputAnswer = {
  answers: string[];
};

export type ToolRequestUserInputResponse = {
  answers: { [key: string]: ToolRequestUserInputAnswer | undefined };
};

export type ServerRequestResolvedNotification = {
  threadId: string;
  requestId: JsonRpcId;
};

export type ServerNotification = {
  method: string;
  params?: unknown;
};

export type NotificationFilterState = {
  optedOutMethods: ReadonlySet<string>;
};

export function asJsonRpcId(value: unknown): JsonRpcId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}
