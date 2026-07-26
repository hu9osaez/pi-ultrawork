import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ultrawork/dispatch.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/ultrawork/dispatch.js")>();
	return { ...actual, runDispatch: vi.fn() };
});

import extension from "../src/index.js";
import { AUTO_CONTINUE_CAP } from "../src/ultrawork/continuation.js";
import {
	DispatchParams,
	runDispatch,
	summarizeDispatchResults,
} from "../src/ultrawork/dispatch.js";
import {
	buildContinuationPrompt,
	buildReinjectDirective,
	buildUltraworkDirective,
} from "../src/ultrawork/prompt.js";
import {
	isAlwaysOn,
	isTriggerDisabled,
	readRun,
	recordAutoContinueAttempt,
	setAlwaysOn,
	stopRun,
	triggerRun,
	ultraworkStoreRef,
} from "../src/ultrawork/store.js";
import type {
	UltraWorkRun,
	UltraWorkStoreRef,
} from "../src/ultrawork/types.js";
import { STATUS_KEY, ultraworkStatusText } from "../src/ultrawork/ui.js";

const ULTRAWORK_CONTINUATION_MESSAGE_TYPE = "pi-ultrawork-continuation";
const ULTRAWORK_DIRECTIVE_MESSAGE_TYPE = "pi-ultrawork-directive";
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX =
	"This extension ctx is stale after session replacement or reload.";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.mocked(runDispatch).mockReset();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("index extension wiring", () => {
	it("registers the ulw_dispatch and ulw_complete tools", () => {
		const { api, tools } = createFakeApi();
		extension(api);

		expect(tools).toHaveLength(2);
		const dispatchTool = tools.find((t) => t.name === "ulw_dispatch");
		expect(dispatchTool?.label).toBe("UltraWork Dispatch");
		expect(dispatchTool?.parameters).toBe(DispatchParams);

		const completeTool = tools.find((t) => t.name === "ulw_complete");
		expect(completeTool?.label).toBe("UltraWork Complete");
		expect(typeof completeTool?.description).toBe("string");
		expect(completeTool?.description.length).toBeGreaterThan(0);
	});

	it("registers the ulw command", () => {
		const { api, commands } = createFakeApi();
		extension(api);
		expect(commands.has("ulw")).toBe(true);
		expect(typeof commands.get("ulw")?.handler).toBe("function");
	});

	it("registers before_agent_start, session_start, session_compact, agent_start, agent_end, agent_settled, and session_shutdown handlers", () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		expect(handlers.has("before_agent_start")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_compact")).toBe(true);
		expect(handlers.has("agent_start")).toBe(true);
		expect(handlers.has("agent_end")).toBe(true);
		expect(handlers.has("agent_settled")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});
});

describe("ulw_dispatch tool execution", () => {
	it("folds the dispatch summary into an existing run and refreshes the footer", async () => {
		const { api, tools } = createFakeApi();
		extension(api);
		const tool = tools.find((t) => t.name === "ulw_dispatch");
		if (!tool) throw new Error("tool not registered");

		const { ctx, ref, statuses } = await createFakeCtx();
		await triggerRun(ref, "ultrawork ship it");

		const fakeResults = [{ index: 0, task: "a", exitCode: 0, output: "done" }];
		vi.mocked(runDispatch).mockResolvedValue({
			results: fakeResults,
			summary: { taskCount: 1, succeeded: 1, failed: 0 },
		});

		const response = await tool.execute(
			"call-1",
			{ tasks: [{ task: "a" }] },
			undefined,
			undefined,
			ctx,
		);

		// The handler now wraps onUpdate in a footer-mirroring callback, so the 4th arg is a function.
		expect(runDispatch).toHaveBeenCalledWith(
			ctx,
			{ tasks: [{ task: "a" }] },
			undefined,
			expect.any(Function),
		);
		expect(response.details.results).toEqual(fakeResults);
		expect(response.content[0].text).toBe(
			summarizeDispatchResults(fakeResults),
		);

		const updatedRun = await readRun(ref);
		expect(updatedRun?.dispatchCount).toBe(1);
		expect(statuses.get(STATUS_KEY)).toBe(
			ultraworkStatusText(updatedRun as UltraWorkRun),
		);
	});

	it("does not touch the footer when no run exists and no live progress was shown", async () => {
		const { api, tools } = createFakeApi();
		extension(api);
		const tool = tools.find((t) => t.name === "ulw_dispatch");
		if (!tool) throw new Error("tool not registered");

		const { ctx, statuses } = await createFakeCtx();
		vi.mocked(runDispatch).mockResolvedValue({
			results: [],
			summary: { taskCount: 0, succeeded: 0, failed: 0 },
		});

		await tool.execute(
			"call-1",
			{ tasks: [{ task: "a" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(statuses.has(STATUS_KEY)).toBe(false);
	});

	it("announces the launch and mirrors live dispatch progress onto the footer", async () => {
		const { api, tools } = createFakeApi();
		extension(api);
		const tool = tools.find((t) => t.name === "ulw_dispatch");
		if (!tool) throw new Error("tool not registered");

		const { ctx, ref, statuses, notifications } = await createFakeCtx();
		await triggerRun(ref, "ultrawork ship it");

		const liveStatuses: Array<string | undefined> = [];
		// Make the mocked runDispatch drive the handler's onUpdate to simulate live progress.
		vi.mocked(runDispatch).mockImplementation(
			async (_ctx, _params, _signal, onUpdate) => {
				onUpdate?.({
					content: [{ type: "text", text: "live" }],
					details: {
						results: [
							{ index: 0, task: "a", exitCode: -1, output: "", started: true },
							{ index: 1, task: "b", exitCode: -1, output: "", started: true },
						],
					},
				});
				liveStatuses.push(statuses.get(STATUS_KEY));
				return {
					results: [],
					summary: { taskCount: 2, succeeded: 2, failed: 0 },
				};
			},
		);

		await tool.execute(
			"call-1",
			{ tasks: [{ task: "a" }, { task: "b" }] },
			undefined,
			undefined,
			ctx,
		);

		expect(
			notifications.some((n) => n.message.includes("launching 2 sub-tasks")),
		).toBe(true);
		expect(liveStatuses).toContain(
			"● UltraWork dispatch — 0/2 done · 2 running",
		);
	});
});

describe("ulw_complete tool execution", () => {
	it("completes a running run, updates the footer, and disarms continuation", async () => {
		const { api, tools, handlers, sentMessages } = createFakeApi();
		extension(api);
		const tool = tools.find((t) => t.name === "ulw_complete");
		if (!tool) throw new Error("tool not registered");

		const { ctx, ref, statuses } = await createFakeCtx({
			hasPendingMessages: false,
		});
		await triggerRun(ref, "ultrawork ship it");

		const response = await tool.execute(
			"call-1",
			{ summary: "shipped it" },
			undefined,
			undefined,
			ctx,
		);

		expect(response.content[0].text).toContain("UltraWork complete");
		expect(response.content[0].text).toContain("shipped it");
		expect(response.details.run.status).toBe("complete");

		const run = await readRun(ref);
		expect(run?.status).toBe("complete");
		expect(run?.summary).toBe("shipped it");
		expect(statuses.get(STATUS_KEY)).toBe(
			ultraworkStatusText(run as UltraWorkRun),
		);

		// A completed run must never get an auto-continuation prompt queued for it.
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(sentMessages).toHaveLength(0);
	});

	it("returns a friendly error result instead of throwing when there is no run", async () => {
		const { api, tools } = createFakeApi();
		extension(api);
		const tool = tools.find((t) => t.name === "ulw_complete");
		if (!tool) throw new Error("tool not registered");

		const { ctx } = await createFakeCtx();

		const response = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			ctx,
		);

		expect(response.content[0].text).toContain("No UltraWork run to complete");
		expect(response.details.run).toBeNull();
	});
});

describe("before_agent_start trigger detection", () => {
	it("starts a fresh run and injects the directive when the prompt contains 'ultrawork'", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref, statuses } = await createFakeCtx();

		const result = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "let's ultrawork this feature" },
			ctx,
		);

		const run = await readRun(ref);
		expect(run?.status).toBe("running");
		expect(run?.goal).toBe("let's ultrawork this feature");
		expect(statuses.get(STATUS_KEY)).toContain("running");

		expect(result?.message).toMatchObject({
			customType: ULTRAWORK_DIRECTIVE_MESSAGE_TYPE,
			display: true,
		});
		expect(result?.message?.content).toBe(
			buildUltraworkDirective(run as UltraWorkRun),
		);
	});

	it("matches the bare 'ulw' keyword as a whole word too", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "ulw fix the auth bug" },
			ctx,
		);

		const run = await readRun(ref);
		expect(run?.status).toBe("running");
	});

	it("does not match substrings that merely contain the trigger word", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		const result = await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "ultraworking on the bulwark defenses",
			},
			ctx,
		);

		expect(result).toBeUndefined();
		expect(await readRun(ref)).toBeNull();
	});

	it("is a safe no-op refresh while already running: no directive re-injection, no state reset", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "ultrawork the original goal" },
			ctx,
		);
		await recordAutoContinueAttempt(ref);
		const before = await readRun(ref);

		const result = await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				prompt: "ultrawork mentioned again mid-run",
			},
			ctx,
		);

		expect(result).toBeUndefined();
		const after = await readRun(ref);
		expect(after?.id).toBe(before?.id);
		expect(after?.goal).toBe(before?.goal);
		expect(after?.startedAt).toBe(before?.startedAt);
		expect(after?.dispatchCount).toBe(before?.dispatchCount);
		expect(after?.autoContinueAttempts).toBe(before?.autoContinueAttempts);
	});

	it("does nothing when the prompt has no trigger word", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		const result = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "just fix the bug please" },
			ctx,
		);

		expect(result).toBeUndefined();
		expect(await readRun(ref)).toBeNull();
	});

	it("notifies instead of throwing when the triggering prompt fails validation", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx();

		const overlong = `ultrawork ${"x".repeat(5000)}`;
		const result = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: overlong },
			ctx,
		);

		expect(result).toBeUndefined();
		expect(notifications.at(-1)).toMatchObject({ type: "error" });
		expect(notifications.at(-1)?.message).toContain("too long");
		expect(await readRun(ref)).toBeNull();
	});
});

