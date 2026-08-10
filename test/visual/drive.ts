// Driven flow: a looping animated SVG "video" of a fake-driven session, from a
// fresh idle row through working -> tool -> completed, then the keystroke-driven
// peek / reply / rename states. Run via jiti:
//   node <jiti> test/visual/drive.ts            # assert current == golden
//   node <jiti> test/visual/drive.ts --update   # (re)write golden
//
// It drives the REAL state machine (deriveState) and the REAL renderer
// (renderFrame) with the exact RPC event sequence the fake pi emits — so the
// artifact is a faithful picture of the live pipeline, minus only the pty host.
// Deterministic (no clocks reach the frame), so the golden is byte-stable.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveState, initialState } from "../../src/broker/state.js";
import { renderFrame, type FrameUi } from "../../src/extension/frame.js";
import type { ManagedRow } from "../../src/extension/render.js";
import type { BrokerState } from "../../src/types.js";
import type { RpcMessage } from "../../src/broker/rpc-client.js";
import { ansiFramesToAnimatedSvg } from "./ansi-to-svg.js";
import { ansiColor } from "./theme.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const GOLDEN_DIR = join(__dirname, "__golden__");
const GOLDEN = join(GOLDEN_DIR, "driven-flow.svg");
const ARTIFACT_DIR = join(__dirname, "__artifacts__");
const update = process.argv.includes("--update");

const WIDTH = 76;
const TITLE = "refactor the parser";
// Fixed elapsed per state so frames are byte-stable (deriveState stamps real
// clocks into BrokerState; we never surface those in the display row).
const ELAPSED: Record<string, number | undefined> = { working: 3_000, awaiting_input: 9_000, completed: 48_000 };

function rowFor(state: BrokerState): ManagedRow {
  return {
    id: "s1",
    title: TITLE,
    state: state.state,
    activity: state.activity,
    reply: state.finalResponse,
    elapsedMs: ELAPSED[state.state],
    needsInput: state.state === "awaiting_input",
    jsonlPath: "/sessions/s1/s.jsonl",
  };
}

function frame(state: BrokerState, ui: Partial<FrameUi>): string[] {
  const full: FrameUi = {
    selectedId: "s1",
    peekOpen: false,
    replyBuf: "",
    justSent: false,
    sendError: undefined,
    renameMode: false,
    renameBuf: "",
    ...ui,
  };
  return renderFrame([rowFor(state)], WIDTH, full, ansiColor);
}

// The exact events the fake pi emits on a prompt (scenario "ok", with a tool step).
const events: RpcMessage[] = [
  { type: "agent_start" },
  { type: "tool_execution_start", toolName: "edit" },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Done — split the tokenizer out; all 42 tests pass." }] },
  },
  { type: "agent_settled" },
];

const frames: string[][] = [];
let state = initialState("s1");
let seq = 0;
frames.push(frame(state, {})); // idle — freshly created
for (const ev of events) {
  state = deriveState(state, ev, ++seq) ?? state; // working -> tool -> responded -> completed
  frames.push(frame(state, {}));
}
// Keystroke-driven UI states on the completed row.
frames.push(frame(state, { peekOpen: true })); //           Space: peek panel opens
frames.push(frame(state, { peekOpen: true, replyBuf: "ship it" })); // type a follow-up
frames.push(frame(state, { peekOpen: true, justSent: true })); //     Enter: sent ✓
frames.push(frame(state, { renameMode: true, renameBuf: "parser split" })); // r: rename

const svg = ansiFramesToAnimatedSvg(frames, { title: "Agent View — fake-driven flow", msPerFrame: 1100 });

await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(join(ARTIFACT_DIR, "driven-flow.svg"), svg);

if (update) {
  await mkdir(GOLDEN_DIR, { recursive: true });
  await writeFile(GOLDEN, svg);
  console.log(`driven-flow: ↻ wrote golden (${frames.length} frames)`);
  process.exit(0);
}

let golden: string | undefined;
try {
  golden = await readFile(GOLDEN, "utf8");
} catch {
  golden = undefined;
}
if (golden === undefined) {
  console.log("driven-flow: ✗ no golden (run: npm run test:visual:update)");
  process.exit(1);
}
const okFlow = golden.replace(/\r\n/g, "\n") === svg; // CRLF-tolerant (see stills.ts)
console.log(
  `driven-flow: ${okFlow ? "✅ matches golden" : "❌ differs (see __artifacts__/driven-flow.svg)"} — ${frames.length} frames`,
);
process.exit(okFlow ? 0 : 1);
