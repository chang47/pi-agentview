// Shared tunables. Kept in one place so the extension, the broker and the
// stores can't drift on values that must agree across process boundaries.

/** Set to "1" by the broker on the pi RPC worker it spawns. The extension reads
 *  this to refuse the fleet-manager role inside its own worker processes. */
export const BROKER_CHILD_ENV = "PI_AGENTVIEW_BROKER_CHILD";

/** Env var carrying the resolved pi CLI path from extension -> broker. */
export const PI_CLI_ENV = "PI_AGENTVIEW_PI_CLI";

/** Env override for the state-dir root. TEST-ISOLATION SEAM: unset in production
 *  (the per-OS default applies); when set, every process — extension, broker,
 *  worker — shares one throwaway state dir, so concurrent/test runs can't collide
 *  with the machine-wide default or leak sessions/<id> into it. */
export const STATE_DIR_ENV = "PI_AGENTVIEW_STATE_DIR";

/** How often an interactive host re-stamps its ownership claim. */
export const CLAIM_HEARTBEAT_MS = 10_000;

/**
 * A claim older than this is treated as dead even if its PID still resolves.
 *
 * A live PID is NOT proof of ownership: Windows recycles PIDs aggressively and
 * this project spawns many long-lived node processes (brokers + RPC workers)
 * that readily land on a recycled PID. Freshness is the real proof; the PID
 * check is only a cheap fast-path for "obviously gone".
 *
 * Must be comfortably larger than CLAIM_HEARTBEAT_MS so a busy host that misses
 * a beat is not evicted mid-session.
 */
export const CLAIM_TTL_MS = 60_000;

/** Broker connect budget from the extension (attempts x delay). */
export const CONNECT_ATTEMPTS = 12;
export const CONNECT_DELAY_MS = 250;

/** How long to wait for a broker's process tree to actually disappear. */
export const RELEASE_TIMEOUT_MS = 5_000;
export const RELEASE_POLL_MS = 100;

/** Broker self-reap: how often it checks that its durable spec still exists. */
export const SPEC_WATCH_MS = 30_000;

/** Shown when nothing better is derivable yet. Treated as "no title": it must
 *  never displace a real one the user gave us. */
export const PLACEHOLDER_TITLE = "session";

/**
 * Auto-continue nudge sent to a freshly-brokered worker when the user
 * DELIBERATELY backgrounded a session mid-run (BrokerSpec.resumeOnStart).
 *
 * pi has no attach/detach primitive: "backgrounding" an interactive session
 * tears down the foreground pi and a fresh headless RPC worker re-opens the
 * JSONL — which drops the in-flight turn. This nudge asks the new worker to
 * pick the work back up.
 *
 * The wording is deliberately RECONCILE-FIRST, not a bare "continue". A turn
 * cut mid-flight may have half-run a side-effecting tool (a command, an edit)
 * whose result never persisted; a blunt "continue" risks repeating it. Telling
 * the model to verify current state before acting is what makes an auto-resume
 * safe — it is the same thing a careful human does on reopening. See the
 * conservative-interrupt invariant (SPEC §4) which this stays consistent with:
 * only a USER-initiated background nudges; an unexpected crash stays
 * `interrupted` and waits for a human.
 */
export const RESUME_CONTINUE_PROMPT =
  "Your previous turn was interrupted before it finished (this session was moved to the background). " +
  "Some steps may have only partly completed. First check the current state of the files and repo, " +
  "do NOT repeat any command or edit that already ran, then continue where you left off.";

export function isPlaceholderTitle(t: string | undefined): boolean {
  return !t || !t.trim() || t.trim() === PLACEHOLDER_TITLE;
}

/**
 * Files a session dir may contain that are OURS — rebuildable broker indexes.
 *
 * Anything else in a session dir (above all a `.jsonl`) is CONVERSATION DATA and
 * must never be deleted by an index-driven sweep. Cleanup is allowed to remove a
 * directory only when its entire contents are a subset of this set: a corrupt or
 * stale index must never be able to destroy history.
 */
export const BROKER_ARTIFACTS = new Set([
  "broker-spec.json",
  "broker-state.json",
  "broker.lock",
  "journal.jsonl",
]);

/** Atomic-write leftovers, e.g. `broker-state.json.tmp-1496-e02bbfbc`. */
export function isBrokerTempFile(name: string): boolean {
  return /\.tmp-\d+-[0-9a-f]+$/.test(name);
}

/** True only if every entry in a session dir is a broker index file. */
export function isBrokerOnlyDir(entries: string[]): boolean {
  return entries.every((n) => BROKER_ARTIFACTS.has(n) || isBrokerTempFile(n));
}
