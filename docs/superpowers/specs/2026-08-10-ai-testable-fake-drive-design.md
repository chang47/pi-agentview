# pi-agentview — AI-testable via fake-drive + visual evidence

**Date:** 2026-08-10
**Status:** approved design → implementing foundation
**Author:** Josh + Claude

## Problem

pi-agentview is a TUI fleet dashboard for *real* `pi` coding-agent sessions. Testing it the
obvious way needs real `pi` workers running real models — which cost money, need network + API
keys, and are **non-deterministic** (a model improvises every take). That is exactly why the
nightly `smoke-broker.ts [3]` "Broker subprocess e2e" test fails: on any box without model
credentials/network it is 21/25, and the 4 failures are all the live-model round-trip
(`agent_start` / `agent_settled` / final state `completed` / `finalResponse` captured).

Two more gaps block testability:
- The interactive TUI is **never exercised** — it's typecheck-only (REVIEW.md §5). There is no way
  to render a screen state and assert/inspect it.
- The state dir (`stateDir()`) is **machine-wide** with no isolation override, so concurrent/nightly
  test runs collide and can leak `sessions/<id>` dirs.

## Goal / success criteria

1. `smoke-broker.ts [3]` passes **offline** — no model, no credentials, no network.
2. Every Agent View screen-state has a committed **still** (image) golden.
3. Key interaction flows produce a **driven capture** (watchable video-style evidence), made by
   scripting keystrokes into the *real* TUI backed by a fake pi.
4. **Zero real agents/models/network** in the default test run.
5. Determinism: the same inputs produce byte-identical event streams and stable rendered frames.

## Core idea

**Replace the real agent with a scripted stand-in.** The dashboard finds the `pi` binary through
an env var (`PI_AGENTVIEW_PI_CLI`) — a seam that already exists. Point it at a tiny **fake pi** that
*reads a script* instead of thinking. The dashboard cannot tell the difference; everything else
(broker, IPC, journal, state derivation, the TUI) runs for real. From that one swap, both testing
halves follow:

- **Stills** — call the (extracted) pure screen renderer with a fixture roster → image. No app, no
  agents, instant, identical every run.
- **Driven capture** — run the *real* dashboard with the fake pi as backend, script keystrokes,
  record frames → video-style artifact.

## Architecture

```
        REAL side                                     FAKE side
 ┌──────────────────────────┐                 ┌───────────────────────────┐
 │ interactive pi (TUI host) │   PI_AGENTVIEW_ │ fake-pi (test/fakes)      │
 │  + pi-agentview extension │───_PI_CLI seam─▶│  speaks --mode rpc JSONL: │
 │  → broker (dist/broker.mjs)│                │  session→agent_start→     │
 │  → IPC / journal / state  │◀── RPC JSONL ───│  message_end→agent_settled│
 └──────────────────────────┘                 │  (+ get_state, dialogs)   │
   ▲ node-pty presses keys                     │  No AI, no net, no cost.  │
   │ @xterm/headless decodes frames            └───────────────────────────┘
   ▼
 driven capture → SVG stills + animated-SVG / asciinema .cast
```

### Product-code changes (small, and independently good)

**C1 — Make the pi-CLI seam first-class.** `resolvePiCliPath()` (`src/platform/spawn.ts`) must honor
an existing `PI_AGENTVIEW_PI_CLI` override instead of always resolving the real package. Today
`spawnBroker()` calls `resolvePiCliPath()` and injects the result into the broker's env, so a fake
set in the *extension's* env is overwritten with the real pi before it reaches the worker. One guard
at the top of `resolvePiCliPath()` (`const o = process.env[ENV_CLI]; if (o) return o;`) makes the
fake propagate through the whole chain (extension → broker → worker). Production is unaffected: the
var is unset in normal use; the only process that has it set is the broker child, where it already
points at the real pi.

**C2 — State-dir isolation.** `stateDir()` (`src/platform/paths.ts`) must honor a
`PI_AGENTVIEW_STATE_DIR` override (first check, before the per-OS branch) so each test run gets a
throwaway dir. Prevents cross-run collisions and `sessions/<id>` leaks. Good hygiene regardless.

**C3 — Extract a pure frame renderer.** Pull the body of `AgentViewComponent.render(width)`
(`src/extension/view.ts`) into a free function in a new pure module (e.g.
`src/extension/frame.ts`):

```ts
export interface FrameUi {
  selectedId?: ManagedId; peekOpen: boolean; replyBuf: string;
  justSent: boolean; sendError?: string; renameMode: boolean; renameBuf: string;
}
export type ColorFn = (name: string, s: string) => string;
export function renderFrame(rows: ManagedRow[], width: number, ui: FrameUi, color: ColorFn): string[];
```

`AgentViewComponent.render()` becomes a thin adapter that calls `renderFrame(this.cachedRows, width,
{…instance ui…}, (n,s) => this.color(n,s))`. Behavior is byte-identical (verified by an existing
smoke). `truncateToWidth` (pure util from pi-tui) is imported by the frame module; the module has no
live-TUI/timer dependency, so it is callable from a test with a fixture roster + a fake color fn.

*Everything else lives under `test/` — no other product code is touched.*

### Test-side components (all new, under `test/`)

**T1 — Fake pi CLI** `test/fakes/fake-pi.ts` (run via jiti, same loader as the smokes).
- Parses `--mode rpc --session <path> [--provider/--model/--thinking]` (accepts + ignores extras).
- Reads stdin line-by-line (LF-framed JSON, tolerant of trailing CR — matches `rpc-client.ts`).
- **Correlated commands** (have an `id`): replies `{type:"response", id, …}`. Minimum: `get_state`
  → a small canned state so `smoke-broker [1]` passes.
