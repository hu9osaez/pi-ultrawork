import { describe, expect, it } from "vitest";

import { AUTO_CONTINUE_CAP } from "../src/ultrawork/continuation.js";
import { ultraworkStatusText } from "../src/ultrawork/ui.js";
import type { UltraWorkRun } from "../src/ultrawork/types.js";

describe("ultrawork status indicator text", () => {
	it("shows the running indicator with the goal and elapsed time", () => {
		const fiveMinutesAgo = Math.trunc(Date.now() / 1000) - 5 * 60;
		const run = testRun({ status: "running", startedAt: fiveMinutesAgo });
		expect(ultraworkStatusText(run)).toBe(
			"● UltraWork running — Ship it (started 5m ago)",
		);
	});

	it("shows a short complete indicator without the goal text", () => {
		const run = testRun({
			status: "complete",
			goal: "a very long goal that should not appear in the footer at all",
		});
		expect(ultraworkStatusText(run)).toBe("UltraWork complete");
	});

	it("truncates an oversized goal in the running indicator", () => {
		const longGoal =
			"add a one-paragraph doc comment above the default export explaining what UltraWork does";
		const run = testRun({ status: "running", goal: longGoal, startedAt: 0 });
		const text = ultraworkStatusText(run);
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(
			`● UltraWork running — ${longGoal} (started 0s ago)`.length,
		);
	});

	it("shows the stopped indicator with the trigger-word hint", () => {
		const run = testRun({ status: "stopped" });
		expect(ultraworkStatusText(run)).toBe(
			'UltraWork stopped (say "ultrawork" to resume)',
		);
	});

	it("shows the stuck indicator with the retry cap and trigger-word hint", () => {
		const run = testRun({ status: "stuck" });
		expect(ultraworkStatusText(run)).toBe(
			`UltraWork stuck after ${AUTO_CONTINUE_CAP} idle retries — say "ultrawork" again to restart`,
		);
	});
});

function testRun(overrides: Partial<UltraWorkRun> = {}): UltraWorkRun {
	return {
		id: "run-1",
		threadId: "thread-1",
		goal: "Ship it",
		status: "running",
		createdAt: 0,
		updatedAt: 0,
		startedAt: 0,
		dispatchCount: 0,
		autoContinueAttempts: 0,
		...overrides,
	};
}
