// Core domain types for pi-agentview.
//
// Three layers of state (see design doc):
//   1. Pi JSONL session file — AUTHORITATIVE conversation history (source of truth).
//   2. Registry              — which sessions appear in Agent View + display metadata.
//   3. Broker state          — operational status (working/completed/...), an index.
// Layers 2 and 3 are reconstructable indexes; they must NEVER replace the JSONL.

/** Stable id for a managed (peer-level main) session. */
export type ManagedId = string;

/** Operational state of a managed session, derived from structured RPC events. */
export type SessionState =
  | "working" // an agent run is in progress
  | "completed" // latest requested run settled successfully
  | "awaiting_input" // a blocking extension dialog is open
  | "interrupted" // worker died mid-run; needs human ack before replay
  | "idle" // alive, nothing to do, ready for a prompt
  | "needs_attention" // degraded/recoverable anomaly
  | "stopped" // service stopped; JSONL retained, row resumable
  | "attached"; // a session currently opened in a terminal (claimed), not a broker

/** Display order, most urgent first (matches Claude Code's grouping intent). */
export const STATE_ORDER: SessionState[] = [
  "awaiting_input",
  "attached",
  "working",
  "completed",
  "idle",
  "needs_attention",
  "interrupted",
  "stopped",
];

/** Durable spec to (re)start a broker. Written once at creation; read on restart. */
export interface BrokerSpec {
  id: ManagedId;
  jsonlPath: string; // absolute path to the Pi session JSONL (may not exist yet)
  cwd: string;
  model?: string; // provider/model id; inherits foreground if unset
  thinkingLevel?: string;
  initialTask?: string; // useful because Pi creates the JSONL lazily after a response
  /**
   * Set when the user DELIBERATELY backgrounded this session while a run was in
   * flight. pi has no attach/detach: backgrounding tears down the foreground pi
   * and a fresh headless worker re-opens the JSONL, dropping the live turn. On
   * first start the broker nudges the new worker to pick the work back up
   * (RESUME_CONTINUE_PROMPT) and CLEARS this flag — so it fires exactly once,
   * and only for a user-initiated background, never an unexpected crash.
   */
  resumeOnStart?: boolean;
  createdAt: number;
}

/** Registry row — what shows up in Agent View. */
export interface RegistryEntry {
  id: ManagedId;
  title: string;
  jsonlPath: string;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  createdAt: number;
  /** Path to the durable BrokerSpec (so the view can restart the broker). */
  specPath: string;
  /** IPC address (named pipe on Windows, unix socket elsewhere). */
  socketAddress: string;
  /** Last known broker PID (liveness checked via pid.ts, not timestamp freshness). */
  brokerPid?: number;
}

/** Operational state owned by the broker. Reconstructable from JSONL + RPC. */
export interface BrokerState {
  id: ManagedId;
  state: SessionState;
  activity: string; // e.g. "running tool: edit", "compacting", "streaming response"
  finalResponse?: string; // actual last assistant text (display priority over journal noise)
  runStartedAt?: number;
  runDurationMs?: number;
  completedAt?: number;
  waitingSince?: number;
  lastEventSeq: number; // highest journal sequence number applied
  updatedAt: number;
  /** Active blocking dialog (when state === "awaiting_input"). */
  pendingDialog?: {
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title?: string;
    message?: string;
    options?: string[];
  };
}

/** Ownership claim written by a foreground interactive Pi. */
export interface ForegroundClaim {
  sessionId: string; // Pi session id
  jsonlPath: string;
  title: string;
  /** WHERE `title` came from, so the two title lanes (live claim vs durable
   *  registry) can be reconciled instead of overwriting each other:
   *   "name"     – an explicit Pi session name (strongest signal)
   *   "prompt"   – derived from the first user message
   *   "fallback" – nothing was derivable yet (a placeholder) */
  titleSource?: "name" | "prompt" | "fallback";
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  ownerPid: number;
  nonce: string; // birth token; guards against PID reuse
  updatedAt: number;
}

/** A journaled RPC event, replayable after a frontend reconnect. */
export interface JournalEvent {
  seq: number; // monotonic; clients request replay from lastSeq+1
  type: string; // e.g. "agent_start" | "tool_execution_start" | "agent_settled" | "dialog"
  timestamp: number;
  payload?: unknown;
}

/** Mutation lease over a session (only one holder may prompt/steer/abort/answer). */
export interface Lease {
  holder: string; // opaque client id
  acquiredAt: number;
}
