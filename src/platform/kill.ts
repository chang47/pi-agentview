// Process-tree termination.
//
// POSIX: signalling a NEGATIVE pid targets the process GROUP, which reaches
// descendants — but only when the target is a group leader, i.e. it was spawned
// with `detached: true`. Our brokers are; the pi RPC worker is NOT (it needs its
// stdio pipes wired to the broker). Signalling only the group therefore killed
// brokers but silently no-opped on workers, so a stuck worker leaked on Linux
// while `taskkill /T` masked the bug on Windows. Caught by the smoke suite on
// WSL2/Ubuntu. Signal BOTH: the group for descendants, the pid for itself.

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { isAlive, waitForExit } from "./pid.js";

const isWin = platform() === "win32";

/** Forcefully kill a process and all its descendants. */
export async function killTree(pid: number, graceMs = 3000): Promise<void> {
  if (isWin) {
    await new Promise<void>((resolve) => {
      const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      p.on("close", () => resolve());
      p.on("error", () => resolve()); // taskkill missing or pid gone
    });
    return;
  }

  // Group first (descendants), then the process itself. Either may legitimately
  // fail — no group when the child isn't detached, ESRCH once it's already gone.
  const sig = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      /* not a group leader, or group already gone */
    }
    try {
      process.kill(pid, s);
    } catch {
      /* already dead */
    }
  };

  sig("SIGTERM");
  // Poll rather than always burning the full grace period.
  if (await waitForExit(pid, graceMs)) return;
  sig("SIGKILL");
  await waitForExit(pid, 1000);
}

/** Best-effort graceful stop: ask politely, then force. (Broker sends an RPC
 *  shutdown first; this is the fallback for a stuck worker.) */
export async function stopTree(pid: number, graceMs = 3000): Promise<void> {
  if (isWin) {
    // Windows has no SIGTERM equivalent via taskkill without /F being immediate.
    // Callers should RPC-shutdown first; here we fall through to force.
    return killTree(pid, 0);
  }
  return killTree(pid, graceMs);
}

/** Exported for tests: is this process gone? */
export { isAlive };
