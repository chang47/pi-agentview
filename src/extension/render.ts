// Pure view-model helpers for Agent View. No TUI deps -> unit-testable.

import { STATE_ORDER, type BrokerState, type ManagedId, type RegistryEntry, type SessionState, type SessionStats } from "../types.js";

export interface ManagedRow {
  id: ManagedId;
  title: string;
  state: SessionState;
  activity: string;
  /** The model's latest reply text (when available) — shown for completed rows + peek. */
  reply?: string;
  /** Per-session usage from get_session_stats — tokens / cost / context%. */
  stats?: SessionStats;
  /** ms since the semantic state transition (run start / completion / wait). */
  elapsedMs: number | undefined;
  needsInput: boolean;
  /** Session JSONL — used to dedup foreground vs broker rows for the same file. */
  jsonlPath: string;
  /** True for sessions currently opened in a terminal (display + peek only; no resume/remove). */
  attached?: boolean;
}

/** State aliases accepted in a `s:<state>` filter token. */
const STATE_ALIASES: Record<string, SessionState> = {
  blocked: "awaiting_input",
  waiting: "awaiting_input",
  done: "completed",
  running: "working",
};

/**
 * Filter rows by a query. Space-separated tokens are ANDed. A `s:<state>` token
 * matches by session state (via the aliases above, else a substring of the state,
 * so `s:idle` / `s:working` / `s:blocked` all work); any other token is free text
 * matched against title + activity + reply. Empty query returns all rows.
 * Pure -> unit-testable.
 */
export function filterRows(rows: ManagedRow[], query: string): ManagedRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const tokens = q.split(/\s+/);
  return rows.filter((row) =>
    tokens.every((t) => {
      if (t.startsWith("s:")) {
        const s = t.slice(2);
        if (!s) return true;
        const target = STATE_ALIASES[s] ?? s;
        return row.state === target || row.state.includes(s);
      }
      const hay = `${row.title} ${row.activity} ${row.reply ?? ""}`.toLowerCase();
      return hay.includes(t);
    }),
  );
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

/** Round to one decimal, dropping a trailing ".0" (12.0 -> "12", 12.34 -> "12.3"). */
function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}` : `${r}`;
}

/** Compact token count: 12.8k / 1.2M / 834. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1_000_000) return `${round1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${round1(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

/** USD cost with up to 4 decimals, trailing zeros stripped ($0.0421 / $0.04 / $1). */
function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return "";
  return `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** One-glance usage: `12.8k·$0.04·42%`. Renders whatever fields are present; an
 *  empty result means the row should show nothing (callers gate on row.stats). */
export function formatStats(s: SessionStats | undefined): string {
  if (!s) return "";
  const parts: string[] = [];
  const tok = formatTokens(s.tokens);
  if (tok) parts.push(tok);
  const cost = formatCost(s.costUsd);
  if (cost) parts.push(cost);
  if (s.contextPct !== undefined && Number.isFinite(s.contextPct)) parts.push(`${round1(s.contextPct)}%`);
  return parts.join("·");
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
      stats: st?.stats,
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
