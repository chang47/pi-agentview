# Spec: agentdeck — a cross-repo PR-review cockpit (manual-validation router)

> **Type:** design spec. **Produced for:** Brief B (the review/validation dashboard). **Consumes:** Thread C's validation engine (`/project validate`). **Date:** 2026-08-10. **Home:** new standalone repo `agentdeck`. **Status:** DESIGN ONLY — do not build.
> Sources are inline; unverifiable claims are flagged `[UNVERIFIED]`. Grounded against real `gh` output (chang47, 8 open PRs) and `~/.claude/skills/project/skill.md`.
> **Bottom line:** a **local web page** that lists every open agent-authored PR across all your repos — one row each with an **AI one-liner + a risk badge** — anchored on Thread C's `validated` / `validation-failed` / `drain-hold` labels. It is a **router, not a reviewer**: it tells you which PRs to hand-validate and lets you trust the rest. The MVP is a read-only feed that reuses your already-authed `gh` and `claude` CLIs (no new credentials). The **north star** (designed, not built) is a per-row "drive & validate" action that shells `claude -p` from the same local server, checks out the PR, drives the changed feature, and returns evidence into the row.
> Read §3 (Scope), §5 (Risk model), and §12 (Open questions) before starting the implementation plan.

Tools surveyed: Graphite · gh-dash · CodeRabbit · GitHub native (+ Copilot) · Aviator · Mergify · Greptile · Ellipsis · Sourcery · Sourcegraph · Codegen.

---

## 1. The gap — "AI-in-the-row triage" (market survey)

The wedge is a **fusion** nobody ships: an AI one-liner **and** a risk/severity signal, rendered **per row** in a **cross-repo** PR triage list whose **job is to route a human's manual validation** (triage-this vs trust-this) over incoming agent-authored PRs. Every competitor has at most two or three of `{cross-repo row, AI summary, risk signal, manual-validation routing}` — none puts all of them **in the row**.

| Tool | AI summary? | Risk/triage signal? | Where it lives | Cross-repo? | Routes manual-validation? |
|---|---|---|---|---|---|
| **Graphite** | Yes — auto PR summary | Per-comment priority (Nit/Optional/Blocking); **no PR-level risk** | **In-PR** diff comments; inbox rows = metadata only | **Yes** (inbox) | No — rule/filter triage, no AI trust signal |
| **gh-dash** | **No** | **No** — raw GitHub fields (CI/review/labels/lines) | List row (TUI), no AI in it | **Yes** (`author:@me` searches) | No — raw list/filter/nav |
| **CodeRabbit** | Yes — "walkthrough" comment | 1–5 effort + per-finding severity; no single PR-level badge `[UNVERIFIED]` | **In-PR**; dashboard = metrics only | Review context only; no live per-PR list | No — reviews in place |
| **GitHub + Copilot** | Yes (Copilot) — in PR body/timeline | Copilot severity High/Med/Low — on the inline comment | **In-PR**; `github.com/pulls` rows carry no AI | **Yes** (pulls dashboard, GA 2026-07-09) | Rule/state-based only |
| **Aviator** | **Roadmap/shadow-mode only** | Algorithmic LOW/STRICT (not AI); "High Risk group" = shadow roadmap | **List row** — but AI content not shipped | **Yes** (Inbox "across every repo") | Yes (attention routing) — via rules/effort, not AI risk |
| **Mergify** | No | No — rule/CI merge gating | Queue/metrics dashboard | Queue only `[UNVERIFIED]` | No — merge gating |
| **Greptile** | Yes — review summary | Severity P0/P1/P2 + confidence — on inline comments | **In-PR**; dashboard = aggregate metrics | Numbers across repos, not per-PR rows | No — reviewer |
| **Ellipsis** | Yes — maintains PR summary | "Highlights risky changes" + internal Confidence Filter (not surfaced per-PR) | **In-PR** | No cross-repo dashboard found | No — reviewer/fixer |
| **Sourcery** | Yes — "Summary by Sourcery" incl. "where the risk is" | Prose risk + typed comments + single pass/fail status | **In-PR** | No | No — reviewer |
| **Sourcegraph** | Cody (in-editor) can draft summaries | None in Batch Changes rows — status only | Cody = in-editor; Batch Changes = cross-repo row, **status only** | **Yes** (Batch Changes) — but your own changesets, no AI | No — bulk-change tracking |
| **Codegen** | In-PR review comments (a PR-*author*) | No structured per-PR risk `[UNVERIFIED]` | **In-PR** | No | No — authors PRs. ⚠ **shut down 2026-04-30** |

