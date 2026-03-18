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

export type Account = { type: "apiKey" } | { type: "chatgpt"; email: string; planType: string };

export type GetAccountResponse = {
  account: Account | null;
  requiresOpenaiAuth: boolean;
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

export type Model = {
  id: string;
  model: string;
  upgrade: string | null;
  upgradeInfo: JsonValue | null;
  availabilityNux: JsonValue | null;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
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
