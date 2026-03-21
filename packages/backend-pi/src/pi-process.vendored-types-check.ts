import type {
  AssistantMessage as VendoredAssistantMessage,
  ImageContent as VendoredPiImageContent,
  Usage as VendoredUsage,
} from "../../../types/pi/packages/ai/src/types.js";
import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "../../../types/pi/packages/coding-agent/src/core/extensions/types.js";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "../../../types/pi/packages/coding-agent/src/modes/rpc/rpc-types.js";

type AssertAssignable<From extends To, To> = true;

type LocalPiImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

type LocalUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

type LocalAssistantMessage = {
  role: "assistant";
  content: (
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  )[];
  api: string;
  provider: string;
  model: string;
  usage: LocalUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  responseId?: string;
  timestamp: number;
};

type LocalElicitationRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    };

type LocalElicitationResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

type LocalToolExecutionStartEvent = {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
};

type LocalToolExecutionUpdateEvent = {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
};

type LocalToolExecutionEndEvent = {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

type VendoredElicitationRequest = Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

type PiVendoredTypesMatch = [
  AssertAssignable<LocalPiImageContent, VendoredPiImageContent>,
  AssertAssignable<VendoredPiImageContent, LocalPiImageContent>,
  AssertAssignable<LocalUsage, VendoredUsage>,
  AssertAssignable<VendoredUsage, LocalUsage>,
  AssertAssignable<LocalAssistantMessage, VendoredAssistantMessage>,
  AssertAssignable<VendoredAssistantMessage, LocalAssistantMessage>,
  AssertAssignable<LocalElicitationRequest, VendoredElicitationRequest>,
  AssertAssignable<VendoredElicitationRequest, LocalElicitationRequest>,
  AssertAssignable<LocalElicitationResponse, RpcExtensionUIResponse>,
  AssertAssignable<RpcExtensionUIResponse, LocalElicitationResponse>,
  AssertAssignable<LocalToolExecutionStartEvent, ToolExecutionStartEvent>,
  AssertAssignable<ToolExecutionStartEvent, LocalToolExecutionStartEvent>,
  AssertAssignable<LocalToolExecutionUpdateEvent, ToolExecutionUpdateEvent>,
  AssertAssignable<ToolExecutionUpdateEvent, LocalToolExecutionUpdateEvent>,
  AssertAssignable<LocalToolExecutionEndEvent, ToolExecutionEndEvent>,
  AssertAssignable<ToolExecutionEndEvent, LocalToolExecutionEndEvent>,
];
