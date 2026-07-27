import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	completeRun,
	addSteer,
	consumePendingReinject,
	consumeSteers,
	isAlwaysOn,
	isTriggerDisabled,
	setAlwaysOn,
	setPendingReinject,
	markRunStuck,
	readRun,
	recordAutoContinueAttempt,
	recordDispatch,
	runFilePath,
	setTriggerDisabled,
	stopRun,
	triggerRun,
	ultraworkStoreRef,
} from "../src/ultrawork/store.js";
import type { UltraWorkStoreRef } from "../src/ultrawork/types.js";

const tempDirs: string[] = [];

describe("ultrawork store", () => {
	afterEach(async () => {
		await Promise.all(
			tempDirs
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	describe("triggerRun", () => {
		it("creates a fresh running run when none exists", async () => {
			const ref = await tempStore("thread-create");
			const { run, fresh } = await triggerRun(
				ref,
				"  ultrawork ship the extension  ",
			);

			expect(fresh).toBe(true);
			expect(run.threadId).toBe("thread-create");
			expect(run.goal).toBe("ultrawork ship the extension");
			expect(run.status).toBe("running");
			expect(run.dispatchCount).toBe(0);
			expect(run.autoContinueAttempts).toBe(0);
			expect(await readRun(ref)).toMatchObject({
				id: run.id,
				goal: "ultrawork ship the extension",
			});
			expect(runFilePath(ref)).toContain(
				join("extensions", "ultrawork", "thread-create.json"),
			);

			const fileContents = await readFile(runFilePath(ref), "utf8");
			expect(fileContents).toContain('"version": 1');
		});

		it("round-trips a run through write and read", async () => {
			const ref = await tempStore();
			const { run: created } = await triggerRun(ref, "ultrawork round trip me");
			const reloaded = await readRun(ref);
			expect(reloaded).toEqual(created);
		});

		it("is a safe no-op refresh when the run is already running: preserves id, startedAt, dispatchCount, and autoContinueAttempts", async () => {
			const ref = await tempStore();
			const { run: first } = await triggerRun(ref, "ultrawork original goal");
			await recordDispatch(ref, { taskCount: 2, succeeded: 2, failed: 0 });
			await recordAutoContinueAttempt(ref);
			const beforeRetrigger = await readRun(ref);

			const { run: refreshed, fresh } = await triggerRun(
				ref,
				"ultrawork a completely different message",
			);

			expect(fresh).toBe(false);
			expect(refreshed.id).toBe(first.id);
			expect(refreshed.goal).toBe("ultrawork original goal");
			expect(refreshed.startedAt).toBe(beforeRetrigger?.startedAt);
			expect(refreshed.dispatchCount).toBe(beforeRetrigger?.dispatchCount);
			expect(refreshed.autoContinueAttempts).toBe(
				beforeRetrigger?.autoContinueAttempts,
			);
			expect(refreshed.updatedAt).toBeGreaterThanOrEqual(
				beforeRetrigger?.updatedAt ?? 0,
			);
		});

		it("creates a brand new run (fresh) when the previous run is stopped", async () => {
			const ref = await tempStore();
			const { run: first } = await triggerRun(ref, "ultrawork first goal");
			await stopRun(ref);

			const { run: restarted, fresh } = await triggerRun(
				ref,
				"ultrawork new goal after stop",
			);

			expect(fresh).toBe(true);
			expect(restarted.id).not.toBe(first.id);
			expect(restarted.goal).toBe("ultrawork new goal after stop");
			expect(restarted.status).toBe("running");
			expect(restarted.dispatchCount).toBe(0);
			expect(restarted.autoContinueAttempts).toBe(0);
			expect(restarted.stoppedAt).toBeUndefined();
		});

		it("creates a brand new run (fresh) when the previous run is complete", async () => {
			const ref = await tempStore();
			const { run: first } = await triggerRun(ref, "ultrawork first goal");
			await completeRun(ref, "done");

			const { run: restarted, fresh } = await triggerRun(
				ref,
				"ultrawork new goal after complete",
			);

			expect(fresh).toBe(true);
			expect(restarted.id).not.toBe(first.id);
			expect(restarted.status).toBe("running");
		});

		it("creates a brand new run (fresh) when the previous run is stuck", async () => {
			const ref = await tempStore();
			const { run: first } = await triggerRun(ref, "ultrawork first goal");
			await markRunStuck(ref);

			const { run: restarted, fresh } = await triggerRun(
				ref,
				"ultrawork new goal after stuck",
			);

			expect(fresh).toBe(true);
			expect(restarted.id).not.toBe(first.id);
			expect(restarted.status).toBe("running");
			expect(restarted.autoContinueAttempts).toBe(0);
		});

		it("rejects an empty goal", async () => {
			const ref = await tempStore();
			await expect(triggerRun(ref, "   ")).rejects.toThrow(
				"UltraWork goal cannot be empty.",
			);
		});
	});

	describe("stopRun", () => {
		it("stops a running run", async () => {
			const ref = await tempStore();
			const { run: started } = await triggerRun(ref, "ultrawork track me");

			const stopped = await stopRun(ref);
			expect(stopped.id).toBe(started.id);
			expect(stopped.status).toBe("stopped");
			expect(typeof stopped.stoppedAt).toBe("number");
		});

		it("is idempotent when already stopped", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork track me");
			const first = await stopRun(ref);
			const second = await stopRun(ref);
			expect(second).toEqual(first);
		});

		it("stops a stuck run too", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork track me");
			await markRunStuck(ref);
			const stopped = await stopRun(ref);
			expect(stopped.status).toBe("stopped");
		});

		it("rejects stop when there is no run", async () => {
			const ref = await tempStore();
			await expect(stopRun(ref)).rejects.toThrow("No UltraWork run to stop");
		});

		it("regression: clears orphaned pending steers on stop (BUG F)", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");
			await addSteer(ref, "later note");

			const stopped = await stopRun(ref);

			expect(stopped.status).toBe("stopped");
			expect(stopped.pendingSteers ?? []).toEqual([]);
			expect((await readRun(ref))?.pendingSteers ?? []).toEqual([]);
		});
	});

	describe("completeRun", () => {
		it("transitions a running run to complete and disarms continuation state", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");

			const completed = await completeRun(ref, "shipped the release");
			expect(completed.status).toBe("complete");
			expect(typeof completed.completedAt).toBe("number");
			expect(completed.summary).toBe("shipped the release");
		});

		it("omits summary when none is given", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");
			const completed = await completeRun(ref);
			expect(completed.summary).toBeUndefined();
		});

		it("is idempotent when already complete", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");
			const first = await completeRun(ref, "first summary");
			const second = await completeRun(ref, "second summary");
			expect(second).toEqual(first);
		});

		it("rejects complete when there is no run", async () => {
			const ref = await tempStore();
			await expect(completeRun(ref)).rejects.toThrow(
				"No UltraWork run to complete",
			);
		});

		it("regression: clears orphaned pending steers on complete (BUG F)", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");
			await addSteer(ref, "polish the README");

			const completed = await completeRun(ref, "done");

			expect(completed.status).toBe("complete");
			expect(completed.pendingSteers ?? []).toEqual([]);
			expect((await readRun(ref))?.pendingSteers ?? []).toEqual([]);
		});
	});

	describe("markRunStuck", () => {
		it("transitions a running run to stuck", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork track me");
			const stuck = await markRunStuck(ref);
			expect(stuck?.status).toBe("stuck");
			expect(typeof stuck?.stuckAt).toBe("number");
		});

		it("is idempotent when already stuck", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork track me");
			const first = await markRunStuck(ref);
			const second = await markRunStuck(ref);
			expect(second).toEqual(first);
		});

		it("no-ops when there is no run", async () => {
			const ref = await tempStore();
			expect(await markRunStuck(ref)).toBeNull();
		});

		it("regression: clears orphaned pending steers on stuck transition (BUG F)", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork ship it");
			await addSteer(ref, "switch to plan B");

			const stuck = await markRunStuck(ref);

			expect(stuck?.status).toBe("stuck");
			expect(stuck?.pendingSteers ?? []).toEqual([]);
			expect((await readRun(ref))?.pendingSteers ?? []).toEqual([]);
		});
	});

	describe("recordAutoContinueAttempt", () => {
		it("increments the counter on the run", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork track me");

			const once = await recordAutoContinueAttempt(ref);
			expect(once?.autoContinueAttempts).toBe(1);

			const twice = await recordAutoContinueAttempt(ref);
			expect(twice?.autoContinueAttempts).toBe(2);
		});

		it("no-ops when there is no run", async () => {
			const ref = await tempStore();
			expect(await recordAutoContinueAttempt(ref)).toBeNull();
		});
	});

	describe("recordDispatch", () => {
		it("folds ulw_dispatch summaries back into the run", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork dispatch tracked");

			const updated = await recordDispatch(ref, {
				taskCount: 3,
				succeeded: 2,
				failed: 1,
			});
			expect(updated?.dispatchCount).toBe(3);
			expect(typeof updated?.lastDispatchAt).toBe("number");

			const again = await recordDispatch(ref, {
				taskCount: 2,
				succeeded: 2,
				failed: 0,
			});
			expect(again?.dispatchCount).toBe(5);
		});

		it("resets autoContinueAttempts to 0 as observable forward progress", async () => {
			const ref = await tempStore();
			await triggerRun(ref, "ultrawork dispatch tracked");
			await recordAutoContinueAttempt(ref);
			await recordAutoContinueAttempt(ref);

			const updated = await recordDispatch(ref, {
				taskCount: 1,
				succeeded: 1,
				failed: 0,
			});
			expect(updated?.autoContinueAttempts).toBe(0);
		});

		it("no-ops when there is no run", async () => {
			const ref = await tempStore();
			expect(
				await recordDispatch(ref, { taskCount: 1, succeeded: 1, failed: 0 }),
			).toBeNull();
		});
	});

	describe("triggerDisabled flag", () => {
		it("defaults to enabled (not disabled) when no store exists", async () => {
			const ref = await tempStore("thread-flag-default");
			expect(await isTriggerDisabled(ref)).toBe(false);
		});

		it("round-trips the disabled flag and clears it again", async () => {
			const ref = await tempStore("thread-flag-toggle");
			await setTriggerDisabled(ref, true);
			expect(await isTriggerDisabled(ref)).toBe(true);
			await setTriggerDisabled(ref, false);
			expect(await isTriggerDisabled(ref)).toBe(false);
		});

		it("omits the flag key from the file when enabled, writes it when disabled", async () => {
			const ref = await tempStore("thread-flag-file");
			await setTriggerDisabled(ref, true);
			expect(await readFile(runFilePath(ref), "utf8")).toContain(
				'"triggerDisabled": true',
			);
			await setTriggerDisabled(ref, false);
			expect(await readFile(runFilePath(ref), "utf8")).not.toContain(
				"triggerDisabled",
			);
		});

		it("preserves the disabled flag across an unrelated writeRun (triggerRun)", async () => {
			const ref = await tempStore("thread-flag-preserve");
			await setTriggerDisabled(ref, true);
			await triggerRun(ref, "ultrawork keep the flag");
			expect(await isTriggerDisabled(ref)).toBe(true);
			expect(await readRun(ref)).toMatchObject({
				goal: "ultrawork keep the flag",
				status: "running",
			});
		});
	});

	describe("alwaysOn flag", () => {
		it("defaults to off and round-trips", async () => {
			const ref = await tempStore("thread-always-toggle");
			expect(await isAlwaysOn(ref)).toBe(false);
			await setAlwaysOn(ref, true);
			expect(await isAlwaysOn(ref)).toBe(true);
			await setAlwaysOn(ref, false);
			expect(await isAlwaysOn(ref)).toBe(false);
		});

		it("is mutually exclusive with triggerDisabled: each setter clears the other", async () => {
			const ref = await tempStore("thread-mutex");
			await setTriggerDisabled(ref, true);
			await setAlwaysOn(ref, true);
			expect(await isAlwaysOn(ref)).toBe(true);
			expect(await isTriggerDisabled(ref)).toBe(false);
			await setTriggerDisabled(ref, true);
			expect(await isTriggerDisabled(ref)).toBe(true);
			expect(await isAlwaysOn(ref)).toBe(false);
		});
	});

	describe("pendingReinject flag", () => {
		it("set then consume returns true once, then false", async () => {
			const ref = await tempStore("thread-reinject");
			await triggerRun(ref, "ultrawork goal");
			await setPendingReinject(ref);
			expect(await consumePendingReinject(ref)).toBe(true);
			expect(await consumePendingReinject(ref)).toBe(false);
		});

		it("no-ops (false) when there is no run", async () => {
			const ref = await tempStore("thread-reinject-norun");
			expect(await setPendingReinject(ref)).toBeNull();
			expect(await consumePendingReinject(ref)).toBe(false);
		});
	});

	describe("pendingSteers queue", () => {
		it("appends and consumes steers exactly once, preserving order and case", async () => {
			const ref = await tempStore("thread-steer");
			await triggerRun(ref, "ultrawork goal");
			await addSteer(ref, "Use TypeScript strict mode");
			await addSteer(ref, "Focus on the auth module");
			expect(await consumeSteers(ref)).toEqual([
				"Use TypeScript strict mode",
				"Focus on the auth module",
			]);
			expect(await consumeSteers(ref)).toEqual([]);
		});

		it("ignores a blank steer and no-ops without a run", async () => {
			const ref = await tempStore("thread-steer-edge");
			expect(await addSteer(ref, "anything")).toBeNull();
			await triggerRun(ref, "ultrawork goal");
			await addSteer(ref, "   ");
			expect(await consumeSteers(ref)).toEqual([]);
		});
	});

	describe("all file-level fields preserved together", () => {
		it("a run write does not drop alwaysOn (writeStore preserves every flag)", async () => {
			const ref = await tempStore("thread-preserve-all");
			await setAlwaysOn(ref, true);
			// An unrelated run write must not clobber the file-level alwaysOn flag.
			await triggerRun(ref, "ultrawork keep everything");
			await addSteer(ref, "steer note");
			expect(await isAlwaysOn(ref)).toBe(true);
			expect(await readRun(ref)).toMatchObject({
				pendingSteers: ["steer note"],
			});
		});
	});
});

