export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export interface CollabAgentState {
  status: CollabAgentStatus;
  message: string | null;
}

export type CollabAgentTool = "spawnAgent" | "sendInput" | "wait" | "closeAgent" | "resumeAgent";

export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed";

export interface CollabAgentToolCallItem {
  type: "collabAgentToolCall";
  id: string;
  tool: CollabAgentTool;
  status: CollabAgentToolCallStatus;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentsStates: Record<string, CollabAgentState>;
}

export interface CollabAgent {
  agentId: string;
  nickname: string;
  role: string | null;
  threadId: string;
  sessionId: string;
  parentThreadId: string;
  depth: number;
  status: CollabAgentStatus;
  completionMessage: string | null;
}

export interface CollabSpawnRequest {
  parentThreadId: string;
  message: string;
  agentType?: string;
  model?: string;
  reasoningEffort?: string;
  forkContext?: boolean;
}

export interface CollabSpawnResponse {
  agent_id: string;
  nickname: string;
}

export interface CollabSendInputRequest {
  parentThreadId: string;
  id: string;
  message: string;
  interrupt?: boolean;
}

export interface CollabSendInputResponse {
  submission_id: string;
}

export interface CollabWaitRequest {
  parentThreadId: string;
  ids: string[];
  timeout_ms?: number;
}

export interface CollabWaitResponse {
  status: Record<string, CollabAgentStatus>;
  timed_out: boolean;
}

export interface CollabCloseRequest {
  parentThreadId: string;
  id: string;
}

export interface CollabCloseResponse {
  previous_status: CollabAgentStatus;
}

export interface CollabResumeRequest {
  parentThreadId: string;
  id: string;
}

export interface CollabResumeResponse {
  status: CollabAgentStatus;
}

export interface CollabConfig {
  maxAgents: number;
  maxDepth: number;
  defaultTimeoutMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
}
