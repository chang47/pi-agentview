// A deterministic ANSI color mapper for renderFrame's semantic color names.
// ansi-to-svg decodes these SGR codes back into hex fills. Shared by the stills
// and driven-flow harnesses so their palettes can't drift.

import type { ColorFn } from "../../src/extension/frame.js";
import { markdownTheme } from "../../src/extension/focus.js";

const CODE: Record<string, number> = {
  accent: 96,
  muted: 90,
  success: 92,
  warning: 93,
  error: 91,
  // pi's markdown color names (the focus pane renders agent replies as markdown)
  mdHeading: 93,
  mdLink: 96,
  mdLinkUrl: 90,
  mdCode: 96,
  mdCodeBlock: 92,
  mdCodeBlockBorder: 90,
  mdQuote: 90,
  mdQuoteBorder: 90,
  mdHr: 90,
  mdListBullet: 96,
};

export const ansiColor: ColorFn = (name, s) => {
  const code = CODE[name];
  return code ? `\x1b[${code}m${s}\x1b[39m` : s;
};

/** The focus pane's markdown theme in the same deterministic palette. */
export const ansiMarkdown = markdownTheme(ansiColor);
