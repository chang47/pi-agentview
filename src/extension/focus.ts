// Pure renderer for the session FOCUS pane: one session's conversation at full height, scrollable,
// with a reply line at the bottom. Opened from Agent View with → (or Space) on a row; Esc/← returns to the
// list with the same row selected. Like frame.ts: rows + ui state + a color fn in, lines out — no
// TUI, no I/O — so tests snapshot it directly.

import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

/** A MarkdownTheme in the host's colors, built from semantic names (mdHeading, mdCode, …) — the
 *  same names pi's own getMarkdownTheme() uses, minus syntax highlighting. Tests pass their ANSI
 *  mapper so goldens stay deterministic. */
export function markdownTheme(
  color: ColorFn,
  style: Partial<Record<"bold" | "italic" | "underline", (s: string) => string>> = {},
): MarkdownTheme {
  const c = (name: string) => (s: string) => color(name, s);
  return {
    heading: c("mdHeading"),
    link: c("mdLink"),
    linkUrl: c("mdLinkUrl"),
    code: c("mdCode"),
    codeBlock: c("mdCodeBlock"),
    codeBlockBorder: c("mdCodeBlockBorder"),
    quote: c("mdQuote"),
    quoteBorder: c("mdQuoteBorder"),
    hr: c("mdHr"),
    listBullet: c("mdListBullet"),
    bold: style.bold ?? ((s) => s),
    italic: style.italic ?? ((s) => s),
    underline: style.underline ?? ((s) => s),
    strikethrough: (s) => s,
  };
}

// Rendering markdown is the expensive part of a frame, and the transcript is re-read every tick —
// cache per (theme, width, text) so only new/changed replies are re-rendered.
const mdCache = new WeakMap<MarkdownTheme, Map<string, string[]>>();
function renderMarkdown(text: string, width: number, md: MarkdownTheme): string[] {
  let byKey = mdCache.get(md);
  if (!byKey) mdCache.set(md, (byKey = new Map()));
  const key = `${width}\0${text}`;
  let out = byKey.get(key);
  if (!out) {
    if (byKey.size > 500) byKey.clear();
    // Markdown pads every line to the full width; strip that so lines stay clean.
    out = new Markdown(text, 0, 0, md).render(width).map((l) => l.replace(/ +$/, ""));
    byKey.set(key, out);
  }
  return out;
}

/** The transcript as display lines (before windowing). With `md`, the agent's replies render as
 *  markdown (headings, lists, code blocks, tables); your own messages stay verbatim. */
export function transcriptLines(items: TranscriptItem[], width: number, color: ColorFn, md?: MarkdownTheme): string[] {
  const w = Math.max(10, width);
  const lines: string[] = [];
  const block = (label: string, labelColor: string, text: string, markdown = false): void => {
    if (lines.length) lines.push("");
    lines.push(color(labelColor, label));
    if (markdown && md) {
      for (const ln of renderMarkdown(text, w - 2, md)) lines.push(ln ? "  " + ln : "");
      return;
    }
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
    else if (it.kind === "assistant") block("agent ▸", "success", it.text, true);
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
export function maxFocusScroll(
  row: ManagedRow,
  items: TranscriptItem[],
  width: number,
  height: number,
  ui: FocusUi,
  md?: MarkdownTheme,
): number {
  return Math.max(0, transcriptLines(items, width, (_n, s) => s, md).length - bodyHeight(row, width, height, ui));
}

function footer(row: ManagedRow, width: number, ui: FocusUi, color: ColorFn): string[] {
  const lines: string[] = [];
  // Live status the transcript can't show: the pending dialog question, or the tool running now.
  if (row.state === "awaiting_input" && row.activity) {
    lines.push(color("warning", truncateToWidth(`  ⚠ waiting: ${row.activity}`, width, "…")));
  } else if (row.state === "working" && row.activity) {
    lines.push(color("muted", truncateToWidth(`  ⋯ ${row.activity}`, width, "…")));
  }
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

function bodyHeight(row: ManagedRow, width: number, height: number, ui: FocusUi): number {
  const chrome = 2 /* title + rule */ + 1 /* rule */ + footer(row, width, ui, (_n, s) => s).length;
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
  md?: MarkdownTheme,
): string[] {
  const elapsed = row.elapsedMs !== undefined ? color("muted", `  ${formatElapsed(row.elapsedMs)}`) : "";
  const title = truncateToWidth(row.title, Math.max(1, width - 16), "…");
  const lines: string[] = [
    color("accent", "Session ▸ ") + `${statusGlyph(row.state)} ${title}` + color("muted", `  ${row.state}`) + elapsed,
    color("muted", "─".repeat(Math.max(1, width))),
  ];

  const body = bodyHeight(row, width, height, ui);
  const all = transcriptLines(items, width, color, md);
  const scroll = Math.min(ui.scrollFromBottom, Math.max(0, all.length - body));
  let view: string[];
  if (ui.loading) view = [color("muted", "  loading conversation…")];
  else if (all.length === 0) view = [color("muted", "  No messages yet.")];
  else view = all.slice(Math.max(0, all.length - body - scroll), all.length - scroll);
  if (scroll > 0) view[view.length - 1] = color("muted", `  ↓ ${scroll} more line${scroll === 1 ? "" : "s"} below — ↓ to follow`);
  while (view.length < body) view.push("");
  lines.push(...view.slice(0, body));

  lines.push(color("muted", "─".repeat(Math.max(1, width))));
  lines.push(...footer(row, width, ui, color));
  return lines;
}
