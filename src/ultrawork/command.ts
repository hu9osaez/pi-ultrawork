export const ULW_USAGE =
	'Usage: /ulw [status] | /ulw stop | /ulw off | /ulw on | /ulw always on|off\nSay "ultrawork" or "ulw" in a message to start it. "/ulw off" mutes the keyword trigger, "/ulw on" re-arms it. "/ulw always on" runs every message in UltraWork; "/ulw always off" reverts. Mid-run steering lives in its own command: "/ulw-steer <text>".';

export const STEER_USAGE =
	'Usage: /ulw-steer <text> | /ulw-steer | /ulw-steer clear\n"/ulw-steer <text>" injects a mid-run instruction into the active run (applied ASAP). Bare "/ulw-steer" lists pending steers; "/ulw-steer clear" empties the queue.';

export type ParsedUltraworkCommand =
	| { kind: "status" }
	| { kind: "stop" }
	| { kind: "off" }
	| { kind: "on" }
	| { kind: "always-on" }
	| { kind: "always-off" }
	| { kind: "unknown"; input: string };

export type ParsedSteerCommand =
	| { kind: "list" }
	| { kind: "clear" }
	| { kind: "add"; text: string };

/**
 * Parse the raw text after `/ulw-steer`.
 * - empty        -> list pending steers
 * - exactly "clear" (case-insensitive) -> clear the queue
 * - anything else -> add it verbatim as a steer note (case + spacing preserved)
 *
 * Note: to steer the literal single word "clear", phrase it differently (e.g.
 * "clear the cache first"); a bare `clear` is always the clear subcommand.
 */
export function parseSteerCommand(rawArgs: string): ParsedSteerCommand {
	const trimmed = rawArgs.trim();
	if (trimmed === "") return { kind: "list" };
	if (trimmed.toLowerCase() === "clear") return { kind: "clear" };
	return { kind: "add", text: trimmed };
}

/**
 * Parse the raw text after `/ulw`. Bare input (no args) is treated as `status`.
 *
 * `start`/`resume` are intentionally not commands: UltraWork mode starts and
 * re-engages automatically from the `ultrawork`/`ulw` keyword trigger in a
 * normal prompt. `/ulw stop` remains as a manual safety valve, `/ulw off` /
 * `/ulw on` mute and re-arm that keyword trigger, and `/ulw always on|off`
 * toggles always-on mode. Mid-run steering is its own command (`/ulw-steer`,
 * parsed by parseSteerCommand).
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
		default:
			return { kind: "unknown", input: trimmed };
	}
}
