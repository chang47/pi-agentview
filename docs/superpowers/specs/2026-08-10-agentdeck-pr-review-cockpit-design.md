# Spec: agentdeck — a cross-repo PR-review cockpit (manual-validation router)

> **Type:** design spec. **Produced for:** Brief B (the review/validation dashboard). **Consumes:** Thread C's validation engine (`/project validate`). **Date:** 2026-08-10. **Home:** new standalone repo `agentdeck`. **Status:** DESIGN ONLY — do not build.
> Sources are inline; unverifiable claims are flagged `[UNVERIFIED]`. Grounded against real `gh` output (chang47, 8 open PRs) and `~/.claude/skills/project/skill.md`.
> **Bottom line:** a **static local web page**. You paste a GitHub token; it fetches every open PR across all your repos from the GitHub API and renders one **deterministic** row each — the PR's own title, a **risk badge**, and a **lane** — sorted most-needs-attention first. **No AI in the surface, no server, no build step:** the page is rules over API data, and you refresh it by reloading. The trust signal is **not** a model's opinion — it is the label Thread C's adversarial validator already wrote after independently reproducing the PR's `Done when:` proof; a PR with **no validator label is itself the signal that it needs *you*.** It is a **router, not a reviewer**, and it is **read-only** — no merge, no auto-land. The **north star** (designed, not built) is a per-row "drive & validate" hand-off that reproduces the change locally; that is the *only* place a local process ever enters, and it lives outside the read-only view.
> Read §3 (Scope), §5 (Risk model), §6 (Architecture — note: serverless), and §12 (Open questions) before starting the implementation plan.

Tools surveyed: Graphite · gh-dash · CodeRabbit · GitHub native (+ Copilot) · Aviator · Mergify · Greptile · Ellipsis · Sourcery · Sourcegraph · Codegen.

---

## 1. The gap — "AI-in-the-row triage", and why agentdeck goes one better

The market gap the brief identified is **"AI-in-the-row triage"**: a per-row AI summary + risk signal, in a cross-repo triage list, that routes a human's manual validation. Every competitor has at most two or three of `{cross-repo row, AI summary, risk signal, manual-validation routing}` — none puts all of them **in the row**.

| Tool | AI summary? | Risk/triage signal? | Where it lives | Cross-repo? | Routes manual-validation? |
|---|---|---|---|---|---|
| **Graphite** | Yes — auto PR summary | Per-comment priority (Nit/Optional/Blocking); **no PR-level risk** | **In-PR** diff comments; inbox rows = metadata only | **Yes** (inbox) | No — rule/filter triage, no trust signal |
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
- **gh-dash has the cross-repo triage row but ZERO AI** — raw GitHub API fields, no summary, no risk (`dlvhdr/gh-dash`). It is the row shape agentdeck wants, empty of a trust signal.
- **CodeRabbit / Greptile / Ellipsis / Sourcery review INSIDE each PR** — summary + severity land as PR comments; their only cross-PR surface is a **metrics dashboard** or nothing, never a per-PR triage row.
- **Graphite has both an inbox AND AI review, but the AI lives in the PR, not the row.**
- **GitHub ships both halves and still stops short** — cross-repo `github.com/pulls` (GA 2026-07-09) + Copilot summaries + Copilot High/Med/Low — but the AI is **in-PR** and the dashboard's triage is **rule/state-based**, never a per-row trust badge.
- **Aviator is the closest competitor** — it shipped the cross-repo row-based **Inbox** and roadmaps "one-line PR summaries + a High Risk group," but those AI signals **run in shadow-mode, explicitly not live** (aviator.co/inbox).
- **The single most defensible wedge line:** *no shipped tool renders a per-row trust/risk signal in a cross-repo PR triage list that routes manual validation — Aviator announced exactly this but keeps the AI signals in shadow-mode, not live.*

**agentdeck's asymmetric advantage — it does one better than "AI-in-the-row":** every competitor's row signal (where it exists at all) is a **model's opinion generated by reading the diff**. agentdeck's row signal is a **reproduced-proof verdict** — the label Thread C's adversarial validator wrote *after independently re-deriving the PR's `Done when:` proof from disk*. So agentdeck deliberately has **no AI in the surface at all**: the page is pure rules over GitHub-API data, the intelligence already happened upstream in the validator, and its output is a durable GitHub label the page just reads. That is (a) a stronger trust signal than a review-bot's guess, and (b) cheaper, faster, and offline-testable, because rendering the dashboard costs zero model calls. The market frames the gap as "AI-in-the-row"; agentdeck's answer is **"validation-in-the-row."**

