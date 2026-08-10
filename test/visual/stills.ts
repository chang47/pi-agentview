// Stills: render every Agent View fixture to a terminal-style SVG and compare it
// against a committed golden. Run via jiti:
//   node <jiti> test/visual/stills.ts            # assert current == golden
//   node <jiti> test/visual/stills.ts --update   # (re)write goldens
//
// Determinism comes from the fake color fn + literal fixture data; the golden is
// the SVG SOURCE, so there is no font/pixel flakiness. Always also writes the
// current SVGs to __artifacts__/ for eyeballing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderFrame } from "../../src/extension/frame.js";
import { ansiLinesToSvg } from "./ansi-to-svg.js";
import { ansiColor } from "./theme.js";
import { FIXTURES } from "./fixtures.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const GOLDEN_DIR = join(__dirname, "__golden__");
const ARTIFACT_DIR = join(__dirname, "__artifacts__");
const update = process.argv.includes("--update");

let pass = 0;
let fail = 0;

await mkdir(ARTIFACT_DIR, { recursive: true });
if (update) await mkdir(GOLDEN_DIR, { recursive: true });

console.log(`stills — ${FIXTURES.length} fixtures${update ? " (updating goldens)" : ""}`);

for (const fx of FIXTURES) {
  const lines = renderFrame(fx.rows, fx.width, fx.ui, ansiColor);
  const svg = ansiLinesToSvg(lines, { title: `Agent View — ${fx.name}` });
  const goldenPath = join(GOLDEN_DIR, `${fx.name}.svg`);
  const artifactPath = join(ARTIFACT_DIR, `${fx.name}.svg`);
  await writeFile(artifactPath, svg);

  if (update) {
    await writeFile(goldenPath, svg);
    console.log(`  ↻ ${fx.name}`);
    pass++;
    continue;
  }

  let golden: string | undefined;
  try {
    golden = await readFile(goldenPath, "utf8");
  } catch {
    golden = undefined;
  }
  if (golden === undefined) {
    console.log(`  ✗ ${fx.name} — no golden (run: npm run test:visual:update)`);
    fail++;
  } else if (golden.replace(/\r\n/g, "\n") === svg) {
    // Normalize CRLF: git may check the golden out with CRLF on Windows, but the
    // generator always emits LF — compare semantically, not byte-for-byte.
    console.log(`  ✓ ${fx.name}`);
    pass++;
  } else {
    console.log(`  ✗ ${fx.name} — differs from golden (see __artifacts__/${fx.name}.svg)`);
    fail++;
  }
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
