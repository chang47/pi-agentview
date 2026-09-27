// BrokerManager: owns the live set of background sessions from the extension's
// side — reconcile, spawn/reconnect brokers, create/remove, resume handoff,
// and the row model the view renders.

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RegistryStore,
  BrokerSpecStore,
  BrokerStateStore,
  ForegroundClaimStore,
  reconcileRegistry,
  titleFromJsonl,
  isClaimLive,
} from "../registry.js";
import { readLock } from "../broker/lock.js";
import {
  defaultBrokerPath,
  brokerLockPath,
  brokerSpecPath,
  socketAddress,
  sessionDir,
  sessionsDir,
} from "../platform/paths.js";
import { spawnBroker } from "../platform/spawn.js";
import { killTree } from "../platform/kill.js";
import { isAlive, newNonce, waitForExit } from "../platform/pid.js";
import {
  CONNECT_ATTEMPTS,
  CONNECT_DELAY_MS,
  RELEASE_POLL_MS,
  RELEASE_TIMEOUT_MS,
  BROKER_ARTIFACTS,
  isBrokerOnlyDir,
  isBrokerTempFile,
  isPlaceholderTitle,
  PLACEHOLDER_TITLE,
} from "../platform/constants.js";
import { IpcClient } from "./ipc-client.js";
import { rowsFor, type ManagedRow } from "./render.js";
import type { BrokerState, ManagedId, RegistryEntry, SessionState } from "../types.js";

interface ManagedSession {
  entry: RegistryEntry;
  nonce: string;
  brokerPid?: number;
  client?: IpcClient;
  state?: BrokerState;
  /** Set when we gave up connecting — surfaced as needs_attention, not silence. */
  unreachable?: boolean;
}

