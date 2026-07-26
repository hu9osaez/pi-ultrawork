import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	currentDispatchDepth,
	getFinalOutput,
	getPiInvocation,
	mapWithConcurrencyLimit,
	MAX_DISPATCH_DEPTH,
	runDispatch,
	runDispatchTask,
	summarizeDispatchResults,
	truncateOutput,
} from "../src/ultrawork/dispatch.js";
import type { DispatchTaskResult } from "../src/ultrawork/dispatch.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("mapWithConcurrencyLimit", () => {
	it("returns an empty array for no items", async () => {
		expect(await mapWithConcurrencyLimit([], 3, async (x) => x)).toEqual([]);
	});

	it("preserves input order regardless of completion order", async () => {
		const delays = [30, 10, 20, 0];
		const results = await mapWithConcurrencyLimit(
			delays,
			2,
			async (delay, index) => {
				await new Promise((resolve) => setTimeout(resolve, delay));
				return index;
			},
		);
		expect(results).toEqual([0, 1, 2, 3]);
	});

	it("never runs more than the concurrency limit at once", async () => {
		let active = 0;
		let maxActive = 0;
		const items = Array.from({ length: 8 }, (_, i) => i);

		await mapWithConcurrencyLimit(items, 3, async (item) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return item;
		});

		expect(maxActive).toBeLessThanOrEqual(3);
	});

	it("clamps concurrency to the item count", async () => {
		let active = 0;
		let maxActive = 0;
		const items = [1, 2];

		await mapWithConcurrencyLimit(items, 10, async (item) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return item;
		});

		expect(maxActive).toBeLessThanOrEqual(2);
	});
});

describe("summarizeDispatchResults", () => {
	it("reports no tasks", () => {
		expect(summarizeDispatchResults([])).toBe("ulw_dispatch: no tasks.");
	});

	it("counts successes and includes per-task output", () => {
		const results: DispatchTaskResult[] = [
			{ index: 0, task: "a", exitCode: 0, output: "done a" },
			{ index: 1, task: "b", exitCode: 1, output: "", errorMessage: "boom" },
		];
		const summary = summarizeDispatchResults(results);
		expect(summary).toContain("ulw_dispatch: 1/2 succeeded");
		expect(summary).toContain("done a");
		expect(summary).toContain("boom");
	});
});

describe("currentDispatchDepth", () => {
	it("defaults to 0 when the env var is unset", () => {
		expect(currentDispatchDepth({})).toBe(0);
	});

	it("reads a valid depth from the env var", () => {
		expect(currentDispatchDepth({ PI_ULTRAWORK_DISPATCH_DEPTH: "2" })).toBe(2);
	});

	it("falls back to 0 for a garbage value", () => {
		expect(
			currentDispatchDepth({ PI_ULTRAWORK_DISPATCH_DEPTH: "not-a-number" }),
		).toBe(0);
	});

	it("falls back to 0 for a negative value", () => {
		expect(currentDispatchDepth({ PI_ULTRAWORK_DISPATCH_DEPTH: "-1" })).toBe(0);
	});
});

