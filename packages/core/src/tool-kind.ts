export type ToolItemKind = "commandExecution" | "fileChange" | "agentMessage";

const COMMAND_TOOL_NAMES = new Set(["bash", "command", "exec", "exec_command", "shell"]);

const FILE_CHANGE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit_file",
  "file_edit",
  "patch",
  "write",
  "write_file",
]);

function tokenizeToolName(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
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
