import { AUTO_CONTINUE_CAP } from "./continuation.js";
import type { UltraWorkRun, UltraWorkStatus } from "./types.js";

export function formatElapsedSeconds(value: number): string {
	const seconds = Math.max(0, Math.trunc(value));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.trunc(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.trunc(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) {
		const days = Math.trunc(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h ${remainingMinutes}m`;
	}

	if (remainingMinutes === 0) return `${hours}h`;
	return `${hours}h ${remainingMinutes}m`;
}

/** Whole seconds elapsed since a Unix-seconds timestamp, floored at zero. */
export function secondsSince(unixSeconds: number, now: number = Date.now()): number {
	return Math.max(0, Math.trunc(now / 1000) - unixSeconds);
}

export function ultraworkStatusLabel(status: UltraWorkStatus): string {
	switch (status) {
		case "running":
			return "running";
		case "complete":
			return "complete";
		case "stopped":
			return "stopped";
		case "stuck":
			return "stuck";
	}
}

export function formatRunForUser(run: UltraWorkRun | null): string {
	if (!run) return 'UltraWork is not running.\nSay "ultrawork" or "ulw" in a message to start it.';

	const lines = [
		`Goal: ${run.goal}`,
		`Status: ${ultraworkStatusLabel(run.status)}`,
		`Started: ${formatElapsedSeconds(secondsSince(run.startedAt))} ago`,
	];
	if (run.dispatchCount > 0) lines.push(`Dispatched sub-tasks: ${run.dispatchCount}`);
	if (run.status === "running" && run.autoContinueAttempts > 0) {
		lines.push(`Auto-continue attempts: ${run.autoContinueAttempts}/${AUTO_CONTINUE_CAP}`);
	}
	if (run.status === "complete" && run.summary) lines.push(`Summary: ${run.summary}`);
	return lines.join("\n");
}