**Key derivations:**
- **gh-dash has the cross-repo triage row but ZERO AI** — its rows are raw GitHub API fields, no summary, no risk (`dlvhdr/gh-dash`). It is the row shape agentdeck wants, empty of intelligence.
- **CodeRabbit / Greptile / Ellipsis / Sourcery review INSIDE each PR** — summary + severity land as PR comments; their only cross-PR surface is a **metrics dashboard** or nothing, never a per-PR triage row. Greptile even has the risk badge (P0/P1/P2) — but on the inline comment, not in a cross-repo row.
- **Graphite has both an inbox AND AI review, but the AI lives in the PR, not the row** — inbox rows carry CI/files/age; the AI summary + comment-priority sit on the diff inside the PR.
- **GitHub ships both halves and still stops short** — cross-repo `github.com/pulls` (GA 2026-07-09) + Copilot summaries + Copilot High/Med/Low — but the AI is **in-PR** and the dashboard's triage is **rule/state-based**, never an AI risk badge per row.
- **Aviator is the closest competitor and the one to watch** — it shipped the cross-repo, row-based **Inbox** and publicly roadmaps "one-line PR summaries + a High Risk group," but those AI signals **run in shadow-mode, explicitly not live** (aviator.co/inbox). The wedge is real, but a funded competitor has announced this exact direction.
- **Sourcegraph has both halves but never fuses them** — Batch Changes is a real cross-repo per-changeset row UI, yet the rows show merge/check status only, and only for changesets *you generated*; Cody's AI stays in the editor.
- **Merge-automation (Mergify, Aviator MergeQueue) gates merges by rules/CI** — that is automated *gating*, not human manual-validation *routing*. Different job.
- **The single most defensible wedge line:** *no shipped tool renders an AI one-liner + risk/severity in a cross-repo PR triage row that routes manual validation — Aviator announced exactly this but keeps the AI signals in shadow-mode, not live.*

