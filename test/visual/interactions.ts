// Interaction scenarios: drive the real AgentViewComponent through keystrokes and
// assert what it did + snapshot the filmstrip. Run via jiti:
//   node <jiti> test/visual/interactions.ts            # assert calls + filmstrip golden
//   node <jiti> test/visual/interactions.ts --update    # (re)write the filmstrip golden
//
// This is the template for "help me debug the agentview": to reproduce a reported
// bug, add a scenario (a roster + keystrokes), run it, and inspect the frames +
// the call log. No real broker, no model.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManagedRow } from "../../src/extension/render.js";
import { runScenario, KEY, type Step } from "./harness.js";
import { MARKDOWN_TRANSCRIPT, SAMPLE_TRANSCRIPT } from "./fixtures.js";
import { ansiFramesToAnimatedSvg } from "./ansi-to-svg.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const GOLDEN_DIR = join(__dirname, "__golden__");
const GOLDEN = join(GOLDEN_DIR, "interaction-flow.svg");
const ARTIFACT_DIR = join(__dirname, "__artifacts__");
const update = process.argv.includes("--update");

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

function row(p: Partial<ManagedRow> & Pick<ManagedRow, "id" | "title" | "state">): ManagedRow {
  return { activity: "ready", elapsedMs: undefined, needsInput: false, jsonlPath: `/s/${p.id}.jsonl`, ...p };
}

const roster = (): ManagedRow[] => [
  row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 }),
  row({
    id: "s2",
    title: "fix the flaky uploader test",
    state: "completed",
    activity: "responded",
    reply: "All 42 tests pass now — the retry wrapper was swallowing the timeout.",
    elapsedMs: 302_000,
  }),
  row({ id: "s4", title: "scratch session", state: "idle" }),
];

const lastFrame = (frames: string[][]): string[] => frames[frames.length - 1];

// --- Scenario A: navigate → focus (Space) → reply → send → back → rename → save --
console.log("[A] navigate → Space focus → reply → rename");
const stepsA: Step[] = [
  { key: KEY.down, label: "↓ select completed" },
  { key: KEY.space, label: "Space: open focus pane" },
  { text: "ship it", label: 'type "ship it"' },
  { key: KEY.enter, label: "Enter: send reply" },
  { key: KEY.esc, label: "Esc: back to the list" },
  { key: KEY.down, label: "↓ select idle" },
  { key: "r", label: "r: rename" },
  { text: " (renamed)", label: "edit title" },
  { key: KEY.enter, label: "Enter: save title" },
];
const a = runScenario(roster(), stepsA, { transcripts: { s2: SAMPLE_TRANSCRIPT }, height: 16 });
ok("Space opens the focus pane (peek is gone)", a.frames[2].some((l) => l.includes("Session ▸")), a.frames[2].join("\n"));

ok(
  "reply delivered to the selected (completed) session",
  a.calls.some((c) => c.fn === "sendReply" && c.args[0] === "s2" && c.args[1] === "ship it"),
  JSON.stringify(a.calls),
);
ok(
  "rename saved to the idle session",
  a.calls.some((c) => c.fn === "setTitle" && c.args[0] === "s4" && c.args[1] === "scratch session (renamed)"),
  JSON.stringify(a.calls.filter((c) => c.fn === "setTitle")),
);
ok("no stray resume/remove/close emitted", a.done.length === 0, JSON.stringify(a.done));

// --- Scenario B: the delivery-FAILURE path (unreachable broker) --------------
console.log("[B] reply to an unreachable broker → error state, no false 'sent ✓'");
const b = runScenario(roster(), [{ key: KEY.down }, { key: KEY.space }, { text: "hello?" }, { key: KEY.enter }], {
  replyOk: false,
});
ok("sendReply was still attempted", b.calls.some((c) => c.fn === "sendReply" && c.args[0] === "s2"), JSON.stringify(b.calls));
ok(
  "focus pane shows the delivery-error line (not a false success)",
  lastFrame(b.frames).some((ln) => ln.includes("no live broker")) &&
    !lastFrame(b.frames).some((ln) => ln.includes("sent ✓")),
  lastFrame(b.frames).join("\n"),
);

