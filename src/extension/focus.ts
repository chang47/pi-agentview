// Pure renderer for the session FOCUS pane: one session's conversation at full height, scrollable,
// with a reply line at the bottom. Opened from Agent View with → on a row; Esc/← returns to the
// list with the same row selected. Like frame.ts: rows + ui state + a color fn in, lines out — no
// TUI, no I/O — so tests snapshot it directly.

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed, statusGlyph, type ManagedRow } from "./render.js";
import type { TranscriptItem } from "./transcript.js";
import type { ColorFn } from "./frame.js";

export interface FocusUi {
  /** Lines scrolled up from the bottom. 0 = following the newest message. */
  scrollFromBottom: number;
  replyBuf: string;
  justSent: boolean;
  sendError?: string;
  /** Attached rows are read-only: you're typing in that session elsewhere. */
  readOnly: boolean;
  /** The transcript hasn't loaded yet (first open). */
  loading: boolean;
}

/** The transcript as display lines (before windowing). */
export function transcriptLines(items: TranscriptItem[], width: number, color: ColorFn): string[] {
  const w = Math.max(10, width);
  const lines: string[] = [];
  const block = (label: string, labelColor: string, text: string): void => {
    if (lines.length) lines.push("");
    lines.push(color(labelColor, label));
    for (const para of text.split("\n")) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      for (const ln of wrapTextWithAnsi(para, w - 2)) lines.push("  " + ln);
    }
  };
  for (const it of items) {
    if (it.kind === "user") block("you ▸", "accent", it.text);
    else if (it.kind === "assistant") block("agent ▸", "success", it.text);
    else {
      const t = `  ⚙ ${it.name}${it.summary ? `: ${it.summary}` : ""}`;
      lines.push(color("muted", truncateToWidth(t, w, "…")));
    }
  }
  return lines;
}

function hintLines(items: string[], width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const item of items) {
    const next = cur ? `${cur} · ${item}` : ` ${item}`;
    if (cur && visibleWidth(next) > width) {
      out.push(cur);
      cur = ` ${item}`;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out.map((l) => truncateToWidth(l, Math.max(1, width), "…"));
}

/** How far up the transcript can scroll, given the space the body gets. */
export function maxFocusScroll(items: TranscriptItem[], width: number, height: number, ui: FocusUi): number {
  return Math.max(0, transcriptLines(items, width, (_n, s) => s).length - bodyHeight(width, height, ui));
}

function footer(width: number, ui: FocusUi, color: ColorFn): string[] {
  const lines: string[] = [];
  if (ui.readOnly) {
    lines.push(color("muted", truncateToWidth("  read-only: this session is attached in a terminal — reply there", width, "…")));
  } else if (ui.justSent) {
    lines.push(color("success", "  sent ✓"));
  } else {
    lines.push(color("accent", "  reply ▸ ") + truncateToWidth(ui.replyBuf + "█", Math.max(1, width - 11), ""));
  }
  if (ui.sendError) lines.push(color("error", "  ✗ " + truncateToWidth(ui.sendError, Math.max(2, width - 4), "…")));
  const keys = ui.readOnly
    ? ["↑↓ scroll", "PgUp/PgDn page", "Esc/← back"]
    : ["↑↓ scroll", "PgUp/PgDn page", "type to reply", "Enter send", "Esc/← back"];
  for (const h of hintLines(keys, width)) lines.push(color("muted", h));
  return lines;
}

function bodyHeight(width: number, height: number, ui: FocusUi): number {
  const chrome = 2 /* title + rule */ + 1 /* rule */ + footer(width, ui, (_n, s) => s).length;
  return Math.max(3, height - chrome);
}

/** Render the focus pane at exactly `height` lines (so the reply line stays pinned to the bottom). */
export function renderFocus(
  row: ManagedRow,
  items: TranscriptItem[],
  width: number,
  height: number,
  ui: FocusUi,
  color: ColorFn,
): string[] {
  const elapsed = row.elapsedMs !== undefined ? color("muted", `  ${formatElapsed(row.elapsedMs)}`) : "";
  const title = truncateToWidth(row.title, Math.max(1, width - 16), "…");
  const lines: string[] = [
    color("accent", "Session ▸ ") + `${statusGlyph(row.state)} ${title}` + color("muted", `  ${row.state}`) + elapsed,
    color("muted", "─".repeat(Math.max(1, width))),
  ];

  const body = bodyHeight(width, height, ui);
  const all = transcriptLines(items, width, color);
  const scroll = Math.min(ui.scrollFromBottom, Math.max(0, all.length - body));
  let view: string[];
  if (ui.loading) view = [color("muted", "  loading conversation…")];
  else if (all.length === 0) view = [color("muted", "  No messages yet.")];
  else view = all.slice(Math.max(0, all.length - body - scroll), all.length - scroll);
  if (scroll > 0) view[view.length - 1] = color("muted", `  ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below — ↓ to follow`);
  while (view.length < body) view.push("");
  lines.push(...view.slice(0, body));

  lines.push(color("muted", "─".repeat(Math.max(1, width))));
  lines.push(...footer(width, ui, color));
  return lines;
}