**RULED-OUT / adjacent:** Mergify (merge-queue gating, no triage row); Sourcegraph Cody (in-editor, never a PR surface); Sourcegraph Batch Changes (your own changesets' status, not incoming PRs); Codegen (a PR *author*; standalone shut down 2026-04-30, absorbed into ClickUp); Reviewpad (acquired by **Snyk** Oct 2023 — the brief's "acquired by Codegen" hint is wrong — folded into Snyk, standalone sunset).

---

## 2. What we build on (grounded facts)

### 2a. Thread C's validation engine — the interface we consume (never reimplement)
`/project validate <PR# | issue#>` (`~/.claude/skills/project/skill.md:153-186`) is an adversarial Opus sub-agent that reads the target repo's `## Validation` section, **independently reproduces** the PR's `Done when:` proof (code → re-derive from disk; visual → re-render + screenshot; physical → device-pending, never faked), defaults to **REJECT**, and writes its verdict as:
- **exactly one GitHub label** — `validated` / `validation-failed` / `validation-uncertain` (`skill.md:174-177`);
- **a comment** carrying "verdict + the exact evidence + (if not validated) the gap" — on the **PR** for a ship, the **issue** for a hold;
- plus the drain's own markers: **`drain-hold`** (looked, human decides — no-ship) and **`auto`** (the per-repo opt-in gate: "yes, let an unattended agent open a PR here") (`skill.md:63-144`).

**There is no JSON API and no confidence score.** The contract is **GitHub labels (machine state) + a comment body (evidence prose).** The engine has **no notion of "lanes" and no PR-level risk score** — lanes and the risk badge are **agentdeck's deterministic layer on top.** Runs on Opus 4.8, one PR at a time, async via a `*/15` heartbeat cron (`config/schedule.yaml:188-201`).

> **This is the whole trust model.** agentdeck's badge is a function of *which of these labels is present* (plus deterministic GitHub signals). The label is authorship-agnostic: it means **"our validator reproduced the proof,"** whoever opened the PR. **No label = un-adjudicated = your job.** agentdeck **reads** the label and renders the comment body as an evidence pane (P1); it **never** calls `/project validate` from the read-only view.

### 2b. The real feed today (chang47, verified `gh search prs --author @me --state open`)
8 open PRs across 5 repos — pi-agentview ×3, pipkin ×2, Stock-Indicators ×1, Synod-Labs ×1, My-Insomnia-Pal ×1; several are drafts months old. **pipkin #12 already carries the `validated` label** (*"Adversarial validation reproduced the Done-when (advisory)"*) — the trust signal is live in production data. pipkin #13 (`docs(backlog): …`) is a clean Lane-A (read) row. **The MVP shows all 8**, drafts and stale ones included — a good nudge to clean up dead work.

### 2c. Everything the row needs is one GitHub-API read (no CLI, no AI)
The browser can fetch it all directly with the pasted token. Recommended: **one GraphQL query** over `search(query:"is:pr is:open author:@me", type:ISSUE)` pulling, per PR: `title, url, number, isDraft, createdAt, headRefOid, additions, deletions, changedFiles, labels(first:20), reviewDecision, mergeable, commits(last:1){ statusCheckRollup.state }, files(first:100){ path }, repository{ nameWithOwner }`. (REST equivalent = `/search/issues` + per-PR `/pulls/{n}`, `/pulls/{n}/files`, `/commits/{sha}/check-runs` — more round-trips; GraphQL preferred.) The GitHub API supports authenticated **CORS from the browser** `[UNVERIFIED — confirm the exact endpoints + rate-limit headers at build]`, which is what makes a serverless client-side page viable.

### 2d. Claude Code seam — reserved for the north star only (§9)
The MVP touches no local process. For §9's optional "drive & validate," the relevant fact (verify at build, flag surface `[UNVERIFIED]`): a browser cannot exec local binaries, so a repro hand-off needs *either* the `claude-cli://open?cwd=&q=` URL scheme (pre-fills a prompt, needs a keypress; GitHub markdown strips such links) *or* a tiny local companion that shells **`claude -p … --output-format stream-json`**. Both are **out of the MVP**; the read-only page never introduces a server.

