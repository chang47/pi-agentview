# pi-agentview — Design Spec

A **fleet dashboard** for the [pi coding agent](https://github.com/earendil-works/pi): manage many background sessions from one screen, Claude-Code-style. Cross-platform (Windows / Linux / macOS).

This document is the source of truth for what was built, why, and where every piece lives.

---

## 1. Goals & non-goals

**Goals**
- Separate the lifetime of an agent from the terminal that controls it. A managed agent keeps running with no terminal attached.
- One screen (Agent View) showing every session — background brokers **and** the current foreground session — with live status, the model's reply, peek/reply, rename.
- Match Claude Code's actual capability: sessions survive terminal close while the machine is on, and are **fully recovered with zero data loss** on reopen. (CC itself does not survive reboot; neither do we, by design.)
- One distributable package that runs identically on Windows and POSIX.

**Non-goals (Tier 1)**
- Surviving logout/reboot (a pluggable OS-supervisor adapter is the seam; not built).
- Answering blocking dialogs (`select`/`confirm`) inline from the view — reply currently sends a follow-up prompt. (Future.)
- Native MCP (pi gap; out of scope here).

---

## 2. Architecture (4 pieces)

```
┌──────────────────────────────────────────────────────────────┐
│  Extension  (src/index.ts)                                    │
│   • Left-Arrow editor -> /agents        (src/extension/editor)│
│   • /agents command -> fleet view       (src/extension/view)  │
│   • foreground ownership hooks          (claims)              │
│   • auto-background on swap             (session_before_switch│
│   • switchSession handoff (resume)                            │
│   • BrokerManager lifecycle             (src/extension/       │
│                                            controller)        │
└──────────────────────────────────────────────────────────────┘
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

**Failure isolation:** one broker per session (not a global daemon). A broken session/broker can't take down the others. Brokers are detached processes that survive the foreground pi/terminal closing.

---

## 3. State model (3 layers)

> The Pi JSONL is **always the source of truth.** The registry and broker state are reconstructable indexes — a corrupt index never destroys conversation history.

| Layer | Where | Authoritative? | Holds |
|---|---|---|---|
| **1. Conversation** | Pi session `.jsonl` | ✅ yes | messages, tool calls, branches, session identity |
| **2. Registry** | `registry.json` | index | which sessions appear in Agent View: id, **title**, jsonlPath, cwd, model, thinkingLevel, specPath, socketAddress |
| **3. Broker state** | per-session `broker-state.json` | index | operational status: `state`, `activity`, `finalResponse`, run/completion times, `pendingDialog`, `lastEventSeq` |
| **Foreground claims** | `foreground-claims.json` | index | live interactive sessions: sessionId(=jsonlPath), title, cwd, model, **ownerPid**, nonce |

State directory: `%LOCALAPPDATA%\pi-agentview\` (Win) · `~/.local/state/pi-agentview/` (Linux) · `~/Library/Application Support/pi-agentview/` (mac). See `src/platform/paths.ts`.

Types: `src/types.ts` — `SessionState` (working / completed / awaiting_input / interrupted / idle / needs_attention / stopped / **foreground**), `RegistryEntry`, `BrokerSpec`, `BrokerState`, `ForegroundClaim`, `JournalEvent`.

---

## 4. Cross-platform platform layer — `src/platform/`

Node's built-ins abstract most differences; the ~5 real seams live here, selected at runtime by `process.platform`.

| File | Concern | POSIX | Windows |
|---|---|---|---|
| `paths.ts` | state dir + IPC address | unix socket `<stateDir>/sockets/<id>.sock` | named pipe `\\.\pipe\pi-agentview-<id>` |
| `spawn.ts` | detached broker spawn + pi CLI resolution | `node <cli.js>` | same (`node <cli.js>`, no shell) |
| `kill.ts` | tree-kill | `process.kill(-pgid)` SIGTERM→SIGKILL | `taskkill /T /F` |
| `pid.ts` | liveness + identity | `process.kill(pid,0)` + nonce | same |
| `atomic.ts` | atomic file replace | `rename` | `rename` + retry on `EPERM`/`EBUSY` |

Key decisions:
- **IPC transport:** `net.listen(socketAddress(id))` is a unix socket on POSIX and a named pipe on Windows — one code path, only the address string differs.
- **No `shell:true`:** the broker spawns `node <pi-cli.js>` directly (resolved via `import.meta.resolve("@earendil-works/pi-coding-agent")` + the package's `bin`). Avoids Node's DEP0190 warning and works identically everywhere. The extension passes the resolved path to the broker via the `PI_AGENTVIEW_PI_CLI` env var.
- **PID-reuse guard:** primary mechanism is a per-broker **nonce** in the lockfile, confirmed via an IPC auth challenge. A recycled PID can't produce the matching nonce.

---

## 5. Broker — `src/broker/` (bundle entry `src/broker.ts` → `dist/broker.mjs`)

Owns **one** headless `pi --mode rpc` worker per managed session; exposes a private, reconnectable local IPC endpoint.

| File | Role |
|---|---|
| `main.ts` | Orchestrator: parse args (`--id --nonce`), load `BrokerSpec`, acquire lock, spawn worker, wire RPC events → journal → state → IPC broadcast, handle worker death, graceful shutdown |
| `rpc-client.ts` | `PiRpcClient`: spawns `pi --mode rpc`, **manual LF framing** (not readline — U+2028/2029 safe), request/response correlation, fire-and-forget writes |
| `journal.ts` | Append-only event journal with **monotonic seq**; persisted to `journal.jsonl`; in-memory ring for replay-after-reconnect |
| `state.ts` | Pure reducer: RPC event → `BrokerState` transition (or null). Status from first-class events, never scraping |
| `ipc.ts` | `IpcServer`: named-pipe/socket server, **nonce auth**, snapshot+replay on connect, single **mutation lease**, fan-out |
| `lock.ts` | lockfile `{pid, nonce, startedAt}` acquire/read/release |

**State derivation (`state.ts`):**
- `agent_start` → working · `tool_execution_start` → "tool: X" · `compaction_start` → "compacting" · `auto_retry_start` → "retrying" · `message_end`(assistant) → captures `finalResponse` (≤4000 chars) · `extension_ui_request`(select/confirm/input/editor) → awaiting_input · `agent_settled` → completed (records run duration)
- **Conservative interrupt:** worker death during active work → `interrupted` (never auto-replays — a tool may have side-effected before its result persisted).

**IPC protocol (JSONL):** client→broker `hello`/`acquire_lease`/`release_lease`/`rpc`/`answer`/`shutdown`; broker→client `auth_ok`/`auth_fail`/`snapshot`/`state`/`event`/`lease`.

---

## 6. Extension — `src/extension/` + `src/index.ts`

### `index.ts` — wiring
- `session_start`: **always** reconcile (the BrokerManager is recreated on every session replacement, so in-memory state is lost across switches); skip the foreground session's own JSONL; install the Left-Arrow editor (TUI only); write foreground claim.
- `session_before_switch`: **auto-background** the session being left if not already tracked (covers `/new` + resume).
- `session_shutdown`: remove the foreground claim.
- `session_info_changed` / `model_select` / `thinking_level_select`: refresh the claim.
- `registerCommand("agents", ...)`: open the view; dispatch create / resume / remove.
- `resume` action also calls `backgroundCurrentIfUntracked` (idempotent with the hook).

### `editor.ts` — `AgentsEditor extends CustomEditor`
Left-Arrow on an **empty** buffer submits `/agents` through the real editor submit callback (runs normal slash dispatch so the command handler gets session-switching APIs). Non-empty buffer → normal cursor movement.

### `view.ts` — `AgentViewComponent` (rendered via `ctx.ui.custom`)
Grouped rows by urgency, status glyphs, the model's reply as the row preview, and a peek/reply + rename input. Navigation indexes against the **flattened visual (grouped) order** — not creation order (that was the inverted-nav bug).
- Keys: `↑↓/j k` select · `Space` peek (then type a reply, `Enter` sends) · `Enter` resume · `n` new · `d` remove **(stays in view)** · `r` rename (inline) · `Esc` close.

### `controller.ts` — `BrokerManager`
Owns the live set: in-memory `sessions` map + cached foreground rows.
- `reconcile(skipJsonl?)`: rebuild registry from disk, refresh/prune foreground claims, (re)connect live brokers, restart dead ones (skipping the foreground).
- `tick()`: refresh foreground-claim cache + prune claims whose owner PID died (the redundancy checkpoint, called by the view's 1s timer and by reconcile).
- `create` / `registerExisting` (background current, no spawn) / `stopBrokerForResume` / `returnToPool` / `remove` (preserves JSONL) / `sendReply` / `setTitle` / `isTracked`.
- `rows()`: merges foreground rows + broker rows, **dedup by jsonlPath (foreground wins)**.

### `render.ts` — pure view-model (unit-tested)
`ManagedRow`, `rowsFor`, `groupRows` (urgency-ordered), `statusGlyph`, `stateLabel`, `formatElapsed`. No TUI deps.

### `ipc-client.ts` — `IpcClient`
Connects to a broker, authenticates, subscribes to state/event/lease, forwards `prompt`/`follow_up`/`answer`/`shutdown`.

---

## 7. Lifecycle flows

**Create (`n`):** dialogs → `mgr.create` writes spec+registry, spawns broker (detached), connects IPC. Broker boots the worker; optional initial task fires as the first prompt.

**Resume (`Enter`):** `backgroundCurrentIfUntracked` (save the leaving session) → `stopBrokerForResume(target)` (releases target's JSONL) → `ctx.switchSession(target.jsonl)`. On the next `session_start`, reconcile restarts the broker for the session we left.

**Auto-background on swap (`/new` or resume):** `session_before_switch` → if the leaving session's JSONL isn't tracked, `registerExisting` writes durable spec+registry (no spawn — foreground still owns the file). After the switch releases the file, `reconcile` spawns its broker.

**Reply-from-peek (`Space`, type, `Enter`):** view → `mgr.sendReply` → IPC `rpc` → broker forwards `follow_up` (if busy) or `prompt` (if idle) to the worker.

**Rename (`r`):** background → `mgr.setTitle` updates the registry entry; foreground → `pi.setSessionName` (sticks as the real session name).

**Foreground tracking:** every `session_start` writes/refreshes a claim keyed by **jsonlPath** (so `session_shutdown` — which removes by jsonlPath — actually clears it). The view shows claims as `▶ Foreground` rows.

**Redundancy:** every `session_start` + each 1s view tick prunes dead claims and reconnects/restarts dead brokers.

---

## 8. Testing

All run via jiti against the **real** modules on the host (Windows-validated).

| Suite | File | Covers | Result |
|---|---|---|---|
| Phase A | `smoke.ts` | platform + registry (named-pipe IPC, atomic replace, taskkill, PID liveness, reconcile) | 12/12 |
| Phase B | `smoke-broker.ts` | real `pi --mode rpc` round-trip + **live broker e2e** (agent_start→agent_settled→completed) + journal/state/IPC | 25/25 |
| Phase C | `smoke-extension.ts` | render logic + real BrokerManager create→rows→remove + reconcile-from-orphan | 13/13 |

The interactive TUI (editor, view rendering, `switchSession` handoff) is typechecked + load-tested (`pi -e ... -p` exit 0) but driven manually in a live terminal.

---

## 9. Install / dev

```bash
cd pi-agentview
npm install
npm run typecheck          # tsc --noEmit
npm run build:broker       # esbuild src/broker.ts -> dist/broker.mjs
```

**Dev (live reload):** a 1-line loader at `~/.pi/agent/extensions/pi-agentview.ts` re-exports the live `src/index.ts`, so plain `pi` auto-loads it and `/reload` picks up edits.
**Permanent (frozen copy):** `pi install .` (then `/reload` reloads the copy — re-run after source edits).

---

## 10. Known limitations / roadmap

- Dialog-answering from peek (render `select` choices, pick one) — reply currently sends a follow-up.
- Foreground-row live activity (tool calls/replies) — currently a static marker; the main TUI already shows it.
- Secondary PID start-time guard; Job-Object tree-kill on Windows; named-pipe DACL hardening.
- Pluggable OS-supervisor adapter (systemd-user / Task Scheduler / launchd) for true reboot survival.

---

## 11. Code map

```
src/
├── types.ts                 (110) 3-layer state model + SessionState
├── registry.ts              (217) JsonStore + Registry/Spec/State/Claim stores + reconcile
├── index.ts                 (144) extension wiring (hooks, /agents, editor, claims)
├── broker.ts                  (8) bundle entry → dist/broker.mjs
├── platform/
│   ├── paths.ts              (78) state dir + named-pipe/socket address
│   ├── spawn.ts              (63) detached spawn + pi CLI resolution (no shell)
│   ├── kill.ts               (47) taskkill (win) / process-group (posix)
│   ├── pid.ts                (28) isAlive + nonce
│   └── atomic.ts             (47) temp+rename, retry on EPERM
├── broker/
│   ├── main.ts              (165) orchestrator
│   ├── rpc-client.ts        (149) pi RPC worker bridge (LF framing)
│   ├── journal.ts            (60) monotonic event journal + replay
│   ├── state.ts             (110) pure event→state reducer
│   ├── ipc.ts               (222) IPC server (auth, lease, fan-out)
│   └── lock.ts               (30) lockfile (pid+nonce)
└── extension/
    ├── editor.ts             (20) Left-Arrow → /agents
    ├── view.ts              (312) fleet view (peek/reply/rename, in-place delete)
    ├── controller.ts        (285) BrokerManager lifecycle
    ├── render.ts            (129) pure view-model
    └── ipc-client.ts        (105) broker IPC client
dist/broker.mjs             (~21KB) bundled broker
smoke.ts / smoke-broker.ts / smoke-extension.ts   test suites
README.md                          quickstart + status
DESIGN.md                          this document
```
