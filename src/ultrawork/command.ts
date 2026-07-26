export const ULW_USAGE =
	'Usage: /ulw [status] | /ulw stop | /ulw off | /ulw on\nSay "ultrawork" or "ulw" in a message to start or resume it. Use "/ulw off" to mute the keyword trigger so those words stop activating the mode; "/ulw on" re-arms it.';

export type ParsedUltraworkCommand =
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "off" }
	| { kind: "on" }
	| { kind: "unknown"; input: string };

/**
 * Parse the raw text after `/ulw`. Bare input (no args) is treated as `status`.
 *
 * `start`/`resume` are intentionally not commands: UltraWork mode starts and
 * re-engages automatically from the `ultrawork`/`ulw` keyword trigger in a
 * normal prompt. `/ulw stop` remains as a manual safety valve, and
 * `/ulw off` / `/ulw on` mute and re-arm that keyword trigger.
 */
export function parseUltraworkCommand(rawArgs: string): ParsedUltraworkCommand {
	const trimmed = rawArgs.trim();
	if (trimmed === "") return { kind: "status" };

	const [verbRaw] = trimmed.split(/\s+/);
	const verb = (verbRaw ?? "").toLowerCase();

	switch (verb) {
		case "status":
			return { kind: "status" };
		case "stop":
			return { kind: "stop" };
		case "off":
			return { kind: "off" };
		case "on":
			return { kind: "on" };
		default:
			return { kind: "unknown", input: trimmed };
	}
}
