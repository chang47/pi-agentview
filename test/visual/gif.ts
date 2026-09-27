// Animated-GIF evidence: drive the REAL AgentViewComponent typing a filter and
// encode the frame-by-frame process as a GIF you can WATCH in the PR (GitHub
// renders GIFs inline; it won't animate our SVGs). Each frame -> SVG -> resvg
// pixels -> gifenc. Run via jiti:  npm run test:gif
// Writes test/visual/__evidence__/filter-flow.gif and focus-flow.gif.

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManagedRow } from "../../src/extension/render.js";
import { runScenario, KEY, type Step } from "./harness.js";
import { SAMPLE_TRANSCRIPT } from "./fixtures.js";
import { ansiLinesToSvg } from "./ansi-to-svg.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(__dirname, "__evidence__");

function row(p: Partial<ManagedRow> & Pick<ManagedRow, "id" | "title" | "state">): ManagedRow {
  return { activity: "ready", elapsedMs: undefined, needsInput: false, jsonlPath: `/s/${p.id}.jsonl`, ...p };
}

const roster: ManagedRow[] = [
  row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 }),
  row({ id: "s2", title: "add retry to the uploader", state: "working", activity: "running", elapsedMs: 12_000 }),
  row({ id: "s3", title: "run the migration script", state: "completed", activity: "responded", reply: "done", elapsedMs: 300_000 }),
  row({ id: "s4", title: "scratch session", state: "idle" }),
];

/** Encode a filmstrip as a GIF on a fixed grid (every frame the same pixel size). */
async function writeGif(name: string, frames: string[][], hold: { first: number; last: number; step: number }): Promise<void> {
  const strip = (l: string): number => l.replace(/\x1b\[[0-9;]*m/g, "").length;
  const cols = Math.max(1, ...frames.flatMap((f) => f.map(strip)));
  const rows = Math.max(1, ...frames.map((f) => f.length));
  const gif = GIFEncoder();
  frames.forEach((frame, i) => {
    const svg = ansiLinesToSvg(frame, { cols, rows });
    const rendered = new Resvg(svg).render();
    const rgba = new Uint8Array(rendered.pixels);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    const delay = i === 0 ? hold.first : i === frames.length - 1 ? hold.last : hold.step;
    gif.writeFrame(index, rendered.width, rendered.height, { palette, delay });
  });
  gif.finish();
  await mkdir(OUT_DIR, { recursive: true });
  const bytes = gif.bytes();
  await writeFile(join(OUT_DIR, name), bytes);
  console.log(`✓ ${name} (${bytes.length} bytes, ${frames.length} frames, ${cols}x${rows} cells)`);
}

// Filter flow: one key per step => one frame per keystroke, so you watch it type + narrow.
const filterSteps: Step[] = [{ key: "/" }, ...[..."refactor"].map((c): Step => ({ key: c }))];
await writeGif("filter-flow.gif", runScenario(roster, filterSteps).frames, { first: 900, last: 2200, step: 360 });

// Focus flow: → into a session, scroll its conversation, reply, Esc back to the list.
const focusSteps: Step[] = [
  { key: KEY.down }, // select "add retry to the uploader"
  { key: KEY.right },
  { key: KEY.up },
  { key: KEY.up },
  { key: KEY.up },
  { key: KEY.down },
  { key: KEY.down },
  { key: KEY.down },
  ...[..."ship it"].map((c): Step => ({ key: c })),
  { key: KEY.enter },
  { key: KEY.esc },
];
const focus = runScenario(roster, focusSteps, { transcripts: { s2: SAMPLE_TRANSCRIPT }, height: 16 });
await writeGif("focus-flow.gif", focus.frames, { first: 900, last: 2200, step: 500 });
