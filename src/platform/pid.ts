// Process liveness + identity.
//
// PID-reuse guard: the PRIMARY mechanism is a per-broker nonce written to the
// lockfile at start and confirmed via an IPC auth challenge. A recycled PID will
// not know the nonce, so it can never be mistaken for our broker. isAlive() below
// is the cheap "is anything at this PID" check used before the nonce challenge.

import { randomBytes } from "node:crypto";

/** True if a process with this PID exists. Cross-platform (process.kill signal 0). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = exists but we lack permission.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Random birth token for lockfile + IPC challenge (guards against PID reuse). */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Block until `pid` is gone, or the timeout expires. Returns true if it died.
 *
 * Needed before handing a session JSONL to interactive pi: pi opens the target
 * SessionManager BEFORE our session_shutdown hook runs, so releasing the file
 * has to be complete by the time switchSession() is called — there is no later
 * chance to let go, and two writers corrupt the session.
 */
export async function waitForExit(pid: number, timeoutMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isAlive(pid);
}

// NOTE on PID reuse: for BROKERS the nonce in the lockfile is the guard (a
// recycled PID cannot produce it, and IPC challenge-confirms it). For ATTACHED
// CLAIMS there is no channel to challenge, so freshness is the guard instead —
// see isClaimLive() / CLAIM_TTL_MS in registry.ts. A bare isAlive() check is NOT
// sufficient there: Windows recycles PIDs fast and this project spawns many
// long-lived node processes that land on them.
