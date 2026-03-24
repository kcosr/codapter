# GUI Audit And Parity Plan

Status: Active

## Purpose

Define a repeatable GUI validation plan for backend parity and long-lived regression coverage.

This plan covers:

1. native Codex baseline behavior via `scripts/codex.sh`,
2. routed Codex behavior via `scripts/codapter.sh` with a raw Codex model,
3. routed Pi behavior via `scripts/codapter.sh` with a `pi / ...` model,
4. backend-aware sub-agent flows,
5. command and file-edit rendering,
6. thread continuity, resume, and fork behavior,
7. log and MCP evidence collection when a GUI regression appears,
8. normalized artifact comparison against native Codex as the source of truth.

## Artifact Workflow

Use the native Codex GUI run as the baseline and record each run into its own artifact directory.

Recommended artifact root:

```bash
mkdir -p /tmp/codapter-gui-audit
```

After each scenario run, collect the logs into a normalized report:

```bash
# Native Codex baseline
npm run gui:audit:collect -- \
  --scenario native-codex \
  --artifact-dir /tmp/codapter-gui-audit \
  --stdio-log /tmp/codapter-codex-stdio.log

# Routed Codex
npm run gui:audit:collect -- \
  --scenario routed-codex \
  --artifact-dir /tmp/codapter-gui-audit \
  --stdio-log /tmp/codapter-stdio.log \
  --debug-log /tmp/codapter.jsonl

# Routed Pi
npm run gui:audit:collect -- \
  --scenario routed-pi \
  --artifact-dir /tmp/codapter-gui-audit \
  --stdio-log /tmp/codapter-stdio.log \
  --debug-log /tmp/codapter.jsonl
```

The collector copies the raw logs and writes:

1. `summary.json` with normalized GUI-facing request/response/notification sequences,
2. `summary.json.visible` with a focused parity digest for the visible parent/child flow,
3. `summary.json.sessions[]` with normalized native Codex session transcript summaries when `--session-log` is provided,
4. `metadata.json` with the captured inputs,
5. `raw/` with the original stdio and debug logs.

When a routed run diverges from native Codex on the same scenario, compare the normalized summaries directly:

```bash
npm run gui:audit:compare -- \
  --baseline /tmp/codapter-gui-audit/native-codex-.../summary.json \
  --candidate /tmp/codapter-gui-audit/routed-codex-.../summary.json
```

This comparison is intentionally focused on GUI-visible protocol shape, not byte-for-byte transport parity.

Use `summary.json.visible` first when reviewing parity manually. It is designed to answer:

1. which child threads were visible in the focused flow,
2. whether a child had a display name,
3. whether the child reached a command execution and turn completion,
4. how many parent agent messages appeared after `wait_agent`.

That last count is especially useful for catching routed Pi regressions where the parent shows both a synthetic wait summary and the model's own final answer.

## Prompt Discipline

Model-driven sub-agent flows are not fully deterministic. The same high-level prompt can produce different
`spawn_agent` arguments across runs, including `fork_context: true`, different `agent_type` values, or a
different child prompt. Those differences can change the observed GUI behavior even when the transport layer
is working correctly.

For parity runs, prefer prompts that explicitly constrain the sub-agent tool call shape. Example:

```text
Spawn one sub-agent without forking context. Use model gpt-5.4-mini. Have the child run the date command and report the exact output back concisely. Then wait for the child and summarize the result in this parent thread.
```

When a run diverges, always capture whether the parent actually chose:

1. `fork_context: true` or `false`,
2. a different `agent_type`,
3. a different `reasoning_effort`,
4. a materially different child prompt.

Do not treat routed/native differences as adapter regressions until the parent tool call shape is confirmed comparable.

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

5. For routed Codex runs, explicitly choose a raw native Codex id in the picker, for example `GPT-5.4-Mini`.

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

After collecting those artifacts, run `gui:audit:collect` so every failure has a comparable normalized summary.

When reviewing sub-agent rows in the sidebar, do not treat the unlabeled nested `Archive thread 1m` accessibility row as a routed-only bug. Native Codex snapshots show the same row shape today. Treat it as a parity issue only if routed behavior diverges from the native baseline in click behavior or opened thread content.

For Codex-backed sub-agent failures, also capture the parent and child session transcripts:

```bash
ls -1t ~/.codex/sessions/$(date +%Y/%m/%d) | head
rg -n 'spawn_agent|wait_agent|fork_context|function_call_output|task_complete' \
  ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl
```

Then include the relevant parent and child transcripts in the collected artifact:

```bash
npm run gui:audit:collect -- \
  --scenario routed-codex \
  --artifact-dir /tmp/codapter-gui-audit \
  --stdio-log /tmp/codapter-stdio.log \
  --debug-log /tmp/codapter.jsonl \
  --session-log ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-<parent>.jsonl \
  --session-log ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-<child>.jsonl
```

Those transcripts are the fastest way to distinguish:

1. model-planning variance,
2. backend child-session failure,
3. adapter/client rendering failure.

Use the transcript summaries to compare:

