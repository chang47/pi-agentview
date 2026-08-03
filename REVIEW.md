# pi-agentview — code review (2026-07-31)

Reviewed against `SPEC.md`, pi `@earendil-works/pi-coding-agent@0.82.1` (types, `docs/rpc.md`,
`docs/extensions.md`, `dist/core/agent-session-runtime.js`), and the live state on this machine.

**Verdict: the design is right. The implementation had one architectural omission that caused most
of the symptoms you've been chasing.** Everything else is ordinary bugs, several of them serious.

---

## 0. The headline

**The extension had no notion of *host role*.** It is installed at USER scope, so pi loads it into
**every** pi process — including the `pi --mode rpc` workers that pi-agentview's own brokers spawn.
Every worker therefore ran the full fleet-manager lifecycle: claimed its own session as "attached",
reconciled the registry, and spawned/connected brokers for the whole fleet.

This is a **self-instantiating system**, and it is the root cause of your "the name is wrong on the
foreground" complaint. Those foreground rows were never your terminal.

### Proof (not inference)

1. A spawned RPC worker answers `get_commands` with `agents`, `sourceInfo.path =
   ~/.pi/agent/extensions/pi-agentview.ts`, `scope: "user"`. Extensions **do** run in RPC mode —
   `docs/rpc.md` states `ctx.mode === "rpc"` and tells you to guard TUI features on `mode === "tui"`.
2. On-disk claim `ownerPid: 40236`, `jsonlPath: …019fa955….jsonl`. PID 40236's actual command line is
   `pi … --mode rpc --session …019fa955….jsonl` — **byte-identical**. The worker claimed itself.
   Not PID reuse.
3. **Live single-writer violation at review time:** PID 7768 (interactive pi) and PID 13944 (RPC
   worker) were both on `…019fa42a….jsonl`. That is the exact corruption case the design exists to
   prevent, happening in production.
4. **Measured startup cost:** a worker's first stdout came at **28,522 ms**, because `session_start`
   awaited `reconcile()` → broker spawn + IPC connect retry loops. After the fix: **1,546 ms** (18×).
5. **12 orphaned processes** (6 brokers + 6 RPC workers) had been running since Jul 28.

**Fix:** `isFleetHost(ctx)` = `ctx.mode === "tui" && !process.env.PI_AGENTVIEW_BROKER_CHILD`. The
broker now stamps `PI_AGENTVIEW_BROKER_CHILD=1` on the worker it spawns (belt), and every hook
returns early when the guard fails (braces).

---

## 1. Is the core design right?

**Yes**, and I verified the constraint it's built on rather than taking SPEC §2 on trust.

`AgentSessionRuntime.switchSession()` (`dist/core/agent-session-runtime.js`) does:

```js
await this.emitBeforeSwitch("resume", sessionPath);   // session_before_switch
const sessionManager = SessionManager.open(sessionPath);   // ← TARGET FILE OPENED HERE
await this.teardownCurrent("resume", …);              // session_shutdown
this.apply(await this.createRuntime({ … }));          // session_start (new extension instance)
```

Two consequences the SPEC gets right and one it under-states:

- ✅ pi opens the target **before** any teardown hook runs. So a background broker's release **must
  be complete before `ctx.switchSession()` is called** — there is no later chance to let go. The
  resume flow orders this correctly.
- ✅ The extension really is **recreated** on every session replacement, so `reconcile()` on every
  `session_start` is necessary, not defensive.
- ⚠️ Because of that recreation, `lastResumedId` (a closure variable) is **always `undefined`** at
  the next `session_start`. The `returnToPool` branch is effectively dead; `reconcile()` is the only
  path that actually restarts the broker for the session you left. That's fine, but the SPEC
  presents `returnToPool` as the mechanism, and it isn't.

**Divergences from Claude Code, judged:**

