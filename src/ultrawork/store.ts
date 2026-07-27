import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { ULTRAWORK_STATUS_VALUES } from "./types.js";
import {
	InvalidUltraWorkStoreError,
	UltraWorkNotFoundError,
	UnsupportedUltraWorkStoreVersionError,
} from "./errors.js";
import type {
	DispatchSummary,
	UltraWorkFile,
	UltraWorkRun,
	UltraWorkStoreRef,
} from "./types.js";
import { isRecord } from "./types.js";
import { validateGoal } from "./validation.js";

const STORE_VERSION = 1;

/** Minimal session shape needed to compute a store ref; matches ExtensionContext's sessionManager + cwd. */
export type UltraWorkStoreRefSource = {
	cwd: string;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionDir(): string;
		getSessionId(): string;
	};
};

/** Result of a `triggerRun` call: the current run, and whether this call actually (re)started it. */
export type TriggerResult = {
	run: UltraWorkRun;
	/** True when this call created a fresh run (no run existed, or the previous one was not running). */
	fresh: boolean;
};

/**
 * Resolve where this thread's UltraWork state lives on disk.
 *
 * Session-scoped: `<sessionDir>/extensions/ultrawork/<threadId>.json`.
 * No-session fallback: `$PI_CODING_AGENT_DIR/extensions/ultrawork/no-session/<hash(cwd)>/<threadId>.json`.
 */