// --- Scenario C: an attached (foreground) row can't be resumed or removed -----
console.log("[C] attached row: Enter/d are refused");
const attachedRoster: ManagedRow[] = [
  row({ id: "fg:1", title: "this terminal", state: "attached", activity: "active", attached: true }),
  row({ id: "s2", title: "background job", state: "completed", activity: "responded", reply: "done", elapsedMs: 5_000 }),
];
// STATE_ORDER puts attached first, so it's selected initially.
const c = runScenario(attachedRoster, [{ key: KEY.enter, label: "Enter on attached" }, { key: "d", label: "d on attached" }]);
ok("Enter on an attached row does NOT resume", !c.done.some((r) => r?.action === "resume"), JSON.stringify(c.done));
ok("d on an attached row does NOT remove", !c.calls.some((x) => x.fn === "remove"), JSON.stringify(c.calls));

// --- Scenario D: filter narrows the list; state filter; no-match; Esc clears --
console.log("[D] filter narrows the list, then clears");
const filterRoster: ManagedRow[] = [
  row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 }),
  row({ id: "s2", title: "fix the flaky uploader test", state: "completed", activity: "responded", reply: "done", elapsedMs: 5_000 }),
  row({ id: "s3", title: "add retry to the uploader", state: "working", activity: "running", elapsedMs: 12_000 }),
];
const has = (frames: string[][], s: string): boolean => lastFrame(frames).some((l) => l.includes(s));

const d1 = runScenario(filterRoster, [{ key: "/" }, { text: "uploader" }]);
ok(
  "free-text filter shows only matching rows",
  has(d1.frames, "uploader test") && has(d1.frames, "add retry") && !has(d1.frames, "refactor the parser"),
  lastFrame(d1.frames).join("\n"),
);
const d2 = runScenario(filterRoster, [{ key: "/" }, { text: "s:working" }]);
ok(
  "s:working shows only working rows",
  has(d2.frames, "refactor the parser") && has(d2.frames, "add retry") && !has(d2.frames, "uploader test"),
  lastFrame(d2.frames).join("\n"),
);
const d3 = runScenario(filterRoster, [{ key: "/" }, { text: "zzz" }]);
ok("a non-matching filter shows the 'no match' line", has(d3.frames, "No sessions match"), lastFrame(d3.frames).join("\n"));
const d4 = runScenario(filterRoster, [{ key: "/" }, { text: "uploader" }, { key: KEY.esc }]);
ok(
  "Esc clears the filter (all rows return)",
  has(d4.frames, "refactor the parser") && has(d4.frames, "uploader test") && has(d4.frames, "add retry"),
  lastFrame(d4.frames).join("\n"),
);