| Choice | Verdict |
|---|---|
| Per-session brokers, not one daemon | **Right.** pi has no daemon primitive; failure isolation is real. Cost is 2N processes with **no central reaper** — which is exactly what produced 12 orphans. That's a missing component, not a wrong architecture. |
| Resume = stop broker → reopen in foreground pi | **Right, and forced.** Full slash-command UX only exists in interactive mode, which requires owning the file. Path A would have cost native commands. |
| An "attached" row (CC has none) | **Better UX, highest complexity-per-value.** It's the source of the entire claim subsystem, and most of your bugs live there. Keep it — but the freshness invariant below has to be a stated rule, not an implementation detail. |
| JSONL is source of truth | **Stated but not implemented.** Nothing read the JSONL until this review. See gap G1. |

---

## 2. Bugs found and fixed

Severity: **S1** = data loss / corruption / core feature broken · **S2** = user-visible wrong
behaviour · **S3** = correctness nit or latent.

### S1 — Single-writer holes

| # | Bug | Detail | Fix |
|---|---|---|---|
| 1 | **RPC workers act as fleet managers** | Above. Produced a live double-writer. | `isFleetHost()` guard + `PI_AGENTVIEW_BROKER_CHILD` env stamp. |
| 2 | **`ensureBroker` never recorded `brokerPid` on the reconnect path** | If a broker was already alive (lock held), `ms.brokerPid` stayed `undefined`. So `stopBrokerForResume()`'s `if (ms.brokerPid && isAlive(…)) killTree(…)` was a **no-op**, and `remove()` likewise. The broker survived, kept its worker, kept the JSONL. **This is the mechanism behind both the orphan processes and the resume race in SPEC §11.1/§11.3.** | Set `ms.brokerPid = lock.pid` on reconnect. |
| 3 | **Resume released the file on hope, not confirmation** | `stopBrokerForResume` sent IPC `shutdown` then **immediately destroyed the socket** (the message could be dropped), never waited for death, and returned `void`. The caller switched sessions regardless. | Now: send shutdown → `waitForExit` → `killTree` fallback → `waitForExit` → **return `boolean`**. `index.ts` refuses to switch on `false` and tells the user why. |
| 4 | **`PiRpcClient.stop()` gave up after 2.5 s** | It ended stdin, waited, then just set `this.proc = null` — leaving a live worker with a dying parent. Orphan-worker leak. | `killTree` the worker if it hasn't exited. |

### S2 — The naming bug you reported

| # | Bug | Detail | Fix |
|---|---|---|---|
| 5 | **cwd-basename fallback still present** | SPEC §11.8 asks to confirm the "iamjo" fallback is gone everywhere. **It wasn't** — `controller.ts:78` had `c.title \|\| c.cwd.split(/[\\/]/).pop()`. Any claim with an empty title still rendered as your home-folder name. | Fallback is now `"session"`. Never cwd, never username. |
| 6 | **Claim title was written once and never refreshed** | `writeClaim` ran at `session_start`, when the branch is empty and no session name exists → `"session"` forever, even after you typed a prompt. (Your live claim literally read `"session"`.) | Title re-derived on a 10 s heartbeat **and** on `agent_start`, so it upgrades to the first user prompt / `/name` as soon as one exists. |
| 7 | **Background rows titled with a JSONL basename** | `registerExisting` and `titleFromSpec` fell back to `2026-07-28T15-26-13-426Z_019fa955-….jsonl`. Your registry is full of these. | New `titleFromJsonl()` reads the session's own `session_info` name, else its first user message, out of the JSONL. |

### S2 — Lifecycle / recovery

