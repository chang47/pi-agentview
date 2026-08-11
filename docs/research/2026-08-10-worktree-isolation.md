# Research: Per-session git worktree isolation — ecosystem survey + pi-agentview integration

> **Type:** research (read-only). **Produced for:** issue #17. **Feeds design:** #13. **Date:** 2026-08-10.
> Sources are inline; unverifiable claims are flagged `[UNVERIFIED]`. Grounded against this repo's `src/`.
> **Bottom line:** recommend **Option A** — worktree-per-session under the state dir, eager create in `create()`,
> opt-in first, preserve-on-work teardown. The broker/worker process split already gives Windows-safe removal.
> Read "Recommendation" + "Open questions" before starting the #13 design.

Tools surveyed: Claude Code, Claude Squad, ccmanager, uzi, container-use.

---

## pi-agentview code facts this recommendation is built on

- **`BrokerManager.create(opts)`** (`src/extension/controller.ts:326`) — `CreateOptions = { title?, cwd, jsonlPath?, model?, thinkingLevel?, initialTask? }`. Writes a durable `BrokerSpec { id, jsonlPath, cwd, … }` to `sessions/<id>/broker-spec.json`, then `spawn()` → `spawnBroker()`.
- **`jsonlPath` defaults to `sessions/<id>/session.jsonl`** in the state dir (`controller.ts:332`), *independent of `cwd`*. The conversation source-of-truth is already decoupled from the working directory the agent edits in — so enabling worktrees touches **only `spec.cwd`**, nothing about the JSONL.
- **Only the *worker* runs in the session cwd, not the broker.** `spawn()` calls `spawnBroker({ brokerPath, args })` with **no `cwd`** (`controller.ts:211`) — the detached broker inherits the extension's cwd. The broker then `RpcClient.start()`s `node <pi-cli> --mode rpc` with **`cwd: spec.cwd`** (`src/broker/rpc-client.ts:50-51`). The worktree checkout would be the cwd of exactly one process: the grandchild worker.
- **`remove(id)`** (`controller.ts:454`) shuts the client down, `killTree(brokerPid)` (kills broker + worker), waits for exit, removes the registry row + spec, then `purgeBrokerArtifacts(sessionDir(id))` — **preserves the JSONL**. Governing invariant: *an index must never be able to destroy conversation history* (`controller.ts:480-495`).
- **State dir:** Windows `%LOCALAPPDATA%\pi-agentview`; `sessionsDir()=stateDir/sessions`; `PI_AGENTVIEW_STATE_DIR` override (`src/platform/paths.ts`, `constants.ts`).
- **No JSON settings file exists** — all config is env-var driven (`PI_AGENTVIEW_*`). Spawns use raw `child_process.spawn(process.execPath, …)` (no `shell:true`), not `cross-spawn`.
- **Session ids are short:** `s-<base36 time><4 rand>` (~10 chars) — helps Windows path length.