---

## 3. Scope

### P0 — MVP (this spec's build target)
A **static local web page** (no server, no AI, no build pipeline) that, given a pasted GitHub token, fetches every open PR across all your repos and renders one **deterministic** row each: **badge · title · lane · repo · age · diffstat · draft flag · link to the PR**, sorted most-needs-attention first. Rules do all the work (lane §4, badge §5). Refresh = reload the page. **Read-only. Shows everything (all authors, all drafts).**

### P1 — polish + the feature you asked for
- **Inline content expansion** — a **side pane or accordion** per row that pulls the PR's diff + body + the validator's evidence comment into the same view, so a quick review never leaves the page. *(Your explicit request; §11.)*
- **Filters** (by lane / badge / repo) — UI toggles over the same client-side data.

### North star — one-click repro (designed in §9; NOT built)
Per-row **"drive & validate"** hand-off that checks out the PR locally, drives the changed feature, and captures evidence. This is the **only** component that ever introduces a local process, and — per your point that actions don't belong in the view — it is a hand-off *out* of the read-only dashboard, not an embedded button that mutates state.

### P2 — issue-list mode (the "issues-in" half)
A second surface over your **issues**, not just PRs: the TBDs, and the **dependencies** (issue X blocked until PR Y lands) you currently have zero visibility into. Same client-side fetch pattern over `is:issue is:open author:@me` / assigned-to-me, plus a **"startable-now vs blocked" ranker**. Framing that keeps it coherent:

> **agentdeck is a read-only surface over your whole `/project` loop: issues in (backlog / blocked-on-PR / ready) → PRs out (validated) → merge.** The MVP builds the *PRs-out* half; P2 adds the *issues-in* half, and re-surfaces `/project`'s own issue queue (`auto`, `drain-hold`, held).

### Non-goals (explicit)
- **No AI in the surface.** The only intelligence in the system is the upstream validator; the page renders its label. Rendering the dashboard is a zero-model-call operation, always.
- **Not a code reviewer.** agentdeck never generates a verdict; it reads Thread C's.
- **No merge, no auto-land, in any tier.** "Trust the rest" = *visual de-emphasis*, never automation. (If auto-landing is ever wanted, it belongs upstream in the validator/drain — it lands immediately and never appears as a dashboard action.)
- **No server in the MVP.** Static page + client-side `fetch`. A local process appears only at the §9 north star.
- **No hosted/multi-user service, no OAuth app.** Local, single-user, personal. Token lives in the browser (§6).

---

## 4. The two lanes (deterministic classification — no AI)

Every PR row gets exactly one lane, from **rules only**:

- **Lane A — Research, to READ.** All changed files match doc globs (`*.md`, `*.mdx`, `*.txt`, `docs/**`) **or** a `documentation`/`research` label **or** a `docs(...)`/`chore(docs)` title. Review action = *read the doc*. e.g. pipkin #13.
- **Lane B — Work, to CHECK.** Any code change. Review action = *trust or hand-validate* per the badge (§5). e.g. pi-agentview #1–3, pipkin #12.

Mixed diffs (docs + code) → Lane B (there is behavior to check). No tie-break model — when the rule is ambiguous it defaults to Lane B (safer: prompts a look). The row's **title is its own one-liner** (your PRs use conventional-commit titles), so no summary is generated.

---

## 5. The risk model (the badge — pure function, no AI)

The badge is a **deterministic function of the validator's label + GitHub signals.** No model, no post-PR summariser — "the grader is the validator," and the page just reads its verdict.

| Badge | Meaning | Rule |
|---|---|---|
| ⛔ **Held** | human decision pending | `drain-hold` **or** `validation-failed` label present |
| 🔴 **Validate** | needs *you* | **no validator label** (un-adjudicated), **or** `validation-uncertain`, **or** checks failing, **or** high blast radius (large diff, or touches a risk path: CI/`.github/workflows`, config, auth/secrets, deleted tests, guard files) |
| 🟡 **Skim** | quick look | `validated` but non-trivial diff, **or** Lane A (read it), **or** medium diff with green checks |
| 🟢 **Trusted** | skip it | `validated` **and** small/low-blast-radius diff **and** checks green |

