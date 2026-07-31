// Process-tree termination. POSIX uses negative-PID process-group signals
// (brokers/workers are spawned detached, so pgid == pid). Windows has no process
// groups reachable via signals, so we use `taskkill /T` (tree) `/F` (force).

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { isAlive } from "./pid.js";

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

  // POSIX: kill the whole group (negative pid), wait, then SIGKILL if still alive.
  const sig = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      /* group may already be gone */
    }
  };
  sig("SIGTERM");
  await new Promise((r) => setTimeout(r, graceMs));
  if (isAlive(pid)) sig("SIGKILL");
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
