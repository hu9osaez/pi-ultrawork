/**
 * ulw_dispatch: fan sub-tasks out to background `pi` child processes.
 *
 * Adapted from senpi's subagent example (examples/extensions/subagent/index.ts):
 * spawn a `pi --mode json -p --no-session <task>` process per sub-task, parse
 * its NDJSON stdout for message_end events to recover the final assistant
 * text, and run a small worker pool so at most `concurrency` processes are
 * alive at once. UltraWork trims this down to plain text tasks (no named
 * agent configs) since that is all the spec calls for.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
	AgentToolResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { isRecord } from "./types.js";

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 6;
export const MAX_TASKS = 12;
export const PER_TASK_OUTPUT_CAP = 20 * 1024;

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Max nesting depth for ulw_dispatch → child `pi` process hops. Depth 0 is the
 * top-level/interactive session; a process spawned by ulw_dispatch runs at
 * depth 1 and is refused if it tries to dispatch again. This bounds the whole
 * process tree (not just a single call's fan-out, which MAX_TASKS/MAX_CONCURRENCY
 * already cover) so a dispatched child cannot recursively spawn further
 * generations of real, paid-API-call child processes.
 */
export const MAX_DISPATCH_DEPTH = 1;

/** Env var a dispatched child process inherits, recording how many ulw_dispatch hops produced it. */
const DISPATCH_DEPTH_ENV_VAR = "PI_ULTRAWORK_DISPATCH_DEPTH";

/** How many nested ulw_dispatch hops produced the current process (0 = top-level/interactive). */
export function currentDispatchDepth(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[DISPATCH_DEPTH_ENV_VAR];
	if (raw === undefined) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const DispatchTaskSchema = Type.Object({
	task: Type.String({
		description: "The sub-task prompt for the child pi process to work on.",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for this sub-task. Defaults to the current working directory.",
		}),
	),
});

export const DispatchParams = Type.Object(
	{
		tasks: Type.Array(DispatchTaskSchema, {
			description:
				"One or more independent sub-tasks to delegate to background pi processes.",
			minItems: 1,
		}),
		concurrency: Type.Optional(
			Type.Integer({
				description: `Max sub-tasks to run in parallel. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`,
				minimum: 1,
				maximum: MAX_CONCURRENCY,
			}),
		),
		sequential: Type.Optional(
			Type.Boolean({
				description:
					"Run tasks one at a time in order instead of in parallel. Default false.",
				default: false,
			}),
		),
	},
	{ additionalProperties: false },
);

export type DispatchParamsType = Static<typeof DispatchParams>;

export type DispatchTaskResult = {
	index: number;
	task: string;
	/** -1 while still running. */
	exitCode: number;
	output: string;
	errorMessage?: string;
	/**
	 * True once the child process for this task has been spawned. Lets observers
	 * distinguish a task that is actively running (`started && exitCode === -1`)
	 * from one still waiting for a free worker slot (`!started`).
	 */
	started?: boolean;
	/**
	 * Latest human-readable activity of the child (e.g. "web_search", "thinking…",
	 * "Edit"), derived from its NDJSON event stream. Surfaced live so the main chat
	 * isn't blind to what each dispatched task is doing until it finishes.
	 */
	activity?: string;
};

/**
 * Map a child NDJSON session event to a short activity label for live progress.
 * The child (`pi --mode json`) streams every session event as one JSON line; we
 * only translate the few that indicate "what is it doing right now".
 */
export function activityFromChildEvent(event: unknown): string | undefined {
	if (!isRecord(event)) return undefined;
	switch (event["type"]) {
		case "tool_execution_start":
			return typeof event["toolName"] === "string" && event["toolName"]
				? event["toolName"]
				: "using a tool";
		case "tool_execution_end":
			return "working…";
		case "message_start":
			return "responding…";
		case "turn_start":
			return "thinking…";
		default:
			return undefined;
	}
}

export type DispatchDetails = {
	results: DispatchTaskResult[];
};

