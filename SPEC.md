# pi-agentview — Spec & Cross-Check Document

**Purpose:** a complete record of what this project is, what it's trying to be, **why** each decision was made (grounded in Claude Code's agent-view research), the current implementation, known bugs, and open questions. Written so a **second agent can cross-check the work** — verify correctness, find holes, and challenge decisions.

> Note: `DESIGN.md` is **stale** (written mid-build, before the foreground→attached reframe, peek/reply, rename, and the single-writer crash fix). **This file is the source of truth.**

---

## 1. What this is

A **fleet dashboard extension** for the [pi coding agent](https://github.com/earendil-works/pi): manage many background coding sessions from one screen, inspired by Claude Code's *agent view*. Built cross-platform (Windows-first, also Linux/macOS). One distributable `pi` package.

**Current state:** functional, tested (50 automated tests, Windows-validated, incl. a live model end-to-end). Several known rough edges (§10). Not yet `pi install`-ed for production — loaded via a dev loader for live `/reload`.

---

## 2. Context: pi vs Claude Code (the research that drives everything)

**Claude Code's agent view (verified from code.claude.com/docs/en/agent-view + architecture sources):**
- A **per-user supervisor daemon** (`~/.claude/daemon/`) **owns every background session *process***. Each session = its own worker PID + Unix sockets, registered in an on-disk roster (`roster.json`).
- The agent-view TUI is a **control surface** that talks to the daemon. **Attach** = the daemon hands the session's I/O to your terminal; the session *process never moves*. Detach (`←`) = the session keeps running under the daemon.
- Agent view lists **background sessions only**. Quote: *"Interactive sessions you have open in other terminals don't appear until you background them."* **There is no foreground row.**
- Naming: a **Haiku-class model auto-names** from the prompt + `Ctrl+R` rename.
- Single-writer per session too — **one attached terminal at a time**. (CC has *many sessions*, not many concurrent attachers to one.)
- Survives terminal close (daemon owns processes); **does not survive reboot**.

**pi's reality (the fundamental constraint):**
- A pi session is a **JSONL file owned by a single pi process** (single writer; two writers corrupt it).
- pi has **no daemon**, and **no mechanism to attach a terminal to an already-running session**. RPC mode (`pi --mode rpc`) starts a *fresh headless worker* — it does not attach to an existing interactive pi.
- The full native UX (every slash command, editor, autocomplete, `/model`, tool rendering) exists **only in interactive mode**, which requires the pi process to **own the session file**. A headless RPC worker has a reduced command surface.

**The one-sentence crux:** CC owns sessions in a daemon and terminals *attach as views*; pi sessions are single-writer files with no attach API, so the only way to "enter" a session with full UX is for the foreground pi to **own the file**. Every design choice below is a consequence of bridging that gap.

---

## 3. Goals & non-goals

**Goals**
- Background sessions that keep running with no terminal attached; recoverable with zero data loss on reopen (parity with CC's *actual* capability — CC also doesn't survive reboot).
- One dashboard showing every session, with live status, the model's reply, peek/reply, rename.
- Full native pi UX (all slash commands) when you're "in" a session.
- One package, identical on Windows/POSIX.

**Non-goals (Tier 1)**
- Reboot survival (pluggable OS-supervisor is the seam; not built).
- Multiple terminals concurrently attached to one session (CC doesn't do this either).
- Inline dialog-answering from the dashboard (reply sends a follow-up today).
- Native MCP (pi gap).

---

## 4. Key decisions & rationale (the WHY — read this first)

| Decision | Why |
|---|---|
| **Per-session brokers, not one global daemon** (divergence from CC) | Failure isolation (one crash can't kill all sessions); pi has no daemon primitive, so we compose from detached broker processes. Tradeoff: more processes; harder OS-supervision (unneeded at Tier 1). |
| **Resume = stop broker → reopen JSONL in foreground pi (the "handoff dance")** | pi can't attach a terminal to a running session. Full interactive UX (slash commands) **only** exists when the foreground pi owns the file. So "entering" a background session requires transferring file ownership. This is the core compromise pi forces. |
| **Considered "Path A" (daemon owns all + remote attached TUI) — rejected** | Would require reimplementing pi's interactive transcript as a custom extension component (large), AND would **lose native slash commands** (they only exist in interactive mode) — directly against the primary requirement. |
| **"Attached" claims (foreground tracking), reframed from "foreground"** | (a) show active sessions for continuity (no jarring vanish on switch); (b) **detect single-writer conflicts** (don't spawn a broker for a file a terminal owns); (c) recover crashed terminals (prune dead-PID claims). Renamed foreground→attached after the term caused confusion and stale-row accumulation. |
| **Reconcile on EVERY `session_start`, not just startup** | pi **recreates the extension (and the in-memory BrokerManager) on every session replacement** (new/resume/fork). In-memory state is lost across switches → must repopulate from the durable registry every time. (An early bug: reconcile only ran at startup → empty view after any switch.) |
| **Auto-background on swap (`session_before_switch`)** | Matches CC's flow — switching away from a session sends it to the background pool. Idempotent (`isTracked` check). Writes durable spec+registry only (no broker spawn while the foreground owns the file); reconcile spawns the broker after the switch releases the file. |
| **Spawn `node <pi-cli.js>` directly, no shell** | Avoids Node's DEP0190 (`shell:true` + args), identical Windows/POSIX, stdio pipes straight to pi. Resolved via `import.meta.resolve("@earendil-works/pi-coding-agent")` + the package `bin`. The extension passes the path to the broker via `PI_AGENTVIEW_PI_CLI` env. |
| **Conservative interrupt** | If a worker dies mid-run, **never auto-replay** — a tool may have side-effected before its result persisted. Mark `interrupted`; needs human ack. |
| **JSONL = source of truth; registry/claims/broker-state are rebuildable indexes** | Corruption-safety: a corrupt index never destroys conversation history. Reconciliation rebuilds indexes from durable sources. |
| **Heartbeat (`tick`) for recovery, no manual probe** | User preference. `tick` runs every 1 s the dashboard is open + on reconcile, prunes dead-PID claims, reconnects/restarts brokers. Known edge: PID reuse (§10). |

---

## 5. Architecture (4 pieces)

```
┌─────────────────────────────────────────────────────────────┐
│  Extension (src/index.ts)                                    │
│   • Left-Arrow editor -> /agents      (src/extension/editor) │
│   • /agents command -> fleet view     (src/extension/view)   │
│   • attached ownership hooks (claims)                        │
│   • auto-background on swap           (session_before_switch)│
│   • switchSession handoff (resume)    (the single-writer     │
│   • BrokerManager lifecycle           dance)                 │
│                                        (src/extension/       │
│                                            controller)       │
└─────────────────────────────────────────────────────────────┘
        │ spawns detached                     │ reads/writes
        ▼                                     ▼
┌─────────────────────────────┐        ┌──────────────────────┐
│  Broker (src/broker.ts →     │        │  Stores              │
│           dist/broker.mjs)   │ state  │  (src/registry.ts)   │
│   • owns pi --mode rpc worker│◄───────│   JSONL = source of  │
│   • IPC server (pipe/socket) │        │   truth              │
│   • event journal + replay   │        └──────────────────────┘
│   • single mutation lease    │
└─────────────────────────────┘
        │ spawns
        ▼
   pi RPC worker (the actual agent)
```

**Failure isolation:** one broker per session (not a global daemon). Brokers are **detached** processes that survive the foreground pi/terminal closing.

---

## 6. State model

> Pi JSONL is **always authoritative.** Everything else is a rebuildable index.

| Layer | File | Holds |
|---|---|---|
| Conversation | Pi session `.jsonl` | messages, tool calls, branches (source of truth) |
| Registry | `registry.json` | which sessions appear: id, **title**, jsonlPath, cwd, model, specPath, socketAddress |
| Broker state | per-session `broker-state.json` | `state`, `activity`, `finalResponse`, run/completion times, `pendingDialog`, `lastEventSeq` |
| Broker spec | per-session `broker-spec.json` | durable restart params (jsonl, cwd, model, initialTask) |
| Attached claims | `foreground-claims.json` | sessions open in a terminal: sessionId(=jsonlPath), title, cwd, model, **ownerPid**, nonce, updatedAt |
| Journal | per-session `journal.jsonl` | monotonic-seq event log for replay-after-reconnect |

State dir: `%LOCALAPPDATA%\pi-agentview\` (Win) · `$XDG_STATE_HOME/pi-agentview` (Linux) · `~/Library/Application Support/pi-agentview` (mac) — `src/platform/paths.ts`. **Shared across all pi instances on the machine.**

Types: `src/types.ts`. `SessionState` = working | completed | awaiting_input | interrupted | idle | needs_attention | stopped | **attached**.

---

## 7. Current implementation (file map)

```
src/
├── types.ts                 (110) SessionState, RegistryEntry, BrokerSpec, BrokerState, ForegroundClaim, JournalEvent
├── registry.ts              (217) JsonStore (atomic, corruption-safe) + Registry/Spec/State/Claim stores + reconcileRegistry
├── index.ts                 (176) EXTENSION WIRING: hooks, /agents command, editor install, claims, deriveTitle, backgroundCurrentIfUntracked
├── broker.ts                  (8) bundle entry → dist/broker.mjs
├── platform/
│   ├── paths.ts              (78) state dir + named-pipe (win) / unix-socket (posix) address
│   ├── spawn.ts              (63) detached broker spawn + pi CLI resolution (node <cli.js>, no shell)
│   ├── kill.ts               (47) taskkill /T /F (win) / process-group SIGTERM→KILL (posix)
│   ├── pid.ts                (28) isAlive (process.kill signal 0) + nonce
│   └── atomic.ts             (47) temp+rename, retry on EPERM/EBUSY (the Windows file-lock gotcha)
├── broker/
│   ├── main.ts              (165) orchestrator: args, spec, lock, spawn worker, wire events→journal→state→IPC, worker-death, shutdown
│   ├── rpc-client.ts        (149) PiRpcClient: spawns pi --mode rpc; MANUAL LF framing (not readline — U+2028/2029 safe); req/res correlation
│   ├── journal.ts            (60) append-only event journal, monotonic seq, in-memory replay ring
│   ├── state.ts             (110) PURE reducer: RPC event → BrokerState (status from first-class events, never scraping)
│   ├── ipc.ts               (222) IpcServer: nonce auth, snapshot+replay-on-connect, single mutation lease, fan-out
│   └── lock.ts               (30) lockfile {pid, nonce, startedAt}
└── extension/
    ├── editor.ts             (20) AgentsEditor: Left-Arrow on empty buffer → submits /agents via real callback
    ├── view.ts              (318) AgentViewComponent: grouped rows, reply preview, peek/reply, inline rename, in-place delete, "attached" markers
    ├── controller.ts        (292) BrokerManager: reconcile/tick/create/registerExisting/stopBrokerForResume/returnToPool/remove/sendReply/setTitle/isTracked/isAttachedElsewhere
    ├── render.ts            (129) PURE view-model: ManagedRow, rowsFor, groupRows (urgency-ordered), statusGlyph, stateLabel, formatElapsed
    └── ipc-client.ts        (105) IpcClient: connect, auth, subscribe, forward prompt/follow_up/answer/shutdown

dist/broker.mjs             (~21KB) bundled broker (esbuild)
smoke.ts / smoke-broker.ts / smoke-extension.ts   test suites (12 / 25 / 13 tests)
~/.pi/agent/extensions/pi-agentview.ts            DEV LOADER (re-exports live src/index.ts for /reload)
```

---

## 8. Lifecycle flows

- **Create (`n` in view):** dialogs → `mgr.create` (spec+registry+spawn broker+connect IPC); optional initial task fires as first prompt.
- **Resume (`Enter`):** guard `isAttachedElsewhere` (refuse if another live terminal owns it) → `backgroundCurrentIfUntracked` (save the session we're leaving) → `stopBrokerForResume(target)` (release target JSONL) → `ctx.switchSession(target.jsonl)`. Next `session_start` reconciles → restarts the broker for the session we left.
- **Auto-background on swap (`/new` or resume):** `session_before_switch` → if leaving session's JSONL untracked, `registerExisting` (durable write only). Reconcile spawns the broker once the file is free.
- **Reply-from-peek (`Space`, type, `Enter`):** view → `mgr.sendReply` → IPC `rpc` → broker forwards `follow_up` (if busy) or `prompt` (if idle).
- **Rename (`r`):** background → registry title; attached → `pi.setSessionName`.
- **Attached tracking:** every `session_start` writes/refreshes a claim keyed by **jsonlPath** (matches `session_shutdown` removal key — an earlier bug keyed by sessionId UUID and claims never cleared).
- **Recovery (heartbeat):** `tick()` (1 s while view open + on reconcile) prunes claims whose `ownerPid` died → session returns to background, reconnectable.

---

## 9. Cross-platform platform layer (`src/platform/`)

Node built-ins abstract most differences; ~5 seams selected by `process.platform`:

| Concern | POSIX | Windows |
|---|---|---|
| IPC | unix socket | named pipe `\\.\pipe\pi-agentview-<id>` (one `net.listen` path) |
| Spawn broker | `detached:true` (new session) | + `windowsHide:true` |
| Spawn pi worker | `node <cli.js>` | same (no shell) |
| Tree-kill | `process.kill(-pgid)` | `taskkill /T /F` |
| PID-reuse guard | nonce in lockfile + IPC challenge | same |
| Atomic replace | `rename` | `rename` + retry on `EPERM`/`EBUSY` |

---

> **2026-07-31 — §10 and §11 below are SUPERSEDED by [`REVIEW.md`](./REVIEW.md).** A full cross-check
> found that most of these symptoms shared one root cause: the extension is installed at USER scope,
> so pi loads it into the `pi --mode rpc` **workers our own brokers spawn**, and each worker ran the
> full fleet-manager lifecycle (self-claiming as "attached", reconciling, spawning brokers). That —
> not PID reuse — is why foreground rows had wrong names, and it produced an observed live
> single-writer violation. 23 bugs fixed; every §11 question is answered in REVIEW.md §3.
> Still open: registry.json multi-writer race, JSONL-as-source-of-truth is not actually implemented,
> inline dialog answering. **Read REVIEW.md first.**

## 10. Known issues / bugs / TODO (HISTORICAL — see REVIEW.md)

1. **Stale attached claims from dead terminals aren't always cleaned up** (user currently sees 3). Likely cause: **PID reuse** (dead terminal's PID recycled by an unrelated process → `isAlive` true → not pruned), OR `tick` only runs while a dashboard is open / on `session_start` (no background sweep). User says "OK for now." **Fix: add process start-time to claims (secondary guard); add a startup sweep.**
2. **PID-reuse edge** (same root): a dead owner can look alive briefly. Roadmap: start-time guard.
3. **No GC of removed sessions' state dirs** — 29 dirs accumulated. `remove()` clears registry+spec but leaves the session dir.
4. **No inline dialog-answering** — peek reply sends a follow-up; can't pick a `select`/`confirm` choice.
5. **No live activity on attached rows** — static marker only (the main TUI already shows the local session's activity).
6. **Resume handoff race** — `stopBrokerForResume` → `switchSession`: brief ownership-transfer window; Windows file-lock release timing is unverified for tight sequences.
7. **Shared state files across instances** (`registry.json`, `foreground-claims.json`) — atomic writes mitigate, but multi-writer last-write-wins could lose an update. No file lock.
8. **Dev loader hardcodes an absolute path** (`~/.pi/agent/extensions/pi-agentview.ts`) — breaks if the repo moves. Fine for dev; use `pi install .` for a frozen copy.
9. **Broker restart-on-reconcile for dead brokers** could spawn many workers on every `session_start` if many are dead. Accepted (user wants many background sessions).
10. **`DESIGN.md` is stale** — this file supersedes it.

---

## 11. Open questions for the cross-checker (ANSWERED — see REVIEW.md §3)

1. **Is the single-writer guarantee airtight?** Trace *every* path that opens a session JSONL: `ensureBroker` (via reconcile), `create`, `registerExisting`+reconcile, `returnToPool`, resume (`switchSession`). Confirm none can produce two concurrent writers. (The most recent crash was a hole: reconcile didn't skip sessions attached to another terminal — now fixed in `reconcile` via `attachedJsonls` + the `isAttachedElsewhere` resume guard. **Are there other holes?** e.g., `returnToPool` after a resume — does it verify the file is free before restarting the broker? `ensureBroker` on a dead broker whose JSONL a terminal just opened?)
2. **Why do dead-terminal claims persist?** Determine if it's PID reuse or tick-not-running, and propose the minimal robust fix (start-time field + startup sweep that cross-checks claims against live broker/terminal PIDs).
3. **Race in the resume handoff** — on Windows, is the broker's file handle fully released *before* `switchSession` opens it? Could `stopBrokerForResume`'s `killTree` grace be insufficient? Reproduce/verify.
4. **Concurrency on shared state files** across multiple pi instances — is the atomic-write + JSON-merge strategy safe under concurrent writers, or can registry/claim entries be lost? Is a lock needed?
5. **Reconcile restarting `interrupted` brokers** — confirm the broker preserves `interrupted` state on restart and never auto-replays (the conservative-interrupt invariant).
6. **`deriveTitle`** reads `ctx.sessionManager.getBranch()` on every claim write — robust across compacted/image-only/single-turn sessions? Any throw paths outside its try/catch?
7. **Extension-reload staleness** — after `switchSession`, the old `BrokerManager` is torn down. Are there captured references (e.g., in `withSession` callbacks, or the resume action after `switchSession`) that use stale objects? The `backgroundCurrentIfUntracked` + `registerExisting` pattern was chosen to write durable state *before* the switch precisely to avoid this — confirm it holds everywhere.
8. **Naming correctness** — does the title reliably come from session name → first user prompt → "session" (never cwd/username)? The "iamjo" bug was the cwd-basename fallback; verify it's gone everywhere claims/registry titles are set.

---

## 12. How to run / test

```bash
cd pi-agentview
npm install
npm run typecheck          # tsc --noEmit
npm run build:broker       # esbuild src/broker.ts -> dist/broker.mjs
node <jiti-cli.mjs> smoke.ts            # Phase A: platform + registry (12)
node <jiti-cli.mjs> smoke-broker.ts     # Phase B: real RPC + live broker e2e (25)
node <jiti-cli.mjs> smoke-extension.ts  # Phase C: render + BrokerManager (13)
```

Interactive (manual): `pi` (the dev loader auto-loads it) → Left-Arrow opens Agent View. `/reload` picks up source edits.

jiti CLI location: `node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs` (or the global pi install's copy).
