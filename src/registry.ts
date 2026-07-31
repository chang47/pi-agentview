// Persistent stores + startup reconciliation.
//
// All writes are atomic (temp + rename). Corrupt reads fall back to the default
// and stash the bad file for diagnosis — indexes are rebuildable from the JSONL,
// so a corrupt registry never destroys conversation history.

import { readFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "./platform/atomic.js";
import { isAlive } from "./platform/pid.js";
import { CLAIM_TTL_MS } from "./platform/constants.js";
import {
  registryPath,
  foregroundClaimsPath,
  claimsDir,
  sessionsDir,
  brokerSpecPath,
  brokerStatePath,
} from "./platform/paths.js";
import type { BrokerSpec, BrokerState, ForegroundClaim, ManagedId, RegistryEntry } from "./types.js";

/** Atomic, corruption-safe JSON store. */
export class JsonStore<T> {
  constructor(private readonly filePath: string, private readonly fallback: T) {}

  async read(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.fallback);
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<T>;
      // Shallow-merge over the fallback so newly-added fields get defaults.
      return { ...structuredClone(this.fallback), ...parsed } as T;
    } catch {
      // Corrupt: quarantine it, return fallback. Reconciliation can rebuild.
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      await atomicWrite(quarantine, raw).catch(() => {});
      return structuredClone(this.fallback);
    }
  }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWrite(this.filePath, JSON.stringify(value, null, 2));
  }
}

// --- Typed stores -----------------------------------------------------------

export class RegistryStore {
  private store = new JsonStore<Record<ManagedId, RegistryEntry>>(registryPath(), {});

  async list(): Promise<RegistryEntry[]> {
    const map = await this.store.read();
    return Object.values(map).sort((a, b) => a.createdAt - b.createdAt);
  }
  async get(id: ManagedId): Promise<RegistryEntry | undefined> {
    return (await this.store.read())[id];
  }
  async upsert(entry: RegistryEntry): Promise<void> {
    const map = await this.store.read();
    map[entry.id] = entry;
    await this.store.write(map);
  }
  async remove(id: ManagedId): Promise<void> {
    const map = await this.store.read();
    delete map[id];
    await this.store.write(map);
  }
}

/**
 * Attached-terminal ownership claims, stored as ONE FILE PER OWNING PROCESS
 * under `claims/`.
 *
 * Why not a single shared JSON map: every pi instance on the machine reads and
 * writes claims, and a read-modify-write over one shared file is a lost-update
 * race no atomic-rename can fix (two hosts read {A}, each adds its own key, the
 * second write erases the first). One file per owner means a host only ever
 * writes its own file, so concurrent hosts cannot clobber each other.
 *
 * A claim is authoritative only while it is FRESH — see isClaimLive().
 */
export class ForegroundClaimStore {
  private ownFile(claim: ForegroundClaim): string {
    return join(claimsDir(), `${claim.ownerPid}-${claim.nonce}.json`);
  }

  async all(): Promise<ForegroundClaim[]> {
    await this.dropLegacyStore();
    let files: string[];
    try {
      files = await readdir(claimsDir());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: ForegroundClaim[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(claimsDir(), f), "utf8");
        const c = JSON.parse(raw) as ForegroundClaim;
        if (c && typeof c.ownerPid === "number" && typeof c.jsonlPath === "string") out.push(c);
      } catch {
        // Unreadable/corrupt claim file: treat as absent. Claims are a
        // rebuildable index — a live host re-stamps its own within a heartbeat.
      }
    }
    return out;
  }

  async get(sessionId: string): Promise<ForegroundClaim | undefined> {
    return (await this.all()).find((c) => c.jsonlPath === sessionId);
  }

  async upsert(claim: ForegroundClaim): Promise<void> {
    await mkdir(claimsDir(), { recursive: true });
    // A host owns exactly one session at a time: clear any other file of ours
    // so switching sessions can't leave a second, permanently-fresh claim.
    for (const c of await this.all()) {
      if (c.ownerPid === claim.ownerPid && c.nonce === claim.nonce && c.jsonlPath !== claim.jsonlPath) {
        await unlinkQuiet(this.ownFile(c));
      }
    }
    await atomicWrite(this.ownFile(claim), JSON.stringify(claim, null, 2));
  }

  async remove(sessionId: string): Promise<void> {
    for (const c of await this.all()) {
      if (c.jsonlPath === sessionId) await unlinkQuiet(this.ownFile(c));
    }
  }

  /** Drop every claim held by a given PID (teardown safety net). */
  async removeByOwner(ownerPid: number): Promise<void> {
    for (const c of await this.all()) {
      if (c.ownerPid === ownerPid) await unlinkQuiet(this.ownFile(c));
    }
  }

  /** Remove claims that are dead or stale (see isClaimLive). Returns survivors. */
  async prune(now = Date.now()): Promise<ForegroundClaim[]> {
    const live: ForegroundClaim[] = [];
    for (const c of await this.all()) {
      if (isClaimLive(c, now)) live.push(c);
      else await unlinkQuiet(this.ownFile(c));
    }
    return live;
  }

  /** The pre-0.2 single-map file can only hold stale entries now; delete it. */
  private async dropLegacyStore(): Promise<void> {
    if (legacyDropped) return;
    legacyDropped = true;
    await unlinkQuiet(foregroundClaimsPath());
  }
}