/** Run `fn` over `items` with at most `concurrency` in flight at once, preserving input order in the output. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const runWorker = async (): Promise<void> => {
		for (;;) {
			const current = nextIndex++;
			if (current >= items.length) return;
			const item = items[current];
			if (item === undefined) return;
			results[current] = await fn(item, current);
		}
	};
	const workers = Array.from({ length: limit }, () => runWorker());
	await Promise.all(workers);
	return results;
}

/** Resolve how to re-invoke pi for a child process, mirroring how the current process itself was launched. */
export function getPiInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export function getFinalOutput(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			!isRecord(message) ||
			message["role"] !== "assistant" ||
			!Array.isArray(message["content"])
		)
			continue;
		for (const part of message["content"]) {
			if (
				isRecord(part) &&
				part["type"] === "text" &&
				typeof part["text"] === "string"
			)
				return part["text"];
		}
	}
	return "";
}

export function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

/** One-line, length-capped label for a task, used in the live progress grid. */
export function dispatchTaskLabel(task: string, max = 60): string {
	const oneLine = task.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export type RunDispatchTaskOptions = {
	defaultCwd: string;
	index: number;
	task: string;
	cwd: string | undefined;
	signal: AbortSignal | undefined;
	/** Called on child progress; receives a fresh activity label when one is known. */
	onProgress: ((activity?: string) => void) | undefined;
	timeoutMs?: number;
};

export async function runDispatchTask(
	options: RunDispatchTaskOptions,
): Promise<DispatchTaskResult> {
	const { defaultCwd, index, task, cwd, signal, onProgress } = options;
	const result: DispatchTaskResult = { index, task, exitCode: -1, output: "" };
	const args = ["--mode", "json", "-p", "--no-session", task];

	await new Promise<void>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: cwd ?? defaultCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				[DISPATCH_DEPTH_ENV_VAR]: String(currentDispatchDepth() + 1),
			},
		});

		const messages: unknown[] = [];
		let buffer = "";
		let stderr = "";
		let wasAborted = false;
		let timedOut = false;
		let stdoutOverCap = false;
		let stderrOverCap = false;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(event)) return;
			if (event["type"] === "message_end" && isRecord(event["message"])) {
				messages.push(event["message"]);
				const latest = getFinalOutput(messages);
				if (latest) result.output = latest;
				onProgress?.();
				return;
			}
			// Live activity signals — surface what the child is doing right now.
			const activity = activityFromChildEvent(event);
			if (activity !== undefined) {
				result.activity = activity;
				onProgress?.(activity);
			}
		};

		proc.stdout?.on("data", (data: Buffer) => {
			if (!stdoutOverCap) {
				const chunk = data.toString();
				if (Buffer.byteLength(buffer + chunk, "utf8") > PER_TASK_OUTPUT_CAP) {
					buffer += "\n\n[stdout truncated: exceeded output cap]";
					stdoutOverCap = true;
				} else {
					buffer += chunk;
				}
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			if (!stderrOverCap) {
				const chunk = data.toString();
				if (Buffer.byteLength(stderr + chunk, "utf8") > PER_TASK_OUTPUT_CAP) {
					stderr += "\n\n[stderr truncated: exceeded output cap]";
					stderrOverCap = true;
				} else {
					stderr += chunk;
				}
			}
		});
		proc.on("close", (code) => {
			clearTimeout(taskTimeout);
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code ?? 1;
			if (timedOut) {
				result.errorMessage = "Dispatch task timed out after 10m";
			} else if (wasAborted) {
				result.errorMessage = "Dispatch task was aborted";
			} else if (result.exitCode !== 0) {
				result.errorMessage = truncateOutput(
					stderr.trim() || result.output || "(no output)",
				);
			} else {
				result.output = truncateOutput(result.output || "(no output)");
			}
			resolve();
		});
		proc.on("error", (error) => {
			clearTimeout(taskTimeout);
			result.exitCode = 1;
			result.errorMessage = `Failed to spawn pi: ${error.message}`;
			resolve();
		});

		if (signal) {
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				const forceKill = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
				forceKill.unref();
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		const taskTimeout = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			const forceKill = setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
			forceKill.unref();
		}, options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
		taskTimeout.unref();
	});

	return result;
}

/**
 * Core dispatch logic: runs every requested sub-task by spawning one background `pi` child process each (via a
 * bounded parallel worker pool or sequentially when `sequential` is set), streaming incremental progress through
 * `onUpdate` and returning per-task results plus a success/failure summary. Its depth-guard prevents runaway
 * recursive fan-out: each dispatched child inherits the `PI_ULTRAWORK_DISPATCH_DEPTH` env var incremented by one
 * (`currentDispatchDepth() + 1`), so a top-level/interactive session runs at depth 0 and any process it spawns runs
 * at depth 1; before doing any work `runDispatch` checks `currentDispatchDepth() >= MAX_DISPATCH_DEPTH` (which is 1)
 * and, if the current process is already a dispatched child, refuses every task with an explanatory error instead of
 * spawning another generation — bounding the entire process tree rather than a single call's fan-out (already capped
 * by MAX_TASKS/MAX_CONCURRENCY) so dispatched children cannot infinitely spawn further paid-API child processes.
 */
