# UltraWork

A pi.dev extension: a persistent "running" mode triggered by a keyword in your message, that stays visible across turns, with capped hidden auto-continuation and background multi-agent fan-out.

## What it does

- **Trigger** — say `ultrawork` or `ulw` (as a whole word) anywhere in a message to start or re-engage the mode. No command needed.
- **Mode** — one UltraWork run per session, persisted as `running` / `complete` / `stopped` / `stuck`.
- **Status indicator** — always visible in the pi footer while a run exists: `● UltraWork running — <goal> (started Nm ago)`, `UltraWork complete — <goal>`, `UltraWork stopped (say "ultrawork" to resume)`, or `UltraWork stuck after 2 idle retries — say "ultrawork" again to restart`.
- **Auto-continuation** — while running, pi queues a hidden follow-up prompt once each turn settles, nudging the agent to keep making progress. Capped at 2 unproductive attempts (reset by any completed `ulw_dispatch` call) before the run is marked stuck instead of looping forever.
- **`ulw_complete` tool** — the model calls this once the goal is genuinely achieved; it ends the run and disarms auto-continuation.
- **`ulw_dispatch` tool** — spawns child `pi` processes to run sub-tasks in parallel (with a concurrency cap) or sequentially, and folds their results back into the run.
- **`/ulw stop`** — a manual safety valve to bail out early, since `ulw_dispatch` spawns real child processes that cost real API tokens.

## Install / dev-load

```bash
pi -e ./src/index.ts
```

## Usage

```
ultrawork implement dark mode across the settings screens
```

That's it — no command. UltraWork mode starts, keeps working autonomously across turns (fanning out independent sub-tasks via `ulw_dispatch` when useful), and ends when the model calls `ulw_complete`, the stuck cap is hit, or you run `/ulw stop`.

## Commands

```bash
/ulw          # show the current run (same as /ulw status)
/ulw status   # show the current run
/ulw stop     # stop; auto-continuation stops too
```

## Agent Tools

- `ulw_dispatch({ tasks: [{ task, cwd? }], concurrency?, sequential? })` — fan sub-tasks out to background `pi` processes.
- `ulw_complete({ summary? })` — signal the goal is achieved and end the run.

See [SKILL.md](./SKILL.md) for the full model-facing usage guide.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```