| # | Bug | Detail | Fix |
|---|---|---|---|
| 8 | **Stale "attached" rows never pruned** | PID liveness is **not** proof of ownership. Windows recycles PIDs aggressively, and this project spawns a swarm of long-lived node processes that land on them — a dead terminal's claim looks alive forever. The `nonce` field existed but was **never checked** for claims (it's only used for broker IPC auth), so SPEC §9's "PID-reuse guard: same" was not true of claims. | Claims now carry a **heartbeat**; `isClaimLive()` = `isAlive(pid) && age < 60 s`. Stale claims are deleted on every tick. Your 3 phantom rows are gone. |
| 9 | **Broker re-sent `initialTask` on every restart** | The spec is durable and never cleared, so each reconnect/crash-recovery re-prompted the session with its original task. Directly violates the conservative-interrupt invariant (SPEC §11.5 asks about exactly this and the answer was "no, it does auto-replay"). | Only sent when `journal.lastSeq === 0 && state.lastEventSeq === 0`. |
| 10 | **Duplicate prompt delivery** | `onRpc` did `await rpc.send(cmd)` and, on **any** rejection, re-`write(cmd)`. `send()` also rejects on its own 30 s timeout — so a slow-but-successful prompt was delivered **twice**. Nothing consumes the response. | Single fire-and-forget `write()`. |
| 11 | **A failed connect left a zombie client** | After 60 failed attempts `connect()` still assigned `ms.client` and called `acquireLease()` on a socket-less client. The row sat at "idle / ready" forever and `sendReply` silently no-op'd. | Attempts cut to 12 × 250 ms; failure sets `unreachable` → row renders **needs_attention**, and `tick()` self-heals every 5 s. |
| 12 | **`IpcClient` could never reconnect** | `closed` latched `true` on first close and was never reset, so every later `send()` was swallowed. No reconnect path existed. | `connect()` resets state; `lastSeq` now tracked from events so a reconnect replays only the delta. |
| 13 | **Reply UI lied** | `justSent = true` was set unconditionally — "sent ✓" flashed for attached rows and dead brokers alike. | `sendReply` returns a boolean; the view shows a red reason on failure. |
| 14 | **Removed sessions leaked their state dir** | `remove()` cleared registry + spec but left the directory (29 had accumulated). | `remove()` deletes the dir; `reconcile()` GCs orphan dirs (incl. `rec-*` / `smoke-*` test junk). |
| 15 | **No reaper for orphaned brokers** | Nothing ever ended a broker whose row was gone. | Broker self-reaps when its durable spec disappears (30 s poll). |

### S1 — Regression introduced by this review, then fixed (2026-07-31)

| # | Bug | Detail | Fix |
|---|---|---|---|
| 24 | **`gcOrphanDirs()` deleted live session directories** | Symptom: `ENOENT … sessions\<id>\session.jsonl` as soon as you interacted with a newly created session. pi creates the parent directory for `--session` **immediately** but writes the JSONL **lazily**, so a brand-new live session presents as an empty, spec-less directory — indistinguishable from an orphan under the "no `broker-spec.json`" predicate I shipped in #14. The sweep then `rm -rf`'d it out from under the running worker. **This violated the project's first invariant: an index must never be able to destroy conversation history.** I scoped cleanup by an index heuristic when the correct predicate is a *content* one. | GC now requires **four** independent guards: no spec, no live lock, **not referenced by any registry row's `jsonlPath`**, and **the directory contains nothing but broker index files** (`BROKER_ARTIFACTS` + `*.tmp-*`). Anything else — above all a `.jsonl` — is untouchable. |
| 25 | **`create()` minted two different ids** (pre-existing) | `index.ts::createSession` generated an id for the JSONL path, then `mgr.create()` generated a *second* one for the spec/registry. A session's data and its broker indexes therefore lived in two different directories (`…/s-ms95j0fp2pou/session.jsonl` vs `…/s-ms95j0fpi64i/broker-spec.json`, visible in the live registry). Harmless on its own, but it is what made every data dir *look* orphaned — the trap #24 fell into. | `create()` owns the id and derives the JSONL path from it (`jsonlPath` is now optional). Data and indexes share one directory. |
| 26 | **`remove()` would then have deleted the conversation** | Consequence of unifying the dirs: #14's `rm -rf sessionDir(id)` would have destroyed the JSONL, contradicting remove()'s documented contract ("PRESERVES the Pi JSONL"). | `remove()` purges only broker index files, then removes the directory *only if that left it empty*. |

