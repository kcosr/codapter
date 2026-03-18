import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type {
  CommandExecParams,
  CommandExecResizeParams,
  CommandExecResponse,
  CommandExecTerminateParams,
  CommandExecWriteParams,
} from "./protocol.js";

const DEFAULT_OUTPUT_BYTES_CAP = 1024 * 1024;

export interface CommandExecNotification {
  readonly method: "command/exec/outputDelta";
  readonly params: {
    processId: string;
    stream: "stdout" | "stderr";
    deltaBase64: string;
    capReached: boolean;
  };
}

export interface CommandExecManagerOptions {
  readonly onNotification?: (notification: CommandExecNotification) => void | Promise<void>;
}

type RunningCommand = BufferedCommand | PtyCommand;

interface CommandBase {
  readonly processId: string;
  readonly tty: boolean;
  readonly streamStdin: boolean;
  readonly streamStdoutStderr: boolean;
  readonly close: () => Promise<void>;
  readonly waitForExit: Promise<CommandExecResponse>;
}

interface BufferedCommand extends CommandBase {
  readonly tty: false;
  readonly child: ChildProcessWithoutNullStreams;
}

interface PtyCommand extends CommandBase {
  readonly tty: true;
  readonly ptyProcess: IPty;
}

function mergeEnvironment(overrides: CommandExecParams["env"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null || value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}

function createOutputCollector(cap: number | null) {
  let text = "";
  let bytes = 0;
  let capReached = false;

  return {
    append(chunk: Buffer | string): string {
      const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (cap !== null && bytes >= cap) {
        capReached = true;
        return "";
      }

      const remaining = cap === null ? next.length : Math.max(cap - bytes, 0);
      const slice = next.subarray(0, remaining);
      bytes += slice.length;
      text += slice.toString("utf8");
      if (cap !== null && slice.length < next.length) {
        capReached = true;
      }
      return slice.toString("utf8");
    },
    get text() {
      return text;
    },
    get capReached() {
      return capReached;
    },
  };
}

export class CommandExecManager {
  private readonly onNotification;
  private readonly processes = new Map<string, RunningCommand>();

  constructor(options: CommandExecManagerOptions = {}) {
    this.onNotification = options.onNotification;
  }

  async execute(params: CommandExecParams): Promise<CommandExecResponse> {
    if (params.command.length === 0) {
      throw new Error("command/exec requires a non-empty command array");
    }
    if (
      params.disableOutputCap &&
      params.outputBytesCap !== undefined &&
      params.outputBytesCap !== null
    ) {
      throw new Error("disableOutputCap cannot be combined with outputBytesCap");
    }
    if (params.disableTimeout && params.timeoutMs !== undefined && params.timeoutMs !== null) {
      throw new Error("disableTimeout cannot be combined with timeoutMs");
    }

    const tty = params.tty === true;
    const streamStdin = tty || params.streamStdin === true;
    const streamStdoutStderr = tty || params.streamStdoutStderr === true;
    const processId =
      params.processId ?? (tty || streamStdin || streamStdoutStderr ? null : randomUUID());

    if ((tty || streamStdin || streamStdoutStderr) && !processId) {
      throw new Error("processId is required for tty or streaming command/exec requests");
    }
    if (tty && !params.size) {
      throw new Error("TTY command/exec requests require an initial terminal size");
    }

    const command = tty
      ? await this.startPtyCommand(params, processId as string, streamStdoutStderr)
      : await this.startBufferedCommand(
          params,
          processId as string | null,
          streamStdin,
          streamStdoutStderr
        );

    if (processId) {
      this.processes.set(processId, command);
    }

    try {
      return await command.waitForExit;
    } finally {
      if (processId) {
        this.processes.delete(processId);
      }
    }
  }

  async write(params: CommandExecWriteParams): Promise<void> {
    const command = this.getCommand(params.processId);
    if (!command.streamStdin) {
      throw new Error(`command/exec process ${params.processId} does not accept stdin writes`);
    }

    if (command.tty) {
      if (params.deltaBase64) {
        command.ptyProcess.write(Buffer.from(params.deltaBase64, "base64").toString("utf8"));
      }
      if (params.closeStdin) {
        command.ptyProcess.kill();
      }
      return;
    }

    if (params.deltaBase64) {
      command.child.stdin.write(Buffer.from(params.deltaBase64, "base64"));
    }
    if (params.closeStdin) {
      command.child.stdin.end();
    }
  }

  async resize(params: CommandExecResizeParams): Promise<void> {
    const command = this.getCommand(params.processId);
    if (!command.tty) {
      throw new Error(`command/exec process ${params.processId} is not PTY-backed`);
    }
    command.ptyProcess.resize(params.size.cols, params.size.rows);
  }

  async terminate(params: CommandExecTerminateParams): Promise<void> {
    const command = this.getCommand(params.processId);
    await command.close();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.processes.values()].map(async (command) => command.close()));
    this.processes.clear();
  }

  private getCommand(processId: string): RunningCommand {
    const command = this.processes.get(processId);
    if (!command) {
      throw new Error(`Unknown command/exec process: ${processId}`);
    }
    return command;
  }

  private async startBufferedCommand(
    params: CommandExecParams,
    processId: string | null,
    streamStdin: boolean,
    streamStdoutStderr: boolean
  ): Promise<BufferedCommand> {
    const env = mergeEnvironment(params.env);
    const child = spawn(params.command[0], params.command.slice(1), {
      cwd: params.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cap = params.disableOutputCap
      ? null
      : (params.outputBytesCap ?? DEFAULT_OUTPUT_BYTES_CAP);
    const stdout = createOutputCollector(streamStdoutStderr ? null : cap);
    const stderr = createOutputCollector(streamStdoutStderr ? null : cap);
    let timedOut = false;
    const timeoutMs = params.disableTimeout ? null : (params.timeoutMs ?? null);
    const timeout =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = stdout.append(chunk);
      if (streamStdoutStderr && processId) {
        void this.notify({
          method: "command/exec/outputDelta",
          params: {
            processId,
            stream: "stdout",
            deltaBase64: Buffer.from(appended, "utf8").toString("base64"),
            capReached: stdout.capReached,
          },
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = stderr.append(chunk);
      if (streamStdoutStderr && processId) {
        void this.notify({
          method: "command/exec/outputDelta",
          params: {
            processId,
            stream: "stderr",
            deltaBase64: Buffer.from(appended, "utf8").toString("base64"),
            capReached: stderr.capReached,
          },
        });
      }
    });

    const waitForExit = new Promise<CommandExecResponse>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: code ?? (timedOut ? 124 : 1),
          stdout: streamStdoutStderr ? "" : stdout.text,
          stderr: streamStdoutStderr ? "" : stderr.text,
        });
      });
    });

    return {
      processId: processId ?? randomUUID(),
      tty: false,
      streamStdin,
      streamStdoutStderr,
      child,
      async close() {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      },
      waitForExit,
    };
  }

  private async startPtyCommand(
    params: CommandExecParams,
    processId: string,
    streamStdoutStderr: boolean
  ): Promise<PtyCommand> {
    const env = mergeEnvironment(params.env);
    const ptyProcess = pty.spawn(params.command[0], params.command.slice(1), {
      cols: params.size?.cols ?? 80,
      rows: params.size?.rows ?? 24,
      cwd: params.cwd ?? process.cwd(),
      env,
      name: "xterm-256color",
    });

    const stdout = createOutputCollector(null);
    const waitForExit = new Promise<CommandExecResponse>((resolve) => {
      ptyProcess.onData((data) => {
        stdout.append(data);
        if (streamStdoutStderr) {
          void this.notify({
            method: "command/exec/outputDelta",
            params: {
              processId,
              stream: "stdout",
              deltaBase64: Buffer.from(data, "utf8").toString("base64"),
              capReached: false,
            },
          });
        }
      });
      ptyProcess.onExit(({ exitCode }) => {
        resolve({
          exitCode,
          stdout: streamStdoutStderr ? "" : stdout.text,
          stderr: "",
        });
      });
    });

    return {
      processId,
      tty: true,
      streamStdin: true,
      streamStdoutStderr,
      ptyProcess,
      async close() {
        ptyProcess.kill();
      },
      waitForExit,
    };
  }

  private async notify(notification: CommandExecNotification): Promise<void> {
    await this.onNotification?.(notification);
  }
}
