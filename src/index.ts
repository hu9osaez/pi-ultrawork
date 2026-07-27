import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import {
	parseSteerCommand,
	parseUltraworkCommand,
	STEER_USAGE,
	ULW_USAGE,
} from "./ultrawork/command.js";
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
	buildReinjectDirective,
	buildSteerPrompt,
	buildUltraworkDirective,
} from "./ultrawork/prompt.js";
import {
	SteerChoiceComponent,
	type SteerChoice,
} from "./ultrawork/steer-component.js";
import {
	addSteer,
	completeRun,
	consumePendingReinject,
	consumeSteers,
	isAlwaysOn,
	isTriggerDisabled,
	markRunStuck,
	readRun,
	recordAutoContinueAttempt,
	recordDispatch,
	setAlwaysOn,
	setPendingReinject,
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
const ULTRAWORK_STEER_MESSAGE_TYPE = "pi-ultrawork-steer";

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
					case "always-on": {
						// Every prompt now starts/refreshes a run. Clears triggerDisabled by mutex.
						await setAlwaysOn(ref, true);
						ctx.ui.notify(
							'UltraWork always-on — every message now runs in UltraWork mode. Say "/ulw always off" to revert.',
							"info",
						);
						return;
					}
					case "always-off": {
						// Stop auto-triggering every prompt. Does NOT stop an in-flight run
						// (that is what /ulw stop is for).
						await setAlwaysOn(ref, false);
						ctx.ui.notify(
							'UltraWork always-on disabled — only messages containing "ultrawork"/"ulw" trigger the mode again.',
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

	pi.registerCommand("ulw-steer", {
		description:
			"Inject a mid-run instruction into the active UltraWork run (applied ASAP). Bare lists pending steers; 'clear' empties the queue.",
		handler: async (rawArgs, ctx) => {
			const command = parseSteerCommand(rawArgs);
			const ref = ultraworkStoreRef(ctx);
			try {
				switch (command.kind) {
					case "list": {
						const run = await readRun(ref);
						const steers = run?.pendingSteers ?? [];
						ctx.ui.notify(
							steers.length === 0
								? `No pending steers.\n${STEER_USAGE}`
								: `Pending steers (${steers.length}):\n${steers.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
							"info",
						);
						return;
					}
					case "clear": {
						const cleared = await consumeSteers(ref);
						ctx.ui.notify(
							cleared.length > 0
								? `Cleared ${cleared.length} pending steer(s).`
								: "No pending steers to clear.",
							"info",
						);
						return;
					}
					case "add": {
						const updated = await addSteer(ref, command.text);
						if (updated === null || updated.status !== "running") {
							ctx.ui.notify(
								"No running UltraWork run to steer. Start one first, then /ulw-steer <text>.",
								"warning",
							);
							return;
						}
					// Mid-stream injection vs idle continuation. Two delivery paths:
					//   • In-progress (the common steer case): send via pi's native
					//     `deliverAs: "steer"` so the text lands after the current
					//     turn's tool calls, before the next LLM call. This is the
					//     first principle from @agnishc/edb-agent-steer — pi already
					//     has a mid-stream steering primitive; use it. The disk
					//     queue is cleared so the steer lands exactly once.
					//   • Idle: no in-progress turn to interrupt, so kick a hidden
					//     continuation turn now and let `advanceOrStallUltrawork`
					//     drain the steer into `buildContinuationPrompt`. This path
					//     works reliably now that BUG A is fixed (steers drain
					//     before the stuck-cap check).
					if (ctx.isIdle()) {
						await advanceOrStallUltrawork(pi, ctx, ref, updated, {
							userInitiated: true,
						});
						ctx.ui.notify("Steer applied now.", "info");
					} else {
						pi.sendMessage(
							{
								customType: ULTRAWORK_STEER_MESSAGE_TYPE,
								content: buildSteerPrompt(command.text),
								display: true,
							},
							{ deliverAs: "steer" },
						);
						await consumeSteers(ref);
						ctx.ui.notify(
							"Steer applied now (in-stream) — lands before the next LLM call.",
							"info",
						);
					}
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	// Mid-run steer interceptor. When the user types free text (not a slash
	// command) while an UltraWork run is actively streaming, surface a
	// single-keypress modal so they can pick how the message is delivered:
	//
	//   s — steer: deliver via pi's native `deliverAs: "steer"` so the text
	//             lands after the current turn's tool calls, before the next
	//             LLM call. This is the first principle from
	//             @agnishc/edb-agent-steer — pi already has a mid-stream
	//             steering primitive; use it instead of waiting for idle.
	//   q — queue: append to the disk queue (existing path). Drains into the
	//             next auto-continuation via advanceOrStallUltrawork.
	//   d — discard: drop the message.
	//   e — edit: pass the input through unchanged so the user can keep typing.
	//
	// Slash commands bypass this entirely (pi checks commands first per the
	// input-event processing order). Re-injected messages from our own
	// `pi.sendMessage` carry `source: "extension"` and are skipped explicitly.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = event.text ?? "";
		if (text.trim() === "" || text.startsWith("/")) {
			return { action: "continue" };
		}
		// `ctx.ui.custom` is only safe in TUI mode (per docs/extensions.md).
		// Headless modes (`print`, `json`) have no UI surface for a modal, and
		// `rpc` calls must not block on user input mid-event.
		if (ctx.mode !== "tui") return { action: "continue" };
		// Nothing to steer if the run is idle or absent: let the input reach
		// the agent as a normal turn (it might itself be an `ultrawork` trigger).
		if (ctx.isIdle()) return { action: "continue" };

		const ref = ultraworkStoreRef(ctx);
		const run = await readRun(ref);
		if (run === null || run.status !== "running") {
			return { action: "continue" };
		}

		let choice: SteerChoice | null = null;
		try {
			choice = await ctx.ui.custom<SteerChoice | null>((_, _theme, _kb, done) =>
				new SteerChoiceComponent(text, (c) => done(c as SteerChoice)),
			);
		} catch {
			// Stale ctx during teardown, or user dismissed the modal via Ctrl+C —
			// pass the input through so the editor keeps the original text.
			choice = null;
		}
		choice ??= "edit";

		if (choice === "edit") return { action: "continue" };
		if (choice === "discard") {
			ctx.ui.notify("Steer input discarded.", "info");
			return { action: "handled" };
		}
		if (choice === "queue") {
			const updated = await addSteer(ref, text);
			const queued = updated?.pendingSteers?.length ?? 0;
			ctx.ui.notify(
				`Steer queued (${queued} pending) — applies on the next continuation.`,
				"info",
			);
			return { action: "handled" };
		}
		// choice === "steer": send mid-stream via pi's native steer primitive.
		pi.sendMessage(
			{
				customType: ULTRAWORK_STEER_MESSAGE_TYPE,
				content: buildSteerPrompt(text),
				display: true,
			},
			{ deliverAs: "steer" },
		);
		// Drain anything else that landed on the disk queue so this steer and
		// any earlier queued notes are not double-delivered on the next settle.
		await consumeSteers(ref);
		ctx.ui.notify(
			"Steer applied now (in-stream) — lands before the next LLM call.",
			"info",
		);
		return { action: "handled" };
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
		const ref = ultraworkStoreRef(ctx);
		try {
			const keywordMatch = ULTRAWORK_TRIGGER_PATTERN.test(event.prompt);
			// Kill switch (`/ulw off`) mutes the keyword; always-on (`/ulw always on`)
			// turns EVERY prompt into an UltraWork turn. They are mutually exclusive.
			const triggerDisabled = await isTriggerDisabled(ref);
			const alwaysOn = await isAlwaysOn(ref);
			const shouldTrigger = (keywordMatch && !triggerDisabled) || alwaysOn;

			if (shouldTrigger) {
				const { run, fresh } = await triggerRun(ref, event.prompt);
				updateUltraworkUiBestEffort(ctx, run);
				if (fresh) {
					// Visible (unlike the hidden continuation nudges below): the user asked
					// to actually see what gets injected when UltraWork triggers.
					return {
						message: {
							customType: ULTRAWORK_DIRECTIVE_MESSAGE_TYPE,
							content: buildUltraworkDirective(run),
							display: true,
						},
					};
				}
			}

			// Post-compaction bridge: session_compact can't inject on its own, so it
			// flags the run and we restore the mode framing here — even when this prompt
			// carried no keyword — then clear the flag so it fires exactly once.
			const current = await readRun(ref);
			if (
				current?.status === "running" &&
				(await consumePendingReinject(ref))
			) {
				updateUltraworkUiBestEffort(ctx, current);
				return {
					message: {
						customType: ULTRAWORK_DIRECTIVE_MESSAGE_TYPE,
						content: buildReinjectDirective(current),
						display: true,
					},
				};
			}

			return;
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
	});

	// Post-compaction bridge (Feature A): the `session_compact` event fires after a
	// compaction rewrites context, which can strip the UltraWork framing. Its
	// handler returns void so it cannot inject a message itself — instead it flags
	// the running run, and the next `before_agent_start` re-injects the directive.
	pi.on("session_compact", async (_event, ctx) => {
		const ref = ultraworkStoreRef(ctx);
		const run = await readRun(ref);
		if (run?.status === "running") {
			await setPendingReinject(ref);
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
		opts?: { userInitiated?: boolean },
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

		// Drain any mid-run steers (`/ulw-steer <text>`) FIRST. Steers are
		// deliberate forward progress from the user and must be honored even
		// when the auto-continue cap would otherwise block. They ride this exact
		// continuation turn once, then are cleared.
		const steers = await consumeSteers(ref);

		// When steers are present, they count as user-initiated progress and
		// bypass the stuck cap. The presence of steers also means we do NOT
		// increment the auto-continue counter for this turn.
		const hasSteers = steers.length > 0;
		const isUserInitiated = opts?.userInitiated || hasSteers;

		// The stuck cap only blocks idle auto-continuation attempts, not
		// user-initiated steers or continuation triggered by a steer.
		if (!isUserInitiated && hasReachedAutoContinueCap(run)) {
			const stuckRun = await markRunStuck(ref);
			if (stuckRun) updateUltraworkUiBestEffort(ctx, stuckRun);
			ctx.ui.notify(
				`UltraWork stuck after ${AUTO_CONTINUE_CAP} idle retries — say "ultrawork" again to restart`,
				"warning",
			);
			return;
		}

		const updated = isUserInitiated
			? run
			: ((await recordAutoContinueAttempt(ref)) ?? run);
		// When the continuation carries steers, show it so the user sees exactly what
		// mid-run instruction the agent received and when it was applied.
		queueHiddenUltraworkPrompt(
			pi,
			buildContinuationPrompt(updated, steers),
			hasSteers,
		);
	}
}

function queueHiddenUltraworkPrompt(
	pi: ExtensionAPI,
	content: string,
	display = false,
): void {
	pi.sendMessage(
		{
			customType: ULTRAWORK_CONTINUATION_MESSAGE_TYPE,
			content,
			display,
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