**agentdeck's asymmetric advantage over all of them:** it does not run its own review model to *generate* a risk verdict — it **reads Thread C's already-produced verdict** (`validated` / `validation-failed` / `drain-hold`, from an adversarial Opus validator that independently reproduced the PR's `Done when:` proof). Competitors surface a *reviewer's opinion*; agentdeck surfaces a *reproduced-proof verdict*, and only spends an LLM on the one-liner. That is a different and stronger trust signal, and it is cheap.

**RULED-OUT / adjacent:** Mergify (merge-queue gating, no triage row); Sourcegraph Cody (in-editor, never a PR surface); Sourcegraph Batch Changes (your own changesets' status, not incoming PRs); Codegen (a PR *author*; standalone shut down 2026-04-30, absorbed into ClickUp); Reviewpad (acquired by **Snyk** Oct 2023 — the brief's "acquired by Codegen" hint is wrong — folded into Snyk, standalone sunset).

---

## 2. What we build on (grounded facts)

### 2a. Thread C's validation engine — the interface we consume (never reimplement)
`/project validate <PR# | issue#>` (`~/.claude/skills/project/skill.md:153-186`) is an adversarial Opus sub-agent that reads the target repo's `## Validation` section, **independently reproduces** the PR's `Done when:` proof (code → re-derive from disk; visual → re-render + screenshot; physical → device-pending, never faked), defaults to **REJECT**, and writes its verdict as:
- **exactly one GitHub label** — `validated` / `validation-failed` / `validation-uncertain` (`skill.md:174-177`);
- **a comment** carrying "verdict + the exact evidence + (if not validated) the gap" — on the **PR** for a ship, the **issue** for a hold;
- plus the drain's own markers: **`drain-hold`** (looked, human decides — no-ship) and **`auto`** (the per-repo opt-in gate: "yes, let an unattended agent open a PR here") (`skill.md:63-144`).

**There is no JSON API and no confidence score.** The contract is **GitHub labels (machine state) + a comment body (evidence prose).** The engine has **no notion of "lanes" and no PR-level risk score** — its only differentiation is by change *type* (code/visual/physical), which drives *how* it reproduces proof. Lanes and the risk badge are **agentdeck's invention on top**. Runs on Opus 4.8, one PR at a time, async via a `*/15` heartbeat cron (`config/schedule.yaml:188-201`), 30-min timeout, `retry_on_fail:false`.

> **Design implication (verbatim from the interface report):** "Your cockpit should read `gh` labels for machine state and render the comment body as the evidence pane. Do not assume a callable API that returns `{verdict, confidence, evidence}` — you'd be reimplementing what is deliberately a skill+label protocol."

### 2b. The real feed today (chang47, verified `gh search prs --author @me --state open`)
8 open PRs across 5 repos — pi-agentview ×3, pipkin ×2, Stock-Indicators ×1, Synod-Labs ×1, My-Insomnia-Pal ×1; several are drafts months old. **pipkin #12 already carries the `validated` label** (*"Adversarial validation reproduced the Done-when (advisory)"*) — the router's trust signal is live in production data. pipkin #13 (`docs(backlog): …`) is a clean Lane-A (read) row.

### 2c. Cheap per-PR enrichment (one `gh` call each, verified)
`gh pr view <N> --repo <R> --json number,title,additions,deletions,changedFiles,files,labels,reviewDecision,statusCheckRollup,mergeable,isDraft,headRefOid,url,body` returns everything the router needs in a single call: diff size, file paths, the validation labels, checks, mergeability, draft state, and `headRefOid` (the revision key for summary caching).

### 2d. The Claude Code integration seam (for the north star, §9)
Per the CC-capability probe (flag exact surface `[UNVERIFIED]`, verify at build):
- A URL scheme **exists** — `claude-cli://open?cwd=<abs>&q=<urlencoded>` — but it only *pre-fills* a prompt (you press Enter), and **GitHub-rendered markdown strips `claude-cli://` links**. Not the bridge.
- **`claude -p` headless is the real bridge** — `--allowedTools`, `--permission-mode`, `--output-format json|stream-json`, `--resume`, `--max-turns`, `--max-budget-usd`. Built for exactly this. No API key needed if the local `claude` is authed.
- There is **no localhost HTTP/MCP surface** a browser can hit directly; a page cannot exec local binaries.
- **Convergence:** the thinnest realistic browser→local bridge is *"a small local companion HTTP server the page fetches, which shells `claude -p`"* — **and agentdeck's own local server already is that companion** (it is already shelling `gh`). So the north-star bridge is "one extra write route on a server we are already building," not a new component.

---

## 3. Scope

### P0 — MVP (this spec's build target)
A **read-only, local web feed** of open agent PRs across all repos, each row = **risk badge + AI one-liner + lane + repo · age · diffstat + link out to the PR**, sorted most-needs-validation first. Reuses already-authed `gh` (data + verdict labels) and `claude -p` (one-liner), cached per revision. **No credential UI, no writes, no auto-merge.**

### P1 — polish + the feature you asked for
- **Inline content expansion** — a **side pane or accordion** per row that pulls the PR's actual content (diff, body, the validator's evidence comment) into the same view, so a quick review never leaves the page. *(Your explicit request; recorded as a backlog issue in §11.)*
- Feed **filters + sort controls** (by lane / badge / repo); surface each repo's `auto`-gate state.

### North star — one-click repro (designed in §9; P1→P2, gated on the bridge)
Per-row **"drive & validate"** → local server shells `claude -p` / `/project validate <PR#>` → checkout PR → drive the changed feature → **evidence (stills/GIF) rendered back into the row.**

### P2 — issue-list mode (the "issues-in" half)
A second surface over your **issues**, not just PRs: the TBDs, and the **dependencies** (issue X blocked until PR Y lands) you currently have zero visibility into. Same Collector pattern over `gh search issues --author @me` / assigned-to-me, plus a **"startable-now vs blocked" ranker** and re-assignment affordance. Framing that keeps it coherent, not bolted-on:

