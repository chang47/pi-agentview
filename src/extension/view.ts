// Agent View component (rendered via ctx.ui.custom). A session switcher/monitor
// with a peek panel that doubles as a reply input (type + Enter to send a
// follow-up to that background session, no attach).
// Keys: ↑↓/j/k select · Space peek (then type to reply, Enter sends) ·
//       Enter resume · n new · d remove · Esc close

import { type TUI } from "@earendil-works/pi-tui";
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { BrokerManager } from "./controller.js";
import { groupRows, filterRows, type ManagedRow } from "./render.js";
import { renderFrame } from "./frame.js";
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
  private filterMode = false; // true while typing a filter
  private filterQuery = ""; // active filter; empty = show all

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

  /** Rows that pass the active filter — what the view actually shows/navigates. */
  private visibleRows(): ManagedRow[] {
    return filterRows(this.cachedRows, this.filterQuery);
  }

  private refresh(): void {
    this.cachedRows = this.mgr.rows();
    const visible = this.visibleRows();
    // Selection must stay within the visible (filtered) set.
    if (this.selectedId && !visible.some((r) => r.id === this.selectedId)) {
      this.selectedId = visible[0]?.id;
    }
    if (!this.selectedId) this.selectedId = visible[0]?.id;
  }

  private flatRows(): ManagedRow[] {
    return groupRows(this.visibleRows()).flatMap((g) => g.rows);
  }

  private color(name: string, s: string): string {
    try {
      const fn = (this.theme as { fg?: (n: string, s: string) => string }).fg?.(name, s);
      return typeof fn === "string" ? fn : s;
    } catch {
      return s;
    }
  }

  render(width: number): string[] {
    this.refresh();
    return renderFrame(
      this.visibleRows(),
      width,
      {
        selectedId: this.selectedId,
        peekOpen: this.peekOpen,
        replyBuf: this.replyBuf,
        justSent: this.justSent,
        sendError: this.sendError,
        renameMode: this.renameMode,
        renameBuf: this.renameBuf,
        filterMode: this.filterMode,
        filterQuery: this.filterQuery,
      },
      (n, s) => this.color(n, s),
    );
  }

  handleInput(data: string): void {
    if (this.filterMode) {
      this.handleFilterInput(data);
      return;
    }
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
    } else if (data === "/") {
      this.filterMode = true;
      this.tui.requestRender();
    } else if (data === "\x1b") {
      // Esc clears an active filter first; a second Esc closes the view.
      if (this.filterQuery) {
        this.filterQuery = "";
        this.refresh();
        this.tui.requestRender();
      } else {
        this.close(null);
      }
    } else if (data === "q") {
      this.close(null);
    }
  }

  private handleFilterInput(data: string): void {
    if (data === "\r" || data === "\n") {
      // Enter applies the filter and leaves typing mode (the filter stays active).
      this.filterMode = false;
      this.tui.requestRender();
    } else if (data === "\x1b") {
      // Esc clears the filter and exits.
      this.filterMode = false;
      this.filterQuery = "";
      this.refresh();
      this.tui.requestRender();
    } else if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.filterQuery = this.filterQuery.slice(0, -1);
      this.refresh();
      this.tui.requestRender();
    } else if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.filterQuery += data;
      this.refresh();
      this.tui.requestRender();
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