Regression tests added (`smoke-extension.ts`, +5): GC preserves a dir containing a session JSONL ·
GC still sweeps a broker-index-only orphan · `jsonlPath` lives inside its own session dir ·
`remove()` preserves the JSONL · `remove()` drops the spec.

Verified end-to-end afterwards: a session created through the real `n` path ran a live turn to
`completed` (model replied `PONG`) with `reconcile()` — and therefore GC — running **every second**
throughout; the 1,125-byte JSONL survived, and survived `remove()`.

### S2 — Rows renamed themselves on every session switch (found 2026-07-31)

| # | Bug | Detail | Fix |
|---|---|---|---|
| 27 | **Two title lanes that never reconciled** | Every session has *two* titles: the **live claim** (re-derived by the owning terminal each heartbeat) and the **durable registry row** (set at create, or by a rename). `rows()` shows the claim while attached and the registry row once backgrounded — so the displayed name flipped on every switch. Caught in live state: a session the user created as **"session 3"** had `registry.title = "session 3"` but `claim.title = "session"`, because at `session_start` there is no Pi session name and no user message yet, so `deriveTitle` returned its placeholder — and a placeholder was allowed to *displace* a title the user had explicitly typed. | Single `resolveTitle()` used by both lanes, with an explicit precedence: **Pi session name → registry title → first-user-prompt → placeholder**. Claims now record `titleSource` (`name` / `prompt` / `fallback`) so "the user named this" is distinguishable from "we guessed". |
| 28 | **Registry titles were write-once** | A session auto-backgrounded before its first turn was frozen as `"session"` forever, even after the conversation had content — the JSONL fallback in `registerExisting` never ran because the placeholder was truthy. A rename made in the attached terminal also never propagated, so it reverted on the next switch. | `refreshTitles()` runs on reconcile and **only ever upgrades**: it fills a placeholder from the JSONL, and pushes an explicit Pi session name into the registry. Verified on live data: the stuck `"session"` row resolved to its real first prompt, `"hi"`. |

The user's own hypothesis — "do we somehow share state between sessions?" — was right that state is shared, but that isn't the fault. `registry.json` and `claims/` are **deliberately** machine-wide so any terminal can see the whole fleet. The bug was two writers of the same logical field with no agreed precedence.

Regression tests added (+7): registry title beats a placeholder claim · explicit name beats registry ·
registry beats a prompt-derived title · prompt fills a placeholder registry · both-placeholder ·
never-empty · **attached and background resolve to the SAME string** (the invariant that makes the
name stable across a switch).

### S1 — Cross-platform (POSIX was broken; Windows-only testing hid it)

| # | Bug | Detail | Fix |
|---|---|---|---|
| 16 | **Brokers could not start on Linux/macOS** | `socketAddress()` returns `<stateDir>/sockets/<id>.sock`, but **nothing ever created `sockets/`** → `listen()` fails `ENOENT`. A stale `.sock` from a crashed broker would also fail `EADDRINUSE`. Windows named pipes need neither, so this was invisible here. | `mkdir -p` + unlink stale socket before `listen`. Also fixed `start()` leaking an `error` listener on success. |
| 17 | **`defaultBrokerPath()` produced a relative path on POSIX** | `new URL(...).pathname.replace(/^\//, "")` strips the leading slash → resolves against cwd. It also leaves percent-encoding, so any path with a space or non-ASCII char breaks on **all** platforms. | `fileURLToPath()`. |

### S3 — Correctness nits

