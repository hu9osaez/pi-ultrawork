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

	it("treats unrecognized verbs as unknown, including the retired start/resume verbs", () => {
		expect(parseUltraworkCommand("start ship the release")).toEqual({ kind: "unknown", input: "start ship the release" });
		expect(parseUltraworkCommand("resume")).toEqual({ kind: "unknown", input: "resume" });
		expect(parseUltraworkCommand("pause")).toEqual({ kind: "unknown", input: "pause" });
		expect(parseUltraworkCommand("clear")).toEqual({ kind: "unknown", input: "clear" });
		expect(parseUltraworkCommand("help")).toEqual({ kind: "unknown", input: "help" });
	});
});