describe("runDispatch depth guard", () => {
	afterEach(() => {
		delete process.env["PI_ULTRAWORK_DISPATCH_DEPTH"];
		vi.mocked(spawn).mockReset();
	});

	it("refuses to dispatch (without spawning any child process) once the max nesting depth is reached", async () => {
		process.env["PI_ULTRAWORK_DISPATCH_DEPTH"] = String(MAX_DISPATCH_DEPTH);

		const { results, summary } = await runDispatch(
			{ cwd: "/work" },
			{ tasks: [{ task: "a" }, { task: "b" }] },
			undefined,
			undefined,
		);

		expect(summary).toEqual({ taskCount: 2, succeeded: 0, failed: 2 });
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.exitCode).not.toBe(0);
			expect(result.errorMessage).toContain("refused");
		}
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("runDispatch progress reporting", () => {
	class FakeChildProcess extends EventEmitter {
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		killed = false;
		kill = vi.fn((_signal?: string) => true);
	}

	afterEach(() => {
		delete process.env["PI_ULTRAWORK_DISPATCH_DEPTH"];
		vi.mocked(spawn).mockReset();
	});

	it("emits a running transition (started, not yet done) before tasks finish, then a final all-done frame", async () => {
		const procs: FakeChildProcess[] = [];
		vi.mocked(spawn).mockImplementation(() => {
			const proc = new FakeChildProcess();
			procs.push(proc);
			return proc as unknown as ChildProcess;
		});

		const frames: Array<{ total: number; done: number; running: number }> = [];
		const onUpdate = (partial: {
			details?: { results: DispatchTaskResult[] };
		}) => {
			const results = partial.details?.results ?? [];
			frames.push({
				total: results.length,
				done: results.filter((r) => r.exitCode !== -1).length,
				running: results.filter((r) => r.started === true && r.exitCode === -1)
					.length,
			});
		};

		const promise = runDispatch(
			{ cwd: "/work" },
			{ tasks: [{ task: "a" }, { task: "b" }], concurrency: 2 },
			undefined,
			onUpdate as never,
		);

		// Let both workers spawn and mark themselves started.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(procs).toHaveLength(2);
		expect(frames.some((f) => f.running === 2 && f.done === 0)).toBe(true);

		for (const proc of procs) {
			const line = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n`;
			proc.stdout.emit("data", Buffer.from(line));
			proc.emit("close", 0);
		}

		const { summary } = await promise;
		expect(summary).toEqual({ taskCount: 2, succeeded: 2, failed: 0 });
		expect(frames.at(-1)).toEqual({ total: 2, done: 2, running: 0 });
	});
});

describe("getPiInvocation", () => {
	const originalArgv1 = process.argv[1];
	const originalExecPath = process.execPath;

	afterEach(() => {
		if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
		process.execPath = originalExecPath;
	});

	it("re-invokes the current script directly when it exists on disk", () => {
		const thisFile = fileURLToPath(import.meta.url);
		process.argv[1] = thisFile;
		const result = getPiInvocation(["--mode", "json"]);
		expect(result).toEqual({
			command: process.execPath,
			args: [thisFile, "--mode", "json"],
		});
	});

	it("falls back to the bare `pi` binary for a bun virtual script under a generic runtime", () => {
		process.argv[1] = "/$bunfs/root/pi";
		process.execPath = "/usr/local/bin/node";
		const result = getPiInvocation(["x"]);
		expect(result).toEqual({ command: "pi", args: ["x"] });
	});

	it("falls back to the bare `pi` binary when the script path does not exist under a generic runtime", () => {
		process.argv[1] = "/definitely/does/not/exist/pi-entry.js";
		process.execPath = "/usr/local/bin/node";
		const result = getPiInvocation(["y"]);
		expect(result).toEqual({ command: "pi", args: ["y"] });
	});

	it("re-invokes the runtime's own execPath directly for a non-generic (compiled) runtime", () => {
		process.argv[1] = "/definitely/does/not/exist/pi-entry.js";
		process.execPath = "/usr/local/bin/pi";
		const result = getPiInvocation(["z"]);
		expect(result).toEqual({ command: "/usr/local/bin/pi", args: ["z"] });
	});
});

describe("getFinalOutput", () => {
	it("returns empty string for no messages", () => {
		expect(getFinalOutput([])).toBe("");
	});

	it("returns the last assistant text content, scanning from the end", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{
				role: "user",
				content: [{ type: "text", text: "ignored (not assistant)" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		];
		expect(getFinalOutput(messages)).toBe("second");
	});

	it("ignores malformed entries (non-record, missing content, non-text parts)", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "keep me" }] },
			null,
			"not a record",
			{ role: "assistant" },
			{ role: "assistant", content: "not an array" },
			{ role: "assistant", content: [{ type: "image" }] },
		];
		expect(getFinalOutput(messages)).toBe("keep me");
	});
});

describe("truncateOutput", () => {
	it("returns output unchanged when under the cap", () => {
		expect(truncateOutput("hello world")).toBe("hello world");
	});

	it("truncates output over the cap and reports omitted bytes", () => {
		const big = "a".repeat(25 * 1024);
		const result = truncateOutput(big);
		expect(result).toContain("[Output truncated:");
		expect(result.startsWith("a".repeat(20 * 1024))).toBe(true);
	});

	it("never splits a multi-byte UTF-8 character at the truncation boundary", () => {
		// Pad so the naive byte-slice cut point lands in the middle of a 4-byte emoji.
		const padding = "a".repeat(20 * 1024 - 2);
		const input = `${padding}🙂more text after the emoji`;
		const result = truncateOutput(input);
		const [body] = result.split("\n\n[Output truncated:");
		expect(body).toBeDefined();
		// A broken multi-byte sequence would decode with U+FFFD replacement characters.
		expect(body).not.toContain("�");
		expect(Buffer.byteLength(body ?? "", "utf8")).toBeLessThanOrEqual(
			20 * 1024,
		);
	});
});

describe("runDispatchTask", () => {
	class FakeChildProcess extends EventEmitter {
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		killed = false;
		kill = vi.fn((_signal?: string) => true);
	}

	afterEach(() => {
		vi.mocked(spawn).mockReset();
		vi.useRealTimers();
	});

	function mockSpawn(): FakeChildProcess {
		const proc = new FakeChildProcess();
		vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
		return proc;
	}

	function emitMessageEnd(proc: FakeChildProcess, text: string): void {
		const line = `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
		proc.stdout.emit("data", Buffer.from(line));
	}

	it("captures the final assistant text and exits cleanly on success", async () => {
		const proc = mockSpawn();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 0,
			task: "do the thing",
			cwd: undefined,
			signal: undefined,
			onProgress: undefined,
		});

		emitMessageEnd(proc, "hello from child");
		proc.emit("close", 0);

		const result = await promise;
		expect(result).toEqual({
			index: 0,
			task: "do the thing",
			exitCode: 0,
			output: "hello from child",
		});
	});

	it("silently skips malformed / non-JSON NDJSON lines", async () => {
		const proc = mockSpawn();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 1,
			task: "t",
			cwd: undefined,
			signal: undefined,
			onProgress: undefined,
		});

		proc.stdout.emit("data", Buffer.from("not json at all\n"));
		proc.stdout.emit(
			"data",
			Buffer.from(`${JSON.stringify({ type: "other_event" })}\n`),
		);
		emitMessageEnd(proc, "the real output");
		proc.emit("close", 0);

		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("the real output");
	});

	it("reports stderr as the error message on non-zero exit", async () => {
		const proc = mockSpawn();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 2,
			task: "t",
			cwd: undefined,
			signal: undefined,
			onProgress: undefined,
		});

		proc.stderr.emit("data", Buffer.from("boom\n"));
		proc.emit("close", 1);

		const result = await promise;
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toBe("boom");
	});

	it("reports a spawn failure via the process 'error' event", async () => {
		const proc = mockSpawn();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 3,
			task: "t",
			cwd: undefined,
			signal: undefined,
			onProgress: undefined,
		});

		proc.emit("error", new Error("ENOENT"));

		const result = await promise;
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toBe("Failed to spawn pi: ENOENT");
	});

	it("sends SIGTERM and reports abortion when the signal fires mid-flight", async () => {
		const proc = mockSpawn();
		const controller = new AbortController();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 4,
			task: "t",
			cwd: undefined,
			signal: controller.signal,
			onProgress: undefined,
		});

		controller.abort();
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

		proc.emit("close", 143);
		const result = await promise;
		expect(result.errorMessage).toBe("Dispatch task was aborted");
	});

	it("force-kills with SIGKILL if the process hasn't exited 5s after SIGTERM", async () => {
		vi.useFakeTimers();
		const proc = mockSpawn();
		const controller = new AbortController();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 5,
			task: "t",
			cwd: undefined,
			signal: controller.signal,
			onProgress: undefined,
		});

		controller.abort();
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");

		await vi.advanceTimersByTimeAsync(5000);
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

		proc.emit("close", 137);
		const result = await promise;
		expect(result.errorMessage).toBe("Dispatch task was aborted");
	});

	it("does not force-kill with SIGKILL if the process already exited before the timeout", async () => {
		vi.useFakeTimers();
		const proc = mockSpawn();
		const controller = new AbortController();
		const promise = runDispatchTask({
			defaultCwd: "/work",
			index: 6,
			task: "t",
			cwd: undefined,
			signal: controller.signal,
			onProgress: undefined,
		});

		controller.abort();
		proc.killed = true;
		proc.emit("close", 143);
		await promise;

		await vi.advanceTimersByTimeAsync(5000);
		expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
	});
});
