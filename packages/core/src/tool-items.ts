import { resolve } from "node:path";
import type { JsonValue } from "./protocol.js";

export type ToolItemKind = "commandExecution" | "fileChange" | "agentMessage";

const COMMAND_TOOL_NAMES = new Set(["bash", "command", "exec", "exec_command", "shell"]);
const FILE_CHANGE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "edit_file",
  "file_edit",
  "patch",
  "write",
  "write_file",
]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file"]);
const EDIT_TOOL_NAMES = new Set(["edit", "edit_file", "file_edit"]);
const PATCH_TOOL_NAMES = new Set(["apply_patch", "patch"]);

function tokenizeToolName(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveChangePath(cwd: string, filePath: string): string {
  return filePath.startsWith("/") ? filePath : resolve(cwd, filePath);
}

function normalizeNumberedDiffLine(line: string): string {
  const match = /^([ +-])(\d+)\s(.*)$/u.exec(line);
  if (!match) {
    return line;
  }
  const [, marker, , content] = match;
  return `${marker}${content}`;
}

function normalizeDiffText(diff: string): string {
  return diff
    .split("\n")
    .map((line) => normalizeNumberedDiffLine(line))
    .join("\n");
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function prefixedLines(prefix: "+" | "-", text: string): string[] {
  return splitLines(text).map((line) => `${prefix}${line}`);
}

function hunkRange(start: number, count: number): string {
  return `${Math.max(1, start)},${Math.max(0, count)}`;
}

function firstChangedLineFromOutput(output: unknown): number | null {
  if (!isRecord(output)) {
    return null;
  }

  if (typeof output.firstChangedLine === "number" && Number.isFinite(output.firstChangedLine)) {
    return output.firstChangedLine;
  }

  const details = isRecord(output.details) ? output.details : null;
  if (
    details &&
    typeof details.firstChangedLine === "number" &&
    Number.isFinite(details.firstChangedLine)
  ) {
    return details.firstChangedLine;
  }

  return null;
}

function buildUnifiedEditDiff(input: Record<string, unknown>, output?: unknown): string | null {
  const oldText = typeof input.oldText === "string" ? input.oldText : "";
  const newText = typeof input.newText === "string" ? input.newText : "";
  if (oldText.length === 0 && newText.length === 0) {
    return null;
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
  const changedNew = newLines.slice(prefix, newLines.length - suffix);
  const firstChangedLine = firstChangedLineFromOutput(output) ?? 1;
  const hunkStart = Math.max(1, firstChangedLine);
  const body = [
    ...oldLines.slice(0, prefix).map((line) => ` ${line}`),
    ...changedOld.map((line) => `-${line}`),
    ...changedNew.map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix).map((line) => ` ${line}`),
  ];

  return [
    `@@ -${hunkRange(hunkStart, oldLines.length)} +${hunkRange(hunkStart, newLines.length)} @@`,
    ...body,
  ].join("\n");
}

function editDiffFromInput(record: Record<string, unknown>): string {
  const oldText = typeof record.oldText === "string" ? record.oldText : "";
  const newText = typeof record.newText === "string" ? record.newText : "";
  if (oldText.length === 0 && newText.length === 0) {
    return "";
  }
  const removed = oldText.length > 0 ? prefixedLines("-", oldText) : [];
  const added = newText.length > 0 ? prefixedLines("+", newText) : [];
  return [...removed, ...added].join("\n");
}

function diffFromOutput(output: unknown): string | null {
  if (!isRecord(output)) {
    return null;
  }

  if (typeof output.diff === "string" && output.diff.length > 0) {
    return normalizeDiffText(output.diff);
  }

  const details = isRecord(output.details) ? output.details : null;
  if (details && typeof details.diff === "string" && details.diff.length > 0) {
    return normalizeDiffText(details.diff);
  }

  return null;
}

export function classifyToolName(toolName: string): ToolItemKind {
  const normalized = toolName.trim().toLowerCase();
  if (COMMAND_TOOL_NAMES.has(normalized)) {
    return "commandExecution";
  }
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) {
    return "fileChange";
  }

  const tokens = tokenizeToolName(normalized);
  if (tokens.includes("bash") || tokens.includes("shell") || tokens.includes("exec")) {
    return "commandExecution";
  }
  if (
    (tokens.includes("file") &&
      (tokens.includes("edit") || tokens.includes("patch") || tokens.includes("write"))) ||
    (tokens.includes("apply") && tokens.includes("patch"))
  ) {
    return "fileChange";
  }

  return "agentMessage";
}

export function synthesizeFileChanges(
  toolName: string,
  cwd: string,
  input: unknown,
  output?: unknown
): JsonValue[] {
  const normalized = toolName.trim().toLowerCase();
  const record = isRecord(input) ? input : {};
  const path = typeof record.path === "string" && record.path.length > 0 ? record.path : null;
  if (!path) {
    return [];
  }

  const resolvedPath = resolveChangePath(cwd, path);

  if (WRITE_TOOL_NAMES.has(normalized)) {
    const diff =
      typeof record.content === "string" ? record.content : (diffFromOutput(output) ?? "");
    return [{ path: resolvedPath, kind: { type: "add" }, diff }];
  }

  if (EDIT_TOOL_NAMES.has(normalized)) {
    const diff =
      buildUnifiedEditDiff(record, output) ??
      diffFromOutput(output) ??
      editDiffFromInput(record) ??
      (typeof record.content === "string" ? record.content : "");
    return [{ path: resolvedPath, kind: { type: "update" }, diff }];
  }

  if (PATCH_TOOL_NAMES.has(normalized)) {
    const diff = diffFromOutput(output) ?? "";
    return [{ path: resolvedPath, kind: { type: "update" }, diff }];
  }

  return [];
}
