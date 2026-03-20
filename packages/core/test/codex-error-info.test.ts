import { describe, expect, it } from "vitest";
import { classifyCodexErrorInfo } from "../src/codex-error-info.js";

describe("classifyCodexErrorInfo", () => {
  it("maps context and overload failures to vendored Codex variants", () => {
    expect(classifyCodexErrorInfo("prompt is too long for this model")).toBe(
      "contextWindowExceeded"
    );
    expect(classifyCodexErrorInfo("529 overloaded_error")).toBe("serverOverloaded");
  });

  it("extracts connection-style variants with http status when present", () => {
    expect(classifyCodexErrorInfo("response stream connection failed with 502")).toEqual({
      responseStreamConnectionFailed: { httpStatusCode: 502 },
    });
    expect(classifyCodexErrorInfo("network timeout while dialing upstream")).toEqual({
      httpConnectionFailed: { httpStatusCode: null },
    });
  });

  it("falls back to other for uncategorized errors", () => {
    expect(classifyCodexErrorInfo("something unexpected happened")).toBe("other");
  });
});
