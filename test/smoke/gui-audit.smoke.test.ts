import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const INTERNAL_TITLE_THREAD_PROMPT =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task\nGenerate a concise UI title";

async function runNodeScript(args: readonly string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr || `node exited with code ${code}`));
    });
  });
}

describe("gui audit smoke", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("anchors focus on the visible parent thread instead of internal title helpers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-gui-audit-"));
    directories.push(directory);

    const stdioLogPath = join(directory, "stdio.log");
    const artifactDir = join(directory, "artifacts");
    const logLines = [
      `[2026-03-24T01:00:00.000Z] GUI→CLI: ${JSON.stringify({
        id: 1,
        method: "thread/start",
        params: { cwd: "/Users/kcassidy/codapter", model: "gpt-5.4-mini" },
      })}`,
      `[2026-03-24T01:00:00.100Z] CLI→GUI: ${JSON.stringify({
        id: 1,
        result: {
          thread: {
            id: "parent-thread",
            preview: "",
            source: "appServer",
            agentNickname: null,
            modelProvider: "codex",
            path: null,
          },
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
      })}`,
      `[2026-03-24T01:00:00.200Z] GUI→CLI: ${JSON.stringify({
        id: 2,
        method: "turn/start",
        params: {
          threadId: "parent-thread",
          input: [{ type: "text", text: "Spawn one child", text_elements: [] }],
        },
      })}`,
      `[2026-03-24T01:00:00.300Z] CLI→GUI: ${JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "child-thread",
            preview: "Run date",
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread",
                  depth: 1,
                  agent_nickname: "Volta",
                  agent_role: "default",
                },
              },
            },
            agentNickname: "Volta",
            modelProvider: "codex",
            path: null,
          },
        },
      })}`,
      `[2026-03-24T01:00:00.400Z] CLI→GUI: ${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "collabAgentToolCall",
            id: "call_spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["child-thread"],
            prompt: "Run date",
            model: "gpt-5.4-mini",
            reasoningEffort: "medium",
            agentsStates: {
              "child-thread": { status: "pendingInit", message: null },
            },
          },
        },
      })}`,
      `[2026-03-24T01:00:00.500Z] GUI→CLI: ${JSON.stringify({
        id: 3,
        method: "thread/start",
        params: { cwd: "/Users/kcassidy/codapter", model: "gpt-5.1-codex-mini" },
      })}`,
      `[2026-03-24T01:00:00.600Z] CLI→GUI: ${JSON.stringify({
        id: 3,
        result: {
          thread: {
            id: "title-thread",
            preview: "",
            source: "appServer",
            agentNickname: null,
            modelProvider: "codex",
            path: null,
          },
          model: "gpt-5.1-codex-mini",
          reasoningEffort: "low",
        },
      })}`,
      `[2026-03-24T01:00:00.700Z] GUI→CLI: ${JSON.stringify({
        id: 4,
        method: "turn/start",
        params: {
          threadId: "title-thread",
          input: [{ type: "text", text: INTERNAL_TITLE_THREAD_PROMPT, text_elements: [] }],
        },
      })}`,
      `[2026-03-24T01:00:00.800Z] CLI→GUI: ${JSON.stringify({
        method: "item/started",
        params: {
          threadId: "title-thread",
          turnId: "title-turn",
          item: {
            type: "userMessage",
            content: [{ type: "text", text: INTERNAL_TITLE_THREAD_PROMPT, text_elements: [] }],
          },
        },
      })}`,
    ].join("\n");
    await writeFile(stdioLogPath, `${logLines}\n`, "utf8");

    const summaryDir = await runNodeScript(
      [
        "scripts/gui-audit.mjs",
        "collect",
        "--scenario",
        "synthetic",
        "--artifact-dir",
        artifactDir,
        "--stdio-log",
        stdioLogPath,
      ],
      "/Users/kcassidy/codapter"
    );

    const summary = JSON.parse(await readFile(join(summaryDir, "summary.json"), "utf8"));
    expect(summary.tap.internalThreadIds).toHaveLength(1);
    expect(summary.focus.rootThreadId).toBe("parent-thread");
    expect(summary.focus.threadIds).toEqual(["parent-thread", "child-thread"]);
    expect(
      summary.focus.responses.some(
        (entry: { thread?: { id?: string } }) => entry.thread?.id === "title-thread"
      )
    ).toBe(false);
    expect(
      summary.focus.notifications.some(
        (entry: { threadId?: string }) => entry.threadId === "title-thread"
      )
    ).toBe(false);
  });

  it("captures Codex session transcript summaries for spawn and child completion parity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-gui-audit-"));
    directories.push(directory);

    const stdioLogPath = join(directory, "stdio.log");
    const parentSessionPath = join(directory, "parent-session.jsonl");
    const childSessionPath = join(directory, "child-session.jsonl");
    const artifactDir = join(directory, "artifacts");

    const stdioLog = [
      `[2026-03-24T01:00:00.000Z] GUI→CLI: ${JSON.stringify({
        id: 1,
        method: "thread/start",
        params: { cwd: "/Users/kcassidy/codapter", model: "gpt-5.4-mini" },
      })}`,
      `[2026-03-24T01:00:00.100Z] CLI→GUI: ${JSON.stringify({
        id: 1,
        result: {
          thread: {
            id: "parent-thread",
            preview: "",
            source: "appServer",
            agentNickname: null,
            modelProvider: "codex",
            path: null,
          },
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
        },
      })}`,
    ].join("\n");
    await writeFile(stdioLogPath, `${stdioLog}\n`, "utf8");

    const parentSessionLog = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "parent_backend",
          cwd: "/Users/kcassidy/codapter",
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          arguments:
            '{"agent_type":"default","fork_context":false,"model":"gpt-5.4-mini","reasoning_effort":"medium","message":"Run date"}',
          call_id: "call_spawn",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_spawn",
          output: '{"agent_id":"child_backend","nickname":"Volta"}',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          arguments: '{"ids":["child_backend"],"timeout_ms":30000}',
          call_id: "call_wait",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_wait",
          output:
            '{"status":{"child_backend":{"completed":"Mon Mar 23 21:22:00 CDT 2026"}},"timed_out":false}',
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "parent_turn",
          last_agent_message: "Child agent output: Mon Mar 23 21:22:00 CDT 2026",
        },
      }),
    ].join("\n");
    await writeFile(parentSessionPath, `${parentSessionLog}\n`, "utf8");

    const childSessionLog = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child_backend",
          cwd: "/Users/kcassidy/codapter",
          model_provider: "openai",
          agent_nickname: "Volta",
          agent_role: "default",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent_backend",
                depth: 1,
                agent_nickname: "Volta",
                agent_role: "default",
              },
            },
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"date","workdir":"/Users/kcassidy/codapter"}',
          call_id: "call_exec",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_exec",
          output:
            "Command: /bin/zsh -lc date\nChunk ID: 1\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 8\nOutput:\nMon Mar 23 21:22:00 CDT 2026\n",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "final_answer",
          message: "Mon Mar 23 21:22:00 CDT 2026",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "child_turn",
          last_agent_message: "Mon Mar 23 21:22:00 CDT 2026",
        },
      }),
    ].join("\n");
    await writeFile(childSessionPath, `${childSessionLog}\n`, "utf8");

    const summaryDir = await runNodeScript(
      [
        "scripts/gui-audit.mjs",
        "collect",
        "--scenario",
        "synthetic-sessions",
        "--artifact-dir",
        artifactDir,
        "--stdio-log",
        stdioLogPath,
        "--session-log",
        parentSessionPath,
        "--session-log",
        childSessionPath,
      ],
      "/Users/kcassidy/codapter"
    );

    const summary = JSON.parse(await readFile(join(summaryDir, "summary.json"), "utf8"));
    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions[0]?.functionCalls).toMatchObject([
      {
        name: "spawn_agent",
        arguments: {
          agent_type: "default",
          fork_context: false,
          model: "gpt-5.4-mini",
          reasoning_effort: "medium",
          message: "Run date",
        },
      },
      {
        name: "wait_agent",
        arguments: {
          ids: ["child_backend"],
          timeout_ms: 30000,
        },
      },
    ]);
    expect(summary.sessions[0]?.functionOutputs).toMatchObject([
      {
        name: "spawn_agent",
        output: {
          agent_id: "child_backend",
          nickname: "Volta",
        },
      },
      {
        name: "wait_agent",
        output: {
          status: {
            child_backend: {
              completed: "Mon Mar 23 21:22:00 CDT 2026",
            },
          },
          timed_out: false,
        },
      },
    ]);
    expect(summary.sessions[1]?.session).toMatchObject({
      agentNickname: "Volta",
      source: {
        type: "subAgent",
      },
    });
    expect(summary.sessions[1]?.functionOutputs).toMatchObject([
      {
        name: "exec_command",
        output: {
          exitCode: 0,
          stdout: "Mon Mar 23 21:22:00 CDT 2026\n",
        },
      },
    ]);
    expect(summary.sessions[1]?.endedWithoutCompletion).toBe(false);
    expect(summary.sessions[1]?.taskCompletions).toMatchObject([
      {
        lastAgentMessage: "Mon Mar 23 21:22:00 CDT 2026",
      },
    ]);
  });

  it("flags child transcripts that stall immediately after exec_command output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-gui-audit-"));
    directories.push(directory);

    const stdioLogPath = join(directory, "stdio.log");
    const childSessionPath = join(directory, "child-stalled.jsonl");
    const artifactDir = join(directory, "artifacts");

    await writeFile(
      stdioLogPath,
      `${`[2026-03-24T01:00:00.000Z] GUI→CLI: ${JSON.stringify({
        id: 1,
        method: "thread/start",
        params: { cwd: "/Users/kcassidy/codapter", model: "gpt-5.4-mini" },
      })}`}\n`,
      "utf8"
    );

    const stalledChildSessionLog = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child_backend",
          cwd: "/Users/kcassidy/codapter",
          model_provider: "openai",
          agent_nickname: "Bohr",
          agent_role: "worker",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"date","workdir":"/Users/kcassidy/codapter"}',
          call_id: "call_exec",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_exec",
          output:
            "Command: /bin/zsh -lc date\nChunk ID: 1\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 8\nOutput:\nMon Mar 23 21:28:19 CDT 2026\n",
        },
      }),
    ].join("\n");
    await writeFile(childSessionPath, `${stalledChildSessionLog}\n`, "utf8");

    const summaryDir = await runNodeScript(
      [
        "scripts/gui-audit.mjs",
        "collect",
        "--scenario",
        "synthetic-stalled-child",
        "--artifact-dir",
        artifactDir,
        "--stdio-log",
        stdioLogPath,
        "--session-log",
        childSessionPath,
      ],
      "/Users/kcassidy/codapter"
    );

    const summary = JSON.parse(await readFile(join(summaryDir, "summary.json"), "utf8"));
    expect(summary.sessions[0]?.lastEventType).toBe("function_call_output:exec_command");
    expect(summary.sessions[0]?.finalAgentMessages).toEqual([]);
    expect(summary.sessions[0]?.taskCompletions).toEqual([]);
    expect(summary.sessions[0]?.endedWithoutCompletion).toBe(true);
  });
});
