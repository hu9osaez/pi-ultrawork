export const MAX_GOAL_LENGTH = 4_000;

export function validateGoal(value: string): string {
	const goal = value.trim();
	if (goal.length === 0) throw new Error("UltraWork goal cannot be empty.");
	const goalCharacters = [...goal].length;
	if (goalCharacters > MAX_GOAL_LENGTH) {
		throw new Error(
			`UltraWork goal is too long: ${goalCharacters.toLocaleString()} characters. Limit: ${MAX_GOAL_LENGTH.toLocaleString()} characters.`,
		);
	}
	return goal;
}
