import type { CodexErrorInfo } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/CodexErrorInfo.js";

function extractHttpStatusCode(message: string): number | null {
  const match = message
    .toLowerCase()
    .match(/\b(?:http|status|code|with)\D{0,8}([45]\d\d)(?!\d|ms)\b/u);
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
    /context window|maximum context|prompt is too long|input is too long|model_context_window_exceeded|exceeds the (?:maximum )?context/.test(
      normalized
    )
  ) {
    return "contextWindowExceeded";
  }
  if (/usage limit|rate limit|quota exceeded/.test(normalized)) {
    return "usageLimitExceeded";
  }
  if (/overloaded|server overloaded|\b529\b/.test(normalized)) {
    return "serverOverloaded";
  }
  if (/thread rollback/i.test(normalized)) {
    return "threadRollbackFailed";
  }
  if (/response stream disconnected/.test(normalized)) {
    return {
      responseStreamDisconnected: { httpStatusCode },
    };
  }
  if (/too many failed attempts/.test(normalized)) {
    return {
      responseTooManyFailedAttempts: { httpStatusCode },
    };
  }
  if (/stream connection failed|response stream connection failed/.test(normalized)) {
    return {
      responseStreamConnectionFailed: { httpStatusCode },
    };
  }
  if (/connection failed|connection reset|econn|enotfound|timed out|network/.test(normalized)) {
    return {
      httpConnectionFailed: { httpStatusCode },
    };
  }
  if (/unauthorized|\b401\b|forbidden|\b403\b/.test(normalized)) {
    return "unauthorized";
  }
  if (/bad request|\b400\b/.test(normalized)) {
    return "badRequest";
  }
  if (/sandbox/.test(normalized)) {
    return "sandboxError";
  }
  if (/internal server|\b500\b/.test(normalized)) {
    return "internalServerError";
  }

  return "other";
}
