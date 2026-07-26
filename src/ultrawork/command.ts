export const ULW_USAGE = 'Usage: /ulw [status] | /ulw stop\nSay "ultrawork" or "ulw" in a message to start or resume it.';

export type ParsedUltraworkCommand = { kind: "status" } | { kind: "stop" } | { kind: "unknown"; input: string };

/**
 * Parse the raw text after `/ulw`. Bare input (no args) is treated as `status`.
 *
 * `start`/`resume` are intentionally not commands: UltraWork mode starts and
 * re-engages automatically from the `ultrawork`/`ulw` keyword trigger in a
 * normal prompt. `/ulw stop` remains as a manual safety valve.
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
		default:
			return { kind: "unknown", input: trimmed };
	}
}