export interface CreateOptions {
  title?: string;
  cwd: string;
  /** Optional. Omit to place the JSONL inside this session's own state dir —
   *  which is what keeps data and indexes in ONE directory. */
  jsonlPath?: string;
  model?: string;
  thinkingLevel?: string;
  initialTask?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrokerManager {
  private registry = new RegistryStore();
  private specs = new BrokerSpecStore();
  private states = new BrokerStateStore();
  private sessions = new Map<ManagedId, ManagedSession>();
  private refreshCb: (() => void) | undefined;
  private readonly clientId = `fe-${process.pid}`;
  private claims = new ForegroundClaimStore();
  private cachedAttached: ManagedRow[] = [];
  private reconciling = false;
  /** JSONL owned by this terminal — remembered so self-healing reconciles can't
   *  start managing the session the user is sitting in. */
  private skipJsonl: string | undefined;
  private lastHealAt = 0;

  onRefresh(cb: () => void): void {
    this.refreshCb = cb;
  }

  private touch(): void {
    this.refreshCb?.();
  }

  /** Reconcile the registry against durable specs, then (re)connect brokers.
   *  Pass the foreground session's JSONL to skip it (never manage a session that
   *  an interactive pi currently owns). */
  async reconcile(skipJsonl?: string): Promise<void> {
    if (skipJsonl !== undefined) this.skipJsonl = skipJsonl;
    else skipJsonl = this.skipJsonl;
    if (this.reconciling) return; // session_start can fire faster than a reconcile completes
    this.reconciling = true;
    try {
      await reconcileRegistry(this.registry);
      await this.gcOrphanDirs();
      await this.tick(); // refresh attached cache + prune dead/stale claims
      await this.refreshTitles();
      const attachedJsonls = new Set(this.cachedAttached.map((r) => r.jsonlPath));
      const entries = await this.registry.list();
      await Promise.all(
        entries
          .filter((e) => e.jsonlPath !== skipJsonl && !attachedJsonls.has(e.jsonlPath) && !this.isLive(e.id))
          .map((e) => this.ensureBroker(e).catch(() => undefined)),
      );
    } finally {
      this.reconciling = false;
      this.touch();
    }
  }

  /**
   * Keep the durable registry title in step with what the session actually is.
   *
   * Registry titles used to be written once and never revisited, so a session
   * auto-backgrounded before its first turn stayed "session" forever even after
   * the conversation had content — and an explicit rename in the attached
   * terminal never propagated, so the name flipped back on the next switch.
   *
   * Only ever UPGRADES: a real title is never replaced by a placeholder.
   */
  private async refreshTitles(): Promise<void> {
    const claimByPath = new Map<string, { title: string; source?: string }>();
    for (const r of this.cachedAttached) claimByPath.set(r.jsonlPath.toLowerCase(), { title: r.title });
    for (const c of await this.claims.all()) {
      claimByPath.set(c.jsonlPath.toLowerCase(), { title: c.title, source: c.titleSource });
    }

    for (const e of await this.registry.list()) {
      const claim = claimByPath.get(e.jsonlPath.toLowerCase());
      let next: string | undefined;
      // An explicit Pi session name is authoritative — this is how a rename made
      // in the attached terminal reaches the background row.
      if (claim?.source === "name" && !isPlaceholderTitle(claim.title)) next = claim.title.trim();
      // Otherwise fill a placeholder from the session's own content.
      else if (isPlaceholderTitle(e.title)) next = await titleFromJsonl(e.jsonlPath);

      if (next && !isPlaceholderTitle(next) && next !== e.title) {
        await this.registry.upsert({ ...e, title: next });
        const ms = this.sessions.get(e.id);
        if (ms) ms.entry = { ...ms.entry, title: next };
      }
    }
  }

  /** Already tracked AND still usable? A session whose broker died must be
   *  re-ensured, otherwise the row freezes forever after a broker crash. */
  private isLive(id: ManagedId): boolean {
    const ms = this.sessions.get(id);
    if (!ms) return false;
    if (ms.unreachable) return false;
    if (ms.brokerPid !== undefined && !isAlive(ms.brokerPid)) return false;
    return true;
  }

  /** Refresh the attached-claim cache and prune claims that are dead OR stale.
   *  Called by the view's refresh tick + reconcile. */
  async tick(now = Date.now()): Promise<void> {
    const live = await this.claims.prune(now);
    // A session has TWO title lanes: the live claim (re-derived by the owning
    // terminal) and the durable registry row (set at create, or by a rename).
    // They must be reconciled here or a row visibly renames itself every time
    // you attach/detach — e.g. a session created as "session 3" showed as
    // "session" while attached, because the claim could derive nothing yet.
    const byPath = new Map<string, string>();
    for (const e of await this.registry.list()) byPath.set(e.jsonlPath.toLowerCase(), e.title);

    this.cachedAttached = live.map((c) => ({
      id: `fg:${c.jsonlPath}`,
      // NEVER fall back to the cwd basename — that is what rendered rows as
      // "iamjo". An unknown title is "session", not the user's home folder.
      title: resolveTitle(c.title, c.titleSource, byPath.get(c.jsonlPath.toLowerCase())),
      state: "attached" as SessionState,
      activity: c.cwd,
      jsonlPath: c.jsonlPath,
      // Attached rows have no run clock; updatedAt is a heartbeat, so showing
      // (now - updatedAt) would render a meaningless ever-growing duration.
      elapsedMs: undefined,
      needsInput: false,
      attached: true,
    }));

    // Self-heal: a broker that died (or was never reachable) would otherwise
    // stay frozen until the next session_start. Retry at most every 5s.
    if (!this.reconciling && now - this.lastHealAt > 5_000 && [...this.sessions.values()].some((s) => s.unreachable)) {
      this.lastHealAt = now;
      void this.reconcile().catch(() => undefined);
    }
  }

  /** Connect to a live broker if one owns this session, else spawn a fresh one. */
  private async ensureBroker(entry: RegistryEntry): Promise<void> {
    const lock = await readLock(brokerLockPath(entry.id));
    const liveLock = lock && isAlive(lock.pid) ? lock : undefined;
    // Reconnect to a broker from a prior pi instance using ITS nonce.
    const nonce = liveLock ? liveLock.nonce : newNonce();
    const ms: ManagedSession = { entry, nonce };
    // BUGFIX: on the reconnect path brokerPid used to be left undefined, so
    // remove()/stopBrokerForResume() could never kill the broker — the source of
    // long-lived orphan broker+worker pairs.
    if (liveLock) ms.brokerPid = liveLock.pid;
    this.sessions.set(entry.id, ms);
    if (!liveLock) await this.spawn(entry.id, ms);
    await this.connect(entry.id, ms);
  }

  private async spawn(id: ManagedId, ms: ManagedSession): Promise<void> {
    const child = spawnBroker({
      brokerPath: defaultBrokerPath(),
      args: ["--id", id, "--nonce", ms.nonce],
    });
    // Poll for the lockfile rather than sleeping a fixed 400ms: a cold broker on
    // Windows can take longer, and a warm one is ready far sooner.
    for (let i = 0; i < 20; i++) {
      const lock = await readLock(brokerLockPath(id));
      if (lock?.nonce === ms.nonce) {
        ms.brokerPid = lock.pid;
        return;
      }
      await sleep(100);
    }
    ms.brokerPid = child.pid ?? undefined;
  }

  private async connect(id: ManagedId, ms: ManagedSession): Promise<void> {
    const client = new IpcClient({
      address: socketAddress(id),
      nonce: ms.nonce,
      clientId: this.clientId,
      onState: (st) => {
        ms.state = st;
        ms.unreachable = false;
        this.states.write(id, st).catch(() => undefined);
        this.touch();
      },
      onDisconnect: () => {
        // The broker went away. Mark it so the next reconcile/tick re-ensures it
        // instead of leaving a permanently frozen row.
        ms.client = undefined;
        ms.unreachable = true;
        this.touch();
      },
    });
    let connected = false;
    for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
      try {
        await client.connect();
        connected = true;
        break;
      } catch {
        await sleep(CONNECT_DELAY_MS);
      }
    }
    if (!connected) {
      // Do NOT keep a dead client around pretending to be usable.
      ms.client = undefined;
      ms.unreachable = true;
      this.touch();
      return;
    }
    ms.client = client;
    ms.unreachable = false;
    client.acquireLease(); // the foreground host holds the mutation lease
  }