| # | Bug | Fix |
|---|---|---|
| 18 | `auth_ok.lastSeq` sent the **count** of replayed events, not the high-water seq. A client resuming from it would skip or re-read history. | `SnapshotProvider.lastSeq()`. |
| 19 | Pending RPC requests never rejected on worker exit — they hung to the 30 s timeout. | Rejected in the `exit` handler. |
| 20 | `RegistryEntry.specPath` was written as `""` by `create()` / `registerExisting()`. | Populated. |
| 21 | Attached rows showed `elapsedMs = now - updatedAt` — a heartbeat age rendered as if it were a run duration, counting up forever. | `undefined` (attached rows have no run clock). |
| 22 | `spawn()` slept a fixed 400 ms then guessed. | Polls for the lockfile (≤2 s), so it's both faster and more reliable. |
| 23 | Re-entrant `reconcile()` could run concurrently with itself. | Guarded. |

### Concurrency (SPEC open question §11.4 — answered)

**Yes, updates could be lost.** `foreground-claims.json` was a single shared map that every pi
instance on the machine read-modify-wrote. Two hosts read `{A}`, each adds its own key, the second
write erases the first. Atomic rename does not help — the race is in the read-modify-write, not the
write.

**Fixed for claims** by switching to **one file per owning process** (`claims/<pid>-<nonce>.json`):
a host only ever writes its own file, so hosts cannot clobber each other. The legacy file is deleted
on first read (its contents are stale by construction).

`registry.json` **still has this race** — see R1 below. Much lower frequency (create/register/
remove/rename only), so I left it rather than expand the blast radius of this pass.

---

## 3. Answers to SPEC §11 (the cross-check questions)

