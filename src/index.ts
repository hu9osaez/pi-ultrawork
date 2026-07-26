import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { parseUltraworkCommand, ULW_USAGE } from "./ultrawork/command.js";
import {
	AUTO_CONTINUE_CAP,
	hasReachedAutoContinueCap,
	shouldQueueContinuationOnSettle,
	shouldQueueContinuationWhenIdle,
} from "./ultrawork/continuation.js";
import {
	DispatchParams,
	type DispatchDetails,
	runDispatch,
	summarizeDispatchResults,
} from "./ultrawork/dispatch.js";
import { formatRunForUser, ultraworkStatusLabel } from "./ultrawork/format.js";
import {
	buildContinuationPrompt,
	buildUltraworkDirective,
} from "./ultrawork/prompt.js";
import {
	completeRun,
	isTriggerDisabled,
	markRunStuck,
	readRun,
	recordAutoContinueAttempt,
	recordDispatch,
	setTriggerDisabled,
	stopRun,
	triggerRun,
	ultraworkStoreRef,
} from "./ultrawork/store.js";
import type { UltraWorkRun, UltraWorkStoreRef } from "./ultrawork/types.js";
import {
	dispatchStatusText,
	STATUS_KEY,
	updateUltraworkUi,
} from "./ultrawork/ui.js";

const ULTRAWORK_CONTINUATION_MESSAGE_TYPE = "pi-ultrawork-continuation";
const ULTRAWORK_DIRECTIVE_MESSAGE_TYPE = "pi-ultrawork-directive";

/** Whole-word match for `ultrawork`/`ulw` anywhere in the prompt, case-insensitive. */
const ULTRAWORK_TRIGGER_PATTERN = /\b(?:ultrawork|ulw)\b/i;

const CompleteParams = Type.Object(
	{
		summary: Type.Optional(
			Type.String({
				description: "Short summary of how the UltraWork goal was achieved.",
			}),
		),
	},
	{ additionalProperties: false },
);
type CompleteParamsType = Static<typeof CompleteParams>;
type CompleteDetails = { run: UltraWorkRun | null };

/**
 * UltraWork is a pi.dev extension that provides a persistent, background multi-agent orchestration mode: saying `ultrawork`/`ulw` in a prompt activates a long-running goal-directed run that survives across turns, surfacing its state through a TUI status indicator, driving the agent forward with capped hidden auto-continuation nudges while idle, and exposing a `ulw_dispatch` tool that fans independent sub-tasks out to background child `pi` processes and folds their results back into the run.
 */
