// Agent View component (rendered via ctx.ui.custom). A session switcher/monitor
// with a peek panel that doubles as a reply input (type + Enter to send a
// follow-up to that background session, no attach).
// Keys: ↑↓/j/k select · Space peek (then type to reply, Enter sends) ·
//       Enter resume · n new · d remove · Esc close

import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { BrokerManager } from "./controller.js";
import { groupRows, statusGlyph, formatElapsed, type ManagedRow } from "./render.js";
import type { ManagedId } from "../types.js";

export type ViewResult =
  | { action: "resume"; id: ManagedId }
  | { action: "remove"; id: ManagedId }
  | { action: "create" }
  | null;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";

export class AgentViewComponent {
  private selectedId: ManagedId | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cachedRows: ManagedRow[] = [];
  private peekOpen = false;
  private replyBuf = "";
  private justSent = false; // brief "sent ✓" flash after Enter
  private sendError: string | undefined; // shown when a reply could not be delivered
  private renameMode = false;
  private renameBuf = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private mgr: BrokerManager,
    private done: (result: ViewResult) => void,
    private onRenameForeground?: (title: string) => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => {
      this.mgr
        .tick()
        .then(() => {
          this.refresh();
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }, 1000);
  }

  private refresh(): void {
    this.cachedRows = this.mgr.rows();
    if (this.selectedId && !this.cachedRows.some((r) => r.id === this.selectedId)) {
      this.selectedId = this.cachedRows[0]?.id;
    }
    if (!this.selectedId) this.selectedId = this.cachedRows[0]?.id;
  }

  private flatRows(): ManagedRow[] {
    return groupRows(this.cachedRows).flatMap((g) => g.rows);
  }

  private color(name: string, s: string): string {
    try {
      const fn = (this.theme as { fg?: (n: string, s: string) => string }).fg?.(name, s);
      return typeof fn === "string" ? fn : s;
    } catch {
      return s;
    }
  }

  private rule(width: number): string {
    return this.color("muted", "─".repeat(Math.max(0, width)));
  }

  private preview(row: ManagedRow): string {
    if (row.attached) return "active in another terminal";
    if ((row.state === "completed" || row.state === "awaiting_input") && row.reply) {
      return row.reply.replace(/\s+/g, " ").trim();
    }
    return row.activity;
  }

  render(width: number): string[] {
    this.refresh();
    const lines: string[] = [];
    const groups = groupRows(this.cachedRows);

    const counts: Record<string, number> = {};
    for (const r of this.cachedRows) counts[r.state] = (counts[r.state] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([s, n]) => `${s}=${n}`)
      .join("  ");

    lines.push(this.color("accent", "Agent View") + (summary ? this.color("muted", `   ${summary}`) : ""));
    lines.push(this.rule(width));

    if (groups.length === 0) {
      lines.push(this.color("muted", "  No background sessions. Press n to create one, Esc to close."));
    }

    for (const g of groups) {
      lines.push(this.color("accent", ` ${g.label} (${g.rows.length})`));
      for (const row of g.rows) {
        const sel = row.id === this.selectedId;
        const marker = sel ? this.color("accent", "▸ ") : "  ";
        const glyph = this.color(this.stateColor(row), statusGlyph(row.state));
        const elapsed = row.elapsedMs !== undefined ? this.color("muted", ` ${formatElapsed(row.elapsedMs)}`) : "";
        const title = truncateToWidth(row.title, Math.max(1, width - 8 - (row.elapsedMs !== undefined ? 6 : 0)), "…");
        const used = 4 + title.length + elapsed.length;
        const previewTxt = this.color("muted", truncateToWidth(` — ${this.preview(row)}`, Math.max(0, width - used), ""));
        lines.push(`${marker}${glyph} ${title}${previewTxt}${elapsed}`);

        if (sel && this.peekOpen) {
          const body = row.state === "awaiting_input" ? row.activity : row.reply ?? row.activity;
          if (body) {
            for (const ln of body.split("\n").slice(0, 10)) {
              lines.push(this.color("muted", "  " + truncateToWidth(ln, Math.max(2, width - 2), "…")));
            }
          }
          // Reply input line.
          const promptLabel = this.color("accent", "  reply ▸ ");
          const buf = truncateToWidth(this.replyBuf + "█", Math.max(1, width - 11), "");
          if (this.justSent) lines.push(this.color("success", "  sent ✓"));
          else lines.push(promptLabel + buf);
          if (this.sendError) lines.push(this.color("error", "  ✗ " + truncateToWidth(this.sendError, Math.max(2, width - 4), "…")));
        }
      }
    }

    if (this.renameMode) {
      lines.push(this.color("accent", "  rename ▸ ") + truncateToWidth(this.renameBuf + "█", Math.max(1, width - 11), ""));
    }
    lines.push(this.rule(width));
    const selAttached = this.cachedRows.some((r) => r.id === this.selectedId && r.attached);
    const hint = this.renameMode
      ? " type new title · Enter save · Esc cancel"
      : this.peekOpen
        ? " type a reply · Enter send · ↑↓ switch · Esc close peek"
        : selAttached
          ? " ⊘ attached in another terminal — can't connect (auto-recovers if it closes) · ↑↓ select · Esc close"
          : " ↑↓ select · Space peek/reply · Enter resume · n new · d remove · r rename · Esc close";
    lines.push(this.color("muted", hint));
    return lines;
  }

