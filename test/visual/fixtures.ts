// Deterministic Agent View fixtures — rosters + UI state for each screen we want
// a still of. elapsedMs values are LITERAL (never Date.now()-derived) so the
// rendered frame is byte-stable across runs.

import type { ManagedRow } from "../../src/extension/render.js";
import type { FrameUi } from "../../src/extension/frame.js";

export interface Fixture {
  name: string;
  width: number;
  rows: ManagedRow[];
  ui: FrameUi;
}

const DEFAULT_UI: FrameUi = {
  selectedId: undefined,
  peekOpen: false,
  replyBuf: "",
  justSent: false,
  sendError: undefined,
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
  { name: "single-completed", width: 76, rows: [completed], ui: ui({ selectedId: "s2" }) },
  { name: "mixed-fleet", width: 76, rows: [awaiting, attached, working, completed, idle], ui: ui({ selectedId: "s1" }) },
  {
    name: "peek-reply-typed",
    width: 76,
    rows: [awaiting, working, completed],
    ui: ui({ selectedId: "s2", peekOpen: true, replyBuf: "ship it" }),
  },
  {
    name: "peek-sent-flash",
    width: 76,
    rows: [working, completed],
    ui: ui({ selectedId: "s2", peekOpen: true, justSent: true }),
  },
  {
    name: "peek-send-error",
    width: 76,
    rows: [working, completed],
    ui: ui({ selectedId: "s2", peekOpen: true, sendError: "no live broker for that session — it will reconnect" }),
  },
  {
    name: "rename",
    width: 76,
    rows: [working, completed, idle],
    ui: ui({ selectedId: "s4", renameMode: true, renameBuf: "nightly drain" }),
  },
  {
    name: "awaiting-input-peek",
    width: 76,
    rows: [awaiting, working],
    ui: ui({ selectedId: "s3", peekOpen: true }),
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
