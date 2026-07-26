import { describe, expect, it } from "vitest";

import {
	parseSteerCommand,
	parseUltraworkCommand,
} from "../src/ultrawork/command.js";

describe("ultrawork command parsing", () => {
	it("treats bare /ulw as a status request", () => {
		expect(parseUltraworkCommand("")).toEqual({ kind: "status" });
		expect(parseUltraworkCommand("   ")).toEqual({ kind: "status" });
	});

	it("parses status explicitly", () => {
		expect(parseUltraworkCommand("status")).toEqual({ kind: "status" });
		expect(parseUltraworkCommand("STATUS")).toEqual({ kind: "status" });
	});

	it("parses stop", () => {
		expect(parseUltraworkCommand("stop")).toEqual({ kind: "stop" });
		expect(parseUltraworkCommand("STOP")).toEqual({ kind: "stop" });
	});

	it("parses the off/on trigger toggle, case-insensitively", () => {
		expect(parseUltraworkCommand("off")).toEqual({ kind: "off" });
		expect(parseUltraworkCommand("OFF")).toEqual({ kind: "off" });
		expect(parseUltraworkCommand("on")).toEqual({ kind: "on" });
		expect(parseUltraworkCommand("On")).toEqual({ kind: "on" });
	});

	it("parses the always on/off subcommand, case-insensitively", () => {
		expect(parseUltraworkCommand("always on")).toEqual({ kind: "always-on" });
		expect(parseUltraworkCommand("ALWAYS ON")).toEqual({ kind: "always-on" });
		expect(parseUltraworkCommand("always   off")).toEqual({
			kind: "always-off",
		});
		expect(parseUltraworkCommand("always")).toEqual({
			kind: "unknown",
			input: "always",
		});
		expect(parseUltraworkCommand("always sideways")).toEqual({
			kind: "unknown",
			input: "always sideways",
		});
	});

	it("no longer treats 'steer' as a /ulw subcommand (it moved to /ulw-steer)", () => {
		expect(parseUltraworkCommand("steer do the thing")).toEqual({
			kind: "unknown",
			input: "steer do the thing",
		});
	});

	it("treats unrecognized verbs as unknown, including the retired start/resume verbs", () => {
		expect(parseUltraworkCommand("start ship the release")).toEqual({
			kind: "unknown",
			input: "start ship the release",
		});
		expect(parseUltraworkCommand("resume")).toEqual({
			kind: "unknown",
			input: "resume",
		});
		expect(parseUltraworkCommand("pause")).toEqual({
			kind: "unknown",
			input: "pause",
		});
		expect(parseUltraworkCommand("clear")).toEqual({
			kind: "unknown",
			input: "clear",
		});
		expect(parseUltraworkCommand("help")).toEqual({
			kind: "unknown",
			input: "help",
		});
	});
});

describe("parseSteerCommand", () => {
	it("treats empty input as a list request", () => {
		expect(parseSteerCommand("")).toEqual({ kind: "list" });
		expect(parseSteerCommand("   ")).toEqual({ kind: "list" });
	});

	it("treats a bare 'clear' (case-insensitive) as the clear subcommand", () => {
		expect(parseSteerCommand("clear")).toEqual({ kind: "clear" });
		expect(parseSteerCommand("CLEAR")).toEqual({ kind: "clear" });
		expect(parseSteerCommand("  clear  ")).toEqual({ kind: "clear" });
	});

	it("treats anything else as an add with verbatim text (case + spacing)", () => {
		expect(
			parseSteerCommand("Use the Repository pattern for DB access"),
		).toEqual({
			kind: "add",
			text: "Use the Repository pattern for DB access",
		});
		expect(parseSteerCommand("Keep the API BACKWARD compatible")).toEqual({
			kind: "add",
			text: "Keep the API BACKWARD compatible",
		});
		// 'clear' as part of a longer instruction is an add, not the clear command.
		expect(parseSteerCommand("clear the cache first")).toEqual({
			kind: "add",
			text: "clear the cache first",
		});
	});
});
