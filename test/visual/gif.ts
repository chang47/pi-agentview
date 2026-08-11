// Animated-GIF evidence: drive the REAL AgentViewComponent typing a filter and
// encode the frame-by-frame process as a GIF you can WATCH in the PR (GitHub
// renders GIFs inline; it won't animate our SVGs). Each frame -> SVG -> resvg
// pixels -> gifenc. Run via jiti:  npm run test:gif
// Writes test/visual/__evidence__/filter-flow.gif.

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManagedRow } from "../../src/extension/render.js";
import { runScenario, type Step } from "./harness.js";
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

// One key per step => one frame per keystroke, so you watch it type + narrow.
const steps: Step[] = [{ key: "/" }, ...[..."refactor"].map((c): Step => ({ key: c }))];
const { frames } = runScenario(roster, steps);

// Fixed grid so every GIF frame is identical pixel size (list shrinks in place).
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
  // Hold the opening list + the final filtered result longer than the keystrokes.
  const delay = i === 0 ? 900 : i === frames.length - 1 ? 2200 : 360;
  gif.writeFrame(index, rendered.width, rendered.height, { palette, delay });
});
gif.finish();

await mkdir(OUT_DIR, { recursive: true });
const bytes = gif.bytes();
await writeFile(join(OUT_DIR, "filter-flow.gif"), bytes);
console.log(`✓ filter-flow.gif (${bytes.length} bytes, ${frames.length} frames, ${cols}x${rows} cells)`);
