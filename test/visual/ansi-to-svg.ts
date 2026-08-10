// Turn an array of ANSI-colored terminal lines into a terminal-style SVG "still".
// Pure string -> string; no native deps, deterministic (the golden is the SVG
// source, not a pixel render). Each same-color run becomes one <text> positioned
// at its starting column * charWidth, so a monospace font keeps the grid aligned.

const SGR_RE = /\x1b\[([0-9;]*)m/g;

// SGR code -> hex, for a dark terminal theme. Covers default(39)/reset(0) plus the
// normal (3x) and bright (9x) foregrounds the frame color fn emits.
const FG: Record<number, string> = {
  0: "#c9d1d9",
  39: "#c9d1d9",
  30: "#6e7681",
  90: "#6e7681", // muted
  31: "#ff7b72",
  91: "#ff7b72", // error
  32: "#3fb950",
  92: "#3fb950", // success
  33: "#d29922",
  93: "#d29922", // warning
  36: "#56d4dd",
  96: "#56d4dd", // accent
  37: "#c9d1d9",
  97: "#ffffff",
};

const DEFAULT_FG = "#c9d1d9";

interface Seg {
  col: number; // starting column (visible chars before it)
  text: string;
  color: string;
}

/** Split one line into colored segments, tracking the visible column offset. */
function segments(line: string): Seg[] {
  const segs: Seg[] = [];
  let color = DEFAULT_FG;
  let col = 0;
  let last = 0;
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (!text) return;
    segs.push({ col, text, color });
    col += [...text].length;
  };
  while ((m = SGR_RE.exec(line))) {
    push(line.slice(last, m.index));
    last = SGR_RE.lastIndex;
    for (const part of m[1].split(";")) {
      const code = Number(part || "0");
      if (code === 0 || code === 39) color = DEFAULT_FG;
      else if (FG[code]) color = FG[code];
    }
  }
  push(line.slice(last));
  return segs;
}

function visibleLen(line: string): number {
  return [...line.replace(SGR_RE, "")].length;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SvgOpts {
  charW?: number;
  lineH?: number;
  fontSize?: number;
  pad?: number;
  bg?: string;
  title?: string;
}

const FONT = "'Cascadia Mono','Consolas','DejaVu Sans Mono','Menlo',monospace";

/** Build the inner <text> elements for one frame, plus its visible column count. */
function linesToInner(lines: string[], charW: number, lineH: number, pad: number): { inner: string; cols: number } {
  const body: string[] = [];
  lines.forEach((line, row) => {
    const y = (pad + (row + 0.78) * lineH).toFixed(1);
    for (const seg of segments(line)) {
      const x = (pad + seg.col * charW).toFixed(1);
      body.push(`<text x="${x}" y="${y}" fill="${seg.color}">${xmlEscape(seg.text)}</text>`);
    }
  });
  return { inner: body.join("\n"), cols: Math.max(1, ...lines.map(visibleLen)) };
}

export function ansiLinesToSvg(lines: string[], opts: SvgOpts = {}): string {
  const charW = opts.charW ?? 8.4;
  const lineH = opts.lineH ?? 20;
  const fontSize = opts.fontSize ?? 14;
  const pad = opts.pad ?? 14;
  const bg = opts.bg ?? "#0d1117";
  const { inner, cols } = linesToInner(lines, charW, lineH, pad);
  const width = Math.ceil(cols * charW + pad * 2);
  const height = Math.ceil(lines.length * lineH + pad * 2);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${fontSize}" xml:space="preserve">`,
    opts.title ? `<title>${xmlEscape(opts.title)}</title>` : "",
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    `<g dominant-baseline="alphabetic">`,
    inner,
    `</g>`,
    `</svg>`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Compose frames into one looping animated SVG. Each frame is shown discretely
 *  for its 1/N slice of the cycle (no fade), so it reads like a terminal GIF.
 *  Deterministic: no clocks — timing is purely a function of frame count. */
export function ansiFramesToAnimatedSvg(frames: string[][], opts: SvgOpts & { msPerFrame?: number } = {}): string {
  const charW = opts.charW ?? 8.4;
  const lineH = opts.lineH ?? 20;
  const fontSize = opts.fontSize ?? 14;
  const pad = opts.pad ?? 14;
  const bg = opts.bg ?? "#0d1117";
  const spf = (opts.msPerFrame ?? 1100) / 1000;
  const F = Math.max(1, frames.length);
  const dur = (F * spf).toFixed(2);
  const cols = Math.max(1, ...frames.flatMap((f) => f.map(visibleLen)));
  const maxRows = Math.max(1, ...frames.map((f) => f.length));
  const width = Math.ceil(cols * charW + pad * 2);
  const height = Math.ceil(maxRows * lineH + pad * 2);

  const groups = frames.map((f, i) => {
    const { inner } = linesToInner(f, charW, lineH, pad);
    const keyTimes = `0;${(i / F).toFixed(4)};${((i + 1) / F).toFixed(4)}`;
    return (
      `<g opacity="0">` +
      `<animate attributeName="opacity" calcMode="discrete" repeatCount="indefinite" dur="${dur}s" keyTimes="${keyTimes}" values="0;1;0"/>\n` +
      inner +
      `\n</g>`
    );
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${fontSize}" xml:space="preserve">`,
    opts.title ? `<title>${xmlEscape(opts.title)}</title>` : "",
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    `<g dominant-baseline="alphabetic">`,
    ...groups,
    `</g>`,
    `</svg>`,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
