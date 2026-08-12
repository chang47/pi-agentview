// Animated-GIF evidence: drive the REAL AgentViewComponent through a scripted
// interaction and encode the frame-by-frame process as a GIF you can WATCH in
// the PR (GitHub renders GIFs inline; it won't animate our SVGs). Each frame ->
// SVG -> resvg pixels -> gifenc. Run via jiti:  npm run test:gif
// Writes test/visual/__evidence__/{filter-flow,abort-flow}.gif.

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManagedRow } from "../../src/extension/render.js";
import { runScenario, KEY, type Step } from "./harness.js";
import { ansiLinesToSvg } from "./ansi-to-svg.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(__dirname, "__evidence__");

function row(p: Partial<ManagedRow> & Pick<ManagedRow, "id" | "title" | "state">): ManagedRow {
  return { activity: "ready", elapsedMs: undefined, needsInput: false, jsonlPath: `/s/${p.id}.jsonl`, ...p };
}

/** Encode ANSI frames into an animated GIF. Frames are padded onto a fixed grid
 *  so every frame is identical pixel size (lists shrink/grow in place). The
 *  first + last frames hold longer so the opening + final states read clearly. */
function encodeGif(frames: string[][]): Uint8Array {
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
    const delay = i === 0 ? 900 : i === frames.length - 1 ? 2200 : 360;
    gif.writeFrame(index, rendered.width, rendered.height, { palette, delay });
  });
  gif.finish();
  return gif.bytes();
}

async function writeGif(name: string, roster: ManagedRow[], steps: Step[]): Promise<void> {
  const { frames } = runScenario(roster, steps);
  const bytes = encodeGif(frames);
  await writeFile(join(OUT_DIR, `${name}.gif`), bytes);
  console.log(`✓ ${name}.gif (${bytes.length} bytes, ${frames.length} frames)`);
}

// --- filter flow: type a query, watch the list narrow ------------------------
const filterRoster: ManagedRow[] = [
  row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 }),
  row({ id: "s2", title: "add retry to the uploader", state: "working", activity: "running", elapsedMs: 12_000 }),
  row({ id: "s3", title: "run the migration script", state: "completed", activity: "responded", reply: "done", elapsedMs: 300_000 }),
  row({ id: "s4", title: "scratch session", state: "idle" }),
];
// One key per step => one frame per keystroke, so you watch it type + narrow.
const filterSteps: Step[] = [{ key: "/" }, ...[..."refactor"].map((c): Step => ({ key: c }))];

// --- abort flow: stop a runaway working row; refused on a completed row ------
const abortRoster: ManagedRow[] = [
  row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 }),
  row({ id: "s2", title: "run the migration script", state: "completed", activity: "responded", reply: "done", elapsedMs: 300_000 }),
];
const abortSteps: Step[] = [
  { key: "a" }, // abort the selected working row -> ✓ flash
  { key: KEY.down }, // move to the completed row (flash clears on the keystroke)
  { key: "a" }, // refused on a non-working row -> ✗ flash
];

await mkdir(OUT_DIR, { recursive: true });
await writeGif("filter-flow", filterRoster, filterSteps);
await writeGif("abort-flow", abortRoster, abortSteps);