// --- Scenario F: focus pane — read the whole reply, scroll without switching, reply, go back ---
console.log("[F] → focus: read the conversation, scroll, reply, Esc back to the list");
const fx = { transcripts: { s2: SAMPLE_TRANSCRIPT }, height: 14 };
const text = (frames: string[][]): string => lastFrame(frames).join("\n");
const f1 = runScenario(roster(), [{ key: KEY.down }, { key: KEY.right }], fx);
ok("→ opens the focus pane for the selected session", text(f1.frames).includes("Session ▸") && text(f1.frames).includes("fix the flaky uploader test"), text(f1.frames));
ok("focus pane shows the agent's full latest reply", text(f1.frames).includes("20 runs in a row"), text(f1.frames));
ok("focus pane is sized to the terminal height", lastFrame(f1.frames).length === 13, `lines=${lastFrame(f1.frames).length}`);
const f2 = runScenario(roster(), [{ key: KEY.down }, { key: KEY.right }, { key: KEY.up }, { key: KEY.up }, { key: KEY.up }], fx);
ok("↑ scrolls the conversation up (older lines + 'more below')", text(f2.frames).includes("more lines below") && text(f2.frames).includes("Reproduced it"), text(f2.frames));
const f3 = runScenario(
  roster(),
  [{ key: KEY.down }, { key: KEY.right }, { key: KEY.up }, { key: KEY.up }, { text: "ship it" }, { key: KEY.enter }, { key: KEY.esc }],
  fx,
);
ok("scrolling never switches sessions: the reply goes to the focused one", f3.calls.some((c) => c.fn === "sendReply" && c.args[0] === "s2" && c.args[1] === "ship it"), JSON.stringify(f3.calls));
ok("after Enter the pane shows 'sent ✓'", f3.frames[f3.frames.length - 2].some((l) => l.includes("sent ✓")), f3.frames[f3.frames.length - 2].join("\n"));
ok("Esc returns to Agent View with the same session selected", text(f3.frames).includes("Agent View") && lastFrame(f3.frames).some((l) => l.includes("▸") && l.includes("fix the flaky uploader test")), text(f3.frames));
const f4 = runScenario(roster(), [{ key: KEY.down }, { key: KEY.right }, { text: "half" }, { key: KEY.left }], fx);
ok("← with a half-typed reply stays put (doesn't drop your text)", text(f4.frames).includes("Session ▸") && text(f4.frames).includes("half"), text(f4.frames));
const f5 = runScenario(roster(), [{ key: KEY.down }, { key: KEY.right }, { key: KEY.left }], fx);
ok("← with an empty reply goes back to the list", text(f5.frames).includes("Agent View"), text(f5.frames));
const f6 = runScenario(attachedRoster, [{ key: KEY.right }, { text: "hi" }, { key: KEY.enter }], { transcripts: { "fg:1": SAMPLE_TRANSCRIPT }, height: 14 });
ok("attached session opens read-only (no reply sent)", text(f6.frames).includes("read-only") && !f6.calls.some((c) => c.fn === "sendReply"), JSON.stringify(f6.calls));
const f7 = runScenario(roster(), [{ key: KEY.right }], { height: 14 });
ok("a session with no messages yet says so", text(f7.frames).includes("No messages yet"), text(f7.frames));
const f8 = runScenario(roster(), [{ key: KEY.down }, { key: KEY.right }], { transcripts: { s2: MARKDOWN_TRANSCRIPT }, height: 30 });
const f8t = text(f8.frames);
ok(
  "agent markdown is rendered, not shown raw (no ## / ** / table pipes; table is box-drawn)",
  f8t.includes("Root cause") && !f8t.includes("## Root") && !f8t.includes("**every**") && !f8t.includes("| --- |") && f8t.includes("│ before │"),
  f8t,
);
const awaitRoster: ManagedRow[] = [
  row({ id: "s3", title: "migrate the config loader", state: "awaiting_input", activity: "Allow running `rm -rf dist`?" }),
];
const f9 = runScenario(awaitRoster, [{ key: KEY.right }], { height: 14 });
ok("awaiting-input session shows the pending question in the focus pane", text(f9.frames).includes("waiting: Allow running"), text(f9.frames));

// --- filmstrip golden (scenario A) -------------------------------------------
const svg = ansiFramesToAnimatedSvg(a.frames, { title: "Agent View — interaction flow", msPerFrame: 1300 });
await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(join(ARTIFACT_DIR, "interaction-flow.svg"), svg);

if (update) {
  await mkdir(GOLDEN_DIR, { recursive: true });
  await writeFile(GOLDEN, svg);
  console.log(`  ↻ interaction-flow golden (${a.frames.length} frames)`);
} else {
  let golden: string | undefined;
  try {
    golden = await readFile(GOLDEN, "utf8");
  } catch {
    golden = undefined;
  }
  ok(
    "interaction-flow filmstrip matches golden",
    golden !== undefined && golden.replace(/\r\n/g, "\n") === svg,
    "run npm run test:visual:update",
  );
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