  rows(now = Date.now()): ManagedRow[] {
    const entries = [...this.sessions.values()].map((s) => s.entry);
    const stateMap = new Map<ManagedId, BrokerState | undefined>();
    for (const s of this.sessions.values()) {
      stateMap.set(s.entry.id, s.unreachable ? { ...(s.state ?? emptyState(s.entry.id)), state: "needs_attention", activity: "broker unreachable" } : s.state);
    }
    const brokerRows = rowsFor(entries, stateMap, now);
    // A session that's both attached and brokered shows as attached only.
    const fgJsonls = new Set(this.cachedAttached.map((r) => r.jsonlPath));
    const deduped = brokerRows.filter((r) => !fgJsonls.has(r.jsonlPath));
    return [...this.cachedAttached, ...deduped];
  }

  /** Is this session JSONL already tracked as a background task? */
  async isTracked(jsonlPath: string): Promise<boolean> {
    const entries = await this.registry.list();
    return entries.some((e) => e.jsonlPath === jsonlPath);
  }

  /** Is this session currently attached to a live terminal that ISN'T us? */
  async isAttachedElsewhere(jsonlPath: string, myPid = process.pid): Promise<boolean> {
    const c = await this.claims.get(jsonlPath);
    if (!c || c.ownerPid === myPid) return false;
    // Freshness, not just PID liveness — see isClaimLive().
    return isClaimLive(c);
  }

  entry(id: ManagedId): RegistryEntry | undefined {
    return this.sessions.get(id)?.entry;
  }

  /** Rename a row's title. Background rows update the registry entry;
   *  attached rows are handled by the caller via pi.setSessionName. */
  async setTitle(rowId: string, title: string): Promise<void> {
    if (rowId.startsWith("fg:")) return; // attached rename goes through pi.setSessionName
    const e = await this.registry.get(rowId);
    if (e) await this.registry.upsert({ ...e, title });
    const ms = this.sessions.get(rowId);
    if (ms) ms.entry = { ...ms.entry, title };
    this.touch();
  }

  /** Send a follow-up prompt to a background session (reply-from-peek).
   *  Returns false when the row cannot accept a reply — the view must surface
   *  that rather than flashing "sent ✓" for a message that went nowhere. */
  sendReply(id: ManagedId, text: string): boolean {
    if (id.startsWith("fg:")) return false; // attached rows are driven by their own terminal
    const ms = this.sessions.get(id);
    if (!ms?.client) return false;
    // pi rejects a bare `prompt` while the agent is streaming, so anything that
    // is not clearly idle must go as follow_up. Treat unknown state as busy.
    const st = ms.state?.state;
    const idle = st === "idle" || st === "completed" || st === "stopped";
    ms.client.sendRpc(idle ? { type: "prompt", message: text } : { type: "follow_up", message: text });
    return true;
  }