export function ultraworkStoreRef(
	ctx: UltraWorkStoreRefSource,
): UltraWorkStoreRef {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(
					getAgentDir(),
					"extensions",
					"ultrawork",
					"no-session",
					cwdStoreKey(ctx.cwd),
				)
			: join(ctx.sessionManager.getSessionDir(), "extensions", "ultrawork");

	return {
		baseDir,
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function cwdStoreKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

export function runFilePath(ref: UltraWorkStoreRef): string {
	return join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.json`);
}

/** Read the whole persisted store envelope, defaulting to an empty file when none exists. */
export async function readStore(
	ref: UltraWorkStoreRef,
): Promise<UltraWorkFile> {
	const filePath = runFilePath(ref);
	try {
		const raw = await readFile(filePath, "utf8");
		try {
			return parseUltraWorkFile(raw);
		} catch (error) {
			if (
				error instanceof InvalidUltraWorkStoreError ||
				error instanceof UnsupportedUltraWorkStoreVersionError
			) {
				console.warn(
					"ultrawork store corrupt or version mismatch, resetting to default:",
					error.message,
				);
				return { version: STORE_VERSION, run: null };
			}
			throw error;
		}
	} catch (error) {
		if (isMissingFile(error)) return { version: STORE_VERSION, run: null };
		throw error;
	}
}

async function writeStore(
	ref: UltraWorkStoreRef,
	file: UltraWorkFile,
): Promise<void> {
	const filePath = runFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	// Normalize: drop falsy file-level flags so the default state has no keys.
	// Every persisted file-level flag MUST be re-added here or it silently vanishes
	// on the next unrelated write (see the all-fields-preserved regression test).
	const normalized: UltraWorkFile = { version: STORE_VERSION, run: file.run };
	if (file.triggerDisabled) normalized.triggerDisabled = true;
	if (file.alwaysOn) normalized.alwaysOn = true;
	await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function readRun(
	ref: UltraWorkStoreRef,
): Promise<UltraWorkRun | null> {
	return (await readStore(ref)).run;
}

/** Persist a run while preserving the thread's existing `triggerDisabled` flag. */
export async function writeRun(
	ref: UltraWorkStoreRef,
	run: UltraWorkRun | null,
): Promise<void> {
	const existing = await readStore(ref);
	await writeStore(ref, { ...existing, run });
}

/** True when the keyword trigger is currently suppressed for this thread. */
export async function isTriggerDisabled(
	ref: UltraWorkStoreRef,
): Promise<boolean> {
	return (await readStore(ref)).triggerDisabled === true;
}

/**
 * Set (or clear) the keyword-trigger kill switch, preserving any existing run.
 * Mutually exclusive with always-on: disabling the trigger also clears alwaysOn,
 * since "never trigger" and "always trigger" cannot both hold.
 */
export async function setTriggerDisabled(
	ref: UltraWorkStoreRef,
	disabled: boolean,
): Promise<void> {
	const existing = await readStore(ref);
	await writeStore(ref, {
		...existing,
		triggerDisabled: disabled,
		...(disabled ? { alwaysOn: false } : {}),
	});
}

/** True when every prompt should start/refresh an UltraWork run for this thread. */
export async function isAlwaysOn(ref: UltraWorkStoreRef): Promise<boolean> {
	return (await readStore(ref)).alwaysOn === true;
}

/**
 * Set (or clear) always-on mode, preserving any existing run. Mutually exclusive
 * with the kill switch: enabling always-on also clears triggerDisabled.
 */
export async function setAlwaysOn(
	ref: UltraWorkStoreRef,
	on: boolean,
): Promise<void> {
	const existing = await readStore(ref);
	await writeStore(ref, {
		...existing,
		alwaysOn: on,
		...(on ? { triggerDisabled: false } : {}),
	});
}

/**
 * Trigger UltraWork for this thread from the `ultrawork`/`ulw` keyword.
 *
 * Idempotent and safe to call on every matching prompt, including our own
 * hidden auto-continuation follow-ups that happen to contain a trigger word:
 *
 * - No run yet, or the existing run's status is not `running`: create a brand
 *   new run (fresh id, counters reset to zero) using `promptText` as the goal.
 *   This is a fresh "start" — the caller should inject the UltraWork directive.
 * - An existing run is already `running`: no-op refresh. Only `updatedAt`
 *   moves; `startedAt`, `dispatchCount`, and `autoContinueAttempts` are left
 *   untouched. The caller should not re-inject the directive.
 */
export async function triggerRun(
	ref: UltraWorkStoreRef,
	promptText: string,
): Promise<TriggerResult> {
	const current = await readRun(ref);
	const now = nowSeconds();

	if (current === null || current.status !== "running") {
		const goal = validateGoal(promptText);
		const next: UltraWorkRun = {
			id: randomUUID(),
			threadId: ref.threadId,
			goal,
			status: "running",
			createdAt: now,
			updatedAt: now,
			startedAt: now,
			dispatchCount: 0,
			autoContinueAttempts: 0,
		};
		await writeRun(ref, next);
		return { run: next, fresh: true };
	}

	const next: UltraWorkRun = { ...current, updatedAt: now };
	await writeRun(ref, next);
	return { run: next, fresh: false };
}

/**
 * Shared read-modify-write core for run status transitions: given an already-
 * loaded run, short-circuit on a no-op idempotency match, otherwise apply
 * `patch` and always bump `updatedAt` before persisting. Centralizes the
 * `{...current, <fields>, updatedAt: now}` / `writeRun` shape so every
 * transition below applies it identically.
 */
async function transitionRun(
	ref: UltraWorkStoreRef,
	current: UltraWorkRun,
	options: {
		isNoop?: (current: UltraWorkRun) => boolean;
		patch: (
			current: UltraWorkRun,
			now: number,
		) => Partial<Omit<UltraWorkRun, "updatedAt">>;
	},
): Promise<UltraWorkRun> {
	if (options.isNoop?.(current)) return current;

	const now = nowSeconds();
	const next: UltraWorkRun = {
		...current,
		...options.patch(current, now),
		updatedAt: now,
	};
	await writeRun(ref, next);
	return next;
}

/** Manual safety valve (`/ulw stop`): stop the run from any non-stopped status and disarm continuation. */
export async function stopRun(ref: UltraWorkStoreRef): Promise<UltraWorkRun> {
	const current = await readRun(ref);
	if (current === null) {
		throw new UltraWorkNotFoundError("No UltraWork run to stop.");
	}
	return transitionRun(ref, current, {
		isNoop: (run) => run.status === "stopped",
		// Clear orphaned steers: a stopped run never continues, so any pending
		// note would otherwise leak on disk and confuse the next `/ulw-steer list`.
		patch: (_run, now) => ({
			status: "stopped",
			stoppedAt: now,
			pendingSteers: [],
		}),
	});
}

/** `ulw_complete`: transition the run to `complete` and disarm continuation. Idempotent. */
export async function completeRun(
	ref: UltraWorkStoreRef,
	summary?: string,
): Promise<UltraWorkRun> {
	const current = await readRun(ref);
	if (current === null) {
		throw new UltraWorkNotFoundError("No UltraWork run to complete.");
	}
	const trimmedSummary = summary?.trim();
	return transitionRun(ref, current, {
		isNoop: (run) => run.status === "complete",
		// Clear orphaned steers: a completed run is done — pending notes are moot.
		patch: (_run, now) => ({
			status: "complete",
			completedAt: now,
			pendingSteers: [],
			...(trimmedSummary ? { summary: trimmedSummary } : {}),
		}),
	});
}

/** Stuck-detector cap hit: transition the run to `stuck` and disarm continuation. No-ops if there is no run. */
export async function markRunStuck(
	ref: UltraWorkStoreRef,
): Promise<UltraWorkRun | null> {
	const current = await readRun(ref);
	if (current === null) return null;
	return transitionRun(ref, current, {
		isNoop: (run) => run.status === "stuck",
		// Clear orphaned steers: a stuck run refuses `/ulw-steer <text>` (status
		// !== "running"), so any pending note would be unrecoverable.
		patch: (_run, now) => ({
			status: "stuck",
			stuckAt: now,
			pendingSteers: [],
		}),
	});
}

/** Record that a hidden auto-continuation prompt was queued. No-ops if there is no run. */
export async function recordAutoContinueAttempt(
	ref: UltraWorkStoreRef,
): Promise<UltraWorkRun | null> {
	const current = await readRun(ref);
	if (current === null) return null;
	return transitionRun(ref, current, {
		patch: (run) => ({ autoContinueAttempts: run.autoContinueAttempts + 1 }),
	});
}

/**
 * Fold a ulw_dispatch result summary back into the run. A completed dispatch is
 * observable forward progress, so it resets the auto-continue stuck counter.
 * No-ops if the run no longer exists.
 */
export async function recordDispatch(
	ref: UltraWorkStoreRef,
	summary: DispatchSummary,
): Promise<UltraWorkRun | null> {
	const current = await readRun(ref);
	if (current === null) return null;
	return transitionRun(ref, current, {
		patch: (run, now) => ({
			dispatchCount: run.dispatchCount + summary.taskCount,
			...(summary.succeeded > 0 ? { autoContinueAttempts: 0 } : {}),
			lastDispatchAt: now,
		}),
	});
}

/**
 * Flag the running run so the full UltraWork directive gets re-injected on the
 * next `before_agent_start` (the post-compaction bridge). No-ops if no run.
 */
export async function setPendingReinject(
	ref: UltraWorkStoreRef,
): Promise<UltraWorkRun | null> {
	const current = await readRun(ref);
	if (current === null) return null;
	return transitionRun(ref, current, {
		isNoop: (run) => run.pendingReinject === true,
		patch: () => ({ pendingReinject: true }),
	});
}

/**
 * Atomically read-and-clear the pending-reinject flag. Returns true when it was
 * set (caller should then re-inject the directive). Returns false with no write
 * when unset or when there is no run.
 */
export async function consumePendingReinject(
	ref: UltraWorkStoreRef,
): Promise<boolean> {
	const current = await readRun(ref);
	if (current === null || current.pendingReinject !== true) return false;
	await transitionRun(ref, current, {
		patch: () => ({ pendingReinject: false }),
	});
	return true;
}

/** Append a mid-run steering note (`/ulw steer <text>`). No-ops if no run or blank note. */
export async function addSteer(
	ref: UltraWorkStoreRef,
	note: string,
): Promise<UltraWorkRun | null> {
	const trimmed = note.trim();
	const current = await readRun(ref);
	if (current === null || trimmed === "") return current;
	return transitionRun(ref, current, {
		patch: (run) => ({
			pendingSteers: [...(run.pendingSteers ?? []), trimmed],
		}),
	});
}

/**
 * Atomically read-and-clear the queued steering notes so each is consumed
 * exactly once. Returns them (possibly empty). No write when there are none.
 */
export async function consumeSteers(ref: UltraWorkStoreRef): Promise<string[]> {
	const current = await readRun(ref);
	if (current === null) return [];
	const steers = current.pendingSteers ?? [];
	if (steers.length === 0) return [];
	await transitionRun(ref, current, { patch: () => ({ pendingSteers: [] }) });
	return steers;
}

function parseUltraWorkFile(raw: string): UltraWorkFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new InvalidUltraWorkStoreError(
			`ultrawork store is not valid JSON: ${detail}`,
		);
	}
	if (!isRecord(parsed))
		throw new InvalidUltraWorkStoreError(
			"ultrawork store must be a JSON object",
		);
	if (parsed["version"] !== STORE_VERSION) {
		throw new UnsupportedUltraWorkStoreVersionError(
			"unsupported ultrawork store version",
		);
	}
	const run = parsed["run"];
	if (run !== null && !isUltraWorkRun(run)) {
		throw new InvalidUltraWorkStoreError(
			"ultrawork store contains an invalid run",
		);
	}
	const triggerDisabled = parsed["triggerDisabled"];
	if (triggerDisabled !== undefined && typeof triggerDisabled !== "boolean") {
		throw new InvalidUltraWorkStoreError(
			"ultrawork store triggerDisabled must be a boolean",
		);
	}
	const alwaysOn = parsed["alwaysOn"];
	if (alwaysOn !== undefined && typeof alwaysOn !== "boolean") {
		throw new InvalidUltraWorkStoreError(
			"ultrawork store alwaysOn must be a boolean",
		);
	}
	const file: UltraWorkFile = { version: STORE_VERSION, run };
	if (triggerDisabled === true) file.triggerDisabled = true;
	if (alwaysOn === true) file.alwaysOn = true;
	return file;
}

function isMissingFile(error: unknown): boolean {
	return isErrorWithCode(error) && error.code === "ENOENT";
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
	return (
		error instanceof Error && "code" in error && typeof error.code === "string"
	);
}

function isUltraWorkRun(value: unknown): value is UltraWorkRun {
	if (!isRecord(value)) return false;
	return (
		typeof value["id"] === "string" &&
		typeof value["threadId"] === "string" &&
		typeof value["goal"] === "string" &&
		isUltraWorkStatus(value["status"]) &&
		isNonNegativeSafeInteger(value["createdAt"]) &&
		isNonNegativeSafeInteger(value["updatedAt"]) &&
		isNonNegativeSafeInteger(value["startedAt"]) &&
		isNonNegativeSafeInteger(value["dispatchCount"]) &&
		isNonNegativeSafeInteger(value["autoContinueAttempts"]) &&
		(value["stoppedAt"] === undefined ||
			isNonNegativeSafeInteger(value["stoppedAt"])) &&
		(value["completedAt"] === undefined ||
			isNonNegativeSafeInteger(value["completedAt"])) &&
		(value["stuckAt"] === undefined ||
			isNonNegativeSafeInteger(value["stuckAt"])) &&
		(value["lastDispatchAt"] === undefined ||
			isNonNegativeSafeInteger(value["lastDispatchAt"])) &&
		(value["summary"] === undefined || typeof value["summary"] === "string") &&
		(value["pendingReinject"] === undefined ||
			typeof value["pendingReinject"] === "boolean") &&
		(value["pendingSteers"] === undefined ||
			(Array.isArray(value["pendingSteers"]) &&
				value["pendingSteers"].every((s) => typeof s === "string")))
	);
}

function isUltraWorkStatus(value: unknown): value is UltraWorkRun["status"] {
	return (
		typeof value === "string" &&
		(ULTRAWORK_STATUS_VALUES as readonly string[]).includes(value)
	);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
