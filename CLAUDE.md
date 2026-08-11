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
| `npm run test:interactions` | Drive the REAL `AgentViewComponent` by keystroke — assert behavior + a filmstrip golden |
| `npm run test:visual:update` | Regenerate ALL visual goldens after an INTENTIONAL UI change — review the diff before committing |

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

**Reproducing a reported bug (the interaction harness).** `test/visual/harness.ts` drives the
REAL `AgentViewComponent` — real `handleInput` + real `render` — against a mock manager (a
scriptable roster + a call log; `sendReply` can be made to fail). To investigate "the agentview
did X wrong": add a scenario to `test/visual/interactions.ts` — a roster + a list of keystrokes
(`{key}` / `{text}` / `{rows}`) — then read back `frames` (what rendered at each step) and
`calls` (what the component asked the manager to do: `sendReply`/`setTitle`/`remove`/resume). No
broker, no model — a bug becomes a small deterministic repro you can look at. `runScenario` is
the reusable entry point; `interactions.ts` shows navigate/peek/reply, the delivery-failure path,
and the attached-row guard as examples.

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

## Research pipeline

Before designing anything non-trivial, gather sourced findings so the decision can be made later
with **no re-research**. A **research issue** is read-only (no code) and drain-safe:

- Label `research` + `auto`; title `[research] <topic>`. Template: `.github/ISSUE_TEMPLATE/research.md`.
- `Done when:` = a findings doc at `docs/research/<YYYY-MM-DD>-<topic>.md` that answers the stated
  questions **with source URLs**, a per-option comparison, what was **ruled out and why**,
  `[UNVERIFIED]` flags, and a **flagged recommendation** — enough to decide the downstream question
  without re-searching.
- **Working it** = run the research (fanning out subagents is fine), write the doc, commit, then
  **close the issue with a one-line summary + doc link**. It then feeds a `[design-first]` issue.
- **The rule that makes it reusable:** the output is the *derivation* (sources + reasoning +
  ruled-outs), never a bare conclusion. A bare answer you can't trace gets re-researched; a sourced
  one is reviewable weeks later — which is the whole point of doing it async.

Example: #17 (worktree isolation) → `docs/research/2026-08-10-worktree-isolation.md` → feeds #13.

## Automation notes (drain / any background agent)

Working an issue in an isolated worktree? These are failure modes we've actually hit:

- **`cd <worktree> && npm install`, NEVER `npm --prefix <path> install`.** A fresh worktree has no
  `node_modules`. But `npm --prefix` run from a *different* cwd makes npm add a bogus self-dependency
  (`"pi-agentview": "file:…"`) to `package.json` + lock — `cd` into the worktree and run plain
  `npm install` instead.
- **Stage only the paths you changed (`git add <paths>`), never `git add -A`.** Multiple agents
  share this checkout, and a stray install can dirty `package.json` — explicit staging keeps junk
  out of the PR.
- **Edit the *worktree* copy of a file, not the shared-checkout path** you may have read from —
  isolation is path-sensitive.
- **Rebuild `dist/broker.mjs`** (`npm run build:broker`) if you touched bundled code (see the gotcha
  above), then re-run `npm test`.

## PR evidence — make the validation VISIBLE

A reviewer must **see** the proof in the PR, not just read "tests passed." For a UI change:

1. After `npm run test:visual:update`, render the new/changed **still(s)** to PNG:
   `npm run test:evidence -- <fixtureName>` → writes `test/visual/__evidence__/<name>.png` and prints
   the markdown line.
2. **Commit the PNG** (it lives in the repo) **and embed it in the PR body** via the printed raw URL
   (replace `<BRANCH>` with your branch). PNG renders inline on GitHub; the SVG golden stays for
   diffing. Both, so nothing is "stored somewhere you have to go check out."

For an **interaction / "watch the process"** (typing, narrowing, state changes), use
`npm run test:gif` → an animated **GIF** under `__evidence__/` (each real frame → resvg pixels →
gifenc). GitHub renders GIFs inline and auto-plays them; it does **not** animate our SVGs, so a GIF
is the format for motion. Same rule — commit it *and* embed it. (`test:evidence` is stills-only.)

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
