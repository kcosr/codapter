import { describe, expect, it } from "vitest";
import { inferCommandActions } from "../src/command-actions.js";

describe("inferCommandActions", () => {
  it("classifies read, list, and search commands", () => {
    expect(inferCommandActions("cat README.md")).toEqual([
      { type: "read", command: "cat README.md", name: "cat", path: "README.md" },
    ]);
    expect(inferCommandActions("ls src")).toEqual([
      { type: "listFiles", command: "ls src", path: "src" },
    ]);
    expect(inferCommandActions("rg TODO packages/core")).toEqual([
      { type: "search", command: "rg TODO packages/core", query: "TODO", path: "packages/core" },
    ]);
  });

  it("splits multi-command pipelines into multiple actions", () => {
    expect(inferCommandActions("cat README.md | rg install docs")).toEqual([
      { type: "read", command: "cat README.md", name: "cat", path: "README.md" },
      { type: "search", command: "rg install docs", query: "install", path: "docs" },
    ]);
  });

  it("falls back to unknown for unsupported commands", () => {
    expect(inferCommandActions("python script.py")).toEqual([
      { type: "unknown", command: "python script.py" },
    ]);
  });
});
