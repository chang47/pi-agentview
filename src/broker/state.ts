// Pure state derivation: maps a Pi RPC event onto a new BrokerState (or null if
// the event does not meaningfully change what Agent View should display).
//
// Status comes from first-class RPC events, never terminal scraping. "Completed"
// means the latest requested run settled successfully (agent_settled), NOT that
// the process exited — the worker stays available in the background.

import type { BrokerState, SessionState } from "../types.js";
import type { RpcMessage } from "./rpc-client.js";

export function initialState(id: string): BrokerState {
  return {
    id,
    state: "idle",
    activity: "ready",
    lastEventSeq: 0,
    updatedAt: Date.now(),
  };
}

function assistantText(message: unknown): string | undefined {
  const m = message as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return undefined;
  const text = m.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text || undefined;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? oneLine.slice(0, 117) + "…" : oneLine;
}

// Argument keys pi's built-in tools carry, ordered by how well each names the
// thing the tool is acting on. The first present one becomes the row's "target".
const TOOL_TARGET_KEYS = [
  "file_path", "filePath", "path", "file",
  "command", "cmd",
  "pattern", "query", "url", "name",
];

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** A concise human "target" (path / command / pattern / url) for a tool event.
 *  pi emits the parsed tool-call arguments alongside the tool name; we surface
 *  the most meaningful one so a working row reads "tool: edit src/foo.ts", not
 *  just "tool: edit". Returns undefined when the event carries no useful detail. */
function toolTarget(ev: RpcMessage): string | undefined {
  const args = (ev.args ?? ev.arguments ?? ev.input) as Record<string, unknown> | undefined;
  const raw =
    firstString(ev.target) ??
    (args && typeof args === "object" ? firstString(...TOOL_TARGET_KEYS.map((k) => args[k])) : undefined);
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? oneLine.slice(0, 47) + "…" : oneLine;
}

/** Compose the activity label shown for a running tool. */
function toolActivity(name: string, target: string | undefined): string {
  return target ? `tool: ${name} ${target}` : `tool: ${name}`;
}

/** Recover the tool name from an existing "tool: <name> …" activity, so a
 *  progress update that omits the name can still refine its target. */
function toolNameFromActivity(activity: string): string | undefined {
  const m = /^tool:\s+(\S+)/.exec(activity);
  return m ? m[1] : undefined;
}

/** Returns the next state, or null if the event is irrelevant to the view. */
export function deriveState(prev: BrokerState, ev: RpcMessage, seq: number): BrokerState | null {
  const now = Date.now();
  const base = { ...prev, lastEventSeq: seq, updatedAt: now };
  const dialogMethods = new Set(["select", "confirm", "input", "editor"]);

  switch (ev.type) {
    case "agent_start":
      return { ...base, state: "working", activity: "running", runStartedAt: now, completedAt: undefined, pendingDialog: undefined };

    case "tool_execution_start": {
      const name = String(ev.toolName ?? "tool");
      return { ...base, state: ensureWorking(base.state), activity: toolActivity(name, toolTarget(ev)) };
    }

    case "tool_execution_update": {
      // Progress on the running tool. Refine the detail if the event carries a
      // fresh name/target; if it carries neither, keep the current activity
      // rather than clobbering "tool: edit foo.ts" with a bare "tool: tool".
      const target = toolTarget(ev);
      if (ev.toolName === undefined && target === undefined) return { ...base };
      const name = ev.toolName !== undefined ? String(ev.toolName) : toolNameFromActivity(base.activity) ?? "tool";
      return { ...base, state: ensureWorking(base.state), activity: toolActivity(name, target) };
    }

    case "compaction_start":
      return { ...base, state: ensureWorking(base.state), activity: "compacting context" };

    case "auto_retry_start": {
      const attempt = (ev.attempt as number | undefined) ?? 1;
      return { ...base, state: ensureWorking(base.state), activity: `retrying (attempt ${attempt})` };
    }

    case "message_end": {
      // Capture the latest assistant response as the candidate final reply.
      // Store a generous slice (peek shows the full text; the row collapses it).
      const text = assistantText(ev.message);
      if (text !== undefined) {
        return { ...base, finalResponse: text.slice(0, 4000), activity: base.state === "awaiting_input" ? base.activity : "responded" };
      }
      return { ...base };
    }

    case "extension_ui_request": {
      const method = ev.method as string | undefined;
      if (!method || !dialogMethods.has(method)) return { ...base }; // fire-and-forget UI -> ignore
      const d = {
        id: String(ev.id),
        method: method as "select" | "confirm" | "input" | "editor",
        title: ev.title as string | undefined,
        message: ev.message as string | undefined,
        options: ev.options as string[] | undefined,
      };
      const label = d.title ?? d.message ?? (d.options ? d.options.join(" / ") : `${method} prompt`);
      return { ...base, state: "awaiting_input", activity: summarize(label), waitingSince: now, pendingDialog: d };
    }

    case "agent_settled": {
      const startedAt = prev.runStartedAt ?? now;
      return {
        ...base,
        state: "completed",
        activity: "completed",
        completedAt: now,
        runDurationMs: now - startedAt,
        waitingSince: undefined,
        pendingDialog: undefined,
        finalResponse: prev.finalResponse, // captured at message_end
      };
    }

    case "queue_update":
      // Useful signal that work is queued; no state change beyond a touch.
      return { ...base };

    default:
      return null; // events we don't surface (e.g. turn_start, message_update deltas)
  }
}

function ensureWorking(s: SessionState): SessionState {
  // A tool/compaction/retry mid-run means we're working, even if we'd briefly
  // shown "completed" or "responded".
  return s === "working" || s === "awaiting_input" ? s : "working";
}
