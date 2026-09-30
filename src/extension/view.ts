// Agent View component (rendered via ctx.ui.custom). A session switcher/monitor;
// → (or Space) opens a session's focus pane — its full conversation, scrollable,
// with a reply line (type + Enter sends a follow-up to that background session,
// no attach).
// Keys: ↑↓/j/k select · →/Space focus (scroll, reply; Esc/← back) ·
//       Enter resume · n new · d remove · r rename · / filter · Esc close

import { type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { BrokerManager } from "./controller.js";
import { groupRows, filterRows, type ManagedRow } from "./render.js";
import { renderFrame } from "./frame.js";
import { renderFocus, maxFocusScroll, markdownTheme, type FocusUi } from "./focus.js";
import { loadTranscript, type TranscriptItem } from "./transcript.js";
import type { ManagedId } from "../types.js";

export type ViewResult =
  | { action: "resume"; id: ManagedId }
  | { action: "remove"; id: ManagedId }
  | { action: "create" }
  | null;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const RIGHT_APP = "\x1bOC"; // application cursor mode
const LEFT = "\x1b[D";
const LEFT_APP = "\x1bOD";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";

/** Where the focus pane gets a session's conversation. Returning an array (not a Promise) makes
 *  it synchronous — the interaction harness uses that to script transcripts deterministically. */
export type TranscriptLoader = (row: ManagedRow) => TranscriptItem[] | Promise<TranscriptItem[]>;

export interface AgentViewOptions {
  loadTranscript?: TranscriptLoader;
  /** Terminal height for the focus pane. Defaults to the live terminal's rows. */
  height?: () => number;
}
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";

export class AgentViewComponent {
  private selectedId: ManagedId | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cachedRows: ManagedRow[] = [];
  private replyBuf = "";
  private justSent = false; // brief "sent ✓" flash after Enter
  private sendError: string | undefined; // shown when a reply could not be delivered
  private renameMode = false;
  private renameBuf = "";
  private filterMode = false; // true while typing a filter
  private filterQuery = ""; // active filter; empty = show all
  // Focus pane: one session's full conversation (→ opens it, Esc/← returns to the list).
  private focusOpen = false;
  private focusScroll = 0; // lines up from the bottom; 0 = follow the newest message
  private focusItems: TranscriptItem[] | undefined; // undefined = still loading
  private focusLoadSeq = 0; // drops a stale load that finishes after the user moved on
  private loader: TranscriptLoader;
  private md: MarkdownTheme;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private mgr: BrokerManager,
    private done: (result: ViewResult) => void,
    private onRenameForeground?: (title: string) => void,
    private opts: AgentViewOptions = {},
  ) {
    this.loader = opts.loadTranscript ?? ((row) => loadTranscript(row.jsonlPath));
    const t = this.theme as Partial<Record<"bold" | "italic" | "underline", (s: string) => string>>;
    this.md = markdownTheme((n, s) => this.color(n, s), {
      bold: t.bold?.bind(this.theme),
      italic: t.italic?.bind(this.theme),
      underline: t.underline?.bind(this.theme),
    });
    this.refresh();
    this.timer = setInterval(() => {
      this.mgr
        .tick()
        .then(() => {
          this.refresh();
          if (this.focusOpen) this.loadFocus(); // live: new replies appear while you read
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }, 1000);
  }

  private height(): number {
    const h = this.opts.height?.() ?? (this.tui as { terminal?: { rows?: number } }).terminal?.rows;
    return Math.max(10, (h ?? 30) - 1);
  }

  private selectedRow(): ManagedRow | undefined {
    return this.cachedRows.find((r) => r.id === this.selectedId);
  }

  private focusUi(): FocusUi {
    return {
      scrollFromBottom: this.focusScroll,
      replyBuf: this.replyBuf,
      justSent: this.justSent,
      sendError: this.sendError,
      readOnly: !!this.selectedRow()?.attached,
      loading: this.focusItems === undefined,
    };
  }

  /** (Re)load the focused session's transcript. Sync loaders apply immediately. */
  private loadFocus(): void {
    const row = this.selectedRow();
    if (!row) return;
    const seq = ++this.focusLoadSeq;
    const apply = (items: TranscriptItem[]): void => {
      if (seq !== this.focusLoadSeq || !this.focusOpen || this.selectedId !== row.id) return;
      this.focusItems = items;
      this.tui.requestRender();
    };
    const r = this.loader(row);
    if (Array.isArray(r)) apply(r);
    else void r.then(apply, () => apply([]));
  }

  private openFocus(): void {
    this.focusOpen = true;
    this.focusScroll = 0;
    this.focusItems = undefined;
    this.replyBuf = "";
    this.justSent = false;
    this.sendError = undefined;
    this.loadFocus();
    this.tui.requestRender();
  }

  private closeFocus(): void {
    this.focusOpen = false;
    this.focusItems = undefined;
    this.replyBuf = "";
    this.justSent = false;
    this.sendError = undefined;
    this.tui.requestRender();
  }

  /** Send `text` to the selected session. Only claims success when a broker took it. */
  private deliverReply(text: string): boolean {
    if (!this.selectedId) return false;
    if (this.mgr.sendReply(this.selectedId, text)) {
      this.replyBuf = "";
      this.justSent = true;
      this.sendError = undefined;
      return true;
    }
    this.justSent = false;
    this.sendError = this.selectedId.startsWith("fg:")
      ? "can't reply to a session attached in a terminal"
      : "no live broker for that session — it will reconnect";
    return false;
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
    const focused = this.focusOpen ? this.selectedRow() : undefined;
    if (this.focusOpen && !focused) this.focusOpen = false; // the session went away underneath us
    if (focused) {
      const ui = this.focusUi();
      const h = this.height();
      const items = this.focusItems ?? [];
      this.focusScroll = Math.min(this.focusScroll, maxFocusScroll(focused, items, width, h, ui, this.md));
      return renderFocus(focused, items, width, h, { ...ui, scrollFromBottom: this.focusScroll }, (n, s) => this.color(n, s), this.md);
    }
    return renderFrame(
      this.visibleRows(),
      width,
      {
        selectedId: this.selectedId,
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
    if (this.focusOpen) {
      this.handleFocusInput(data);
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
    } else if (data === RIGHT || data === RIGHT_APP || data === " ") {
      if (sel) this.openFocus();
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

  private handleFocusInput(data: string): void {
    // Any further keystroke dismisses a delivery error / the "sent ✓" flash.
    if (data !== "\r" && data !== "\n") {
      this.sendError = undefined;
      this.justSent = false;
    }
    const readOnly = !!this.selectedRow()?.attached;
    const page = Math.max(1, this.height() - 8);
    if (data === UP) this.focusScroll += 1;
    else if (data === DOWN) this.focusScroll = Math.max(0, this.focusScroll - 1);
    else if (data === PGUP) this.focusScroll += page;
    else if (data === PGDN) this.focusScroll = Math.max(0, this.focusScroll - page);
    else if (data === "\x1b") this.closeFocus();
    else if (data === LEFT || data === LEFT_APP) {
      // ← goes back only when there's no half-typed reply to lose.
      if (this.replyBuf.length === 0) this.closeFocus();
    } else if (readOnly) {
      /* attached session: reading only — reply in the terminal that has it */
    } else if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.replyBuf = this.replyBuf.slice(0, -1);
    } else if (data === "\r" || data === "\n") {
      const text = this.replyBuf.trim();
      if (text && this.deliverReply(text)) this.focusScroll = 0; // follow the answer as it arrives
    } else if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
      this.replyBuf += data;
    }
    this.tui.requestRender();
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