export async function runDispatch(
	ctx: Pick<ExtensionContext, "cwd">,
	params: DispatchParamsType,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<DispatchDetails>) => void) | undefined,
): Promise<{
	results: DispatchTaskResult[];
	summary: { taskCount: number; succeeded: number; failed: number };
	taskDropWarning?: string;
}> {
	const taskDropWarning =
		params.tasks.length > MAX_TASKS
			? `ulw_dispatch: ${params.tasks.length - MAX_TASKS} task(s) silently dropped (max ${MAX_TASKS} per call)`
			: undefined;

	const tasks = params.tasks.slice(0, MAX_TASKS);

	if (currentDispatchDepth() >= MAX_DISPATCH_DEPTH) {
		const refusalMessage =
			"ulw_dispatch: refused — this process is already a dispatched child (max nesting depth reached). " +
			"A dispatched sub-task cannot itself call ulw_dispatch; do the work directly instead of fanning out further.";
		const results: DispatchTaskResult[] = tasks.map((t, index) => ({
			index,
			task: t.task,
			exitCode: 1,
			output: "",
			errorMessage: refusalMessage,
		}));
		return {
			results,
			summary: {
				taskCount: results.length,
				succeeded: 0,
				failed: results.length,
			},
			...(taskDropWarning ? { taskDropWarning } : {}),
		};
	}

	const concurrency = params.sequential
		? 1
		: Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);

	const allResults: DispatchTaskResult[] = tasks.map((t, i) => ({
		index: i,
		task: t.task,
		exitCode: -1,
		output: "",
	}));

	const emitUpdate = () => {
		if (!onUpdate) return;
		const done = allResults.filter((r) => r.exitCode !== -1).length;
		const running = allResults.filter(
			(r) => r.started === true && r.exitCode === -1,
		).length;
		// Header line + one live line per in-flight task showing its current activity,
		// so the main chat streams what each child is doing instead of going dark.
		const lines = [
			`ulw_dispatch: ${done}/${allResults.length} done · ${running} running`,
		];
		for (const r of allResults) {
			if (r.started === true && r.exitCode === -1) {
				const activity = r.activity ? ` — ${r.activity}` : "";
				lines.push(`  [${r.index}]${activity}: ${dispatchTaskLabel(r.task)}`);
			}
		}
		onUpdate({
			content: [{ type: "text", text: lines.join("\n") }],
			details: { results: [...allResults] },
		});
	};

	const results = await mapWithConcurrencyLimit(
		tasks,
		concurrency,
		async (t, index) => {
			// Mark started the moment a worker picks this task up, so observers see it
			// move from pending → running immediately (not only when it finishes).
			const existing = allResults[index];
			if (existing) existing.started = true;
			emitUpdate();
			const result = await runDispatchTask({
				defaultCwd: ctx.cwd,
				index,
				task: t.task,
				cwd: t.cwd,
				signal,
				onProgress: (activity?: string) => {
					const cur = allResults[index];
					if (cur && activity !== undefined) cur.activity = activity;
					emitUpdate();
				},
			});
			allResults[index] = { ...result, started: true };
			emitUpdate();
			return result;
		},
	);

	const succeeded = results.filter((r) => r.exitCode === 0).length;
	return {
		results,
		summary: {
			taskCount: results.length,
			succeeded,
			failed: results.length - succeeded,
		},
		...(taskDropWarning ? { taskDropWarning } : {}),
	};
}

export function summarizeDispatchResults(
	results: DispatchTaskResult[],
): string {
	if (results.length === 0) return "ulw_dispatch: no tasks.";
	const succeeded = results.filter((r) => r.exitCode === 0).length;
	const sections = results.map((r) => {
		const status = r.exitCode === 0 ? "done" : `failed (exit ${r.exitCode})`;
		const body =
			r.exitCode === 0
				? r.output || "(no output)"
				: r.errorMessage || r.output || "(no output)";
		return `### [${r.index}] ${status}\n${r.task}\n\n${body}`;
	});
	return `ulw_dispatch: ${succeeded}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
}