let legacyDropped = false;

/**
 * Is this claim proof that a live terminal owns the JSONL right now?
 *
 * PID liveness alone is NOT sufficient. Windows recycles PIDs aggressively, and
 * this project spawns many long-lived node processes (brokers + RPC workers)
 * that readily land on a recycled PID — a dead terminal's claim then looks alive
 * forever. Freshness (a heartbeat from the owning host) is the real proof.
 */
export function isClaimLive(claim: ForegroundClaim, now = Date.now()): boolean {
  if (!isAlive(claim.ownerPid)) return false;
  const age = now - (claim.updatedAt ?? 0);
  return age >= 0 ? age < CLAIM_TTL_MS : true; // clock skew -> trust the PID
}

/** Per-session broker state (one file per managed id). */
export class BrokerStateStore {
  async read(id: ManagedId): Promise<BrokerState | undefined> {
    try {
      return JSON.parse(await readFile(brokerStatePath(id), "utf8")) as BrokerState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined; // corrupt -> treat as unknown; broker re-derives on restart
    }
  }
  async write(id: ManagedId, state: BrokerState): Promise<void> {
    await mkdir(dirname(brokerStatePath(id)), { recursive: true });
    await atomicWrite(brokerStatePath(id), JSON.stringify(state, null, 2));
  }
}

/** Durable broker spec (one file per managed id). */
export class BrokerSpecStore {
  async read(id: ManagedId): Promise<BrokerSpec | undefined> {
    try {
      return JSON.parse(await readFile(brokerSpecPath(id), "utf8")) as BrokerSpec;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }
  async write(spec: BrokerSpec): Promise<void> {
    await mkdir(dirname(brokerSpecPath(spec.id)), { recursive: true });
    await atomicWrite(brokerSpecPath(spec.id), JSON.stringify(spec, null, 2));
  }
  async remove(id: ManagedId): Promise<void> {
    try {
      await unlinkQuiet(brokerSpecPath(id));
    } catch {
      /* ignore */
    }
  }
}

async function unlinkQuiet(p: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(p).catch(() => {});
}

/**
 * Reconcile the registry against durable specs on disk.
 *
 * Recovers two partial-write cases:
 *   - broker-spec.json exists but no registry row -> reconstruct the row.
 *   - registry row exists but spec is missing -> drop the orphaned row.
 *
 * Does NOT touch broker liveness (the extension decides whether to (re)start a
 * broker based on process state after reconciliation).
 */
export async function reconcileRegistry(registry: RegistryStore): Promise<{
  added: RegistryEntry[];
  removed: ManagedId[];
}> {
  const added: RegistryEntry[] = [];
  const removed: ManagedId[] = [];

  // Discover durable specs on disk.
  const specIds = new Set<ManagedId>();
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { added, removed };
  }

  const specStore = new BrokerSpecStore();
  for (const id of entries) {
    const specPath = brokerSpecPath(id);
    try {
      await stat(specPath);
    } catch {
      continue; // no spec in this dir
    }
    specIds.add(id);
    const existing = await registry.get(id);
    if (!existing) {
      const spec = await specStore.read(id);
      if (spec) {
        const { socketAddress } = await import("./platform/paths.js");
        added.push({
          id: spec.id,
          title: await titleForSpec(spec),
          jsonlPath: spec.jsonlPath,
          cwd: spec.cwd,
          model: spec.model,
          thinkingLevel: spec.thinkingLevel,
          createdAt: spec.createdAt,
          specPath: brokerSpecPath(id),
          socketAddress: socketAddress(spec.id),
        });
      }
    }
  }

  // Apply additions.
  for (const entry of added) {
    await registry.upsert(entry);
  }

  // Remove registry rows whose durable spec disappeared.
  const rows = await registry.list();
  for (const row of rows) {
    if (!specIds.has(row.id)) {
      await registry.remove(row.id);
      removed.push(row.id);
    }
  }

  return { added, removed };
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
}

/**
 * Best title for a recovered row: the initial task, else the session's own name
 * or first user prompt read from the JSONL.
 *
 * Deliberately never the JSONL basename (a timestamp+UUID filename) and never
 * the cwd basename — the latter is what produced the "iamjo" rows.
 */
async function titleForSpec(spec: BrokerSpec): Promise<string> {
  if (spec.initialTask) return clip(spec.initialTask);
  return (await titleFromJsonl(spec.jsonlPath)) ?? "session";
}

/** Read a session name / first user prompt straight out of a pi session JSONL. */
export async function titleFromJsonl(jsonlPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(jsonlPath, "utf8");
  } catch {
    return undefined; // pi creates the file lazily; absent is normal
  }
  let firstUser: string | undefined;
  let name: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; name?: string; message?: { role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // A later session_info wins (that's how pi resolves the display name).
    if (e.type === "session_info" && typeof e.name === "string" && e.name.trim()) name = e.name.trim();
    if (!firstUser && e.type === "message" && e.message?.role === "user") {
      const c = e.message.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : "")).join("")
            : "";
      if (text.trim()) firstUser = text;
    }
  }
  const picked = name ?? firstUser;
  return picked ? clip(picked) : undefined;
}
