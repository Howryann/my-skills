---
name: subagent
description: Spawn and coordinate a Pi subagent in Herdr, observe its work, wait for completion, and collect the authoritative assistant result from its Pi JSONL session. Use for independent reviews, parallel analysis, or delegated repository work when the user asks for a subagent or Herdr delegation.
compatibility: Requires HERDR_ENV=1, Herdr with the Pi integration, Node.js >=22.19, and @earendil-works/pi-coding-agent available from this package.
---

# Subagent

Run each subagent as a named Pi agent in a dedicated Herdr tab with a dedicated run directory. The run directory owns `prompt.md` and `session.jsonl`; Herdr owns the terminal lifecycle, and `wait.ts` reads the session so terminal truncation cannot change the result.

## Preconditions

Verify that the caller is inside Herdr:

```bash
test "${HERDR_ENV:-}" = 1
```

If this fails, stop. Do not control another Herdr session from outside Herdr.

Use the installed CLI as the syntax authority:

```bash
herdr agent
herdr tab
```

## Spawn

Choose a short, unique agent name. Default to a new background tab in the current workspace and the current working directory. Do not create a workspace, worktree, or different cwd unless the user explicitly requests it. Use a sibling pane only when the user explicitly asks for one.

Create a private run directory:

```bash
mktemp -d
```

Read the returned path as `<run-dir>`. Use the `write` tool to put the complete task in `<run-dir>/prompt.md`, then create the exact session path before launch:

```bash
touch "<run-dir>/session.jsonl"
```

Do not construct the task with `echo`, interpolation, or a quoted shell command.

Create and label the tab without changing focus:

```bash
herdr tab create \
  --workspace "$HERDR_WORKSPACE_ID" \
  --cwd "$PWD" \
  --label "subagent:<name>" \
  --no-focus
```

Read `<tab-id>` from `.result.tab.tab_id` and `<pane-id>` from `.result.root_pane.pane_id`. Start Pi in that root pane with the caller's model settings:

```bash
herdr agent start <name> --kind pi --pane <pane-id> -- \
  --session "<run-dir>/session.jsonl" \
  --provider "$PI_PROVIDER" \
  --model "$PI_MODEL" \
  --thinking "$PI_REASONING_LEVEL"
```

Require `.result.agent.agent_session.kind` to be `path` and verify that `.result.agent.agent_session.value` resolves to `<run-dir>/session.jsonl`. Keep the tab and stop if it does not match; never collect from a predicted or different session path.

## Run

Submit the prompt file as one argument. The outer double quotes prevent its contents from being reinterpreted by the shell:

```bash
herdr agent prompt <name> "$(<"<run-dir>/prompt.md")" --wait --timeout 1800000
```

The settled defaults are `idle`, `done`, or `blocked`. If the command times out, the child keeps running: inspect it and wait again without resending the task.

```bash
herdr agent get <name>
herdr agent read <name> --source visible --lines 80
herdr agent wait <name> --timeout 1800000
```

If the state is `blocked`, read the TUI before answering or sending keys. Do not treat `unknown` as completion.

For concurrent work, omit `--wait`, continue independent parent work, then run `agent wait` before collecting. Herdr does not asynchronously wake the parent after the parent turn has ended.

## Collect

After Herdr reports `idle` or `done`, resolve this skill's directory and run:

```bash
node "<skill-dir>/wait.ts" "<run-dir>/session.jsonl" --timeout 30
```

The script follows the active JSONL branch and waits until its latest message is an assistant message whose `stopReason` is neither `pending` nor `toolUse`. It prints the complete session message entry as JSON.

Inspect `.message.stopReason` before using the content: `stop` is the normal successful result, `length` may be truncated, and `error` or `aborted` is a settled failure rather than a successful answer. The script still exits successfully for those terminal failure entries so their diagnostics remain available.

Use `--count <n>` to collect multiple latest assistant entries. With the default count of one, output is one JSON object; with a larger count, output is an oldest-to-newest JSON array.

```text
--count <n>           Latest assistant entries to print (default: 1)
--timeout <seconds>   Maximum wait (default: 1800)
--poll <milliseconds> Poll interval (default: 500)
```

Set the bash-tool timeout longer than `--timeout`. A nonzero exit means the session could not be read, was structurally invalid, or did not settle before the deadline. A timeout never cancels the child.

Use `agent read` only for progress and diagnosis. Do not infer the final answer from terminal text when the JSONL result is available.

## Cleanup

After collecting the result, close only the tab created by this skill unless the user asked to keep it:

```bash
herdr tab close <tab-id>
```

After the tab is closed, remove the run directory only when the transcript is no longer needed:

```bash
rm -rf "<run-dir>"
```

Keeping the tab also requires keeping the run directory because the live Pi process still owns `session.jsonl`. If collection fails, the task remains blocked, or review is still needed, keep both and report the agent name, tab ID, pane ID, and run directory.