  private stateColor(row: ManagedRow): string {
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

  handleInput(data: string): void {
    if (this.renameMode) {
      this.handleRenameInput(data);
      return;
    }
    // Inside the peek panel: typing builds a reply.
    if (this.peekOpen) {
      this.handlePeekInput(data);
      return;
    }

    const rows = this.flatRows();
    const idx = rows.findIndex((r) => r.id === this.selectedId);
    const sel = idx >= 0 ? rows[idx] : undefined;

    if (data === UP || data === "k") {
      if (idx > 0) this.selectedId = rows[idx - 1]!.id;
      this.tui.requestRender();
    } else if (data === DOWN || data === "j") {
      if (idx >= 0 && idx < rows.length - 1) this.selectedId = rows[idx + 1]!.id;
      this.tui.requestRender();
    } else if (data === " ") {
      this.peekOpen = true;
      this.replyBuf = "";
      this.justSent = false;
      this.sendError = undefined;
      this.tui.requestRender();
    } else if (data === "\r" || data === "\n") {
      // Foreground rows are the interactive session you're in — not resumable.
      if (this.selectedId && !sel?.attached) this.close({ action: "resume", id: this.selectedId });
    } else if (data === "n") {
      this.close({ action: "create" });
    } else if (data === "d") {
      // Remove in-place: stay in the view, move selection to a neighbor.
      if (this.selectedId && !sel?.attached) {
        const id = this.selectedId;
        const at = rows.findIndex((r) => r.id === id);
        const neighbor = rows[at + 1] ?? rows[at - 1];
        this.selectedId = neighbor?.id;
        void this.mgr.remove(id).then(() => {
          this.refresh();
          this.tui.requestRender();
        });
        this.tui.requestRender();
      }
    } else if (data === "r") {
      if (this.selectedId) {
        this.renameMode = true;
        this.renameBuf = sel?.title ?? "";
        this.tui.requestRender();
      }
    } else if (data === "q" || data === "\x1b") {
      this.close(null);
    }
  }

  private handlePeekInput(data: string): void {
    // Any further keystroke dismisses a delivery error.
    if (data !== "\r" && data !== "\n") this.sendError = undefined;
    const rows = this.flatRows();
    const move = (delta: number) => {
      const idx = rows.findIndex((r) => r.id === this.selectedId);
      const next = rows[idx + delta];
      if (next) {
        this.selectedId = next.id;
        this.replyBuf = ""; // don't send A's reply to B
        this.justSent = false;
      }
      this.tui.requestRender();
    };

    if (data === UP) return move(-1);
    if (data === DOWN) return move(1);
    if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.replyBuf = this.replyBuf.slice(0, -1);
      this.justSent = false;
      this.tui.requestRender();
      return;
    }
    if (data === "\r" || data === "\n") {
      const text = this.replyBuf.trim();
      if (text && this.selectedId) {
        // Only claim success when the reply actually reached a broker. This used
        // to flash "sent ✓" unconditionally — including for attached rows and
        // unreachable brokers, where the message went nowhere.
        if (this.mgr.sendReply(this.selectedId, text)) {
          this.replyBuf = "";
          this.justSent = true;
          this.sendError = undefined;
        } else {
          this.justSent = false;
          this.sendError = this.selectedId.startsWith("fg:")
            ? "can't reply to a session attached in a terminal"
            : "no live broker for that session — it will reconnect";
        }
      } else {
        this.peekOpen = false; // Enter on empty reply closes peek
      }
      this.tui.requestRender();
      return;
    }
    if (data === "\x1b") {
      this.peekOpen = false;
      this.replyBuf = "";
      this.justSent = false;
      this.tui.requestRender();
      return;
    }
    if (data === " ") {
      // Space appends to the reply; if empty, treat as "close peek".
      if (this.replyBuf.length === 0) {
        this.peekOpen = false;
        this.tui.requestRender();
      } else {
        this.replyBuf += " ";
        this.justSent = false;
        this.tui.requestRender();
      }
      return;
    }
    // Printable character -> append to reply buffer.
    if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.replyBuf += data;
      this.justSent = false;
      this.tui.requestRender();
    }
  }

  private handleRenameInput(data: string): void {
    if (data === "\r" || data === "\n") {
      const t = this.renameBuf.trim();
      const id = this.selectedId;
      this.renameMode = false;
      this.renameBuf = "";
      if (id && t) {
        if (id.startsWith("fg:")) this.onRenameForeground?.(t);
        else void this.mgr.setTitle(id, t).then(() => {
          this.refresh();
          this.tui.requestRender();
        });
      }
      this.tui.requestRender();
    } else if (data === "\x1b") {
      this.renameMode = false;
      this.renameBuf = "";
      this.tui.requestRender();
    } else if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.renameBuf = this.renameBuf.slice(0, -1);
      this.tui.requestRender();
    } else if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.renameBuf += data;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    /* stateless render beyond per-call computation */
  }

  private close(result: ViewResult): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.done(result);
  }
}
