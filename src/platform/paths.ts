// Cross-platform path resolution.
// Windows: %LOCALAPPDATA%\pi-agentview
// macOS:   ~/Library/Application Support/pi-agentview
// Linux:   $XDG_STATE_HOME/pi-agentview  (or ~/.local/state/pi-agentview)
//
// IPC addresses: Node's `net` module treats a `\\.\pipe\NAME` path as a Windows
// named pipe and a filesystem path as a Unix domain socket on POSIX. So a single
// net.listen(socketAddress(id)) call works everywhere — only the string differs.

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIR_ENV } from "./constants.js";

export const PKG = "pi-agentview";

const PIPE_PREFIX = "\\\\.\\pipe\\"; // -> literal \\.\pipe\

function isWin(): boolean {
  return platform() === "win32";
}

export function stateDir(): string {
  // Test-isolation override (see STATE_DIR_ENV). Checked first so a test run gets
  // a throwaway dir instead of the machine-wide default. Unset in production.
  const override = process.env[STATE_DIR_ENV];
  if (override) return override;
  if (isWin()) {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), PKG);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", PKG);
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), PKG);
}

export function registryPath(): string {
  return join(stateDir(), "registry.json");
}

/** LEGACY single-map claims file (pre per-owner claims). Retained only so the
 *  claim store can delete it on first read. */
export function foregroundClaimsPath(): string {
  return join(stateDir(), "foreground-claims.json");
}

/** One claim file per owning process — see ForegroundClaimStore. */
export function claimsDir(): string {
  return join(stateDir(), "claims");
}

/** Parent directory for POSIX unix-socket files (must exist before listen()). */
export function socketsDir(): string {
  return join(stateDir(), "sockets");
}

/**
 * Prepare the filesystem so `net.listen(socketAddress(id))` can succeed.
 *
 * POSIX only: a unix socket is a real filesystem entry, so its parent chain has
 * to exist and any file left by a crashed broker has to be removed first.
 * Windows named pipes are kernel objects — nothing to do.
 *
 * CALL THIS BEFORE EVERY listen(). Verified on Linux (WSL2, Ubuntu): when the
 * parent chain is missing, Node reports **EACCES**, not ENOENT — a misleading
 * error that reads like a permissions problem and sends you the wrong way.
 */
export async function ensureSocketDir(address: string): Promise<void> {
  if (isWin()) return;
  const { mkdir, unlink } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(address), { recursive: true });
  await unlink(address).catch(() => {}); // stale socket -> EADDRINUSE
}

export function sessionsDir(): string {
  return join(stateDir(), "sessions");
}

export function sessionDir(id: string): string {
  return join(sessionsDir(), id);
}

export function brokerSpecPath(id: string): string {
  return join(sessionDir(id), "broker-spec.json");
}

export function brokerStatePath(id: string): string {
  return join(sessionDir(id), "broker-state.json");
}

export function brokerLockPath(id: string): string {
  return join(sessionDir(id), "broker.lock");
}

export function journalPath(id: string): string {
  return join(sessionDir(id), "journal.jsonl");
}

/**
 * IPC listen address for a session's broker.
 * Windows -> named pipe; POSIX -> unix socket under stateDir (kept short for sun_path).
 */
export function socketAddress(id: string): string {
  if (isWin()) {
    return `${PIPE_PREFIX}${PKG}-${id}`;
  }
  return join(socketsDir(), `${id}.sock`);
}

/** Absolute path to the bundled broker entry (built via `npm run build:broker`). */
export function defaultBrokerPath(): string {
  // fileURLToPath, NOT url.pathname: pathname keeps percent-encoding (breaks on
  // spaces/non-ASCII) and on POSIX the old `.replace(/^\//, "")` stripped the
  // leading slash, yielding a RELATIVE path that resolved against the cwd.
  return fileURLToPath(new URL("../../dist/broker.mjs", import.meta.url));
}
