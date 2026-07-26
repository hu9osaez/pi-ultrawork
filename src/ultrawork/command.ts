export const ULW_USAGE =
	'Usage: /ulw [status] | /ulw stop | /ulw off | /ulw on | /ulw always on|off | /ulw steer <text>\nSay "ultrawork" or "ulw" in a message to start it. "/ulw off" mutes the keyword trigger, "/ulw on" re-arms it. "/ulw always on" runs every message in UltraWork; "/ulw always off" reverts. "/ulw steer <text>" injects a mid-run instruction consumed on the next continuation.';

export type ParsedUltraworkCommand =
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "off" }
	| { kind: "on" }
	| { kind: "always-on" }
	| { kind: "always-off" }
	| { kind: "steer"; text: string }
	| { kind: "unknown"; input: string };

/**
 * Parse the raw text after `/ulw`. Bare input (no args) is treated as `status`.
 *
 * `start`/`resume` are intentionally not commands: UltraWork mode starts and
 * re-engages automatically from the `ultrawork`/`ulw` keyword trigger in a
 * normal prompt. `/ulw stop` remains as a manual safety valve, `/ulw off` /
 * `/ulw on` mute and re-arm that keyword trigger, `/ulw always on|off` toggles
 * always-on mode, and `/ulw steer <text>` injects a mid-run instruction.
 *
 * The verb is matched case-insensitively, but the remainder after `steer` is
 * preserved verbatim (case and whitespace intact) since it is user prose.
 */
export function parseUltraworkCommand(rawArgs: string): ParsedUltraworkCommand {
	const trimmed = rawArgs.trim();
	if (trimmed === "") return { kind: "status" };

	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const verb = (match?.[1] ?? "").toLowerCase();
	const rest = (match?.[2] ?? "").trim();

	switch (verb) {
		case "status":
			return { kind: "status" };
		case "stop":
			return { kind: "stop" };
		case "off":
			return { kind: "off" };
		case "on":
			return { kind: "on" };
		case "always": {
			const sub = rest.toLowerCase();
			if (sub === "on") return { kind: "always-on" };
			if (sub === "off") return { kind: "always-off" };
			return { kind: "unknown", input: trimmed };
		}
		case "steer":
			return rest === ""
				? { kind: "unknown", input: trimmed }
				: { kind: "steer", text: rest };
		default:
			return { kind: "unknown", input: trimmed };
	}
}
