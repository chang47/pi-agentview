# pi-agentview — project instructions

A TUI fleet dashboard for the [pi coding agent](https://github.com/earendil-works/pi):
manage many background sessions from one screen. TypeScript/ESM, Node ≥20, rendered via
`@earendil-works/pi-tui`. A per-session **detached broker** (`dist/broker.mjs`) owns one
`pi --mode rpc` worker; TUI ⇄ broker ⇄ worker over IPC/RPC. Architecture: `SPEC.md`.

## The Feedback Loop

`implement → npm run typecheck && npm test → fix → commit.` Both must be green before you
commit. **`npm test` runs fully OFFLINE** — no model, no API key, no network — so there is
never a reason to commit red because "it needs credentials."

## Validation

Read this before verifying a change. Everything here is offline and deterministic.

| Command | What it checks |
|---|---|
| `npm run typecheck` | `tsc --noEmit`, zero errors |
| `npm test` | The whole suite offline: `smoke.ts`, `smoke-extension.ts`, `smoke-broker.ts` (all via the fake pi), then the visual stills + driven flow |
| `npm run test:visual` | Assert the 9 golden **stills** — one per Agent View screen state |
| `npm run test:drive` | Assert the **driven-flow** animated SVG |
| `npm run test:visual:update` | Regenerate BOTH golden sets after an INTENTIONAL UI change — review the diff before committing |

**How it's testable — the fake pi.** The dashboard resolves the pi binary through the
`PI_AGENTVIEW_PI_CLI` env var (`src/platform/spawn.ts`). `test/fakes/fake-pi.mjs` is a scripted
stand-in that speaks the subset of pi's `--mode rpc` JSONL protocol the broker consumes
(`agent_start → message_end → agent_settled`, `get_state`, the `extension_ui` dialog path).
Point the env var at it and the broker / IPC / journal / state derivation / TUI all run for
**real** against a deterministic agent — no model, no key, no network. `PI_AGENTVIEW_STATE_DIR`
gives each run an isolated state dir (no machine-wide collisions). Scenarios:
`PI_AGENTVIEW_FAKE_SCENARIO=ok|slow|error|dialog`.

**For UI work — LOOK at the evidence.** The stills (`test/visual/__golden__/*.svg`) and the
driven flow (`driven-flow.svg`) are terminal-style SVGs you open in a browser. A layout or
behavior regression shows up as a golden diff **and** is visible in the picture — this is the
"resolve it by looking" gate that catches what an assertion misses. Add a fixture to
`test/visual/fixtures.ts` for a new screen state, then `npm run test:visual:update`.

**GOTCHA — rebuild the broker bundle after touching bundled code.** `dist/broker.mjs` is a
COMMITTED esbuild bundle of `src/broker.ts` and everything it imports (`platform/paths.ts`,
`platform/spawn.ts`, `broker/*`, `registry.ts`, `types.ts`, `platform/*`). If you change any of
those, run `npm run build:broker` — otherwise the broker **subprocess** runs stale code
(`smoke-broker` spawns the bundle, not the source), and the change silently won't take effect.

**Real-pi integration is intentionally NOT in the default flow.** Driving a real `pi` (its
interactive TUI in a pty, or `--mode rpc`) needs pi auth/config and is nondeterministic; a fresh
no-auth install won't even round-trip `get_state`. The fake covers exactly the protocol the
broker depends on. If you add a real-pi test, gate it so it SKIPs without credentials — never
let it make the default suite flaky.

## Guard rails

- Only touch files you created or modified (multiple agents share this checkout).
- Never commit failing `typecheck`/`test`, `console.log` debug, or `--force` pushes.
- Keep `dist/broker.mjs` committed and in sync (see the gotcha above) — `pi install git:` does
  not run the build.

## Design docs

- `docs/superpowers/specs/2026-08-10-ai-testable-fake-drive-design.md` — the testing design
  (fake-drive + visual evidence).
- `SPEC.md` — architecture source of truth. `REVIEW.md` — cross-check + known gaps (G1 JSONL
  rebuild, R1 registry race are open and out of scope for the testing work).
