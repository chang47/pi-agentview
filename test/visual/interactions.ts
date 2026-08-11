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
const attachedRoster: ManagedRow[] = [
  row({ id: "fg:1", title: "this terminal", state: "attached", activity: "active", attached: true }),
  row({ id: "s2", title: "background job", state: "completed", activity: "responded", reply: "done", elapsedMs: 5_000 }),
];
// STATE_ORDER puts attached first, so it's selected initially.
const c = runScenario(attachedRoster, [{ key: KEY.enter, label: "Enter on attached" }, { key: "d", label: "d on attached" }]);
ok("Enter on an attached row does NOT resume", !c.done.some((r) => r?.action === "resume"), JSON.stringify(c.done));
ok("d on an attached row does NOT remove", !c.calls.some((x) => x.fn === "remove"), JSON.stringify(c.calls));

// --- Scenario D: replying to an ATTACHED row is refused, with its own reason --
// Scenario C covers Enter/d on an attached row. Sending it a reply is a separate
// branch: the view picks the error text off the `fg:` prefix, so a background
// broker being down and a session being attached must not read the same.
console.log("[D] reply to an attached row → attach-specific refusal");
const d = runScenario(attachedRoster, [{ key: KEY.space }, { text: "you there?" }, { key: KEY.enter }]);
ok("sendReply was attempted against the attached row", d.calls.some((c) => c.fn === "sendReply" && c.args[0] === "fg:1"), JSON.stringify(d.calls));
ok(
  "peek shows the attach-specific refusal, not the broker-down text",
  lastFrame(d.frames).some((ln) => ln.includes("attached in a terminal")) && !lastFrame(d.frames).some((ln) => ln.includes("no live broker")),
  lastFrame(d.frames).join("\n"),
);
ok("attached refusal shows no 'sent ✓'", !lastFrame(d.frames).some((ln) => ln.includes("sent ✓")), lastFrame(d.frames).join("\n"));

// --- Scenario E: a failed send keeps the draft, and the error is dismissable --
// Losing the text you just typed because delivery failed would be its own bug:
// the reply is unrecoverable and has to be retyped from memory.
console.log("[E] failed send preserves the draft; next keystroke clears the error");
const e = runScenario(
  roster(),
  [{ key: KEY.down }, { key: KEY.space }, { text: "hello?" }, { key: KEY.enter }, { key: "x", label: "type after failure" }],
  { replyOk: false },
);
const eAfterFail = e.frames[4];
ok("failed send keeps the typed draft", eAfterFail.some((ln) => ln.includes("hello?")), eAfterFail.join("\n"));
ok("the next keystroke dismisses the error banner", !lastFrame(e.frames).some((ln) => ln.includes("no live broker")), lastFrame(e.frames).join("\n"));
ok("and that keystroke extends the draft", lastFrame(e.frames).some((ln) => ln.includes("hello?x")), lastFrame(e.frames).join("\n"));

// --- Scenario F: a delivered reply clears the box and flashes 'sent ✓' --------
console.log("[F] delivered reply clears the input");
const f = runScenario(roster(), [{ key: KEY.down }, { key: KEY.space }, { text: "ship it" }, { key: KEY.enter }]);
ok("delivered reply flashes 'sent ✓'", lastFrame(f.frames).some((ln) => ln.includes("sent ✓")), lastFrame(f.frames).join("\n"));
ok("delivered reply clears the input box", !lastFrame(f.frames).some((ln) => ln.includes("reply ▸ ship it")), lastFrame(f.frames).join("\n"));

// --- Scenario G: switching rows mid-peek must not send A's draft to B ---------
// The draft is reset on ↑↓ so a half-typed message can't be delivered to whoever
// happens to be selected when Enter is pressed.
console.log("[G] switching rows mid-peek drops the draft");
const g = runScenario(roster(), [
  { key: KEY.space, label: "peek the working row" },
  { text: "for the first one" },
  { key: KEY.down, label: "↓ switch rows" },
  { key: KEY.enter, label: "Enter on an empty box" },
]);
ok("no reply was sent after switching rows", !g.calls.some((c) => c.fn === "sendReply"), JSON.stringify(g.calls));

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