describe("always-on mode (integration)", () => {
	it("a no-keyword prompt starts a run with the prompt as goal when always-on is set", async () => {
		const { api, handlers, commands } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		await commands.get("ulw")?.handler("always on", ctx);
		expect(await isAlwaysOn(ref)).toBe(true);

		const result = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "refactor the auth module" },
			ctx,
		);
		const run = await readRun(ref);
		expect(run?.status).toBe("running");
		expect(run?.goal).toBe("refactor the auth module");
		expect(result?.message?.customType).toBe(ULTRAWORK_DIRECTIVE_MESSAGE_TYPE);
	});

	it("`/ulw always off` reverts triggering but does not stop the running run", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await triggerRun(ref, "ultrawork keep running");
		await setAlwaysOn(ref, true);

		await commands.get("ulw")?.handler("always off", ctx);
		expect(await isAlwaysOn(ref)).toBe(false);
		expect((await readRun(ref))?.status).toBe("running");
	});

	it("`/ulw off` clears always-on (mutually exclusive)", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await setAlwaysOn(ref, true);

		await commands.get("ulw")?.handler("off", ctx);
		expect(await isAlwaysOn(ref)).toBe(false);
		expect(await isTriggerDisabled(ref)).toBe(true);
	});
});

describe("session_compact reinjection (integration)", () => {
	it("flags a running run on compaction, then before_agent_start reinjects exactly once", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await triggerRun(ref, "ultrawork build the thing");

		await handlers.get("session_compact")?.({ type: "session_compact" }, ctx);

		const result = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "ok continue" },
			ctx,
		);
		const run = await readRun(ref);
		expect(result?.message?.content).toBe(
			buildReinjectDirective(run as UltraWorkRun),
		);

		const second = await handlers.get("before_agent_start")?.(
			{ type: "before_agent_start", prompt: "still going" },
			ctx,
		);
		expect(second).toBeUndefined();
	});

	it("does nothing when there is no running run", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await handlers.get("session_compact")?.({ type: "session_compact" }, ctx);
		expect(await readRun(ref)).toBeNull();
	});
});

