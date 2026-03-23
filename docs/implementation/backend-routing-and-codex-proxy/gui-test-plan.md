# Routed Backend GUI Test Plan

Status: Draft

## Purpose

Define a repeatable GUI validation plan for the routed backend work in this branch.

This plan covers:

1. native Codex baseline behavior via `scripts/codex.sh`,
2. routed Codex behavior via `scripts/codapter.sh` with a `codex / ...` model,
3. routed Pi behavior via `scripts/codapter.sh` with a `pi / ...` model,
4. backend-aware sub-agent flows,
5. command and file-edit rendering,
6. thread continuity, resume, and fork behavior,
7. log and MCP evidence collection when a GUI regression appears.

## Required Environment

1. Build the adapter first:

```bash
npm install
npm run build:dist
```

2. Use a disposable workspace for tool and edit validation:

```bash
mkdir -p /tmp/codapter-gui-smoke
cd /tmp/codapter-gui-smoke
git init
printf 'alpha\nbeta\n' > edit-smoke.txt
printf '# GUI smoke\n' > README.md
```

3. Keep the repo checkout available for code-level diff inspection and log review.

4. Before every Pi GUI run, explicitly choose a model in the picker.
   Preferred Pi validation model: `pi / Claude Opus 4.6`.

## Launchers

Use these scripts exactly:

1. `./scripts/codex.sh`
   Native Codex baseline. Writes stdio traffic to `/tmp/codapter-codex-stdio.log`.
2. `./scripts/codapter.sh`
   Routed adapter run. Writes stdio traffic to `/tmp/codapter-stdio.log` and adapter debug events to `/tmp/codapter.jsonl`.

## Reset Procedure

Run this before switching backends or rerunning a flaky case:

```bash
pkill -f "Codex.app/Contents/MacOS/Codex" || true
rm -f ~/.local/share/codapter/threads.json
rm -f /tmp/codapter-stdio.log /tmp/codapter-codex-stdio.log /tmp/codapter.jsonl
```

Then start exactly one launcher and wait for Electron remote debugging on port `9222`.

## Evidence Collection

For every failed case, capture all of:

1. an MCP snapshot of `app://-/index.html?hostId=local`,
2. a screenshot if layout or duplicate rendering is relevant,
3. the matching slice of `/tmp/codapter-stdio.log` or `/tmp/codapter-codex-stdio.log`,
4. the matching slice of `/tmp/codapter.jsonl` for routed runs,
5. the exact selected model and backend,
6. the exact prompt text used,
7. whether the failure reproduced after a clean restart.

## Shared Checks

Run these checks for both routed backends unless the backend-specific section overrides them.

### S1. Model picker and thread creation

Steps:

1. Launch the app.
2. Open a new thread in `/tmp/codapter-gui-smoke`.
3. Select the intended backend/model explicitly.

Expected:

1. The selected picker label matches the requested backend and model.
2. A single new thread appears in the sidebar.
3. No unexpected hidden helper thread becomes the visible active thread.

### S2. First-turn thread continuity

Prompt:

```text
Reply with hello from <backend>.
```

Expected:

1. The user prompt appears once.
2. The assistant reply is appended in the same visible thread.
3. The sidebar does not show an extra visible thread for the same exchange.

### S3. Follow-up turn continuity

Prompt:

```text
Reply with follow up from <backend>.
```

Expected:

1. The follow-up sends without UI error.
2. The assistant reply lands in the same thread.
3. No `turn_active` readiness failure appears.
4. The thread now shows two user prompts and two assistant replies in order.

### S4. Command tool rendering

Prompt:

```text
Run `pwd` and then tell me only the final working directory.
```

Expected:

1. A `commandExecution` item appears.
2. The rendered command matches `pwd`.
3. Output streaming, final status, and assistant summary all appear in order.
4. Reopening the thread preserves the command item.

### S5. File edit rendering

Prompt:

```text
Edit `edit-smoke.txt` by changing `beta` to `gamma`, then explain the change in one sentence.
```

Expected:

1. A `fileChange` item appears.
2. The diff shows `-beta` and `+gamma`.
3. The filesystem contents match the rendered diff.
4. The final assistant text does not duplicate the diff payload.

### S6. Thread resume after restart

Steps:

1. Complete at least one turn.
2. Quit the GUI.
3. Relaunch the same backend.
4. Reopen the same thread.

Expected:

1. Completed turns rehydrate in the same order.
2. No duplicate user message appears on load.
3. A new follow-up turn can be sent after resume.

### S7. Fork from message

Steps:

1. Use `Fork from this message` on the latest user prompt or assistant reply.
2. Open the forked thread.

Expected:

1. A new thread is created.
2. The original thread remains unchanged.
3. The fork starts from the selected anchor, not from an unrelated turn.

## Codex Baseline Suite

Run with `./scripts/codex.sh`.

### C1. Native baseline capture

Run `S1` through `S5` first on native Codex before comparing routed Codex behavior.

Expected:

1. This produces the behavioral baseline for routed Codex.
2. The relevant stdio lines are present in `/tmp/codapter-codex-stdio.log`.

