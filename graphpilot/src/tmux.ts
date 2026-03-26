import { execFileSync } from "node:child_process";

const SESSION = "graphpilot";

/**
 * Check whether tmux is available on the system.
 * Returns true if the `tmux` binary is found and executable.
 */
export function checkTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the graphpilot tmux session exists.
 * Creates it (detached) if absent; reuses it if already running.
 * Throws if tmux is not installed.
 */
export function ensureSession(): void {
  if (!checkTmux()) {
    throw new Error(
      "tmux is not installed. Install tmux to use gp serve actions.",
    );
  }

  // Check if session already exists
  try {
    execFileSync("tmux", ["has-session", "-t", SESSION], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    // Session exists, nothing to do
  } catch {
    // Session doesn't exist, create it
    execFileSync("tmux", ["new-session", "-d", "-s", SESSION], {
      encoding: "utf-8",
      stdio: "pipe",
    });
  }
}

/**
 * Spawn a new tmux window in the graphpilot session.
 *
 * Window naming conventions:
 * - Launch actions: node ID (e.g. "auth-service")
 * - Design actions: "design"
 * - Dispatch actions: "<id>-dispatch" (e.g. "auth-service-dispatch")
 *
 * @param name   - Window name (used for identification and `tmux select-window`)
 * @param command - Shell command to run in the window
 */
export function spawnWindow(name: string, command: string): void {
  try {
    execFileSync(
      "tmux",
      ["new-window", "-t", SESSION, "-n", name, command],
      { encoding: "utf-8", stdio: "pipe" },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to spawn tmux window "${name}": ${msg}`);
  }
}
