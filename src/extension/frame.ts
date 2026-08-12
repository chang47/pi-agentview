// Pure Agent View frame renderer. Given rows + UI state + a color function, it
// returns the screen as an array of strings — no live TUI, no timers, no I/O.
// AgentViewComponent.render() is a thin adapter over this; tests render frames
// directly from fixtures (see test/visual) to snapshot every screen state.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { groupRows, statusGlyph, formatElapsed, type ManagedRow } from "./render.js";
import type { ManagedId } from "../types.js";

/** UI-local state the frame needs that isn't part of a row. */
export interface FrameUi {
  selectedId?: ManagedId;
  peekOpen: boolean;
  replyBuf: string;
  justSent: boolean;
  sendError?: string;
  renameMode: boolean;
  renameBuf: string;
  /** True while typing a filter (renders a cursor). */
  filterMode?: boolean;
  /** The active filter query (rows are pre-filtered by the caller; this only
   *  drives the filter line + the "no matches" message). */
  filterQuery?: string;
}

/** Wraps `s` in a theme color by semantic name (accent/muted/success/…). The
 *  live component passes the pi Theme; tests pass an ANSI or identity mapper. */
export type ColorFn = (name: string, s: string) => string;

function stateColorName(row: ManagedRow): string {
  switch (row.state) {
    case "working":
      return "accent";
    case "completed":
      return "success";
    case "awaiting_input":
    case "interrupted":
      return "warning";
    case "needs_attention":
      return "error";
    case "attached":
      return "accent";
    default:
      return "muted";
  }
}

function previewOf(row: ManagedRow): string {
  if (row.attached) return "active in another terminal";
  if ((row.state === "completed" || row.state === "awaiting_input") && row.reply) {
    return row.reply.replace(/\s+/g, " ").trim();
  }
  return row.activity;
}

/** Render the Agent View screen. Byte-identical to the pre-extraction inline
 *  render(); the only inputs are rows, width, ui state, and the color mapper. */
export function renderFrame(rows: ManagedRow[], width: number, ui: FrameUi, color: ColorFn): string[] {
  const rule = (w: number): string => color("muted", "─".repeat(Math.max(0, w)));
  const lines: string[] = [];
  const groups = groupRows(rows);

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const summary = Object.entries(counts)
    .map(([s, n]) => `${s}=${n}`)
    .join("  ");

  lines.push(color("accent", "Agent View") + (summary ? color("muted", `   ${summary}`) : ""));
  lines.push(rule(width));

  const filtering = ui.filterMode || (ui.filterQuery !== undefined && ui.filterQuery.length > 0);
  if (filtering) {
    const cursor = ui.filterMode ? "█" : "";
    lines.push(color("accent", "  filter ▸ ") + truncateToWidth((ui.filterQuery ?? "") + cursor, Math.max(1, width - 11), ""));
  }

  if (groups.length === 0) {
    lines.push(
      color(
        "muted",
        ui.filterQuery
          ? `  No sessions match "${ui.filterQuery}". Esc clears the filter.`
          : "  No background sessions. Press n to create one, Esc to close.",
      ),
    );
  }

  for (const g of groups) {
    lines.push(color("accent", ` ${g.label} (${g.rows.length})`));
    for (const row of g.rows) {
      const sel = row.id === ui.selectedId;
      const marker = sel ? color("accent", "▸ ") : "  ";
      const glyph = color(stateColorName(row), statusGlyph(row.state));
      const elapsed = row.elapsedMs !== undefined ? color("muted", ` ${formatElapsed(row.elapsedMs)}`) : "";
      const title = truncateToWidth(row.title, Math.max(1, width - 8 - (row.elapsedMs !== undefined ? 6 : 0)), "…");
      const used = 4 + title.length + elapsed.length;
      const previewTxt = color("muted", truncateToWidth(` — ${previewOf(row)}`, Math.max(0, width - used), ""));
      lines.push(`${marker}${glyph} ${title}${previewTxt}${elapsed}`);

      if (sel && ui.peekOpen) {
        const body = row.state === "awaiting_input" ? row.activity : row.reply ?? row.activity;
        if (body) {
          for (const ln of body.split("\n").slice(0, 10)) {
            lines.push(color("muted", "  " + truncateToWidth(ln, Math.max(2, width - 2), "…")));
          }
        }
        // Reply input line.
        const promptLabel = color("accent", "  reply ▸ ");
        const buf = truncateToWidth(ui.replyBuf + "█", Math.max(1, width - 11), "");
        if (ui.justSent) lines.push(color("success", "  sent ✓"));
        else lines.push(promptLabel + buf);
        if (ui.sendError) lines.push(color("error", "  ✗ " + truncateToWidth(ui.sendError, Math.max(2, width - 4), "…")));
      }
    }
  }

  if (ui.renameMode) {
    lines.push(color("accent", "  rename ▸ ") + truncateToWidth(ui.renameBuf + "█", Math.max(1, width - 11), ""));
  }
  lines.push(rule(width));
  const selAttached = rows.some((r) => r.id === ui.selectedId && r.attached);
  const hint = ui.filterMode
    ? " type to filter · s:working / s:blocked · Enter apply · Esc clear"
    : ui.renameMode
      ? " type new title · Enter save · Esc cancel"
      : ui.peekOpen
        ? " type a reply · Enter send · ↑↓ switch · Esc close peek"
        : selAttached
          ? " ⊘ attached in another terminal — can't connect (auto-recovers if it closes) · ↑↓ select · Esc close"
          : " ↑↓ select · / filter · Space peek/reply · Enter resume · n new · d remove · r rename · Esc close";
  lines.push(color("muted", hint));
  return lines;
}