Two derivations that shape everything below:
1. **pi-agentview cannot do CC-style "lazy, isolate-before-first-edit."** CC gates its own `Edit`/`Write` tool (a `CLAUDE_JOB_DIR` guard). pi-agentview spawns an **opaque `pi --mode rpc` worker** it does not gate — no pre-edit hook. Realistic choices: *eager at create* or *eager at worker spawn*.
2. **The process split gives Windows-safe removal for free.** The broker's cwd is *outside* the worktree; only the worker's cwd is inside. `remove()` already kills the tree and **awaits exit** before cleanup — exactly the ordering Windows requires (you cannot delete a directory that is a live process's cwd).

---

## 1. CREATE FLOW

| Tool | When | Branch name | Where it lives | cwd wiring | Base ref |
|---|---|---|---|---|---|
| **Claude Code** | **Lazy** — starts in main checkout, worktree created **before first edit** (`--worktree` = eager exception) | `worktree-<name>` (`pr-<n>` for PRs); auto-slug if unnamed | **`.claude/worktrees/<name>/` at repo root** | re-roots session cwd via `EnterWorktree` tool | **`worktree.baseRef`**: `"fresh"` (default = `origin/<default>`) or `"head"` |
| **Claude Squad** | **Lazy** — first `Instance.Start()` | `<prefix><session>`, prefix default `<user>/` | **`~/.claude-squad/worktrees/<branch>_<hexnanotime>`** | tmux `-c <path>` | **current HEAD commit** (not configurable; `// TODO` in code) |
| **ccmanager** | **Eager** — `git worktree add` at create, separate from spawn | AI-generated; fallback `<YYYYMMDD>-<hex>` | `autoDirectoryPattern`, **default `'../{branch}'`** (sibling) | session `{ cwd: path }` | **user-selectable base** in UI |
| **uzi** | **Eager** — at `uzi prompt` | `{agent}-{proj}-{githash}-{id}` | **`~/.local/share/uzi/worktrees/<name>`** | tmux `new-session -c <path>` | **current HEAD** (not configurable) |
| **container-use** | **Lazy** — agent creates env via MCP | env `adverb-animal`; branch `cu-<id>` | **`~/.config/container-use/worktrees/<project>/<id>`**, off a **bare fork repo** | copied into Dagger container `/workdir` | **HEAD** by default |

**Key derivations:**
- **Only CC branches from the remote default by default.** Everyone else branches from **current HEAD** ("start where I am"). CC's `"fresh"` is the outlier and even shipped a bug leaking unpushed commits because `git worktree add -b <branch> <path>` ran with **no explicit base ref** → git defaulted to HEAD (anthropics/claude-code#60588).
- **Claude Squad and CC branch from the HEAD *commit object*, not the working tree** — a dirty base doesn't leak uncommitted changes into the new worktree.
- **Location splits three ways:** inside the repo (CC), a home-dir central store (CS, uzi, container-use), or a sibling (ccmanager). The central-store pattern is the closest analog to pi-agentview's state dir.

## 2. CLEANUP

| Tool | Trigger | Clean vs dirty | Leak/crash recovery | Merge-back |
|---|---|---|---|---|
| **Claude Code** | interactive exit; bg = age sweep (`cleanupPeriodDays`, default 30) | **Clean → auto-removed; has work → kept.** "Work" = changed/untracked files **OR unpushed commits** | **`git worktree lock`** while running; sweep releases the lock for an exited session (v2.1.210+). **No documented `prune`** `[UNVERIFIED]` | none (isolation only) |
| **Claude Squad** | explicit `D` (Kill) | **Force-removes, no dirty check** on kill (`remove -f` + `branch -D`); dirty check only on **Pause** (auto-commits, keeps branch) | **Yes — `git worktree prune`** in several sites; defensive pre-clean before add | none (push via `gh`) |
| **ccmanager** | Delete menu | **`remove --force` unconditionally; no dirty warning.** `hasUncommittedChanges` helper **exists but isn't wired** — a safety gap | **No prune found** `[UNVERIFIED]` | merge + rebase (`--no-ff`) |
| **uzi** | `uzi kill` | **`remove --force` + `branch -D`** → **discards uncommitted work** | **No prune found** `[UNVERIFIED]` | `checkpoint` = add+commit+rebase |
| **container-use** | `delete <id>` | auto-commits continuously → nothing uncommitted to lose; "disposable by design" | **`RemoveAll` + `worktree prune` + `remote prune`** on delete | merge (`--no-ff`), apply (`--squash`), checkout |

**Key derivations:**
- **CC's preserve-on-work model is the only safe one; the three force-removers (uzi, ccmanager, CS-kill) silently destroy work.** ccmanager literally ships the dirty-check helper and never calls it.
- **A `status --porcelain`-only "clean" check is insufficient** — it misses *committed-but-unmerged* work. Check **uncommitted OR ahead-of-base**, or a "clean" worktree with valuable commits gets `branch -D`'d away.
- **`git worktree prune` is the standard leaked-stub reaper.** Any path that `rm`s a worktree dir out from under git leaves a `.git/worktrees/<name>` admin stub that only `prune` reaps.

## 3. NON-GIT / EDGE CASES

- **Not a git repo:** CC → **falls back to the plain dir** (no isolation), does not refuse or `git init`. Claude Squad → **hard error**. ccmanager → null root, relies on git errors. uzi/container-use → assume git `[UNVERIFIED]`.
- **Empty repo (no commits):** CS gives a friendly "create an initial commit first." Generic `git worktree add` **fails on Git < ~2.42**; ≥2.42 auto-associates an unborn branch (exact version `[UNVERIFIED]`).
- **Dirty base:** not a blocker for HEAD-commit-object tools (CS, CC `"head"`). CC `"fresh"` ignores the working tree entirely.
- **Bare repo / submodules:** thin. container-use hit a real submodule bug (dagger/container-use#161, resolution `[UNVERIFIED]`) and hosts worktrees off a **bare fork** to avoid "branch already checked out." CC refuses dirs whose git metadata resolves into the main checkout, and refuses symlinked/network paths. CS/ccmanager bare+submodule handling `[UNVERIFIED]`.

## 4. WINDOWS / CROSS-PLATFORM GOTCHAS (highest-value section for a Windows-first team)

- **cwd-inside-the-worktree removal (the load-bearing ordering rule):** on **Windows you cannot delete a directory that is any process's cwd** — a live child with cwd inside the worktree guarantees `EBUSY`. On POSIX it usually succeeds. → **Kill the worker and *await exit* before `git worktree remove`.** pi-agentview's `remove()` already does `killTree` + wait, and the broker's cwd is *outside* the worktree — satisfied by construction, but **never `chdir` the broker into the worktree.** (learn.microsoft.com Directory.Delete; dotnet/runtime#32737.)
- **File-lock `EBUSY` on removal:** Search Indexer, Defender/AV, editors, node watchers hold handles. CC's own worktree cleanup hits this — `git worktree remove`, `Remove-Item`, `rd /s /q`, .NET `Directory.Delete` **all** fail "used by another process," leaving an empty dir (anthropics/claude-code#57767, #41740). → **retry-delete with backoff** (`fs.rm({recursive,force,maxRetries:10,retryDelay:100})` — note `maxRetries` **defaults to 0, must set it**; or `rimraf`), and **defer-and-reap next launch** if still locked.
- **`git worktree remove` force levels:** default = clean only; `--force` once for dirty/untracked/submodules; `--force --force` for a *locked* worktree; the main worktree can never be removed.
- **MAX_PATH / 260-char limit:** `git config core.longpaths true` fixes **git's own** ops (prepends `\\?\`), **but Node `fs`/PowerShell still hit MAX_PATH** unless OS `LongPathsEnabled=1` is also set → deletes can still throw `ENAMETOOLONG`. → keep worktree roots **shallow** and ids/branch names **short**.
- **Line-ending churn breaks the clean/dirty gate:** on Windows a worktree can be **falsely reported dirty** when the git call's effective `core.autocrlf` differs from the repo's. → **Do NOT inject `-c core.autocrlf=…`** into the status call; prefer a committed `.gitattributes`. **Do a normal checkout, not `--no-checkout`** (`--no-checkout` leaves zeroed stat-cache → unreliable status).
- **Concurrent `git worktree add` races on `.git/*.lock`** — documented in exactly this one-worktree-per-agent pattern (anthropics/claude-code#47266, #34645, #55724). → **serialize add/remove/prune behind an in-process async mutex** + retry on lock errors; `git worktree add --lock` closes the add→lock crash window.
- **Node spawn on Windows:** argv array + `cwd`, no `shell:true` (pi-agentview already does this).

## 5. pi INTEGRATION RECOMMENDATION (concrete shape)

**Worktree location → `stateDir/worktrees/<id>/`** (new top-level sibling of `sessions/`, NOT nested under `sessions/<id>/`): matches the central-store pattern, fits the state-dir + `PI_AGENTVIEW_STATE_DIR` model, keeps the user's repo clean (no `.gitignore` needed unlike CC), and is **shallower** (Windows MAX_PATH). The git admin stub still lands in the repo's `.git/worktrees/<id>` — fine, that's what `prune` reaps.

**JSONL stays in `sessions/<id>/` while `cwd` = the worktree.** Already how the code works; it's the safety property that makes this low-risk — **the source of truth survives worktree deletion.** Do NOT move the JSONL into the worktree.

**`create()` / spawn wiring (eager, in the extension where errors are visible):**
```
create(opts):  // brand-new bg sessions only; NOT registerExisting
  isolate = resolveIsolationFlag(opts)          // per-session flag ?? env default (§6)
  worktreeCwd = opts.cwd
  if isolate:
    root = git(-C opts.cwd, rev-parse --show-toplevel)   // not a repo -> skip + note
    if root and repoHasCommits(root):                    // else fall back + note
      branch = "piav/" + id
      wt     = join(stateDir(), "worktrees", id)
      base   = (baseRef=="fresh") ? "origin/<default>" : git(-C root, rev-parse HEAD)
      await withGitMutex(() => git(-C root, worktree add --lock -b branch wt base))  // normal checkout
      worktreeCwd = wt
      spec.worktree = { repoRoot: root, branch, path: wt, baseRef }   // NEW spec field
  spec.cwd = worktreeCwd     // <-- the ONLY behavioral change to the spec
  … write spec, spawnBroker (unchanged: broker cwd stays outside the worktree) …
```
The **broker needs no change** — it already spawns the worker with `cwd = spec.cwd`. Apply isolation in **`create()` only**, never `registerExisting()` (that adopts a foreground session already in a real cwd).

**`remove()` teardown (preserve-on-work, Windows-hardened):**
```
remove(id):
  … existing: shutdown client, killTree(brokerPid), WAIT for exit …   // handles released
  if spec.worktree:
    git(-C repoRoot, worktree unlock path)                 // ignore errors
    dirty    = git(-C path, status --porcelain) != ""      // do NOT pass -c core.autocrlf
    unmerged = git(-C repoRoot, rev-list --count base..branch) > 0
    if dirty or unmerged:  # PRESERVE: keep worktree + branch, surface path+branch to user
    else:
      await withGitMutex(() => git(-C repoRoot, worktree remove path))
      git(-C repoRoot, branch -D branch)
    await withGitMutex(() => git(-C repoRoot, worktree prune))
    if dirExists(path): retryDelete(path)                  // else defer to next launch
  … existing: purge broker artifacts, PRESERVE JSONL …
```
**On `remove()`, mirror the JSONL policy:** clean **and** fully-merged → remove worktree + delete branch; dirty **or** ahead-of-base → **preserve both** and tell the user where. This generalizes the existing "teardown must never destroy history" invariant from the JSONL to the agent's code output. Extend `reconcileRegistry`/`gcOrphanDirs` to reap **leaked** `worktrees/<id>` dirs behind the same guard.

## 6. OPT-OUT / CONFIG

- **How tools opt out:** CC `worktree.bgIsolation: "none"` (v2.1.143; only documented value; default = isolate; on-token `"worktree"` `[UNVERIFIED]`). CS/uzi have no opt-out. ccmanager: select the main worktree. container-use: can't disable.
- **Recommended pi-agentview (env + option, no settings file):**
  - Global default `PI_AGENTVIEW_WORKTREE` = `off` (phase 1 = **opt-in**) | `on`; optional `PI_AGENTVIEW_WORKTREE_BASE` = `head` (default) | `fresh`; `PI_AGENTVIEW_WORKTREE_DIR` to relocate.
  - Per-session override: add `isolate?: boolean` (+ `baseRef?`) to `CreateOptions` so the create UI offers a per-session toggle.
  - Fallback (non-git / no commits): run in the plain cwd, **never refuse, never `git init`**, surface a one-line "isolation skipped — not a git repo" note.

---

## Options for pi-agentview

**Option A — worktree-per-session under the state dir, EAGER create in `create()`, opt-in.** `stateDir/worktrees/<id>/`, branch `piav/<id>`, base = HEAD (config `head`/`fresh`); `spec.cwd` = worktree; dirty-or-unmerged-gated teardown + prune + retry-delete; env + per-session flag.
- *Windows:* **best** — broker cwd outside; existing `killTree`+wait gives removal ordering for free; shallow path; needs `core.longpaths` + retry-delete. *Cleanup:* medium. *Non-git:* clean fallback. *Matches CC:* same preserve-on-work + opt-out semantics, but eager (not lazy), state-dir location, HEAD base.

**Option B — same, but worktree under/next to the repo** (`<repo>/.pi-agentview-worktrees/<id>`).
- *Windows:* **worse** MAX_PATH + pollutes the repo (needs `.gitignore`). *Matches CC:* closest on location, still eager.

**Option C — opt-in "lazy" via the broker** (create the worktree in the broker just before worker spawn).
- *Cleanup:* **higher** — lifecycle split across broker (create) + extension (remove); errors surface in the *detached* broker where the user can't see them; **requires rebuilding `dist/broker.mjs`**. *Matches CC:* closest in spirit, but not truly first-edit-lazy (pi can't gate the worker's edits).

## RECOMMENDATION → Option A

Fits pi-agentview's architecture (state dir, short ids, one-place-per-session, env config), keeps the repo clean, and — critically — the broker/worker process split **already satisfies the Windows-safe removal ordering** that trips up every other tool. Eager-at-create surfaces "not a git repo"/"no commits" in the foreground TUI where the user just picked the repo, and true first-edit-lazy is infeasible for pi anyway. Ship **opt-in** first, prove the Windows cleanup path against the fake-pi harness (`test/visual/harness.ts`, `interactions.ts`), then graduate to on-by-default.

## RULED OUT (with reasons)

- **Container isolation (container-use style)** — hard Docker dependency destroys the offline/deterministic test story + cross-platform simplicity.
- **Force-remove without a dirty/unmerged guard (uzi/ccmanager/CS-kill)** — silently destroys uncommitted **and** committed-but-unmerged work; violates pi-agentview's "never destroy output" invariant.
- **True lazy first-edit isolation (CC's model)** — needs a write-tool hook; pi spawns an opaque worker. Revisit only if pi exposes a pre-edit hook.
- **`--no-checkout` worktrees** — the agent needs the files, and it makes the Windows clean/dirty check unreliable.
- **tmux-based session model** — N/A; pi-agentview has its own broker/IPC model.

## OPEN QUESTIONS for the #13 design pass

1. **Base-ref default:** current HEAD ("start where I am") vs `origin/<default>` "fresh." Recommend **HEAD + config**; confirm which surprises the team less.
2. **Branch-preservation:** never auto-delete branches, or only when empty+clean? Ever **auto-commit dirty work before detaching** (CS Pause style) so a crash can't lose it?
3. **Merge-back UX:** any "bring this branch to main" affordance, or just surface branch name + path?
4. **Location final call:** `stateDir/worktrees/<id>` (recommended, shallow) vs `sessions/<id>/worktree` (deeper).
5. **JSONL location:** confirm it **stays** in `sessions/<id>/` (recommended).
6. **Gitignored-file copying** (`.env` etc. so agents can build in a fresh worktree): needed or defer?
7. **Concurrency:** single in-process mutex enough, or does the multi-host case need a cross-process file lock too?
8. **Reconcile/GC:** extend `reconcileRegistry`/`gcOrphanDirs` to prune leaked `worktrees/<id>` behind the dirty/unmerged guard — confirm the guard.
9. **Windows long-path:** set `core.longpaths`, require OS `LongPathsEnabled`, or document only?

## Sources

**Claude Code:** code.claude.com/docs/en/{worktrees, agent-view, settings} · Piebald-AI/claude-code-system-prompts tool-description-enterworktree.md · anthropics/claude-code #57148, #60588, #62372, #59580, #58435, #41740, #57767
**Claude Squad:** smtg-ai/claude-squad (session/instance.go, session/git/worktree.go, worktree_ops.go, worktree_git.go, util.go, config/config.go, tmux/tmux_windows.go, daemon/daemon_windows.go, README)
**ccmanager:** kbwo/ccmanager (services/worktreeService.ts, worktreeNameGenerator.ts, sessionManager.ts, utils/worktreeUtils.ts, worktreeConfig.ts, gitUtils.ts, components/{NewWorktree,DeleteWorktree,MergeWorktree}.tsx) · docs/{worktree-auto-directory, worktree-hooks, git-worktree-config}.md
**uzi:** devflowinc/uzi (README, pkg/state/state.go, pkg/agents/agents.go, cmd/{prompt,checkpoint,kill}) · uzi-whitepaper.pdf
**container-use:** dagger/container-use (repository/git.go, repository/repository.go, environment/README.md, docs/{quickstart,environment-workflow,environment-configuration}.mdx) · issue #161
**Git/Windows/Node:** git-scm.com/docs/git-worktree · anthropics/claude-code #47266, #34645, #55724 · berry.sh/posts/codex-worktrees-git-locking · Science-Discovery/Aether#938 · docs.github.com line-endings · andrewlock.net MAX_PATH · learn.microsoft.com Directory.Delete · dotnet/runtime#32737 · isaacs/rimraf README · npmjs.com/package/cross-spawn

`[UNVERIFIED]` carried inline: CC `prune` usage & MAX_PATH/CRLF specifics; the `"worktree"` on-token; uzi/ccmanager `prune` absence and non-git/bare/submodule handling; both TUIs' end-to-end Windows viability; container-use submodule-bug resolution; empty-repo `git worktree add` introducing version.