### C2. Native sub-agent lifecycle

Prompt:

```text
Spawn a sub-agent to read `README.md` and report the first heading. After it finishes, summarize the result.
```

Expected:

1. A child thread appears in the GUI.
2. The parent shows the collab tool-call item rather than raw tool spam.
3. The child produces an answer in its own thread.
4. Returning to the parent shows the summary after the child completes.

Then validate:

1. send follow-up input to the child,
2. wait on the child,
3. close the child,
4. resume the child if supported by the backend state.

## Routed Codex Suite

Run with `./scripts/codapter.sh` and select a `codex / ...` model.

### RC1. Parity against native baseline

Run `S1` through `S7`.

Expected:

1. Routed Codex matches native Codex for visible thread behavior.
2. The assistant reply stays in the active thread.
3. No routed thread-id leak creates a second visible thread.

### RC2. Routed server-request relay

Use a prompt that triggers approvals or other server requests if available in the selected model flow.

Expected:

1. The request appears in the GUI.
2. Accepting or rejecting it reaches the backend.
3. `/tmp/codapter-stdio.log` shows adapter-owned request ids outward and upstream request ids inward.

### RC3. Routed native sub-agents

Run `C2` again through the routed adapter.

Expected:

1. Child threads still appear correctly.
2. Parent and child thread routing stay stable after send, wait, close, and resume.
3. Routed thread ids remain consistent in the GUI even if upstream Codex thread ids differ.

## Routed Pi Suite

Run with `./scripts/codapter.sh` and select `pi / Claude Opus 4.6`.

### P1. Initial prompt dedupe regression

Run `S2`.

Expected:

1. The initial user prompt appears once.
2. No second prompt bubble is injected by normalized Pi live events.

### P2. Follow-up send regression

Run `S3`.

Expected:

1. The second turn sends successfully.
2. No `Thread ... is not ready (status: turn_active)` error appears.
3. `/tmp/codapter.jsonl` shows `turn/completed` for the first turn before the second `turn/start`.

### P3. Pi elicitation flow

Use a prompt likely to trigger `item/tool/requestUserInput`, or use a controlled backend fixture.

Expected:

1. The GUI displays the user-input request.
2. Submitting the answer unblocks the turn.
3. The response reaches Pi and the turn completes.

### P4. Pi file-edit output validation

Run `S5`.

Expected:

1. The rendered `fileChange` diff is correct.
2. The final completion does not re-emit the same diff as duplicate plain text.
3. Reopening the thread preserves the completed edit item.

### P5. Pi child-thread rendering and reopen

Prompt:

```text
Spawn exactly one Pi sub-agent using `pi::anthropic/claude-opus-4-6` reasoning `medium`. Tell the child to run `date` and report the output. Wait for the child, then summarize the result.
```

Expected:

1. The parent shows one `Spawned 1 agent` collab item.
2. Opening the child thread shows one user prompt and one rendered command result.
3. No raw JSON `toolCall` or `toolResult` payload is rendered in the child view.
4. Returning to the parent keeps the collab summary on the parent only.
5. Reopening the child thread in the same app session does not duplicate the completed assistant output.

### P6. Pi parent -> Codex child sub-agent routing

Prompt:

```text
Spawn a sub-agent using model `codex / gpt-5.4` to read `README.md` and report the first heading. Wait for it, then summarize the answer.
```

Expected:

1. The parent thread stays on Pi.
2. The child thread is created on Codex.
3. The child thread appears in the GUI with sub-agent metadata.
4. The parent collab item shows the child state transition from running to completed.
5. The parent summary arrives after the child finishes.

Then validate:

1. `send_input` to the child,
2. `wait_agent`,
3. `close_agent`,
4. `resume_agent` while the adapter process remains alive.

### P7. Unsupported cross-backend direction

From a Codex parent, attempt to force a Pi child if the UI/tooling exposes that path.

Expected:

1. The request is rejected deterministically, or
2. the unsupported option is not exposed at all.

No silent fallback to the wrong backend is acceptable.

## Log Review Checklist

### Native Codex

Check `/tmp/codapter-codex-stdio.log` for:

1. one visible thread per requested thread,
2. expected `turn/started` and `turn/completed` ordering,
3. expected collab requests and responses during native sub-agent flows.

### Routed Adapter

Check `/tmp/codapter-stdio.log` and `/tmp/codapter.jsonl` for:

1. backend-prefixed model routing,
2. thread-id rewrite correctness,
3. turn-id rewrite correctness,
4. no duplicate Pi live user-message item notifications,
5. `turn/completed` arrival before Pi follow-up turns,
6. no raw JSON Pi history hydration in reopened child threads,
7. parent/child backend ownership during Pi -> Codex sub-agent tests.

## Minimum Release Gate

Do not call routed backend GUI validation complete until all of these are true:

1. routed Codex passes `RC1` and `RC3`,
2. routed Pi passes `P1`, `P2`, `P4`, and `P5`,
3. native Codex baseline has been captured for comparison,
4. at least one restart/resume run passes on each backend,
5. all failures have matching GUI and log evidence attached.