describe("/ulw-steer command (integration)", () => {
	it("registers the ulw-steer command", () => {
		const { api, commands } = createFakeApi();
		extension(api);
		expect(commands.has("ulw-steer")).toBe(true);
	});

	it("queues a steer without applying it when the agent is busy (not idle)", async () => {
		const { api, commands, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx({ isIdle: false });
		await triggerRun(ref, "ultrawork ship it");

		await commands.get("ulw-steer")?.handler("use the Repository pattern", ctx);
		expect((await readRun(ref))?.pendingSteers).toEqual([
			"use the Repository pattern",
		]);
		expect(notifications.at(-1)?.message).toContain("Steer queued");
		expect(sentMessages).toHaveLength(0);
	});

	it("applies a steer immediately when idle: consumes it and queues a visible continuation", async () => {
		const { api, commands, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx({ isIdle: true });
		await triggerRun(ref, "ultrawork ship it");

		await commands.get("ulw-steer")?.handler("prefer composition", ctx);

		expect((await readRun(ref))?.pendingSteers ?? []).toEqual([]);
		expect(notifications.at(-1)?.message).toContain("Steer applied now");
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message?.content).toContain("prefer composition");
		expect(sentMessages[0]?.message?.display).toBe(true);
	});

	it("warns when there is no running run to steer", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, notifications } = await createFakeCtx();
		await commands.get("ulw-steer")?.handler("focus on tests", ctx);
		expect(notifications.at(-1)).toMatchObject({ type: "warning" });
	});

	it("lists pending steers with bare /ulw-steer and clears them with 'clear'", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx({ isIdle: false });
		await triggerRun(ref, "ultrawork ship it");
		await commands.get("ulw-steer")?.handler("first note", ctx);
		await commands.get("ulw-steer")?.handler("second note", ctx);

		await commands.get("ulw-steer")?.handler("", ctx);
		expect(notifications.at(-1)?.message).toContain("Pending steers (2)");

		await commands.get("ulw-steer")?.handler("clear", ctx);
		expect(notifications.at(-1)?.message).toContain("Cleared 2");
		expect((await readRun(ref))?.pendingSteers ?? []).toEqual([]);
	});
});

