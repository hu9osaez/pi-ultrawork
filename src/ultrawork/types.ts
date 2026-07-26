export const ULTRAWORK_STATUS_VALUES = [
	"running",
	"complete",
	"stopped",
	"stuck",
] as const;

export type UltraWorkStatus = (typeof ULTRAWORK_STATUS_VALUES)[number];

export type UltraWorkStoreRef = {
	baseDir: string;
	threadId: string;
};

export type UltraWorkRun = {
	id: string;
	threadId: string;
	goal: string;
	status: UltraWorkStatus;
	createdAt: number;
	updatedAt: number;
	/** Unix seconds this run was (most recently) started via a fresh trigger. Never reset by stop/complete/stuck. */
	startedAt: number;
	stoppedAt?: number;
	completedAt?: number;
	stuckAt?: number;
	/** Optional short summary the model provided when calling ulw_complete. */
	summary?: string;
	/** Total number of sub-tasks handed to ulw_dispatch across the run's lifetime. */
	dispatchCount: number;
	lastDispatchAt?: number;
	/**
	 * Hidden auto-continuation prompts queued since the last observed forward
	 * progress (a completed ulw_dispatch call resets this to 0). Capped at
	 * AUTO_CONTINUE_CAP (see continuation.ts) before the run is marked stuck.
	 */
	autoContinueAttempts: number;
};

export type UltraWorkFile = {
	version: 1;
	run: UltraWorkRun | null;
	/**
	 * When true, the `ultrawork`/`ulw` keyword trigger is suppressed for this
	 * thread even though the extension is loaded (set via `/ulw off`, cleared via
	 * `/ulw on`). File-level rather than run-level so it persists across runs and
	 * while no run exists. Omitted entirely when enabled to keep the file tidy.
	 */
	triggerDisabled?: boolean;
};

export type UltraWorkUpdate = {
	goal?: string;
	status?: UltraWorkStatus;
};

export type DispatchSummary = {
	taskCount: number;
	succeeded: number;
	failed: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