describe("ultraworkStoreRef", () => {
	it("scopes to the session directory when a session file exists", () => {
		const ref = ultraworkStoreRef({
			cwd: "/workspace/project",
			sessionManager: {
				getSessionFile: () => "/home/user/.pi/agent/sessions/abc.jsonl",
				getSessionDir: () => "/home/user/.pi/agent/sessions",
				getSessionId: () => "thread-abc",
			},
		});
		expect(ref.threadId).toBe("thread-abc");
		expect(ref.baseDir).toBe(
			join("/home/user/.pi/agent/sessions", "extensions", "ultrawork"),
		);
	});

	it("falls back to a cwd-keyed no-session directory when there is no session file", () => {
		const refA = ultraworkStoreRef({
			cwd: "/workspace/project",
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionDir: () => "unused",
				getSessionId: () => "thread-no-session",
			},
		});
		const refB = ultraworkStoreRef({
			cwd: "/workspace/other-project",
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionDir: () => "unused",
				getSessionId: () => "thread-no-session",
			},
		});

		expect(refA.baseDir).toContain(
			join("extensions", "ultrawork", "no-session"),
		);
		expect(refA.baseDir).not.toBe(refB.baseDir);
	});
});

async function tempStore(threadId = "thread-test"): Promise<UltraWorkStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "pi-ultrawork-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "ultrawork"), threadId };
}
