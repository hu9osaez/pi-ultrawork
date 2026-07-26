import type { UltraWorkRun } from "./types.js";

/** Cap on hidden auto-continuation attempts before a running UltraWork run is marked stuck (mirrors OMO's RESUME_CAP). */
export const AUTO_CONTINUE_CAP = 2;

/** Session-start continuation: only fires while idle with nothing else queued. */
export function shouldQueueContinuationWhenIdle(
	run: UltraWorkRun | null,
	isIdle: boolean,
	hasPendingMessages: boolean,
): run is UltraWorkRun {
	return run?.status === "running" && isIdle && !hasPendingMessages;
}

/**
 * agent_settled continuation: fires once pi will not auto-continue on its own
 * (no pending retry, compaction, or queued follow-up), as long as nothing else
 * is already queued.
 */
export function shouldQueueContinuationOnSettle(run: UltraWorkRun | null, hasPendingMessages: boolean): run is UltraWorkRun {
	return run?.status === "running" && !hasPendingMessages;
}

/** True once queueing another auto-continuation attempt would exceed the cap; the run should be marked stuck instead. */
export function hasReachedAutoContinueCap(run: UltraWorkRun): boolean {
	return run.autoContinueAttempts >= AUTO_CONTINUE_CAP;
}