> **agentdeck is a surface over your whole `/project` loop: issues in (backlog / blocked-on-PR / ready) → PRs out (validated) → merge.** The MVP builds the *PRs-out* half; P2 adds the *issues-in* half, and naturally re-surfaces `/project`'s own issue queue (`auto`, `drain-hold`, held).

### Non-goals (explicit)
- **Not a code reviewer.** agentdeck never generates a review verdict; it reads Thread C's. The only LLM spend is the one-liner (and, at the north star, the repro drive).
- **No auto-merge / auto-land in any P-tier without a separate decision** (see §12). "Trust the rest" means *visual de-emphasis*, not automated landing.
- **No hosted/multi-user service.** Local, single-user, personal tool. No secret storage.
- **Not a merge queue.** Mergify/Aviator own that; different job.

---

## 4. The two lanes (row classification)

Every PR row is assigned exactly one lane; the lane changes what "review" *means* for that row.

- **Lane A — Research, to READ.** The deliverable is a doc/research artifact; there is no runtime behavior to reproduce. Review action = *read the rendered doc*. **Detection (heuristic-first):** all changed files match doc globs (`*.md`, `*.mdx`, `*.txt`, `docs/**`) **or** a `documentation`/`research` label **or** a `docs(...)`/`chore(docs)` title. e.g. pipkin #13.
- **Lane B — Work, to CHECK.** Any code change. Review action = *trust or hand-validate*, decided by the risk badge (§5). e.g. pi-agentview #1–3, pipkin #12.

Mixed diffs (docs + code) → Lane B (there is behavior to check). The **summariser breaks genuine ties** (`lane` is one of its outputs), but the heuristic wins when confident — an LLM is not on the critical path for classification.

---

## 5. The risk model (the badge)

The badge is **anchored on the engine's reproduced-proof verdict**, not on model vibes. Deterministic spine decides; the LLM only *modulates* via the one-liner + a "why-risky" note.

| Badge | Meaning | Primary driver (deterministic) |
|---|---|---|
| ⛔ **Held** | human decision pending | `drain-hold` **or** `validation-failed` label — the engine already flagged it |
| 🔴 **Validate** | hand-validate this | no validation label **or** `validation-uncertain`, **or** high blast radius (large diff, or touches risk paths: CI/`.github/workflows`, config, auth/secrets, deletes tests, guard files), **or** checks failing |
| 🟡 **Skim** | quick look | `validated` but non-trivial diff, **or** Lane A (read it), **or** medium diff with green checks |
| 🟢 **Trusted** | skip hand-validation | `validated` label **and** small/low-blast-radius diff **and** checks green |

**Inputs (spine):** validation labels (§2a) · additions+deletions · changedFiles + file paths matched against a configurable **risk-path set** · `statusCheckRollup` · `mergeable` · `reviewDecision` · `isDraft` · age · lane.
**Inputs (nuance, from the summariser):** the one-liner + `risk_reasons[]` (blast radius, surprising scope, "deletes a test," "edits a guard file"). These can push 🟡→🔴 but **cannot** downgrade an engine ⛔/🔴 to 🟢 — the verdict labels are authoritative.

**Sort order:** ⛔ and 🔴 first, then 🟡, then 🟢 sinks to the bottom; within a bucket by risk score, then age. The list's whole job is *"what do I have to look at, and what can I ignore."*

---

## 6. Architecture / components

Six small, independently testable units. Data flow is one-way read (the only write is the north-star repro trigger, §9).

