// Broker orchestrator: owns one headless pi RPC worker per managed session.
//
// Wires: RPC events -> journal -> state derivation -> IPC broadcast.
// Handles: initial task, dialog answering, conservative interrupt on worker death,
// graceful shutdown, and JSONL-ownership release so the foreground can resume.

import { PiRpcClient, type RpcMessage } from "./rpc-client.js";
import { Journal } from "./journal.js";
import { IpcServer } from "./ipc.js";
import { deriveState, initialState } from "./state.js";
import { acquireLock, readLock, releaseLock } from "./lock.js";
import { BrokerSpecStore, BrokerStateStore } from "../registry.js";
import { brokerLockPath, journalPath, socketAddress } from "../platform/paths.js";
import { isAlive } from "../platform/pid.js";
import { SPEC_WATCH_MS } from "../platform/constants.js";
import type { BrokerState } from "../types.js";

export interface BrokerArgs {
  id: string;
  nonce: string;
}

function parseArgs(argv: string[]): BrokerArgs {
  const out: Partial<BrokerArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i];
    else if (a === "--nonce") out.nonce = argv[++i];
  }
  if (!out.id || !out.nonce) {
    console.error("usage: broker.mjs --id <managedId> --nonce <authNonce>");
    process.exit(2);
  }
  return out as BrokerArgs;
}

export async function runBroker(rawArgv: string[]): Promise<void> {
  const { id, nonce } = parseArgs(rawArgv);
  const pid = process.pid;

  // --- durable spec + lock --------------------------------------------------
  const specStore = new BrokerSpecStore();
  const stateStore = new BrokerStateStore();
  const spec = await specStore.read(id);
  if (!spec) {
    console.error(`[broker] no broker-spec.json for id=${id}; refusing to start`);
    process.exit(3);
  }

  // Reclaim only if no OTHER live broker owns this state dir.
  const existing = await readLock(brokerLockPath(id));
  if (existing && existing.nonce !== nonce && isAlive(existing.pid)) {
    console.error(`[broker] state dir for ${id} is owned by live pid ${existing.pid}; exiting`);
    process.exit(4);
  }
  await acquireLock(brokerLockPath(id), pid, nonce);

  // --- state, journal, rpc, ipc --------------------------------------------
  let state: BrokerState = (await stateStore.read(id)) ?? initialState(id);
  // On restart, a stale "working" must not persist (the run that set it is gone).
  if (state.state === "working") state = { ...state, state: "idle", activity: "ready" };

  const journal = new Journal(journalPath(id));
  await journal.open();

  const rpc = new PiRpcClient({
    jsonlPath: spec.jsonlPath,
    cwd: spec.cwd,
    provider: spec.model?.split("/")[0],
    model: spec.model,
    thinkingLevel: spec.thinkingLevel,
  });

  const ipc = new IpcServer(
    socketAddress(id),
    nonce,
    {
      onRpc: async (command) => {
        // Fire-and-forget ONLY. The old code awaited rpc.send() and, on any
        // failure, re-wrote the same command — but send() also rejects on its
        // 30s timeout, so a slow-but-successful prompt was delivered TWICE.
        // Nothing upstream consumes the response, so there is no reason to
        // correlate one; results arrive as events.
        try {
          rpc.write(command);
        } catch {
          /* worker gone; state derivation reports it via the exit handler */
        }
      },
      onAnswer: (ans) => {
        const resp: RpcMessage = { type: "extension_ui_response", id: ans.id };
        if (ans.cancelled) resp.cancelled = true;
        else if (ans.confirmed !== undefined) resp.confirmed = ans.confirmed;
        else resp.value = ans.value;
        try {
          rpc.write(resp);
        } catch {
          /* worker gone */
        }
      },
      onShutdown: async () => {
        await shutdown();
      },
    },
    { getState: () => state, replay: (from) => journal.replay(from), lastSeq: () => journal.lastSeq },
  );
  await ipc.start();

  // --- wire RPC events -> journal -> state -> broadcast --------------------
  const persistState = async (next: BrokerState): Promise<void> => {
    state = next;
    await stateStore.write(id, state);
    ipc.broadcastState(state);
  };

  rpc.on("message", async (msg: RpcMessage) => {
    // Don't journal command acks; only events + UI requests.
    if (msg.type === "response") return;
    const ev = await journal.append(msg.type, msg);
    ipc.broadcastEvent(ev);
    const next = deriveState(state, msg, ev.seq);
    if (next) await persistState(next);
  });

  // Worker death: conservative interrupt. If idle, the broker can be restarted
  // by the extension; if mid-run, mark interrupted (never auto-replay — a tool
  // may have side-effected before its result persisted).
  rpc.on("exit", async ({ code }) => {
    if (state.state === "working" || state.state === "awaiting_input") {
      await persistState({ ...state, state: "interrupted", activity: `worker exited (code ${code})`, pendingDialog: undefined });
    } else {
      await persistState({ ...state, activity: `worker exited (code ${code})` });
    }
  });

  // --- start worker + optional initial task --------------------------------
  await rpc.start();

  // Send the initial task ONLY on a genuinely first start.
  //
  // The spec is durable and was never cleared, so every broker restart used to
  // re-send it as a fresh prompt — the session would redo its original task on
  // each reconnect/crash-recovery. That also violates the conservative-interrupt
  // invariant (never auto-replay work that may already have side-effected).
  const neverRan = journal.lastSeq === 0 && state.lastEventSeq === 0;
  if (spec.initialTask && neverRan) {
    // Fire the first prompt without awaiting (response arrives via events).
    try {
      rpc.write({ type: "prompt", message: spec.initialTask });
    } catch {
      /* worker not ready yet; extension can resend */
    }
  }

  // --- graceful shutdown ----------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(specWatch);
    try {
      await rpc.stop();
    } catch {
      /* ignore */
    }
    await ipc.stop();
    await journal.close();
    await releaseLock(brokerLockPath(id));
    process.exit(0);
  };

  // Self-reap: if our durable spec is deleted (the row was removed), no client
  // will ever manage us again. Without this a broker+worker pair can outlive its
  // session indefinitely — the observed orphan-process leak.
  const specWatch = setInterval(() => {
    void (async () => {
      if (shuttingDown) return;
      if (!(await specStore.read(id))) await shutdown();
    })();
  }, SPEC_WATCH_MS);
  specWatch.unref?.();

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