1. **Is single-writer airtight?** It was not. Three holes: the RPC-worker self-management (#1, which
   produced an observed live double-writer), the `brokerPid`-undefined no-op kill (#2), and
   resume-without-confirmation (#3). All three fixed; resume now **refuses to switch** unless the
   release is confirmed. `returnToPool` also now checks `isAttachedElsewhere` before re-owning.
2. **Why do dead-terminal claims persist?** Neither of your two hypotheses alone. It's that **PID
   liveness isn't ownership** — and this project's own broker/worker swarm is unusually good at
   occupying recycled PIDs. The documented nonce guard was never applied to claims. Fixed with a
   heartbeat + TTL (#8).
3. **Resume handoff race on Windows.** Real, and worse than described: on the reconnect path nothing
   was killed at all. Note that pi opens the target `SessionManager` **before** `session_shutdown`,
   so the release must finish before `switchSession()` — confirmed from pi's source, and now
   enforced by a verified wait (#3).
4. **Shared-state concurrency.** Lost updates were possible. Fixed for claims; registry still open (R1).
5. **`interrupted` on restart / no auto-replay.** `interrupted` *was* preserved correctly (only
   `working` is downgraded to `idle`) — **but the invariant was violated anyway** by `initialTask`
   being re-sent on every start (#9).
6. **`deriveTitle` robustness.** `getBranch()` was already in a try/catch; `pi.getSessionName()` was
   **not**, and it can throw on a disposed session. Both wrapped now. The real defect was staleness,
   not throwing (#6).
7. **Extension-reload staleness.** The `backgroundCurrentIfUntracked` → `registerExisting`
   (durable-write-before-switch) pattern does hold — I traced it. The stale reference that does
   exist is `lastResumedId`, which is silently always `undefined` (§1 above).
8. **Naming correctness.** No — the cwd-basename fallback survived at `controller.ts:78`, and titles
   were never refreshed after `session_start` (#5, #6, #7).

---

## 4. Remaining gaps (not fixed — deliberate)

- **G1 — "JSONL is source of truth" is aspirational.** Nothing reconstructs conversation state from
  the JSONL. A broker restarted after a crash shows `idle / ready` with no `finalResponse`, even
  though the last assistant message is sitting in the file. `titleFromJsonl()` is the first code
  that reads it. If you want the stated invariant to be real, the broker should seed `BrokerState`
  from the JSONL tail on start.
- **R1 — `registry.json` multi-writer lost update.** Same class as the claims bug, lower frequency.
  Fix is either per-session registry files or a lockfile.
- **Editor clobbering.** `setEditorComponent` overwrites any editor another extension installed
  (e.g. a vim-mode extension). pi's compose pattern needs the *other* editor to accept a delegate,
  which a foreign subclass generally won't. Documented in-code as a known limitation.
- **Inline dialog answering.** The whole path exists (`pendingDialog` → IPC `answer` →
  `extension_ui_response`) and is unused by the view. This is close to free and is the highest-value
  remaining feature: an `awaiting_input` row you can't answer from the dashboard is a dead end.
- **Reboot survival** — still a non-goal, still the right call.
- **`ForegroundClaim.sessionId`** is now redundant with `jsonlPath` (both hold the path). Harmless;
  worth collapsing in a future pass.

---

## 5. What I verified vs. what I did not

**Verified**
- `npx tsc --noEmit` clean.
- All 50 smoke tests pass (12 + 13 + 25), including the live-model broker e2e.
- The master bug, by command-line comparison of a live claim against its owning process.
- Worker startup: 28,522 ms → 1,546 ms, measured before and after.
- Legacy claims file removed; the 3 phantom rows are gone.

**POSIX — verified 2026-07-31 on WSL2 / Ubuntu, Node 22, against a fresh clone of the published repo.**
Fixes #16/#17 confirmed, and the exercise found **two more real bugs** that Windows had been masking:

| # | Bug | Detail | Fix |
|---|---|---|---|
| 29 | **`killTree` silently no-opped on non-detached children** | Signalling a negative pid targets the process GROUP, which only works if the target is a group leader (`detached: true`). Brokers are — **the pi RPC worker is not**, because its stdio stays wired to the broker. So on Linux/macOS `killTree` reached brokers but did nothing to a stuck worker, meaning **fix #4 (the orphan-worker leak) would still have leaked on POSIX**. `taskkill /T` hid it on Windows entirely. | Signal the group *and* the pid, tolerating either failing; poll for exit instead of always burning the grace period. |
| 30 | **`smoke.ts` bypassed the socket-dir setup** | It drove `net.listen()` directly rather than through `IpcServer`, so the POSIX suite died before its first assertion. | `ensureSocketDir()` moved into `platform/paths.ts` and shared by both. |

Also learned, and now written into the code: **Node reports a missing parent chain for a unix socket
as `EACCES`, not `ENOENT`** — it reads like a permissions problem and sends you the wrong way. On a
clean machine `~/.local/state` may not exist at all, so the mkdir is genuinely load-bearing.

Result on Linux: **`smoke.ts` 12/12** and **`smoke-extension.ts` 25/25** (the latter spawns real
brokers, so brokers demonstrably start and accept IPC over a unix socket). `smoke-broker.ts` is
**21/25** — the 4 failures are all the live-model round-trip in section [3], and that WSL install has
no model configured (`auth.json` is empty; `get_state` reports `provider: "unknown"`). Everything
that does not need a model passes, including the full IPC auth/snapshot/lease block.

**Still not verified**
- **Interactive TUI behaviour** — I can't drive the pi TUI from here. The view/editor changes are
  reasoned and typechecked, not exercised. Please eyeball: `/agents` rows and titles, `Space` peek
  reply (success + failure paths), `r` rename, `Enter` resume.
- **The live-model path on POSIX** — blocked only on credentials in WSL, not on code.
- **macOS** — untested; it shares the POSIX seams now exercised on Linux, but `taskkill` vs signals
  and `~/Library/Application Support` are the obvious places to look first.
- **The resume race under load** — the confirmed-release path is correct by construction, but I did
  not stress it.

---

## 6. Housekeeping

- **12 orphaned processes are still running** (6 brokers + 6 workers, since Jul 28). They predate
  these fixes, so nothing here reaps them retroactively. Ending them is your call — see the note in
  the handoff message.
- **This project is not a git repo.** For a change of this size that's the single biggest risk to
  you. `git init` + a baseline commit is worth doing before anything else.
