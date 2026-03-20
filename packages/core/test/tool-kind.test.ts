import { describe, expect, it } from "vitest";
import { classifyToolName } from "../src/tool-kind.js";

describe("classifyToolName", () => {
  it("classifies known command tools", () => {
    expect(classifyToolName("bash")).toBe("commandExecution");
    expect(classifyToolName("exec_command")).toBe("commandExecution");
  });

  it("classifies known file change tools", () => {
    expect(classifyToolName("file_edit")).toBe("fileChange");
    expect(classifyToolName("apply_patch")).toBe("fileChange");
  });

  it("uses token fallback for variant names", () => {
    expect(classifyToolName("shell-tool")).toBe("commandExecution");
    expect(classifyToolName("write-file")).toBe("fileChange");
  });

  it("falls back to agentMessage for unknown tools", () => {
    expect(classifyToolName("search_web")).toBe("agentMessage");
  });
});
