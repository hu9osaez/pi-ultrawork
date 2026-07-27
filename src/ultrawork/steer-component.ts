import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type SteerChoice = "steer" | "queue" | "discard" | "edit";

/**
 * Minimal single-keypress modal shown via `ctx.ui.custom()` when the user
 * types text while an UltraWork run is in progress. Mirrors the UX of
 * @agnishc/edb-agent-steer: the user picks how to deliver their message
 * (steer mid-stream, queue for the next idle continuation, discard, or
 * edit) without retyping it.
 *
 * The component renders four key hints plus a one-line preview of the
 * queued text. `handleInput` resolves the custom() promise via `done`
 * on the first valid key, so there is no focus/cursor management.
 */
export class SteerChoiceComponent implements Component {
	private readonly preview: string;
	private readonly done: (choice: SteerChoice) => void;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		text: string,
		done: (choice: SteerChoice) => void,
	) {
		// Cap the preview so very long messages do not blow up the modal. The
		// full text is delivered unchanged regardless of what the user picks.
		this.preview = truncateToWidth(`"${text}"`, 72);
		this.done = done;
	}

	handleInput(data: string): void {
		// Order matters: check Escape before "e" so the conventional cancel
		// gesture still works even though "e" is the "edit" shortcut.
		if (matchesKey(data, "escape")) {
			this.done("edit");
			return;
		}
		if (data === "s") {
			this.done("steer");
			return;
		}
		if (data === "q") {
			this.done("queue");
			return;
		}
		if (data === "d") {
			this.done("discard");
			return;
		}
		if (data === "e") {
			this.done("edit");
			return;
		}
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedLines.length > 0) {
			return this.cachedLines;
		}
		const hints =
			`  s steer   q queue   d discard   e/Esc edit`;
		const lines = [
			"",
			`  ${this.preview}`,
			"",
			truncateToWidth(hints, width),
			"",
		];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}