describe("stuck-detector cap", () => {
	it("queues hidden continuations up to the cap, then marks the run stuck and stops queueing", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications, statuses } = await createFakeCtx({
			hasPendingMessages: false,
		});
		await triggerRun(ref, "ultrawork keep going");

		for (let attempt = 1; attempt <= AUTO_CONTINUE_CAP; attempt++) {
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
			expect(sentMessages).toHaveLength(attempt);
			const run = await readRun(ref);
			expect(run?.status).toBe("running");
			expect(run?.autoContinueAttempts).toBe(attempt);
		}

		// One more settle would exceed the cap: give up instead of queueing again.
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(sentMessages).toHaveLength(AUTO_CONTINUE_CAP);

		const run = await readRun(ref);
		expect(run?.status).toBe("stuck");
		expect(statuses.get(STATUS_KEY)).toContain("stuck");
		expect(notifications.at(-1)).toMatchObject({ type: "warning" });
		expect(notifications.at(-1)?.message).toContain("stuck");
	});

	it("does not queue further hidden continuations once stuck", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({ hasPendingMessages: false });
		await triggerRun(ref, "ultrawork keep going");
		for (let i = 0; i < AUTO_CONTINUE_CAP + 1; i++) {
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		}
		sentMessages.length = 0;

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sentMessages).toHaveLength(0);
	});

	it("resets the counter on a completed ulw_dispatch, avoiding a premature stuck transition", async () => {
		const { api, handlers, tools, sentMessages } = createFakeApi();
		extension(api);
		const dispatchTool = tools.find((t) => t.name === "ulw_dispatch");
		if (!dispatchTool) throw new Error("tool not registered");

		const { ctx, ref } = await createFakeCtx({ hasPendingMessages: false });
		await triggerRun(ref, "ultrawork keep going");

		for (let i = 0; i < AUTO_CONTINUE_CAP; i++) {
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		}
		expect((await readRun(ref))?.autoContinueAttempts).toBe(AUTO_CONTINUE_CAP);

		vi.mocked(runDispatch).mockResolvedValue({
			results: [],
			summary: { taskCount: 1, succeeded: 1, failed: 0 },
		});
		await dispatchTool.execute(
			"call-1",
			{ tasks: [{ task: "a" }] },
			undefined,
			undefined,
			ctx,
		);
		expect((await readRun(ref))?.autoContinueAttempts).toBe(0);

		sentMessages.length = 0;
		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sentMessages).toHaveLength(1);
		expect((await readRun(ref))?.status).toBe("running");
	});
});

