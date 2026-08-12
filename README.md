# pi-agentview

A **fleet dashboard** for the [pi coding agent](https://github.com/earendil-works/pi) — run many background coding sessions and manage them from one screen, in the spirit of Claude Code's agent view. Cross-platform (Windows / Linux / macOS).

Press **Left Arrow** on an empty prompt to open Agent View.

```
Agent View   working=2  completed=1  attached=1
──────────────────────────────────────────────────────────────
 Working (2)
 ▸ ● refactor the parser — tool: edit src/tokenizer.ts   2m14s
   ● add retry to the uploader — running                   47s
 Completed (1)
   ✓ fix the flaky test — all 42 tests pass              5m02s
 Attached (1)
   ▶ session 3 — C:\Users\me\project
──────────────────────────────────────────────────────────────
 ↑↓ select · Space peek/reply · Enter resume · n new · d remove · a abort · r rename · Esc close
```

## Install

```bash
pi install git:github.com/chang47/pi-agentview
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/chang47/pi-agentview
```

Then start `pi` and press **Left Arrow** on an empty prompt (or run `/agents`).

> **Security note:** pi packages run with full system access, and this one spawns detached background processes that keep running after your terminal closes. Read the source before installing — it's ~2.5k lines.

## What it does

- **Background sessions keep running** with no terminal attached — they survive closing your terminal (not a reboot; Claude Code doesn't either).
- **One dashboard** for every session: live status, what the model last said, elapsed time.
- **Peek and reply** without leaving the dashboard — press `Space`, type, `Enter`.
- **Resume** any session into your terminal with the *full* native pi UX — every slash command, the real editor, `/model`, proper tool rendering.
- **Rename** rows (`r`), **remove** them (`d` — your conversation JSONL is always preserved).
- **Abort a runaway run** (`a`) without attaching — stops a `working` session from the dashboard; refused on rows that aren't running.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | select a row |
| `Space` | peek — then type and press `Enter` to send a follow-up |
| `Enter` | resume that session in this terminal |
| `n` | create a new background session |
| `d` | remove from the view (the pi session JSONL is kept) |
| `a` | abort the run on a `working` row (no need to attach); refused otherwise |
| `r` | rename |
| `/` | filter the list (free text, or `s:working` / `s:blocked`); `Esc` clears |
| `Esc` / `q` | close (`Esc` clears an active filter first) |

## How it works

pi has no session daemon, and a pi session is a **single-writer JSONL file** with no API to attach a second terminal to it. Everything here follows from that.

```
┌──────────────────────────────────────────────────────────────┐
│  Extension (src/index.ts)                                     │
│   • Left-Arrow editor -> /agents        (extension/editor)    │
│   • fleet view                          (extension/view)      │
│   • attached-terminal ownership claims                        │
│   • resume handoff: release the JSONL, then switchSession     │
│   • BrokerManager lifecycle             (extension/controller)│
└──────────────────────────────────────────────────────────────┘
        │ spawns detached                    │ reads/writes
        ▼                                    ▼
┌────────────────────────────┐        ┌───────────────────────┐
│  Broker (dist/broker.mjs)   │ state  │  Registry + claims    │
│   • owns a pi --mode rpc    │◄───────│  (src/registry.ts)    │
│     worker                  │        │  JSONL = source of    │
│   • IPC server (pipe/socket)│        │  truth                │
│   • event journal + replay  │        └───────────────────────┘
│   • single mutation lease   │
└────────────────────────────┘
```

**One broker per session, not one daemon for all of them.** A crash takes down one session, not the fleet.

**Resuming transfers file ownership.** The full interactive UX only exists when the foreground pi owns the session file, so `Enter` stops that session's broker, *confirms the process is gone*, and only then hands the file to pi. If the release can't be confirmed, the switch is refused rather than risking two writers on one JSONL.

**The JSONL is always the source of truth.** The registry, per-session broker state, and ownership claims are rebuildable indexes — a corrupt or stale index can never destroy conversation history.

## State on disk

| Platform | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\pi-agentview\` |
| macOS | `~/Library/Application Support/pi-agentview/` |
| Linux | `$XDG_STATE_HOME/pi-agentview` (or `~/.local/state/pi-agentview`) |

Shared across every pi instance on the machine — that's how any terminal can see the whole fleet.

## Cross-platform seams (`src/platform/`)

| Concern | POSIX | Windows |
|---|---|---|
| IPC | unix socket (`<stateDir>/sockets/<id>.sock`) | named pipe (`\\.\pipe\pi-agentview-<id>`) |
| Spawn broker | `detached: true` (new process group) | + `windowsHide: true` |
| Spawn pi worker | `node <pi-cli.js>` (no shell) | same |
| Tree-kill | `process.kill(-pgid)` SIGTERM→SIGKILL | `taskkill /T /F` |
| Atomic replace | `rename` | `rename` + retry on `EPERM`/`EBUSY` |

## Development

```bash
git clone https://github.com/chang47/pi-agentview
cd pi-agentview
npm install
npm run typecheck
npm run build:broker    # bundle the broker -> dist/broker.mjs
npm test                # whole suite, fully OFFLINE — no model, no key, no network
```

**`npm test` is fully offline and deterministic.** It runs the three code suites — platform +
registry (12), render + BrokerManager + safety regressions (25), broker/RPC/IPC (25) — plus the
visual suites (10 golden **stills** + a driven-flow animated SVG). The broker suite drives a
scripted **fake pi** (`test/fakes/fake-pi.mjs`) instead of a real agent, so there is no model
call, credential, or network dependency anywhere. See [`CLAUDE.md`](./CLAUDE.md) for how the fake
works and how to add/regenerate visual goldens (`npm run test:visual:update`).

The visual evidence is terminal-style SVG you can open in a browser — `test/visual/__golden__/`.
For a UI change, **look at the picture**, not just the assertion.

To iterate against your live working copy instead of an installed copy:

```bash
pi -e ./src/index.ts
```

> **After changing any broker-bundled code** (`src/broker.ts` or anything it imports —
> `platform/*`, `broker/*`, `registry.ts`, `types.ts`), rerun `npm run build:broker`: the broker
> runs as a subprocess from the committed `dist/broker.mjs`, not from source.

`dist/broker.mjs` is committed on purpose: `pi install git:` clones the repo and runs `npm install`, but not our build script, so the bundled broker has to already be in the tree.

## Known limitations

- **No reboot survival.** Brokers are detached processes, not OS services. A pluggable supervisor (systemd-user / Task Scheduler / launchd) is the intended seam; it isn't built.
- **Dialogs can't be answered from the dashboard.** A row can show `awaiting_input`, but replying sends a follow-up rather than picking a `select`/`confirm` option.
- **Broker state isn't rebuilt from the JSONL.** After a broker restart a row shows `idle` with no last reply, even though the JSONL has it.
- **It replaces the input editor**, so it will clobber another extension that installs its own (e.g. a vim-mode editor).
- **macOS is untested.** Windows and Linux (WSL2 / Ubuntu, Node 22) are both validated — `smoke.ts`
  12/12 and `smoke-extension.ts` 25/25 on Linux, including real brokers over unix sockets. macOS
  shares those POSIX seams but nobody has run it.

Design rationale, the full bug/decision log, and answers to the cross-check questions live in [`SPEC.md`](./SPEC.md) and [`REVIEW.md`](./REVIEW.md).

## License

MIT