- **Fire-and-forget `prompt`** (`{type:"prompt", message}`): emits a scripted transcript on stdout,
  one JSON object per line:
  `{"type":"session",…}` (once) → `agent_start` → *(optional `tool_execution_start`,
  `message_start`/`message_update` deltas)* → `message_end` (assistant message
  `{role:"assistant",content:[{type:"text",text:<reply>}]}`) → `agent_settled`.
- Terminal-state scenarios selectable via `PI_AGENTVIEW_FAKE_SCENARIO`
  (`ok` default | `slow` | `error` | `dialog`): `dialog` emits an `extension_ui_request`
  (method `confirm`/`select`) and waits for the broker's `extension_ui_response` before settling —
  exercises the `awaiting_input` path.
- Optional richer script via `PI_AGENTVIEW_FAKE_SCRIPT=<json>` (list of `{event, text?, delayMs?,
  toolName?}` steps) for bespoke flows.
- Exits cleanly on stdin end / SIGTERM. Appends a couple of valid lines to the session JSONL so
  "remove preserves JSONL" stays realistic.

**T2 — Broker test repoint** — set `PI_AGENTVIEW_PI_CLI=<fake>` and `PI_AGENTVIEW_STATE_DIR=<tmp>`
in the env `smoke-broker.ts [3]` spawns the broker with, and drop the hardcoded `zai/glm-5.2`
model/`initialTask` dependence on a live provider. Result: the four model-gated assertions pass with
the fake, fully offline. `[1]` and `[2*]` keep working (they already inject stubs / call
model-independent RPC).

**T3 — Stills renderer** `test/visual/stills.ts` + `test/visual/ansi-to-svg.ts`.
- A set of **fixture rosters** (`ManagedRow[]` + `FrameUi`) covering: empty, single idle, working,
  completed-with-reply, mixed fleet, peek-open, reply-typed, sent-flash, send-error, rename,
  awaiting-input.
- For each: `renderFrame(...)` with a small deterministic ANSI color fn → `string[]` →
  **`ansi-to-svg`** (self-written SGR parser → monospace `<text>` SVG). One committed `.svg` golden
  per state under `test/visual/__golden__/`. Pure-JS, **no native deps**, cross-platform,
  diff-friendly. A `--update` flag regenerates goldens on intentional change (gemini-cli pattern);
  CI/`npm test` asserts current == golden.

**T4 — Driven capture** `test/visual/drive.ts`.
- `node-pty` (Windows ConPTY-native) spawns the **real** interactive `pi` with the extension loaded,
  `PI_AGENTVIEW_PI_CLI`→fake, `PI_AGENTVIEW_STATE_DIR`→tmp.
- Sends a scripted keystroke tape (`n` create → observe working→completed → `Space` peek → type a
  reply → `Enter` → `r` rename → `Esc`), using **wait-for-condition** (poll the decoded screen for
  expected text) between steps — never fixed sleeps.
- `@xterm/headless` decodes the emitted ANSI into a screen grid; capture key frames → **SVG stills**
  + an **animated SVG** (frames as timed layers) and the raw **asciinema `.cast`** (timestamped
  output). Both are pure-JS/no-native-deps and Windows-safe; a true `.gif` can be exported later from
  the `.cast` (ffmpeg/agg) if wanted — deliberately out of the foundation to avoid a native encoder.
- Artifacts written under `test/visual/__artifacts__/` (gitignored; ephemeral), a couple of
  representative frames promoted to committed goldens.

**Main feasibility risk (spike T4 first):** whether real pi's `pi-tui` host renders the agent view
deterministically inside node-pty/ConPTY on Windows. **Fallback if flaky:** the driven layer renders
a `renderFrame()` *sequence* (states advanced by feeding the fake's own event stream through
`deriveState`) into the same animated-SVG — still a "video," just not the live pty host. Stills (T3)
and the broker repoint (T2) are unaffected either way.

### Runner

Keep the existing lightweight jiti smoke style (hand-rolled `ok()` counters) — **no vitest
imposition**. Add two scripts to `package.json`: `test:visual` (stills assert + driven spike) and
fold the fake-pi'd broker test into `test`. New deps are **devDependencies** only:
`@earendil-works/pi-coding-agent` (needed to typecheck + to have a real pi for T4 — today it's a
peerDep and absent from a fresh clone), `node-pty`, `@xterm/headless`. Stills/`ansi-to-svg` add
nothing native.

## Data model / determinism notes

- The fake never reads a clock for *content* — timing deltas in the animated SVG come from the tape,
  not wall-clock, so captures are reproducible. (`Date.now()` still stamps `BrokerState.updatedAt`
  inside the real code; stills fix `now` via the fixture so elapsed values are stable.)
- Goldens are the **decoded frame / SVG**, not raw ANSI byte streams — escape churn collapses to a
  stable screen.
- No network egress anywhere in `npm test`.

## Out of scope (explicit)

- Real agents / real models / network (per user decision).
- vitest migration.
- Unrelated REVIEW.md bugs (G1 "JSONL is source of truth" rebuild, R1 `registry.json` race).
- A native GIF/MP4 encoder in the default flow (animated-SVG + `.cast` instead; GIF export documented
  as an optional later step).

## Validation (how we check our own work — mirrored into CLAUDE.md)

- `npm run typecheck` — zero errors.
- `npm test` — smokes green **offline** (fake pi; no creds/net), including `smoke-broker [3]`.
- `npm run test:visual` — stills match goldens; driven spike produces artifacts.
- **Look at the evidence.** Open the committed `.svg` stills and the driven animated SVG / `.cast`
  and confirm the screen states read correctly — this is the "resolve things by looking" gate that
  catches layout/behavior faults automated asserts miss.