describe("/ulw command", () => {
	it("status: notifies with a warning when there is no run and clears the footer", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, notifications, statuses } = await createFakeCtx();

		await commands.get("ulw")?.handler("status", ctx);

		expect(notifications.at(-1)).toMatchObject({ type: "warning" });
		expect(notifications.at(-1)?.message).toContain("UltraWork is not running");
		expect(statuses.get(STATUS_KEY)).toBeUndefined();
		expect(statuses.has(STATUS_KEY)).toBe(true);
	});

	it("status: reports the current run", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx();
		await triggerRun(ref, "ultrawork ship the release");

		await commands.get("ulw")?.handler("status", ctx);

		expect(notifications.at(-1)).toMatchObject({ type: "info" });
		expect(notifications.at(-1)?.message).toContain(
			"Goal: ultrawork ship the release",
		);
	});

	it("stop: stops the run, notifies, and does not queue continuation", async () => {
		const { api, commands, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref, notifications } = await createFakeCtx({
			hasPendingMessages: false,
		});
		await triggerRun(ref, "ultrawork keep going");

		await commands.get("ulw")?.handler("stop", ctx);

		expect(notifications.at(-1)?.message).toContain("UltraWork stopped");
		const run = await readRun(ref);
		expect(run?.status).toBe("stopped");

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(sentMessages).toHaveLength(0);
	});

	it("unknown subcommand: notifies with usage and a warning", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, notifications } = await createFakeCtx();

		await commands.get("ulw")?.handler("frobnicate", ctx);

		expect(notifications.at(-1)).toMatchObject({ type: "warning" });
		expect(notifications.at(-1)?.message).toContain(
			'Unknown /ulw subcommand: "frobnicate"',
		);
	});

	it("start/resume are no longer recognized verbs: they fall through to unknown", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, notifications } = await createFakeCtx();

		await commands.get("ulw")?.handler("start ship the release", ctx);
		expect(notifications.at(-1)?.message).toContain(
			'Unknown /ulw subcommand: "start ship the release"',
		);

		await commands.get("ulw")?.handler("resume", ctx);
		expect(notifications.at(-1)?.message).toContain(
			'Unknown /ulw subcommand: "resume"',
		);
	});

	it("surfaces thrown errors from the command handler as error notifications", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, notifications } = await createFakeCtx();

		await commands.get("ulw")?.handler("stop", ctx);

		expect(notifications.at(-1)).toEqual({
			message: "No UltraWork run to stop.",
			type: "error",
		});
	});
});

