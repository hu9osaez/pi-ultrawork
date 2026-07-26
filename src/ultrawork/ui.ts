import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUTO_CONTINUE_CAP } from "./continuation.js";
import { formatElapsedSeconds, secondsSince } from "./format.js";
import type { UltraWorkRun } from "./types.js";

export const STATUS_KEY = "ultrawork";

/**
 * Keep the footer status in sync with the run.
 *
 * This is the persistent visible indicator: whenever a run exists (even
 * stopped/complete/stuck), some text is shown so the user always sees the
 * mode's state at a glance. Only when no run has ever been triggered is the
 * status cleared.
 */
export function updateUltraworkUi(ctx: ExtensionContext, run: UltraWorkRun | null): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, run === null ? undefined : ultraworkStatusText(run));
}

export function ultraworkStatusText(run: UltraWorkRun): string {
	switch (run.status) {
		case "running":
			return `● UltraWork running — ${run.goal} (started ${formatElapsedSeconds(secondsSince(run.startedAt))} ago)`;
		case "complete":
			return `UltraWork complete — ${run.goal}`;
		case "stopped":
			return 'UltraWork stopped (say "ultrawork" to resume)';
		case "stuck":
			return `UltraWork stuck after ${AUTO_CONTINUE_CAP} idle retries — say "ultrawork" again to restart`;
	}
}
