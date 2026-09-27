// Session transcript for the focus pane: read a pi session JSONL and reduce it to what a person
// wants to read in a terminal — their own messages, the agent's replies, and one condensed line
// per tool call. Thinking blocks, raw tool output (toolResult), and non-message entries
// (session_info, model_change, custom_message, …) are dropped.

import { readFile } from "node:fs/promises";

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string };

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The most telling argument of a tool call, on one line (a bash command, a path, a pattern…). */
function toolSummary(args: unknown): string {
  let a: unknown = args;
  if (typeof args === "string") {
    try {
      a = JSON.parse(args);
    } catch {
      return oneLine(args);
    }
  }
  if (a && typeof a === "object") {
    for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
      const v = (a as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return oneLine(v);
    }
    const first = Object.values(a as Record<string, unknown>).find((v) => typeof v === "string" && v.trim());
    if (typeof first === "string") return oneLine(first);
  }
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Parse a pi session JSONL (as text) into readable transcript items, oldest first. */
export function parseTranscript(raw: string): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a half-written trailing line while the session is live
    }
    if (e.type !== "message" || !e.message) continue;
    const { role, content } = e.message;
    if (role === "user") {
      const text = textOf(content).trim();
      if (text) out.push({ kind: "user", text });
    } else if (role === "assistant") {
      // Keep the order the model produced: text and tool calls interleave within one turn.
      const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [{ type: "text", text: textOf(content) }];
      let pending = "";
      const flush = (): void => {
        if (pending.trim()) out.push({ kind: "assistant", text: pending.trim() });
        pending = "";
      };
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") pending += (pending ? "\n" : "") + b.text;
        else if (b.type === "toolCall") {
          flush();
          out.push({ kind: "tool", name: String(b.name ?? "tool"), summary: toolSummary(b.arguments) });
        }
      }
      flush();
    }
  }
  return out;
}

/** Read + parse a session's transcript. A missing file (pi creates it lazily) is an empty one. */
export async function loadTranscript(jsonlPath: string | undefined): Promise<TranscriptItem[]> {
  if (!jsonlPath) return [];
  try {
    return parseTranscript(await readFile(jsonlPath, "utf8"));
  } catch {
    return [];
  }
}
