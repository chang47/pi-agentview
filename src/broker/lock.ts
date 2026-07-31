// Broker lockfile: live-process ownership claim for a session's state directory.
// { pid, nonce, startedAt }. The nonce guards against PID reuse: a recycled PID
// can't produce the matching nonce, and the IPC layer challenge-confirms it.

import { readFile, unlink } from "node:fs/promises";
import { atomicWrite } from "../platform/atomic.js";

export interface LockFile {
  pid: number;
  nonce: string;
  startedAt: number;
}

export async function readLock(path: string): Promise<LockFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

/** Acquire (or reclaim) the lock. Overwrites — the extension guarantees only one
 *  broker is spawned per session. */
export async function acquireLock(path: string, pid: number, nonce: string): Promise<void> {
  await atomicWrite(path, JSON.stringify({ pid, nonce, startedAt: Date.now() } satisfies LockFile));
}

export async function releaseLock(path: string): Promise<void> {
  await unlink(path).catch(() => {});
}
