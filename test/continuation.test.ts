import { describe, expect, it } from "vitest";

import { AUTO_CONTINUE_CAP, hasReachedAutoContinueCap, shouldQueueContinuationOnSettle, shouldQueueContinuationWhenIdle } from "../src/ultrawork/continuation.js";
import type { UltraWorkRun } from "../src/ultrawork/types.js";

describe("ultrawork continuation policy", () => {
	it("continues a running run once settled when no user work is pending", () => {
		expect(shouldQueueContinuationOnSettle(testRun({ status: "running" }), false)).toBe(true);
	});

	it("does not continue once settled when another message is already pending", () => {
		expect(shouldQueueContinuationOnSettle(testRun({ status: "running" }), true)).toBe(false);
	});

	it("only auto-continues running runs once settled", () => {
		expect(shouldQueueContinuationOnSettle(null, false)).toBe(false);
		expect(shouldQueueContinuationOnSettle(testRun({ status: "stopped" }), false)).toBe(false);
		expect(shouldQueueContinuationOnSettle(testRun({ status: "complete" }), false)).toBe(false);
		expect(shouldQueueContinuationOnSettle(testRun({ status: "stuck" }), false)).toBe(false);
	});

	it("requires idle state for session-start continuation", () => {
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "running" }), true, false)).toBe(true);
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "running" }), false, false)).toBe(false);
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "running" }), true, true)).toBe(false);
	});

	it("never continues a non-running run, idle or not", () => {
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "stopped" }), true, false)).toBe(false);
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "complete" }), true, false)).toBe(false);
		expect(shouldQueueContinuationWhenIdle(testRun({ status: "stuck" }), true, false)).toBe(false);
		expect(shouldQueueContinuationWhenIdle(null, true, false)).toBe(false);
	});
});

describe("ultrawork stuck-detector cap", () => {
	it("has not reached the cap below AUTO_CONTINUE_CAP attempts", () => {
		expect(hasReachedAutoContinueCap(testRun({ autoContinueAttempts: 0 }))).toBe(false);
		expect(hasReachedAutoContinueCap(testRun({ autoContinueAttempts: AUTO_CONTINUE_CAP - 1 }))).toBe(false);
	});

	it("reaches the cap once attempts meet or exceed AUTO_CONTINUE_CAP", () => {
		expect(hasReachedAutoContinueCap(testRun({ autoContinueAttempts: AUTO_CONTINUE_CAP }))).toBe(true);
		expect(hasReachedAutoContinueCap(testRun({ autoContinueAttempts: AUTO_CONTINUE_CAP + 1 }))).toBe(true);
	});
});

function testRun(overrides: Partial<UltraWorkRun> = {}): UltraWorkRun {
	return {
		id: "run-1",
		threadId: "thread-1",
		goal: "Keep going until complete",
		status: "running",
		createdAt: 1_777_766_400,
		updatedAt: 1_777_766_400,
		startedAt: 1_777_766_400,
		dispatchCount: 0,
		autoContinueAttempts: 0,
		...overrides,
	};
}
