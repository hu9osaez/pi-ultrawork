---
name: ultrawork
description: Persistent multi-turn work mode for pi, triggered by saying "ultrawork" or "ulw" in a message, with a visible status indicator, capped hidden auto-continuation, and background multi-agent fan-out via ulw_dispatch. Applies automatically once triggered; use ulw_complete to end it and /ulw status to check on it.
---

# UltraWork

UltraWork tracks one persistent goal per session (thread) and keeps it visible in the pi status bar for as long as it is running.

## Starting

Say `ultrawork` or `ulw` (as a whole word) anywhere in a message. No command needed — the message that contains the trigger word becomes the goal, and UltraWork mode starts immediately for that turn. Saying the trigger word again while already running is a harmless no-op refresh; it does not reset progress or restart the run.

## Ending

UltraWork ends one of three ways:

- **You finish the goal.** Call the `ulw_complete` tool. This is **mandatory** the moment the goal is genuinely achieved — do not just stop responding or declare victory in prose alone. `ulw_complete` accepts an optional short `summary` string.
- **The stuck cap is hit.** If two hidden auto-continuation attempts in a row produce no forward progress (no `ulw_dispatch` call in between), the run is marked `stuck` and auto-continuation stops. Say `ultrawork` again to restart.
- **The user stops it.** `/ulw stop` is a manual safety valve — use it if the user wants to bail out early, since `ulw_dispatch` spawns real child `pi` processes that cost real API tokens.

## Commands

- `/ulw` or `/ulw status` — show the current run (goal, status, elapsed time, dispatch count).
- `/ulw stop` — stop the run manually. Auto-continuation stops immediately.

There is no `start`/`resume` command — those are automatic via the trigger word.

## Status Indicator

While a run exists, its state is always visible in the footer:

- `● UltraWork running — <goal> (started Nm ago)`
- `UltraWork complete — <goal>`
- `UltraWork stopped (say "ultrawork" to resume)`
- `UltraWork stuck after 2 idle retries — say "ultrawork" again to restart`

## Auto-Continuation

While status is `running`, pi queues a hidden follow-up prompt once each turn settles (no pending retry, compaction, or queued follow-up left) nudging the agent to keep making progress on the goal. Each queued attempt counts against a cap of 2 unproductive attempts; a completed `ulw_dispatch` call resets the counter, since that is observable forward progress. Once the cap would be exceeded, the run is marked `stuck` instead of queueing again, and the user is notified once.

## Mid-run Steering (`/ulw-steer`)

The user can correct course mid-run with `/ulw-steer <text>`. When you receive a steer, treat it as **authoritative user guidance** — it can correct, clarify, or override the original goal wording. If a steer contradicts the goal, prefer the steer.

Steers arrive in two forms:

- An **in-stream steer** (`<steer>…</steer>` block) — delivered mid-turn via pi's native steer pipeline. Apply it to the work you are doing right now.
- A **continuation steer** (prefixed "The user injected mid-run steering instruction(s) below…") — delivered at the start of an auto-continuation turn alongside the goal.

Both are deliberate user actions and bypass the stuck-detector cap — the user inserting guidance is forward progress, not an idle retry. Do not argue with steers, do not ask for clarification unless they are genuinely ambiguous, and do not silently ignore them in favor of the original goal.

### How the user triggers a steer

- **Type free text while you are running** — pi shows a single-keypress modal:
  - `s` — steer mid-stream (delivered before your next LLM call)
  - `q` — queue for the next idle continuation
  - `d` — discard
  - `e` / Esc — keep typing/editing
- **`/ulw-steer <text>`** — bypasses the modal, always steers mid-stream when you are running (or kicks an idle continuation if you are idle).
- **`/ulw-steer`** (bare) — list pending queued steers.
- **`/ulw-steer clear`** — empty the queue.

The modal only appears in interactive (TUI) mode while a run is active; headless and RPC modes pass input through unchanged.

## ulw_dispatch Tool

Call `ulw_dispatch` to fan independent sub-tasks out to background `pi` child processes instead of doing everything serially:

```ts
ulw_dispatch({
	tasks: [
		{ task: "Investigate X in packages/a" },
		{ task: "Investigate Y in packages/b" },
	],
	concurrency: 3, // optional, default 3, max 6
});
```

Set `sequential: true` to run tasks one at a time instead of in parallel. Results (per-task output, exit code, errors) are returned and folded into the run's dispatch count. Only dispatch tasks that are genuinely independent — sub-tasks that need to see each other's output should stay in your own sequential reasoning instead.

## ulw_complete Tool

Call `ulw_complete` once the UltraWork goal is genuinely achieved:

```ts
ulw_complete({ summary: "Shipped the release, all tests green" }); // summary is optional
```

This is the only way UltraWork mode ends on success. It transitions the run to `complete`, updates the status indicator, and disarms auto-continuation — no further hidden follow-up prompts are queued for this run.
