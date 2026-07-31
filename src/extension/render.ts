// Pure view-model helpers for Agent View. No TUI deps -> unit-testable.

import { STATE_ORDER, type BrokerState, type ManagedId, type RegistryEntry, type SessionState } from "../types.js";

export interface ManagedRow {
  id: ManagedId;
  title: string;
  state: SessionState;
  activity: string;
  /** The model's latest reply text (when available) — shown for completed rows + peek. */
  reply?: string;
  /** ms since the semantic state transition (run start / completion / wait). */
  elapsedMs: number | undefined;
  needsInput: boolean;
  /** Session JSONL — used to dedup foreground vs broker rows for the same file. */
  jsonlPath: string;
  /** True for sessions currently opened in a terminal (display + peek only; no resume/remove). */
  attached?: boolean;
}

export function statusGlyph(state: SessionState): string {
  switch (state) {
    case "working":
      return "●";
    case "completed":
      return "✓";
    case "awaiting_input":
      return "?";
    case "interrupted":
      return "!";
    case "needs_attention":
      return "▲";
    case "attached":
      return "▶";
    case "stopped":
      return "■";
    case "idle":
    default:
      return "·";
  }
}

export function stateLabel(state: SessionState): string {
  switch (state) {
    case "awaiting_input":
      return "Awaiting Input";
    case "attached":
      return "Attached";
    case "working":
      return "Working";
    case "completed":
      return "Completed";
    case "idle":
      return "Idle";
    case "needs_attention":
      return "Needs Attention";
    case "interrupted":
      return "Interrupted";
    case "stopped":
      return "Stopped";
  }
}

export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/** Build display rows from registry entries + per-id broker states. */
export function rowsFor(
  entries: RegistryEntry[],
  states: Map<ManagedId, BrokerState | undefined>,
  now: number,
): ManagedRow[] {
  return entries.map((e) => {
    const st = states.get(e.id);
    const state = st?.state ?? "idle";
    const activity = st?.activity ?? "ready";
    let since: number | undefined;
    switch (state) {
      case "working":
        since = st?.runStartedAt;
        break;
      case "awaiting_input":
        since = st?.waitingSince;
        break;
      case "completed":
        since = st?.completedAt;
        break;
      default:
        since = undefined;
    }
    return {
      id: e.id,
      title: e.title,
      state,
      activity,
      reply: st?.finalResponse,
      elapsedMs: since !== undefined ? now - since : undefined,
      needsInput: state === "awaiting_input",
      jsonlPath: e.jsonlPath,
    };
  });
}

export interface RowGroup {
  state: SessionState;
  label: string;
  rows: ManagedRow[];
}

/** Group + order rows by urgency (STATE_ORDER). Empty groups are omitted. */
export function groupRows(rows: ManagedRow[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const state of STATE_ORDER) {
    const r = rows.filter((row) => row.state === state);
    if (r.length > 0) {
      groups.push({ state, label: stateLabel(state), rows: r });
    }
  }
  return groups;
}
