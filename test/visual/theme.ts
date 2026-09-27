// A deterministic ANSI color mapper for renderFrame's semantic color names.
// ansi-to-svg decodes these SGR codes back into hex fills. Shared by the stills
// and driven-flow harnesses so their palettes can't drift.

import type { ColorFn } from "../../src/extension/frame.js";

const CODE: Record<string, number> = { accent: 96, muted: 90, success: 92, warning: 93, error: 91 };

export const ansiColor: ColorFn = (name, s) => {
  const code = CODE[name];
  return code ? `\x1b[${code}m${s}\x1b[39m` : s;
};