  async create(opts: CreateOptions): Promise<ManagedId> {
    const id = `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // The JSONL lives in THIS session's own dir unless the caller names a path.
    // Previously the caller minted its own id for the path while create() minted
    // a second one for the spec, so a session's data and its indexes landed in
    // two different directories — which then looked like an orphan to cleanup.
    const jsonlPath = opts.jsonlPath ?? join(sessionDir(id), "session.jsonl");
    await mkdir(sessionDir(id), { recursive: true });
    await this.specs.write({
      id,
      jsonlPath,
      cwd: opts.cwd,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      initialTask: opts.initialTask,
      createdAt: Date.now(),
    });
    const entry: RegistryEntry = {
      id,
      title: opts.title || (opts.initialTask ? opts.initialTask.replace(/\s+/g, " ").slice(0, 60) : "session"),
      jsonlPath,
      cwd: opts.cwd,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      createdAt: Date.now(),
      specPath: brokerSpecPath(id),
      socketAddress: socketAddress(id),
    };
    await this.registry.upsert(entry);
    const ms: ManagedSession = { entry, nonce: newNonce() };
    this.sessions.set(id, ms);
    await this.spawn(id, ms);
    await this.connect(id, ms);
    return id;
  }

  /** Stage an EXISTING foreground session's JSONL for backgrounding:
   *  writes the durable spec + registry row but does NOT spawn a broker (the
   *  foreground still owns the file). A subsequent reconcile() — after the
   *  foreground releases the file — spawns the broker. */
  async registerExisting(
    jsonlPath: string,
    opts: { title?: string; cwd: string; model?: string; thinkingLevel?: string; initialTask?: string; resumeOnStart?: boolean },
  ): Promise<ManagedId> {
    const id = `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await this.specs.write({
      id,
      jsonlPath,
      cwd: opts.cwd,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      initialTask: opts.initialTask,
      // Set when the session being backgrounded was mid-run: the broker that
      // later picks up this JSONL will nudge the fresh worker to continue (once).
      resumeOnStart: opts.resumeOnStart,
      createdAt: Date.now(),
    });
    // Fallback order: caller's title -> the session's own name/first prompt.
    // A placeholder counts as NO title, so it can't freeze "session" into the
    // registry for a session that was backgrounded before its first turn.
    // NEVER the JSONL basename (a timestamp+UUID) and never the cwd basename.
    const title = isPlaceholderTitle(opts.title)
      ? (await titleFromJsonl(jsonlPath)) || PLACEHOLDER_TITLE
      : opts.title!.trim();
    await this.registry.upsert({
      id,
      title,
      jsonlPath,
      cwd: opts.cwd,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      createdAt: Date.now(),
      specPath: brokerSpecPath(id),
      socketAddress: socketAddress(id),
    });
    return id;
  }

  /**
   * Release a background session's JSONL so interactive pi can own it.
   *
   * Returns true only when the broker (and therefore its RPC worker, killed as
   * part of the tree) is CONFIRMED gone. The caller must not switch sessions on
   * false: pi opens the target session file before any of our teardown hooks
   * run, so a surviving worker means two writers on one JSONL.
   */
  async stopBrokerForResume(id: ManagedId): Promise<boolean> {
    const ms = this.sessions.get(id);
    const lock = await readLock(brokerLockPath(id));
    const pid = ms?.brokerPid ?? lock?.pid;

    // Ask politely first so the broker can flush state and close the worker's
    // stdin. Keep the socket open until it's actually gone — the previous code
    // destroyed it immediately, which could drop the shutdown message entirely.
    if (ms?.client) {
      try {
        ms.client.shutdown();
      } catch {
        /* ignore */
      }
    }

    let gone = pid === undefined || !isAlive(pid);
    if (!gone && pid !== undefined) {
      gone = await waitForExit(pid, RELEASE_TIMEOUT_MS / 2, RELEASE_POLL_MS);
      if (!gone) {
        await killTree(pid, 1000);
        gone = await waitForExit(pid, RELEASE_TIMEOUT_MS / 2, RELEASE_POLL_MS);
      }
    }

    ms?.client?.destroy();
    if (ms) {
      ms.client = undefined;
      ms.brokerPid = undefined;
    }
    this.sessions.delete(id);
    this.touch();
    return gone;
  }

  /** Restart the broker for a session that was resumed interactively. */
  async returnToPool(id: ManagedId): Promise<void> {
    const entry = this.sessions.get(id)?.entry ?? (await this.registry.get(id));
    if (!entry) return;
    // Never re-own a file a live terminal holds.
    if (await this.isAttachedElsewhere(entry.jsonlPath)) return;
    await this.ensureBroker(entry);
  }

  /** Remove from Agent View + stop service; PRESERVES the Pi JSONL. */
  async remove(id: ManagedId): Promise<void> {
    const ms = this.sessions.get(id);
    const lock = await readLock(brokerLockPath(id));
    const pid = ms?.brokerPid ?? lock?.pid;
    if (ms?.client) {
      try {
        ms.client.shutdown();
      } catch {
        /* ignore */
      }
    }
    if (pid !== undefined && isAlive(pid)) {
      if (!(await waitForExit(pid, 2000, RELEASE_POLL_MS))) await killTree(pid, 1000);
    }
    ms?.client?.destroy();
    await this.registry.remove(id);
    await this.specs.remove(id);
    this.sessions.delete(id);
    // Drop our rebuildable indexes, but NEVER the session JSONL — remove() is
    // specified to preserve conversation history. Now that a session's data and
    // indexes share one directory, an unconditional rm -rf here would delete the
    // conversation itself.
    await purgeBrokerArtifacts(sessionDir(id));
    this.touch();
  }

