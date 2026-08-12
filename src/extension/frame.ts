// Pure Agent View frame renderer. Given rows + UI state + a color function, it
// returns the screen as an array of strings — no live TUI, no timers, no I/O.
// AgentViewComponent.render() is a thin adapter over this; tests render frames
// directly from fixtures (see test/visual) to snapshot every screen state.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { groupRows, statusGlyph, formatElapsed, THINKING_LEVELS, type ManagedRow } from "./render.js";
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
  /** Model/thinking picker open on the selected row. */
  pickerOpen?: boolean;
  /** Which picker section is active (drives the cursor + highlight). */
  pickerField?: "thinking" | "model";
  /** Highlighted index into THINKING_LEVELS (thinking section). */
  pickerLevelIdx?: number;
  /** Text being typed into the model field (provider/modelId). */
  pickerModelBuf?: string;
  /** Brief confirmation line after an apply (e.g. "thinking set to high"). */
  pickerFlash?: string;
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

      // The selected row surfaces its current model/thinking (the picker edits
      // these). One muted line; only when the row actually has a value, so rows
      // that inherit the foreground default stay single-line.
      if (sel && !ui.peekOpen && (row.model || row.thinkingLevel)) {
        const tag = [row.model, row.thinkingLevel].filter(Boolean).join(" · ");
        lines.push(color("muted", "  " + truncateToWidth(tag, Math.max(2, width - 2), "…")));
      }

      if (sel && ui.pickerOpen) {
        lines.push(...pickerPanel(row, ui, width, color));
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
      : ui.pickerOpen
        ? ui.pickerField === "model"
          ? " type provider/modelId · Tab thinking · Enter apply · Esc back"
          : " ↑↓ pick thinking · Tab model · Enter apply · Esc close"
      : ui.peekOpen
        ? " type a reply · Enter send · ↑↓ switch · Esc close peek"
        : selAttached
          ? " ⊘ attached in another terminal — can't connect (auto-recovers if it closes) · ↑↓ select · Esc close"
          : " ↑↓ select · / filter · Space peek/reply · Enter resume · n new · d remove · r/m rename/model · Esc close";
  lines.push(color("muted", hint));
  return lines;
}

/** Render the model/thinking picker panel under the selected row. Two sections:
 *  a selectable thinking-level list, and an editable model field (provider/modelId).
 *  Tab (handled in the view) switches the active section; the cursor + highlight
 *  follow `ui.pickerField`. */
function pickerPanel(row: ManagedRow, ui: FrameUi, width: number, color: ColorFn): string[] {
  const field = ui.pickerField ?? "thinking";
  const levelIdx = ui.pickerLevelIdx ?? 0;
  const modelBuf = ui.pickerModelBuf ?? "";
  const out: string[] = [];
  const header = `model/thinking ▸ ${row.model ?? "default"} · ${row.thinkingLevel ?? "—"}`;
  out.push(color("accent", "  " + truncateToWidth(header, Math.max(2, width - 2), "…")));

  out.push(color("muted", "  thinking"));
  for (let i = 0; i < THINKING_LEVELS.length; i++) {
    const lvl = THINKING_LEVELS[i]!;
    const highlighted = field === "thinking" && i === levelIdx;
    const current = lvl === row.thinkingLevel;
    const marker = highlighted ? "▸" : current ? "●" : " ";
    const body = `${marker} ${lvl}${current && !highlighted ? " (current)" : ""}`;
    out.push((highlighted ? color("accent", "  " + body) : color("muted", "  " + body)));
  }

  out.push(color("muted", "  model"));
  const modelMarker = field === "model" ? "▸ " : "  ";
  const modelCur = field === "model" ? `${modelBuf}█` : (modelBuf || row.model || "default");
  out.push(color(field === "model" ? "accent" : "muted", "  " + modelMarker + truncateToWidth(modelCur, Math.max(1, width - 4), "")));

  if (ui.pickerFlash) {
    const ok2 = !ui.pickerFlash.startsWith("✗");
    out.push(color(ok2 ? "success" : "error", "  " + truncateToWidth(ui.pickerFlash, Math.max(2, width - 2), "…")));
  }
  return out;
}
