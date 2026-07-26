import { describe, expect, it } from "vitest";

import { parseUltraworkCommand } from "../src/ultrawork/command.js";

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

	it("parses steer and preserves the raw text verbatim (case + spacing)", () => {
		expect(
			parseUltraworkCommand("steer Use the Repository pattern for DB access"),
		).toEqual({
			kind: "steer",
			text: "Use the Repository pattern for DB access",
		});
		expect(
			parseUltraworkCommand("STEER Keep the API BACKWARD compatible"),
		).toEqual({
			kind: "steer",
			text: "Keep the API BACKWARD compatible",
		});
		expect(parseUltraworkCommand("steer")).toEqual({
			kind: "unknown",
			input: "steer",
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
