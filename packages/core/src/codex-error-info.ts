import type { CodexErrorInfo } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/CodexErrorInfo.js";

function extractHttpStatusCode(message: string): number | null {
  const match = message.match(/\b([45]\d\d)\b/u);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyCodexErrorInfo(message: string): CodexErrorInfo {
  const normalized = message.toLowerCase();
  const httpStatusCode = extractHttpStatusCode(message);

  if (
    /context window|maximum context|prompt is too long|input is too long|model_context_window_exceeded|exceeds the (?:maximum )?context/i.test(
      normalized
    )
  ) {
    return "contextWindowExceeded";
  }
  if (/usage limit|rate limit|quota exceeded/i.test(normalized)) {
    return "usageLimitExceeded";
  }
  if (/overloaded|server overloaded|\b529\b/i.test(normalized)) {
    return "serverOverloaded";
  }
  if (/response stream disconnected/i.test(normalized)) {
    return {
      responseStreamDisconnected: { httpStatusCode },
    };
  }
  if (/too many failed attempts/i.test(normalized)) {
    return {
      responseTooManyFailedAttempts: { httpStatusCode },
    };
  }
  if (/stream connection failed|response stream connection failed/i.test(normalized)) {
    return {
      responseStreamConnectionFailed: { httpStatusCode },
    };
  }
  if (/connection failed|econn|enotfound|timed out|network/i.test(normalized)) {
    return {
      httpConnectionFailed: { httpStatusCode },
    };
  }
  if (/unauthorized|\b401\b|forbidden|\b403\b/i.test(normalized)) {
    return "unauthorized";
  }
  if (/bad request|\b400\b/i.test(normalized)) {
    return "badRequest";
  }
  if (/sandbox/i.test(normalized)) {
    return "sandboxError";
  }
  if (/internal server|\b500\b/i.test(normalized)) {
    return "internalServerError";
  }

  return "other";
}
