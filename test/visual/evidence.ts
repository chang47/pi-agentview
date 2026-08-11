// PR evidence: render committed golden STILLS to PNG so the proof is VISIBLE in
// the PR (GitHub renders PNG inline; it doesn't render our SVG goldens inline).
// SVG -> PNG via resvg-js — no browser, cross-platform, deterministic.
//
//   npm run test:evidence -- <fixtureName> [<fixtureName> …]
//
// Writes test/visual/__evidence__/<name>.png (commit these — "in the repo") and
// prints the markdown to paste into the PR body (replace <BRANCH> with your branch,
// so the raw URL resolves and the image renders inline).
//
// STILLS ONLY. Do NOT point this at driven-flow / interaction-flow — those are
// animated SVGs (all frames overlaid), so a static PNG of them is unreadable.

import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const GOLDEN_DIR = join(__dirname, "__golden__");
const OUT_DIR = join(__dirname, "__evidence__");
const REPO = "chang47/pi-agentview";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (names.length === 0) {
  console.error("usage: test:evidence -- <fixtureName> [more…]   (golden name, no .svg; stills only)");
  process.exit(2);
}

await mkdir(OUT_DIR, { recursive: true });
const embeds: string[] = [];
for (const name of names) {
  const svg = await readFile(join(GOLDEN_DIR, `${name}.svg`), "utf8");
  const png = new Resvg(svg).render().asPng();
  await writeFile(join(OUT_DIR, `${name}.png`), png);
  console.log(`  ✓ ${name}.png (${png.length} bytes)`);
  embeds.push(`![${name}](https://raw.githubusercontent.com/${REPO}/<BRANCH>/test/visual/__evidence__/${name}.png)`);
}

console.log("\nCommit the PNG(s), then paste into the PR body (replace <BRANCH> with your branch):\n");
console.log(embeds.join("\n"));