1. the actual `spawn_agent` arguments selected by the parent (`agent_type`, `fork_context`, `model`, `reasoning_effort`, `message`),
2. the `wait_agent` ids and returned completion payload,
3. whether the child transcript reached a final answer and `task_complete`,
4. whether the child transcript stalled immediately after a tool `function_call_output`.

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

### S8. Open active child thread while it is still running

Steps:

1. Spawn one child that runs a deliberately slow command such as `sleep 8 && date`.
2. While the child is still shown as running, expand the parent’s child list.
3. Open the child from the sidebar or the parent’s background-agent panel before it completes.

Expected:

1. The child thread shows exactly one copy of the child input prompt.
2. The child thread remains `active` and continues streaming to completion.
3. Returning to the parent preserves the parent-only collab summary items.
4. Reopening the child after completion does not introduce a second copy of that same prompt.

## Codex Baseline Suite

Run with `./scripts/codex.sh`.

### C1. Native baseline capture

Run `S1` through `S5` first on native Codex before comparing routed Codex behavior.

Expected:

1. This produces the behavioral baseline for routed Codex.
2. The relevant stdio lines are present in `/tmp/codapter-codex-stdio.log`.
3. The run is collected into a baseline artifact directory under `/tmp/codapter-gui-audit`.

### C2. Native sub-agent lifecycle

Prompt:

```text
Spawn a sub-agent to read `README.md` and report the first heading. After it finishes, summarize the result.
```

Expected:

1. A child thread appears in the GUI.
2. The parent shows the collab tool-call item rather than raw tool spam.
3. Opening the child shows a generated task title on the left and the colored agent nickname on the right.
4. The child produces an answer in its own thread.
5. Returning to the parent shows the summary after the child completes.

Then validate:

1. send follow-up input to the child,
2. wait on the child,
3. close the child,
4. resume the child if supported by the backend state.

## Routed Codex Suite

Run with `./scripts/codapter.sh` and select a raw Codex model.

### RC1. Parity against native baseline

Run `S1` through `S8`.

Expected:

1. The visible GUI behavior matches native Codex for the same prompt sequence.
2. Any remaining differences are explainable adapter metadata differences, not rendering regressions.
3. No `codex::` prefix leaks into model labels, hover text, or collab payloads.

### RC2. Routed native Codex sub-agent lifecycle

Prompt:

```text
Spawn one sub-agent using model gpt-5.4-mini. Have the child run `date` and report the result. Then wait for the child and summarize the result in the parent.
```

Expected:

1. The child appears nested under the parent in the sidebar.
2. The child label uses the nickname, not the backend handle.
3. Opening the child shows a generated task title on the left and the colored agent nickname on the right.
4. Opening the child shows the child prompt and child result only.
5. The parent keeps the `Spawning 1 agent`, `Created <nickname>`, and completion summary items.

### RC3. Routed child follow-up lifecycle

Steps:

1. Open the child from `RC2`.
2. Send a follow-up prompt:

```text
Run `pwd` and report the output.
```

Expected:

1. The child thread shows the follow-up user prompt.
2. The child renders the command item and final answer once.
3. Reopening the child does not duplicate the earlier turn.
4. The parent receives a visible child-result summary after the follow-up completes.

### RC4. Open routed Codex child while active

Run `S8` with a raw Codex child model.

Expected:

1. Opening the active child does not duplicate the child input.
2. The child keeps streaming after the tab switch.
3. The child completes without wedging the parent or the rest of the app.

## Routed Pi Suite

Run with `./scripts/codapter.sh` and select `pi / Claude Opus 4.6`.

### RP1. Routed Pi baseline

Run `S1` through `S8`.

Expected:

1. The routed Pi thread behaves consistently with existing Pi expectations.
2. No duplicate initial user message appears.
3. Follow-up turns send after a completed turn.

### RP2. Pi sub-agent lifecycle

Prompt:

```text
Spawn one sub-agent using model pi::anthropic/claude-opus-4-6. Have the child run `date` and report the exact output. Then wait for the child and summarize the result.
```

Expected:

1. The child appears nested under the parent.
2. The child does not show raw JSON tool payloads.
3. Reopening the child preserves a single rendered transcript.
4. The parent shows a visible child-result summary.

### RP3. Cross-backend Pi parent to Codex child

Prompt:

```text
Spawn one sub-agent using model gpt-5.4-mini. Have the child run `pwd` and report the output. Then wait for the child and summarize the result.
```

Expected:

1. The Pi parent can create a Codex child.
2. The child thread shows the Codex-native model label.
3. The parent and child transcripts stay separated.
4. No raw serialized tool payloads leak into the child transcript.

### RP4. Open routed Pi child while active

Run `S8` with a Pi child.

Expected:

1. Opening the active child does not duplicate the child prompt.
2. The child thread stays active and finishes normally.
3. Reopening after completion still shows one copy of the child prompt and one rendered result.

## Comparison Checklist

When native Codex and routed runs differ, inspect these in order:

1. normalized `summary.json` diff from `gui:audit:compare`,
2. raw stdio transport difference,
3. routed `/tmp/codapter.jsonl` app-server notification difference,
4. current DOM snapshot from MCP,
5. screenshot if layout or duplicate rendering is involved.

If the mismatch is GUI-visible, add or tighten a smoke or unit test that asserts the client-facing payload semantics directly.
