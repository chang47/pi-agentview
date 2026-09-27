// Deterministic Agent View fixtures — rosters + UI state for each screen we want
// a still of. elapsedMs values are LITERAL (never Date.now()-derived) so the
// rendered frame is byte-stable across runs.

import type { ManagedRow } from "../../src/extension/render.js";
import type { FrameUi } from "../../src/extension/frame.js";
import type { FocusUi } from "../../src/extension/focus.js";
import type { TranscriptItem } from "../../src/extension/transcript.js";

export interface Fixture {
  name: string;
  width: number;
  rows: ManagedRow[];
  ui: FrameUi;
}

const DEFAULT_UI: FrameUi = {
  selectedId: undefined,
  renameMode: false,
  renameBuf: "",
};

function row(p: Partial<ManagedRow> & Pick<ManagedRow, "id" | "title" | "state">): ManagedRow {
  return {
    activity: "ready",
    elapsedMs: undefined,
    needsInput: false,
    jsonlPath: `/sessions/${p.id}/s.jsonl`,
    ...p,
  };
}

const working = row({ id: "s1", title: "refactor the parser", state: "working", activity: "tool: edit", elapsedMs: 47_000 });
// A live tool row: the current tool AND its target, surfaced from
// tool_execution_start/update events (deriveState composes "tool: <name> <target>").
const midTool = row({
  id: "s5",
  title: "port the auth module",
  state: "working",
  activity: "tool: edit src/auth/session.ts",
  elapsedMs: 8_000,
});
const completed = row({
  id: "s2",
  title: "fix the flaky uploader test",
  state: "completed",
  activity: "responded",
  reply: "All 42 tests pass now — the retry wrapper was swallowing the timeout.",
  elapsedMs: 302_000,
});
const awaiting = row({
  id: "s3",
  title: "migrate the config loader",
  state: "awaiting_input",
  activity: "Allow running `rm -rf dist`?",
  elapsedMs: 12_000,
});
const idle = row({ id: "s4", title: "scratch session", state: "idle", activity: "ready" });
const attached = row({ id: "fg:1", title: "this terminal", state: "attached", activity: "active", attached: true });

const ui = (o: Partial<FrameUi>): FrameUi => ({ ...DEFAULT_UI, ...o });

export const FIXTURES: Fixture[] = [
  { name: "empty", width: 76, rows: [], ui: DEFAULT_UI },
  { name: "single-working", width: 76, rows: [working], ui: ui({ selectedId: "s1" }) },
  { name: "mid-tool", width: 76, rows: [midTool], ui: ui({ selectedId: "s5" }) },
  { name: "single-completed", width: 76, rows: [completed], ui: ui({ selectedId: "s2" }) },
  { name: "mixed-fleet", width: 76, rows: [awaiting, attached, working, completed, idle], ui: ui({ selectedId: "s1" }) },
  {
    name: "rename",
    width: 76,
    rows: [working, completed, idle],
    ui: ui({ selectedId: "s4", renameMode: true, renameBuf: "nightly drain" }),
  },
  {
    name: "filter-active",
    width: 76,
    // Rows are pre-filtered (the component filters before renderFrame); this is
    // the `s:working` result over the mixed fleet — with the filter line showing.
    rows: [working],
    ui: ui({ selectedId: "s1", filterMode: true, filterQuery: "s:working" }),
  },
];

// --- Focus pane (→ on a row): one session's conversation, scrollable, with a reply line ------
export interface FocusFixture {
  name: string;
  width: number;
  height: number;
  row: ManagedRow;
  items: TranscriptItem[];
  ui: FocusUi;
}

export const SAMPLE_TRANSCRIPT: TranscriptItem[] = [
  { kind: "user", text: "The uploader test is flaky on CI. Find out why and fix it." },
  { kind: "tool", name: "bash", summary: "npm test -- uploader --repeat 20" },
  { kind: "assistant", text: "Reproduced it: 3 of 20 runs time out. Looking at the retry wrapper next." },
  { kind: "tool", name: "read", summary: "src/upload/retry.ts" },
  { kind: "tool", name: "edit", summary: "src/upload/retry.ts" },
  {
    kind: "assistant",
    text:
      "Found it. The retry wrapper caught every error, including the timeout, so a slow upload retried forever until the test runner killed it.\n\nI changed it to rethrow timeouts and only retry on network errors. All 42 tests pass now, 20 runs in a row.",
  },
];

// An agent reply written in markdown — the focus pane renders it (heading, bold, inline code,
// list, fenced code, table) instead of showing the raw syntax.
export const MARKDOWN_TRANSCRIPT: TranscriptItem[] = [
  { kind: "user", text: "Why was the uploader test flaky?" },
  {
    kind: "assistant",
    text: [
      "## Root cause",
      "",
      "The retry wrapper caught **every** error, including the timeout.",
      "",
      "- `retry.ts` now rethrows `TimeoutError`",
      "- network errors still retry (max 3)",
      "",
      "```ts",
      "if (err instanceof TimeoutError) throw err;",
      "```",
      "",
      "| runs | failures |",
      "| --- | --- |",
      "| before | 3/20 |",
      "| after | 0/20 |",
    ].join("\n"),
  },
];

const FOCUS_UI: FocusUi = { scrollFromBottom: 0, replyBuf: "", justSent: false, readOnly: false, loading: false };

export const FOCUS_FIXTURES: FocusFixture[] = [
  { name: "focus-conversation", width: 76, height: 24, row: completed, items: SAMPLE_TRANSCRIPT, ui: { ...FOCUS_UI, replyBuf: "ship it" } },
  { name: "focus-scrolled", width: 76, height: 14, row: completed, items: SAMPLE_TRANSCRIPT, ui: { ...FOCUS_UI, scrollFromBottom: 4 } },
  { name: "focus-attached-readonly", width: 76, height: 14, row: attached, items: SAMPLE_TRANSCRIPT.slice(0, 3), ui: { ...FOCUS_UI, readOnly: true } },
  { name: "focus-markdown", width: 76, height: 26, row: completed, items: MARKDOWN_TRANSCRIPT, ui: FOCUS_UI },
  { name: "focus-sent-flash", width: 76, height: 14, row: completed, items: SAMPLE_TRANSCRIPT, ui: { ...FOCUS_UI, justSent: true } },
  {
    name: "focus-send-error",
    width: 76,
    height: 14,
    row: completed,
    items: SAMPLE_TRANSCRIPT,
    ui: { ...FOCUS_UI, replyBuf: "hello?", sendError: "no live broker for that session — it will reconnect" },
  },
  // What peek used to show that the transcript can't: the pending dialog question / the live tool.
  { name: "focus-awaiting-input", width: 76, height: 14, row: awaiting, items: SAMPLE_TRANSCRIPT.slice(0, 2), ui: FOCUS_UI },
  { name: "focus-mid-tool", width: 76, height: 14, row: midTool, items: SAMPLE_TRANSCRIPT.slice(0, 3), ui: FOCUS_UI },
];