1. **Collector** (`collector`) — runs `gh search prs --author @me --state open` → for each, `gh pr view --json …` (+ `gh api` for any field `gh pr view` lacks). Uses the **local `gh auth token`** — **no credential UI in v1** (thinnest and safest; PAT-paste is a later fallback, §11). Output: normalized `PrRow[]` (§7). *Depends on:* `gh` CLI. *Testable via:* captured `gh` JSON fixtures.
2. **Verdict reader** (`verdict`) — from each PR's labels + comments, extracts `{verdict_label, evidence_comment_body, auto_gate, drain_hold}`. Pure read of GitHub state; **never invokes `/project validate`.** *Depends on:* Collector output + one `gh api` comments call. *Testable via:* fixtures.
3. **Summariser** (`summary`) — one `claude -p "<PR title+diffstat+files+body>" --output-format json` per PR → `{one_liner, lane, risk_reasons[]}`. **Cached by `(repo, number, headRefOid)`** so it runs once per revision, not per page load. Reuses the authed local `claude` CLI (no separate API key). *Depends on:* `claude` CLI + a cache dir. *Testable via:* a **fake summariser** (deterministic canned output), zero model calls.
4. **Router/ranker** (`router`) — folds verdict + risk-path heuristics + summariser into `{badge, lane, risk_score, sort_key}` per row and orders the feed (§5). Pure function. *Depends on:* the three above. *Testable via:* table-driven unit tests.
5. **Web server** (`server`) — a single local Node process. Serves the SPA; exposes `GET /feed` (returns the ranked `PrRow[]` as JSON) and, later, the north-star `POST /validate` (§9). Orchestrates Collector→Verdict→Summariser→Router; caches the feed with a manual refresh. *Depends on:* units 1–4. *Testable via:* HTTP-level tests against fixtures.
6. **SPA** (`web`) — renders the scrollable feed: each row = badge · one-liner · lane · repo · age · diffstat · links (PR, files, evidence comment). Filter/sort controls (P1). *Depends on:* `GET /feed`. *Testable via:* **golden render** of a fixture feed (borrowed from pi-agentview's visual-golden pattern — a still, opened in a browser, diffed).

**The unifying decision:** agentdeck shells out to the **two CLIs you already have authed** — `gh` for data/verdicts, `claude -p` for intelligence. **No new credentials anywhere**, for both the MVP summariser and the north-star repro.

---

## 7. Data model — `PrRow`

```jsonc
{
  "repo": "chang47/pipkin",
  "number": 12,
  "title": "feat(cues): pair a distinguishable vibration with each earcon",
  "url": "https://github.com/chang47/pipkin/pull/12",
  "author": "chang47",
  "createdAt": "2026-08-10T18:53:45Z",
  "isDraft": false,
  "headRefOid": "…",                       // summary cache key
  // enrichment (Collector)
  "additions": 17, "deletions": 4, "changedFiles": 1,
  "files": ["public/app-driver.js"],
  "mergeable": "MERGEABLE",
  "reviewDecision": "",
  "statusChecks": "pending|passing|failing|none",
  // verdict (Verdict reader) — the trust spine
  "verdict": "validated|validation-failed|validation-uncertain|drain-hold|none",
  "evidenceComment": "…validator's verdict + evidence prose…",
  "autoGate": true,                        // repo opted into unattended drain
  // intelligence (Summariser, cached)
  "oneLiner": "Adds a vibration channel alongside each audio earcon; single file, self-contained.",
  "riskReasons": [],
  // routing (Router)
  "lane": "A_read|B_check",
  "badge": "held|validate|skim|trusted",
  "riskScore": 0.12,
  "sortKey": "…"
}
```

`statusChecks` is a rollup of `statusCheckRollup`. `verdict:"none"` (no validation label) is itself a **🔴 signal** — an un-adjudicated PR is exactly what needs a human.

---

## 8. Data flow

```
gh search prs (all repos, author:@me, open)
        │
        ▼
gh pr view --json ─┬─► Collector ──► PrRow[] (raw)
                   └─► Verdict reader ──► labels + evidence comment
                                   │
   claude -p (cached by headRefOid) ─► Summariser ──► one_liner + lane + risk_reasons
                                   │
                                   ▼
                              Router/ranker ──► badge + lane + sort
                                   │
                                   ▼
                        GET /feed (JSON)  ──►  SPA scrollable feed
```

One-way read. Refresh is manual (a button); the feed is cached so a reload is instant and cheap. The only write path is §9.

---

## 9. North star — one-click repro (designed, NOT built)

**Goal:** from a row, `checkout PR → Claude drives the changed feature → evidence`, without leaving the page.

**The bridge (from §2d):** the SPA `POST`s to agentdeck's **own local server** — the server is already the "local companion process" the browser needs. The server runs:

```
claude -p "<repro brief for PR #N in <repo>>" \
  --allowedTools "Bash,Read,Glob" --permission-mode acceptEdits \
  --output-format stream-json     # → stream progress back to the row
# or, once graduated: invoke Thread C directly →  /project validate <N>
```

checking out the PR branch (worktree-isolated, per pi-agentview's `2026-08-10-worktree-isolation` research), driving the feature, and capturing stills/GIF (a Bash-invoked screenshotter / Playwright — CC has no built-in screenshot tool `[UNVERIFIED]`). Evidence renders back into the row's inline pane (§P1).

**Why it's only designed here:** (1) it writes/executes, so it needs the worktree-isolation + permission story settled first; (2) Thread C's evidence-driving variant is itself still being prototyped against pi-agentview's fake-drive harness (`docs/superpowers/specs/2026-08-10-ai-testable-fake-drive-design.md`) before graduating into `/project`. agentdeck's job today is to be the **surface** that will host the button; the architecture (§6, the local server) is deliberately shaped so the button is *one added route*, not a rebuild. **Do not build this in the MVP.**

**Ruled out for the bridge:** the `claude-cli://` deep link (needs a keypress; stripped by GitHub markdown); a browser-direct exec (impossible — sandbox); clipboard-copy-a-command (degenerate fallback UX only).

---

## 10. Home, name, and test harness

- **New standalone repo: `agentdeck`.** Agent-agnostic (any PR from any tool, not pi-specific), wants its own install/release, and keeping it out of pi-agentview preserves that project's crisp "pi fleet dashboard" scope. It **borrows pi-agentview's patterns** (small bounded units, env-var config, and especially the **offline-deterministic test story**), not its code.
- **This spec incubates** at `pi-agentview/docs/superpowers/specs/` (beside the sibling Thread specs) until the `agentdeck` repo exists.
- **Test harness (borrowed pattern):** fully **offline and deterministic** — captured `gh` JSON fixtures + a **fake summariser** (canned deterministic output, no model call) → unit tests for the Router (table-driven) and a **golden render** of the SPA feed (a still you open in a browser and diff, exactly like pi-agentview's `test/visual/__golden__`). No network, no model, no `gh`, no `claude` in the test path.

---

## 11. Feature backlog (issues to file in the `agentdeck` repo)

1. **Inline content expansion (P1, user-requested).** Side pane / accordion per row that pulls the PR's diff + body + the validator's evidence comment into the same view, so a quick review stays in one screen. *(For now the row just links out to the PR.)*
2. **North-star "drive & validate" row action (P1→P2).** The §9 bridge: `POST /validate` → `claude -p` / `/project validate` → checkout + drive + evidence into the row.
3. **Issue-list mode (P2).** The §3 "issues-in" half: cross-repo issue feed, blocked-on-PR **dependency awareness**, startable-now ranker, re-assignment; re-surfaces `/project`'s issue queue.
4. **Feed filters + sort controls, repo `auto`-gate visibility (P1).**
5. **PAT-paste credential fallback (P2/opt-in)** for environments without an authed `gh`.

---

## 12. Open questions

1. **"Trust the rest" — how far?** MVP = visual de-emphasis only. Should a 🟢 row ever offer a **one-key merge** (on-brand with your "land on main" rule) or even auto-land? This is the single riskiest possible feature; kept out of every P-tier until a separate decision. **Recommend: stay read-only through P1.**
2. **Summariser model + cost.** Default to a capable model via `claude -p` per your "Opus for execution, don't downgrade" doctrine — but a triage one-liner is lightweight, and a fleet larger than ~20 PRs makes per-PR Opus calls noticeable. Cache-by-`headRefOid` covers repeats; is a cheaper model acceptable *for the one-liner only* (never for the §9 drive)? **Recommend: strong model default, configurable, revisit if the fleet grows.**
3. **Risk-path set.** The default list (CI/`.github/workflows`, config, auth/secrets, test deletions, guard files) — global default, or per-repo config? **Recommend: sensible global default + optional `.agentdeck.json` per repo.**
4. **PR authorship filter.** MVP uses `author:@me`, which includes your hand-written PRs, not only agent ones. Is that correct (you validate all of them), or should agent-authored PRs (drain/bot-opened) be tagged/filterable separately? **Recommend: show all, add an "agent-opened" facet later.**
5. **Refresh model.** Manual button vs a poll interval vs a `gh`/webhook push. **Recommend: manual button in MVP** (cheap, honest, no background surprises).
6. **Draft PRs.** Include the months-old drafts (Stock-Indicators #2, Synod-Labs #1, My-Insomnia-Pal #1) in the feed, or fold them under a collapsed "drafts" group? **Recommend: show, badge as 🟡/🔴 by their diff, but sort below active PRs.**

---

## 13. Sources

**Thread C validation engine:** `~/.claude/skills/project/skill.md` (validate mode 153-186; drain 63-144; labels 75-76, 130-132, 174-177; discrimination proof 182-186) · `~/.claude/skills/heartbeat/config/schedule.yaml:188-201` (project-drain cron) · live `gh` data (chang47, 8 open PRs; pipkin #12 `validated` label).
**Claude Code seam:** code.claude.com/docs headless (`claude -p`, `--allowedTools`, `--permission-mode`, `--output-format`, `--resume`) · `claude-cli://open` URL scheme (pre-fill only; GitHub markdown strips it) `[UNVERIFIED exact flag surface]` · Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, `query()`) · no localhost HTTP/MCP surface.
**Graphite:** graphite.com/features · graphite.com/guides/github-pr-dashboard · graphite.com/blog/github-pr-filters · graphite.com/docs/ai-review-comments · graphite.com/guides/code-review-comment-types
**gh-dash:** `dlvhdr/gh-dash` (README) · gh-dash.dev/configuration/searching · gh-dash.dev/configuration/layout/pr
**CodeRabbit:** docs.coderabbit.ai/pr-reviews/walkthroughs · docs.coderabbit.ai/guides/dashboard · docs.coderabbit.ai/guides/reports-overview
**GitHub + Copilot:** docs.github.com/en/copilot/how-tos/…/create-a-pr-summary · github.blog/changelog/2026-08-07-copilot-code-review-effort-levels-…-ga · github.blog/changelog/2026-07-09-new-pull-requests-dashboard-…-ga · docs.github.com/en/pull-requests/reference/pull-requests
**Aviator:** aviator.co · aviator.co/inbox (AI summary + High-Risk group = shadow-mode roadmap) · aviator.co/team-reviews (algorithmic risk label) · aviator.co/verify
**Mergify:** mergify.com/product/merge-queue · docs.mergify.com/merge-protections
**Greptile:** greptile.com/docs/introduction · greptile.com/docs/code-review-bot/best-practices (P0/P1/P2 + confidence)
**Ellipsis:** ellipsis.dev/docs · zenml.io/llmops-database (Confidence Filter)
**Sourcery:** docs.sourcery.ai/Code-Review/Code-Reviews-on-Pull-Requests/Components-of-a-Code-Review
**Sourcegraph:** sourcegraph.com/docs/cody · sourcegraph.com/batch-changes · sourcegraph.com/docs/batch-changes/tracking-existing-changesets
**Codegen (dead):** codegen.com/blog/an-update-on-codegen · clickup.com/blog/clickup-codegen-acquisition (shutdown 2026-04-30)
**Reviewpad (ruled-out):** snyk.io/blog/welcoming-reviewpad-to-snyk (acquired Oct 2023)

**`[UNVERIFIED]` roll-up:** CodeRabbit single PR-level risk badge + any dedicated triage/inbox product; Graphite any PR-*level* risk score + AI trust/routing signal; GitHub "PR list row contains no AI" (strong negative evidence, no single confirming sentence); Mergify org-wide cross-repo PR-list view; Codegen structured per-PR risk (moot — shut down); Claude Code exact deep-link/headless flag surface (verify at build); CC built-in screenshot tool (none — use Bash/Playwright).