export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ulw_dispatch",
		label: "UltraWork Dispatch",
		description: [
			"Fan independent sub-tasks out to background `pi` child processes and fold the results back into the current UltraWork run.",
			"Use while UltraWork is running, for sub-tasks that can genuinely proceed in isolation (separate files, separate research threads) instead of doing everything yourself one step at a time.",
			"Runs in parallel with a concurrency cap by default; set sequential: true to run tasks one at a time instead.",
		].join(" "),
		parameters: DispatchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Announce the launch immediately so the user isn't blind at t=0 while the
			// child pi processes spin up.
			if (ctx.hasUI) {
				const count = params.tasks.length;
				ctx.ui.notify(
					`ulw_dispatch: launching ${count} sub-task${count === 1 ? "" : "s"}…`,
					"info",
				);
			}

			// Mirror each incremental dispatch update onto the always-visible footer
			// status, so progress (launched → running → done) shows live instead of only
			// appearing once the whole tool call returns.
			let showedDispatchStatus = false;
			const onDispatchUpdate = (
				partial: AgentToolResult<DispatchDetails>,
			): void => {
				onUpdate?.(partial);
				if (!ctx.hasUI) return;
				const taskResults = partial.details?.results ?? [];
				const total = taskResults.length;
				const done = taskResults.filter((r) => r.exitCode !== -1).length;
				const running = taskResults.filter(
					(r) => r.started === true && r.exitCode === -1,
				).length;
				ctx.ui.setStatus(
					STATUS_KEY,
					dispatchStatusText({ total, done, running }),
				);
				showedDispatchStatus = true;
			};

			const { results, summary } = await runDispatch(
				ctx,
				params,
				signal,
				onDispatchUpdate,
			);
			const run = await recordDispatch(ultraworkStoreRef(ctx), summary);
			// Restore the normal run status now that the dispatch footer is stale. If
			// there's no run to restore to, only clear the footer if we actually showed
			// a live dispatch status (otherwise leave it untouched).
			if (run) {
				updateUltraworkUi(ctx, run);
			} else if (showedDispatchStatus && ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}

			const response: AgentToolResult<DispatchDetails> = {
				content: [{ type: "text", text: summarizeDispatchResults(results) }],
				details: { results },
			};
			return response;
		},
	});

	pi.registerTool({
		name: "ulw_complete",
		label: "UltraWork Complete",
		description: [
			"Signal that the active UltraWork goal has been genuinely achieved.",
			"Call this exactly once real work is done and verified — it ends UltraWork mode and stops the hidden auto-continuation loop.",
			"Do not call it speculatively or before the goal is actually met.",
		].join(" "),
		parameters: CompleteParams,
		async execute(
			_toolCallId,
			params: CompleteParamsType,
			_signal,
			_onUpdate,
			ctx,
		) {
			const ref = ultraworkStoreRef(ctx);
			try {
				const run = await completeRun(ref, params.summary);
				updateUltraworkUi(ctx, run);
				const text = params.summary
					? `UltraWork complete: ${run.goal}\n${params.summary}`
					: `UltraWork complete: ${run.goal}`;
				const response: AgentToolResult<CompleteDetails> = {
					content: [{ type: "text", text }],
					details: { run },
				};
				return response;
			} catch (error) {
				const response: AgentToolResult<CompleteDetails> = {
					content: [
						{ type: "text", text: `ulw_complete: ${errorMessage(error)}` },
					],
					details: { run: null },
				};
				return response;
			}
		},
	});

	pi.registerCommand("ulw", {
		description:
			'Check or stop the persistent UltraWork run (say "ultrawork" in a message to start or resume it)',
		handler: async (rawArgs, ctx) => {
			const command = parseUltraworkCommand(rawArgs);
			const ref = ultraworkStoreRef(ctx);
			try {
				switch (command.kind) {
					case "status": {
						const run = await readRun(ref);
						updateUltraworkUi(ctx, run);
						ctx.ui.notify(formatRunForUser(run), run ? "info" : "warning");
						return;
					}
					case "stop": {
						const run = await stopRun(ref);
						updateUltraworkUi(ctx, run);
						ctx.ui.notify(
							`UltraWork ${ultraworkStatusLabel(run.status)}\n${formatRunForUser(run)}`,
							"info",
						);
						return;
					}
					case "off": {
						// Mute the keyword trigger, and quiet any run that's live right now so
						// the current session stops auto-continuing too.
						await setTriggerDisabled(ref, true);
						const current = await readRun(ref);
						const run =
							current?.status === "running" ? await stopRun(ref) : current;
						updateUltraworkUi(ctx, run);
						ctx.ui.notify(
							'UltraWork trigger disabled — "ultrawork"/"ulw" will not activate the mode. Say "/ulw on" to re-enable.',
							"info",
						);
						return;
					}
					case "on": {
						await setTriggerDisabled(ref, false);
						updateUltraworkUi(ctx, await readRun(ref));
						ctx.ui.notify(
							'UltraWork trigger enabled — say "ultrawork" or "ulw" in a message to start it.',
							"info",
						);
						return;
					}
					case "unknown": {
						ctx.ui.notify(
							`Unknown /ulw subcommand: "${command.input}"\n${ULW_USAGE}`,
							"warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	// Keyword trigger: detect "ultrawork"/"ulw" in the raw prompt text of a
	// real (interactive) turn and start or re-engage UltraWork mode. Re-triggering
	// while already running is a safe no-op refresh handled entirely by
	// triggerRun — never a destructive reset.
	//
	// Note: our own hidden auto-continuation follow-ups (queued below via
	// queueHiddenUltraworkPrompt / pi.sendMessage with triggerTurn+followUp) are
	// delivered through AgentSession's low-level follow-up path in the current
	// pi-coding-agent runtime and do NOT re-emit before_agent_start — this
	// handler is not actually re-invoked for them, even though their text also
	// matches the trigger pattern. So this is not a verified safety net against
	// our own continuation messages; it only covers real user-authored turns.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ULTRAWORK_TRIGGER_PATTERN.test(event.prompt)) return;

		const ref = ultraworkStoreRef(ctx);
		try {
			// Kill switch: when the user has run `/ulw off`, the keyword no longer
			// activates the mode, so they can type "ultrawork"/"ulw" freely (e.g. while
			// developing this extension) until they re-arm it with `/ulw on`.
			if (await isTriggerDisabled(ref)) return;

			const { run, fresh } = await triggerRun(ref, event.prompt);
			updateUltraworkUiBestEffort(ctx, run);
			if (!fresh) return;

			// Visible (unlike the hidden continuation nudges below): the user asked to
			// actually see what gets injected when UltraWork triggers, not just infer
			// it from the footer badge.
			return {
				message: {
					customType: ULTRAWORK_DIRECTIVE_MESSAGE_TYPE,
					content: buildUltraworkDirective(run),
					display: true,
				},
			};
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const ref = ultraworkStoreRef(ctx);
		const run = await readRun(ref);
		updateUltraworkUi(ctx, run);
		if (
			shouldQueueContinuationWhenIdle(
				run,
				ctx.isIdle(),
				ctx.hasPendingMessages(),
			)
		) {
			await advanceOrStallUltrawork(pi, ctx, ref, run);
		}
	});

	// Refresh the footer at the start of each turn too, so "started Nm ago" stays
	// current even across long idle-free sessions with no other status update.
	pi.on("agent_start", async (_event, ctx) => {
		const run = await readRun(ultraworkStoreRef(ctx));
		updateUltraworkUiBestEffort(ctx, run);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const run = await readRun(ultraworkStoreRef(ctx));
		updateUltraworkUiBestEffort(ctx, run);
	});

	// agent_settled (not agent_end) is pi's own recommended hook for "should I
	// queue more work" decisions: it only fires once pi will not auto-retry,
	// auto-compact, or continue with a queued follow-up on its own.
	pi.on("agent_settled", async (_event, ctx) => {
		const ref = ultraworkStoreRef(ctx);
		const run = await readRun(ref);
		if (shouldQueueContinuationOnSettle(run, ctx.hasPendingMessages())) {
			await advanceOrStallUltrawork(pi, ctx, ref, run);
		}
	});

	// Best-effort: clear this (soon-to-be-defunct) context's footer status so a
	// stale "UltraWork running…" line can't linger past teardown. Whatever
	// context replaces this one sets its own status on its next session_start.
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// ctx may already be stale during teardown; nothing to clean up in that case.
		}
	});

	/**
	 * Queue the next hidden auto-continuation prompt, or — once the stuck-detector
	 * cap would be exceeded — give up: mark the run stuck and notify the user once
	 * instead of looping silently forever.
	 */
	async function advanceOrStallUltrawork(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		ref: UltraWorkStoreRef,
		run: UltraWorkRun,
	): Promise<void> {
		// Headless modes (`-p` print, `--mode json`) have no UI and are typically
		// single-shot: the process exits right after settling, so queuing a hidden
		// follow-up turn here races the runtime's own teardown and surfaces as a
		// harmless-but-noisy "stale ctx" extension error (pi logs it and moves on,
		// per docs/extensions.md's "Extension errors are logged, agent continues" —
		// this isn't a crash, just noise). Nothing is watching for continued
		// progress without a UI anyway, so skip it. Matches `ctx.hasUI`, the same
		// check ui.ts already uses before touching the status bar. Verified against
		// docs/extensions.md's Mode Behavior table: only "tui" and "rpc" have
		// ctx.hasUI === true; "json" and "print" are both headless.
		if (!ctx.hasUI) return;

		if (hasReachedAutoContinueCap(run)) {
			const stuckRun = await markRunStuck(ref);
			if (stuckRun) updateUltraworkUiBestEffort(ctx, stuckRun);
			ctx.ui.notify(
				`UltraWork stuck after ${AUTO_CONTINUE_CAP} idle retries — say "ultrawork" again to restart`,
				"warning",
			);
			return;
		}

		const updated = await recordAutoContinueAttempt(ref);
		queueHiddenUltraworkPrompt(pi, buildContinuationPrompt(updated ?? run));
	}
}

function queueHiddenUltraworkPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{
			customType: ULTRAWORK_CONTINUATION_MESSAGE_TYPE,
			content,
			display: false,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

const STALE_EXTENSION_CONTEXT_ERROR_PREFIX =
	"This extension ctx is stale after session replacement or reload.";

function updateUltraworkUiBestEffort(
	ctx: ExtensionContext,
	run: UltraWorkRun | null,
): void {
	try {
		updateUltraworkUi(ctx, run);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)
		)
			return;
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
