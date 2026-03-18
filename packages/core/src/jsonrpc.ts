export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccessResponse {
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    (typeof value.id === "string" || typeof value.id === "number")
  );
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && typeof value.method === "string" && value.id === undefined;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { id, result };
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return data === undefined
    ? { id, error: { code, message } }
    : { id, error: { code, message, data } };
}