**Inputs (all deterministic):** the validator label · additions+deletions · changed file paths vs a **risk-path set** (hard-coded default now; per-repo config later, §11) · check-run rollup state · `reviewDecision` · `isDraft` · age · lane. Each row also carries a rule-derived **`riskReasons[]`** for the UI (e.g. `"no validator label"`, `"edits .github/workflows"`, `"deletes a test"`, `"diff >500 lines"`) — these are *why* the badge is what it is, generated by the same rules, never by a model.

**Authorship is irrelevant to the badge** (your decision): an external contributor's PR with a `validated` label (our validator followed their repro steps and reproduced them) is 🟢-eligible; the same PR with no label is 🔴 — exactly the "someone opened a PR and it hasn't been adjudicated, look at it" signal you want.

**Sort:** ⛔ and 🔴 first, then 🟡, then 🟢 sinks to the bottom; within a bucket by risk-path weight, then age. Drafts and stale PRs are **shown**, sorted below active work (a visible backlog to prune).

---

## 6. Architecture (serverless, deterministic)

Four small units, all client-side. **No server. No `gh`. No `claude`. No LLM.** The page is a static bundle you open locally (or `file://`), plus the four rule/fetch modules.

1. **Auth** (`auth`) — a one-field "paste your GitHub token" screen; the token is stored in `localStorage` and sent as the `Authorization: Bearer` header on API calls. This is the "log in with my credentials" model, thinnest form — a **fine-scoped PAT** (repo read). No OAuth app, no secret, no server. *(OAuth device-flow is a later nicety, §11/§12.)* *Testable via:* injected fake token; no network in tests.
2. **Collector** (`collector`) — the §2c GraphQL query via `fetch()`, paginated, across all repos. Normalizes to `PrRow[]`. *Depends on:* Auth + GitHub API. *Testable via:* **captured GitHub-API JSON fixtures** (no network).
3. **Classifier** (`rules`) — pure functions: lane (§4) + badge + `riskReasons` (§5) + sort key. This is the "specific rules that detect and render our work" — hard-coded for the current use case, factored so a future settings/watchlist layer swaps the rule inputs without touching the renderer. *Depends on:* nothing (pure). *Testable via:* table-driven unit tests — the highest-value tests in the repo.
4. **Renderer/SPA** (`web`) — renders the sorted feed (badge · title · lane · repo · age · diffstat · draft · PR link), plus P1 filters + inline pane. *Depends on:* Collector + Classifier output. *Testable via:* **golden render** of a fixture feed (a still you open in a browser and diff — pi-agentview's visual-golden pattern).

**The one dependency:** your GitHub token. That's the whole "no new credentials, no AI" story — the page is rules over authenticated API data, and it is honest by construction (nothing is summarized or invented; every cell traces to an API field or a rule).

---

## 7. Data model — `PrRow`

```jsonc
{
  "repo": "chang47/pipkin",
  "number": 12,
  "title": "feat(cues): pair a distinguishable vibration with each earcon",  // the row's one-liner, verbatim
  "url": "https://github.com/chang47/pipkin/pull/12",
  "author": "chang47",                     // shown, but NOT used by the badge
  "createdAt": "2026-08-10T18:53:45Z",
  "isDraft": false,
  // enrichment (Collector, from the GitHub API)
  "additions": 17, "deletions": 4, "changedFiles": 1,
  "files": ["public/app-driver.js"],
  "mergeable": "MERGEABLE",
  "reviewDecision": "",
  "statusChecks": "pending|passing|failing|none",
  "labels": ["validated"],
  "evidenceComment": "…validator's verdict + evidence prose…",   // P1 inline pane
  "autoGate": true,                        // repo opted into unattended drain
  // routing (Classifier — pure rules, no AI)
  "verdict": "validated|validation-failed|validation-uncertain|drain-hold|none",
  "lane": "A_read|B_check",
  "badge": "held|validate|skim|trusted",
  "riskReasons": [],                       // rule-derived, e.g. ["no validator label","edits .github/workflows"]
  "sortKey": "…"
}
```

`verdict` is derived from `labels`. `verdict:"none"` → 🔴 by rule (§5). Nothing here is model-generated.

---

## 8. Data flow

```
[paste GitHub token]  ──►  Auth (localStorage)
        │
        ▼
GitHub GraphQL API  ──►  Collector  ──►  PrRow[] (raw API fields, all repos)
                                   │
                                   ▼
                        Classifier (pure rules) ──► lane + badge + riskReasons + sort
                                   │
                                   ▼
                              Renderer/SPA  ──►  sorted feed
```

One-way read, entirely in the browser. **Refresh = reload the page** — no button, no poll, no LLM, no background job. The only path that ever leaves the browser is the §9 north-star hand-off.

---

## 9. North star — one-click repro (designed, NOT built)

**Goal:** from a row, `checkout PR → drive the changed feature → evidence`, without hand-typing the setup.

**Shape (kept out of the read-only MVP on purpose):** because a static page can't exec local binaries, the repro is a **hand-off out of the dashboard**, not an in-view action — consistent with your point that actions (merge, land, drive) don't belong in the view. Two candidate bridges (decide at build):
- a **`claude-cli://open?cwd=<repo>&q=<repro brief for PR #N>`** deep link the row exposes (opens Claude Code with the brief pre-filled; you press Enter) — simplest, but the link can't live in GitHub-rendered markdown, only in agentdeck's own DOM; or
- a **tiny local companion** (separate opt-in binary, not the dashboard) that the row `POST`s to, which runs `claude -p "<brief>" --allowedTools "Bash,Read,Glob" --permission-mode acceptEdits --output-format stream-json` in a **worktree-isolated** checkout (pi-agentview's `2026-08-10-worktree-isolation`), captures stills/GIF (Bash-invoked screenshotter / Playwright — CC has no built-in screenshot tool `[UNVERIFIED]`), and returns evidence into the row's P1 pane. Once Thread C's evidence-driving variant graduates into `/project` (prototyped against pi-agentview's fake-drive harness, `docs/superpowers/specs/2026-08-10-ai-testable-fake-drive-design.md`), the companion just calls `/project validate <N>`.

**Why designed-only:** it writes/executes (needs the worktree + permission story) and Thread C's drive variant is still being proven. The MVP's job is to be the read-only surface that *earns* this later; nothing about the static page blocks adding a separate companion. **Do not build it now.**

---

## 10. Home, name, and test harness

- **New standalone repo: `agentdeck`.** Agent-agnostic (any PR from any tool, not pi-specific), own install/release; keeping it out of pi-agentview preserves that project's crisp "pi fleet dashboard" scope. It **borrows pi-agentview's patterns** (small bounded units, the **offline-deterministic test story**), not its code.
- **This spec incubates** at `pi-agentview/docs/superpowers/specs/` (beside the sibling Thread specs) until the `agentdeck` repo exists.
- **Test harness (borrowed pattern), and it fits perfectly now that there's no AI:** fully **offline and deterministic** — captured **GitHub-API JSON fixtures** → table-driven unit tests for the Classifier (the real logic) + a **golden render** of the feed. There is nothing non-deterministic to stub: no model, no server, no `gh`, no network in the test path. This is the payoff of the no-AI-in-surface decision — the whole product is testable without a single live call.

---

## 11. Feature backlog (issues to file in the `agentdeck` repo)

1. **Inline content expansion (P1, user-requested).** Side pane / accordion pulling the PR's diff + body + the validator's evidence comment into the view. *(MVP just links out.)*
2. **Filters — lane / badge / repo (P1).** UI toggles over the client-side data.
3. **Saved settings / personal watchlist (P2).** Replace the hard-coded "what counts as our work / which repos / risk paths" with editable, persisted settings — the generic version of the coupling we're accepting now. Unblocks other users / new use cases.
4. **North-star "drive & validate" hand-off (post-MVP).** The §9 bridge — a *separate* local companion or deep link, never embedded in the read-only view.
5. **Issue-list mode (P2).** The §3 "issues-in" half: cross-repo issue feed, blocked-on-PR **dependency awareness**, startable-now ranker; re-surfaces `/project`'s issue queue.
6. **OAuth device-flow login (P2).** Nicer than a pasted PAT if the tool ever leaves your machine.

---

## 12. Open questions (most resolved by your review)

**Resolved:**
- **Trust-the-rest scope** → **read-only forever**; no one-key merge, no auto-land in any tier. Auto-landing, if ever, lives upstream and never appears here.
- **Summariser model/cost** → **N/A**: there is no summariser. The validator is the only intelligence; the page is rules.
- **Authorship filter** → **show all authors.** The validator *label* (not who opened the PR) is the trust axis; no label = your signal.
- **Refresh model** → **reload the page.** No button, no poll, nothing LLM-tied.
- **Drafts** → **show everything**, sorted below active work (a backlog to prune).

**Still open:**
1. **Token model.** A pasted fine-scoped PAT in `localStorage` (recommended, thinnest) vs a proper OAuth device-flow (§11.6). **Recommend: PAT for MVP**, since it's local and single-user — is that acceptable, or do you want the login to *feel* like "Sign in with GitHub" from day one?
2. **Risk-path set + "what counts as our work."** The hard-coded defaults (risk paths: CI/`.github/workflows`, config, auth/secrets, test deletions, guard files; scope: `author:@me` across all your repos). Confirm the starting rules, knowing they become editable settings later (§11.3).
3. **CORS reality check `[UNVERIFIED]`.** The serverless design assumes the GitHub API answers authenticated browser `fetch` for search + PR detail + check-runs. If any needed endpoint refuses CORS, the fallback is a ~30-line local proxy (still no AI) — a small deviation from "zero server," to confirm at build.
4. **Static delivery.** Plain `file://` open, or a trivial `vite preview`/`python -m http.server` for the local page? (No build step required either way for the logic; this is only how you open it.) **Recommend: a one-command local static serve** to avoid `file://` fetch/CORS quirks.

---

## 13. Sources

**Thread C validation engine:** `~/.claude/skills/project/skill.md` (validate 153-186; drain 63-144; labels 75-76, 130-132, 174-177; discrimination proof 182-186) · `~/.claude/skills/heartbeat/config/schedule.yaml:188-201` · live `gh` data (chang47, 8 open PRs; pipkin #12 `validated`).
**GitHub API (browser fetch):** docs.github.com/en/graphql (search over `is:pr is:open author:@me`; PR fields) · docs.github.com/en/rest/pulls, /rest/checks/runs · GitHub API CORS support `[UNVERIFIED — confirm endpoints + rate-limit headers at build]`.
**Claude Code seam (north star only):** headless `claude -p` (`--allowedTools`, `--permission-mode`, `--output-format stream-json`) · `claude-cli://open` URL scheme (pre-fill only; stripped by GitHub markdown) `[UNVERIFIED exact flag surface]` · no browser-reachable localhost surface.
**Graphite / gh-dash / CodeRabbit / GitHub+Copilot / Aviator / Mergify / Greptile / Ellipsis / Sourcery / Sourcegraph / Codegen / Reviewpad:** Graphite graphite.com/features, /guides/github-pr-dashboard, /blog/github-pr-filters, /docs/ai-review-comments · gh-dash `dlvhdr/gh-dash`, gh-dash.dev/configuration/{searching,layout/pr} · CodeRabbit docs.coderabbit.ai/{pr-reviews/walkthroughs,guides/dashboard,guides/reports-overview} · GitHub+Copilot docs.github.com/en/copilot/how-tos/…/create-a-pr-summary, github.blog/changelog/2026-08-07-copilot-code-review-effort-levels-…-ga, github.blog/changelog/2026-07-09-new-pull-requests-dashboard-…-ga · Aviator aviator.co/{inbox,team-reviews,verify} · Mergify mergify.com/product/merge-queue, docs.mergify.com/merge-protections · Greptile greptile.com/docs/{introduction,code-review-bot/best-practices} · Ellipsis ellipsis.dev/docs · Sourcery docs.sourcery.ai/Code-Review/…/Components-of-a-Code-Review · Sourcegraph sourcegraph.com/{docs/cody,batch-changes} · Codegen codegen.com/blog/an-update-on-codegen, clickup.com/blog/clickup-codegen-acquisition (shutdown 2026-04-30) · Reviewpad snyk.io/blog/welcoming-reviewpad-to-snyk (acquired Oct 2023).

**`[UNVERIFIED]` roll-up:** CodeRabbit single PR-level risk badge + dedicated triage product; Graphite PR-*level* risk score + routing signal; GitHub "PR list row has no AI" (strong negative evidence); Mergify org-wide cross-repo PR-list view; Codegen structured per-PR risk (moot — shut down); GitHub-API browser-CORS coverage for the needed endpoints (verify at build); CC deep-link/headless exact flag surface + built-in screenshot tool (none — use Bash/Playwright).