describe("/ulw off and on command", () => {
	it("off sets triggerDisabled to true in the store", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		expect(await isTriggerDisabled(ref)).toBe(false);
		await commands.get("ulw")?.handler("off", ctx);
		expect(await isTriggerDisabled(ref)).toBe(true);
	});

	it("on clears the disabled flag", async () => {
		const { api, commands } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();

		await commands.get("ulw")?.handler("off", ctx);
		expect(await isTriggerDisabled(ref)).toBe(true);

		await commands.get("ulw")?.handler("on", ctx);
		expect(await isTriggerDisabled(ref)).toBe(false);
	});
});

describe("session_start event", () => {
	it("queues hidden continuation for a running run when idle with nothing pending", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({
			isIdle: true,
			hasPendingMessages: false,
		});
		const { run } = await triggerRun(ref, "ultrawork resume me");

		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0]?.message).toMatchObject({
			customType: ULTRAWORK_CONTINUATION_MESSAGE_TYPE,
			display: false,
		});
		expect(sentMessages[0]?.message.content).toBe(buildContinuationPrompt(run));

		const updated = await readRun(ref);
		expect(updated?.autoContinueAttempts).toBe(1);
	});

	it("does not queue continuation when there are pending messages", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({
			isIdle: true,
			hasPendingMessages: true,
		});
		await triggerRun(ref, "ultrawork resume me");

		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		expect(sentMessages).toHaveLength(0);
	});

	it("refreshes the footer even when there is no run", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, statuses } = await createFakeCtx();

		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		expect(statuses.has(STATUS_KEY)).toBe(true);
		expect(statuses.get(STATUS_KEY)).toBeUndefined();
	});
});

describe("agent_start / agent_end footer refresh (best-effort)", () => {
	it("agent_start refreshes the footer for the current run", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref, statuses } = await createFakeCtx();
		await triggerRun(ref, "ultrawork track me");

		await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);

		expect(statuses.get(STATUS_KEY)).toContain("track me");
	});

	it("agent_start swallows a stale-context error without throwing", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await triggerRun(ref, "ultrawork track me");
		ctx.ui.setStatus = () => {
			throw new Error(`${STALE_EXTENSION_CONTEXT_ERROR_PREFIX} details`);
		};

		await expect(
			handlers.get("agent_start")?.({ type: "agent_start" }, ctx),
		).resolves.toBeUndefined();
	});

	it("agent_start rethrows non-stale-context errors", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx();
		await triggerRun(ref, "ultrawork track me");
		ctx.ui.setStatus = () => {
			throw new Error("boom");
		};

		await expect(
			handlers.get("agent_start")?.({ type: "agent_start" }, ctx),
		).rejects.toThrow("boom");
	});

	it("agent_end refreshes the footer but no longer queues continuation itself (that moved to agent_settled)", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref, statuses } = await createFakeCtx({
			hasPendingMessages: false,
		});
		await triggerRun(ref, "ultrawork track me");

		await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);

		expect(statuses.get(STATUS_KEY)).toContain("track me");
		expect(sentMessages).toHaveLength(0);
	});
});

describe("agent_settled event", () => {
	it("queues continuation when nothing is pending", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({ hasPendingMessages: false });
		await triggerRun(ref, "ultrawork track me");

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sentMessages).toHaveLength(1);
	});

	it("does not queue continuation when messages are pending", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({ hasPendingMessages: true });
		await triggerRun(ref, "ultrawork track me");

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sentMessages).toHaveLength(0);
	});

	it("does not queue continuation for a non-running run", async () => {
		const { api, handlers, sentMessages } = createFakeApi();
		extension(api);
		const { ctx, ref } = await createFakeCtx({ hasPendingMessages: false });
		await triggerRun(ref, "ultrawork track me");
		await stopRun(ref);

		await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sentMessages).toHaveLength(0);
	});
});

