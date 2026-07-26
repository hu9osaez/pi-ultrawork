# UltraWork

A pi.dev extension. Say a keyword, get a persistent **"running" mode**: a goal that survives across turns, a visible footer status, capped hidden auto-continuation, and background multi-agent fan-out.

The idea in one line: **the goal lives on disk, not in the chat context — so the agent keeps pursuing it even after context compaction.**

## What it does

- **Trigger** — say `ultrawork` or `ulw` (as a whole word) anywhere in a message to start or re-engage the mode. No command needed.
- **Persistent goal** — one run per session, stored as a JSON file on disk (`running` / `complete` / `stopped` / `stuck`). Because it lives outside the LLM context, it survives compaction: every turn re-reads the goal and keeps going.
- **Footer status** — always visible while a run exists:
  - `● UltraWork running — <goal…> (started Nm ago)` (goal truncated so it never floods the bar)
  - `UltraWork complete`
  - `UltraWork stopped (say "ultrawork" to resume)`
  - `UltraWork stuck after 2 idle retries — say "ultrawork" again to restart`
- **Auto-continuation** — while running, pi queues a hidden follow-up once each turn settles, nudging the agent forward. Capped at **2** unproductive attempts (reset by any completed `ulw_dispatch`) before the run is marked stuck instead of looping forever.
- **`ulw_dispatch` tool** — fans independent sub-tasks out to child `pi` processes (parallel with a concurrency cap, or sequential) and folds the results back in. A depth-guard (`MAX_DISPATCH_DEPTH = 1`) stops dispatched children from spawning their own children.
- **`ulw_complete` tool** — the model calls this once the goal is genuinely achieved; it ends the run and disarms auto-continuation. It's the only success exit — the agent can't just declare victory in prose.

## Install

UltraWork loads like any pi extension — add it to the `extensions` array in `~/.pi/agent/settings.json`. Three ways, depending on your use case:

```jsonc
// ~/.pi/agent/settings.json
{
  "extensions": [
    "npm:pi-ultrawork",              // 1. published package (for real use)
    "/abs/path/to/pi-ultrawork"      // 2. local checkout (for hacking on it)
  ]
}
```

```bash
# 3. one-off dev load, no settings edit — transpiled on the fly
pi -e ./src/index.ts
```

No build step: pi loads the TypeScript entry (`src/index.ts`) directly. Restart / `reload` pi after editing `settings.json`.

## Usage

```
ultrawork implement dark mode across the settings screens
```

That's it — no command. The mode starts, works autonomously across turns (fanning out independent sub-tasks via `ulw_dispatch` when useful), and ends when the model calls `ulw_complete`, the stuck cap is hit, or you run `/ulw stop`.

## Commands

```bash
/ulw          # show the current run (same as /ulw status)
/ulw status   # show the current run
/ulw stop     # stop the run; auto-continuation stops too
/ulw off      # mute the keyword trigger — "ultrawork"/"ulw" stop activating the mode
/ulw on       # re-arm the keyword trigger
```

`/ulw off` is what you want while **developing this extension** (or any repo where you type "ulw" a lot): it lets you say the trigger words freely without starting a run. The setting persists per session until you `/ulw on`.

## Agent tools

- `ulw_dispatch({ tasks: [{ task, cwd? }], concurrency?, sequential? })` — fan sub-tasks out to background `pi` processes.
- `ulw_complete({ summary? })` — signal the goal is achieved and end the run.

See [SKILL.md](./SKILL.md) for the full model-facing usage guide.

## Publishing

UltraWork ships as an npm package of **TypeScript source** — no build, no `dist/`. pi transpiles `src/index.ts` on load, so the published tarball just needs the source, the docs, and `package.json`.

The `package.json` already declares the two things that matter:

```jsonc
{
  "pi":    { "extensions": ["./src/index.ts"] },  // entry point pi loads
  "files": ["src", "README.md", "SKILL.md"]       // what goes in the tarball
}
```

Steps:

```bash
pnpm test && pnpm typecheck        # 1. green bar before shipping
npm version patch                  # 2. bump (patch | minor | major)
pnpm pack --pack-destination /tmp  # 3. dry-run: inspect the tarball contents
npm publish --access public        # 4. publish (drop --access for a private scope)
```

Then anyone adds it to their `~/.pi/agent/settings.json`:

```jsonc
{ "extensions": ["npm:pi-ultrawork"] }
```

and `reload`. That `npm:<package-name>` form is exactly how pi resolves published extensions — the same mechanism as the built-ins.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
```