  /**
   * Delete leftover session dirs that contain ONLY our own broker indexes.
   *
   * DANGER ZONE — this sweep is index-driven, and the project's first invariant
   * is that an index must never be able to destroy conversation history. An
   * earlier version of this method deleted any dir lacking a broker-spec.json,
   * which wiped the directory pi had just created for a live session's JSONL
   * (pi creates the parent dir immediately but writes the file lazily, so a
   * brand-new session looks exactly like an orphan). That produced ENOENT
   * crashes in running sessions.
   *
   * Four independent guards, all of which must pass:
   *   1. no durable spec  2. no live broker lock
   *   3. not referenced by any registry row's jsonlPath
   *   4. the directory contains nothing but broker index files
   */
  private async gcOrphanDirs(): Promise<void> {
    let ids: string[];
    try {
      ids = await readdir(sessionsDir());
    } catch {
      return;
    }
    // Any directory that holds a tracked session's JSONL is off limits, even if
    // it carries no spec of its own.
    const referenced = new Set(
      (await this.registry.list()).map((e) => dirname(e.jsonlPath).toLowerCase()),
    );

    for (const id of ids) {
      const dir = sessionDir(id);
      try {
        await stat(brokerSpecPath(id));
        continue; // (1) has a spec -> a real managed session
      } catch {
        /* no spec */
      }
      const lock = await readLock(brokerLockPath(id));
      if (lock && isAlive(lock.pid)) continue; // (2) a broker still lives here
      if (referenced.has(dir.toLowerCase())) continue; // (3) holds tracked data

      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      if (!isBrokerOnlyDir(entries)) continue; // (4) holds data we don't own
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  has(id: ManagedId): boolean {
    return this.sessions.has(id);
  }

  /** Is this session's broker currently mid-run — i.e. a live turn that resuming
   *  (which kills the broker) would ABORT? Read from the broker's own derived
   *  state, so it reflects real agent events, checked just before we stop it. */
  isRunning(id: ManagedId): boolean {
    return this.sessions.get(id)?.state?.state === "working";
  }

  /** Re-arm the resume-continue hint on an ALREADY-tracked session's durable
   *  spec (found by its JSONL path). registerExisting only runs the FIRST time a
   *  session is backgrounded; every later background short-circuits on isTracked,
   *  so without this the flag — cleared by the previous continue — stays false
   *  and only the first background of a session ever auto-continues. Idempotent;
   *  a no-op if the session isn't tracked or its spec is gone. */
  async markResumeOnStart(jsonlPath: string): Promise<void> {
    const entry = (await this.registry.list()).find((e) => e.jsonlPath === jsonlPath);
    if (!entry) return;
    const spec = await this.specs.read(entry.id);
    if (spec && !spec.resumeOnStart) await this.specs.write({ ...spec, resumeOnStart: true });
  }
}

function emptyState(id: ManagedId): BrokerState {
  return { id, state: "idle", activity: "ready", lastEventSeq: 0, updatedAt: Date.now() };
}

/**
 * Pick the title to display for a session that has both a live claim and a
 * durable registry row.
 *
 * Precedence, strongest signal first:
 *   1. an explicit Pi session name  (the user typed /name or renamed here)
 *   2. the registry title           (the user typed it at create, or renamed)
 *   3. a title derived from the first user prompt
 *   4. the placeholder
 *
 * Without this the two lanes alternate as you attach/detach and the row looks
 * like it is renaming itself.
 */
export function resolveTitle(
  claimTitle: string | undefined,
  claimSource: "name" | "prompt" | "fallback" | undefined,
  registryTitle: string | undefined,
): string {
  if (claimSource === "name" && !isPlaceholderTitle(claimTitle)) return claimTitle!.trim();
  if (!isPlaceholderTitle(registryTitle)) return registryTitle!.trim();
  if (!isPlaceholderTitle(claimTitle)) return claimTitle!.trim();
  return PLACEHOLDER_TITLE;
}

/**
 * Delete only the broker's own index files from a session dir, then the dir
 * itself if that left it empty. A session JSONL (or anything else we didn't
 * write) is preserved — removing a row must never destroy the conversation.
 */
async function purgeBrokerArtifacts(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  let kept = 0;
  for (const name of entries) {
    if (BROKER_ARTIFACTS.has(name) || isBrokerTempFile(name)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
    } else {
      kept++;
    }
  }
  if (kept === 0) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
