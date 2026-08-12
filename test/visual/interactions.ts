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

// --- Scenario A: navigate → peek → reply → send → rename → save --------------
console.log("[A] navigate → peek → reply → rename");
const stepsA: Step[] = [
  { key: KEY.down, label: "↓ select completed" },
  { key: KEY.space, label: "Space: peek" },
  { text: "ship it", label: 'type "ship it"' },
  { key: KEY.enter, label: "Enter: send reply" },
  { key: KEY.esc, label: "Esc: close peek" },
  { key: KEY.down, label: "↓ select idle" },
  { key: "r", label: "r: rename" },
  { text: " (renamed)", label: "edit title" },
  { key: KEY.enter, label: "Enter: save title" },
];
const a = runScenario(roster(), stepsA);

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
  "peek shows the delivery-error line (not a false success)",
  lastFrame(b.frames).some((ln) => ln.includes("no live broker")) &&
    !lastFrame(b.frames).some((ln) => ln.includes("sent ✓")),
  lastFrame(b.frames).join("\n"),
);

// --- Scenario C: an attached (foreground) row can't be resumed or removed -----
console.log("[C] attached row: Enter/d are refused");
// A factory, not a shared array: MockManager.setTitle mutates the rows it is given,
// so each scenario needs its own copy to stay order-independent.
const attachedRoster = (): ManagedRow[] => [
  row({ id: "fg:1", title: "this terminal", state: "attached", activity: "active", attached: true }),
  row({ id: "s2", title: "background job", state: "completed", activity: "responded", reply: "done", elapsedMs: 5_000 }),
];
// STATE_ORDER puts attached first, so it's selected initially.
const c = runScenario(attachedRoster(), [{ key: KEY.enter, label: "Enter on attached" }, { key: "d", label: "d on attached" }]);
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

// --- Scenario E: rename WHILE ATTACHED goes to pi, not to the broker manager --
// The attached row is the session you're sitting in; it has no broker to write a
// title to (BrokerManager.setTitle early-returns for "fg:" ids), so the rename has
// to leave through the foreground hook (pi.setSessionName in src/index.ts). A
// regression that routed it to mgr.setTitle would look fine on screen and silently
// drop the rename.
console.log("[E] rename an attached row → foreground hook, not mgr.setTitle");
const e = runScenario(attachedRoster(), [
  { key: "r", label: "r: rename attached" },
  { text: " here", label: "edit title" },
  { key: KEY.enter, label: "Enter: save title" },
]);
ok(
  "attached rename leaves via the foreground hook",
  e.renamedForeground.length === 1 && e.renamedForeground[0] === "this terminal here",
  JSON.stringify(e.renamedForeground),
);
ok(
  "attached rename does NOT go to mgr.setTitle (it would be dropped)",
  !e.calls.some((c) => c.fn === "setTitle"),
  JSON.stringify(e.calls),
);
// Esc must abort cleanly: no rename escapes anywhere.
const e2 = runScenario(attachedRoster(), [{ key: "r" }, { text: " here" }, { key: KEY.esc }]);
ok(
  "Esc cancels the rename — nothing is renamed",
  e2.renamedForeground.length === 0 && !e2.calls.some((c) => c.fn === "setTitle"),
  JSON.stringify({ fg: e2.renamedForeground, calls: e2.calls }),
);

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