describe("session_shutdown event", () => {
	it("clears the footer status when UI is available", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, statuses } = await createFakeCtx({ hasUI: true });

		await handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);

		expect(statuses.get(STATUS_KEY)).toBeUndefined();
		expect(statuses.has(STATUS_KEY)).toBe(true);
	});

	it("does nothing when there is no UI", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx, statuses } = await createFakeCtx({ hasUI: false });

		await handlers.get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			ctx,
		);

		expect(statuses.has(STATUS_KEY)).toBe(false);
	});

	it("silently swallows any error while clearing the footer (best-effort teardown)", async () => {
		const { api, handlers } = createFakeApi();
		extension(api);
		const { ctx } = await createFakeCtx({ hasUI: true });
		ctx.ui.setStatus = () => {
			throw new Error("ctx already torn down");
		};

		await expect(
			handlers.get("session_shutdown")?.(
				{ type: "session_shutdown", reason: "quit" },
				ctx,
			),
		).resolves.toBeUndefined();
	});
});

// --- test harness -----------------------------------------------------------

type FakeHandler = (
	event: unknown,
	ctx: ExtensionCommandContext,
	// biome-ignore lint/suspicious/noExplicitAny: test harness stand-in for the various ExtensionEvent handler return types
) => Promise<any> | any;
type FakeCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};
type FakeSentMessage = {
	message: { customType: string; content: string; display: boolean };
	options: unknown;
};
type FakeTool = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionCommandContext,
		// biome-ignore lint/suspicious/noExplicitAny: test harness stand-in for AgentToolResult<TDetails>
	) => Promise<any>;
};

function createFakeApi(): {
	api: ExtensionAPI;
	tools: FakeTool[];
	commands: Map<string, FakeCommand>;
	handlers: Map<string, FakeHandler>;
	sentMessages: FakeSentMessage[];
} {
	const tools: FakeTool[] = [];
	const commands = new Map<string, FakeCommand>();
	const handlers = new Map<string, FakeHandler>();
	const sentMessages: FakeSentMessage[] = [];

	const fakeApi = {
		registerTool: (tool: FakeTool) => {
			tools.push(tool);
		},
		registerCommand: (name: string, options: FakeCommand) => {
			commands.set(name, options);
		},
		on: (event: string, handler: FakeHandler) => {
			handlers.set(event, handler);
		},
		sendMessage: (message: FakeSentMessage["message"], options: unknown) => {
			sentMessages.push({ message, options });
		},
	};

	return {
		api: fakeApi as unknown as ExtensionAPI,
		tools,
		commands,
		handlers,
		sentMessages,
	};
}

async function createFakeCtx(
	options: {
		isIdle?: boolean;
		hasPendingMessages?: boolean;
		hasUI?: boolean;
	} = {},
): Promise<{
	ctx: ExtensionCommandContext;
	ref: UltraWorkStoreRef;
	notifications: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}>;
	statuses: Map<string, string | undefined>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "pi-ultrawork-index-"));
	tempDirs.push(dir);
	const threadId = `thread-${randomUUID()}`;

	const notifications: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	const statuses = new Map<string, string | undefined>();

	const rawCtx = {
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push(
					type === undefined ? { message } : { message, type },
				);
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
		},
		hasUI: options.hasUI ?? true,
		cwd: dir,
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
		},
		isIdle: () => options.isIdle ?? true,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
	};

	const ctx = rawCtx as unknown as ExtensionCommandContext;
	const ref = ultraworkStoreRef(ctx);

	return { ctx, ref, notifications, statuses };
}
