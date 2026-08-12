// Broker smoke test. Run via jiti:  node <jiti-cli.mjs> smoke-broker.ts
import { createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PiRpcClient } from "./src/broker/rpc-client.js";
import { Journal } from "./src/broker/journal.js";
import { deriveState, initialState } from "./src/broker/state.js";
import { IpcServer } from "./src/broker/ipc.js";
import { BrokerSpecStore } from "./src/registry.js";
import { socketAddress, brokerStatePath } from "./src/platform/paths.js";
import { newNonce } from "./src/platform/pid.js";
import { PI_CLI_ENV, STATE_DIR_ENV } from "./src/platform/constants.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BROKER_MJS = join(__dirname, "dist", "broker.mjs");
const FAKE_PI = join(__dirname, "test", "fakes", "fake-pi.mjs");

// Route EVERY `pi --mode rpc` spawn in this suite through the fake worker, so the
// whole broker smoke runs offline — no model, no credentials, no network. We are
// testing the real PiRpcClient / broker / IPC / journal / state code against a
// scripted agent; the real-pi integration check lives in a separate gated test.
process.env[PI_CLI_ENV] = FAKE_PI;

console.log(`broker smoke test — platform: ${process.platform}, node ${process.version}`);

// ---------------------------------------------------------------------------
// PART 1 — real PiRpcClient: spawn pi --mode rpc, round-trip get_state.
// ---------------------------------------------------------------------------
console.log("\n[1] PiRpcClient real (spawn pi --mode rpc, get_state)");
{
  const tmp = await mkdtemp(join(tmpdir(), "rpc-"));
  const jsonl = join(tmp, "s.jsonl");
  const rpc = new PiRpcClient({ jsonlPath: jsonl, cwd: tmp });
  await rpc.start();
  const resp = await rpc.send({ type: "get_state" });
  ok("get_state responded", resp.type === "response" && resp.command === "get_state", JSON.stringify(resp).slice(0, 120));
  const data = resp.data as { sessionFile?: string; sessionId?: string } | undefined;
  ok("response has sessionFile", typeof data?.sessionFile === "string");
  await rpc.stop();
  await rm(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// PART 2 — synthetic: Journal + deriveState + IpcServer.
// ---------------------------------------------------------------------------
console.log("\n[2a] Journal append + replay");
{
  const tmp = await mkdtemp(join(tmpdir(), "j-"));
  const jpath = join(tmp, "j.jsonl");
  const j = new Journal(jpath);
  await j.open();
  await j.append("agent_start");
  await j.append("tool_execution_start", { toolName: "bash" });
  await j.append("agent_settled");
  ok("seq is monotonic (3)", j.lastSeq === 3, `lastSeq=${j.lastSeq}`);
  ok("replay(1) returns 2 events", j.replay(1).length === 2, `len=${j.replay(1).length}`);
  ok("replay(0) returns 3 events", j.replay(0).length === 3);
  await j.close();
  // Reopen persists seq.
  const j2 = new Journal(jpath);
  await j2.open();
  ok("reopened journal recovers high-water seq", j2.lastSeq === 3, `lastSeq=${j2.lastSeq}`);
  await j2.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log("\n[2b] deriveState transitions");
{
  const id = "syn";
  let st = initialState(id);
  st = deriveState(st, { type: "agent_start" }, 1) ?? st;
  ok("agent_start -> working", st.state === "working");
  st = deriveState(st, { type: "tool_execution_start", toolName: "bash" }, 2) ?? st;
  ok("tool -> activity 'tool: bash'", st.activity === "tool: bash");
  // Live tool detail (#10): a tool event's target/args surface next to the name.
  {
    let ts = deriveState(initialState("tool"), { type: "agent_start" }, 1)!;
    ts = deriveState(ts, { type: "tool_execution_start", toolName: "edit", args: { file_path: "src/tokenizer.ts" } }, 2) ?? ts;
    ok("tool_execution_start surfaces target", ts.activity === "tool: edit src/tokenizer.ts", `activity=${ts.activity}`);
    ts = deriveState(ts, { type: "tool_execution_update", target: "src/lexer.ts" }, 3) ?? ts;
    ok("tool_execution_update refines target (keeps name)", ts.activity === "tool: edit src/lexer.ts", `activity=${ts.activity}`);
    const before = ts.activity;
    ts = deriveState(ts, { type: "tool_execution_update" }, 4) ?? ts;
    ok("empty tool_execution_update keeps the current activity", ts.activity === before, `activity=${ts.activity}`);
  }
  st = deriveState(st, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All done here." }] } }, 3) ?? st;
  ok("message_end captures finalResponse", st.finalResponse === "All done here.", `finalResponse=${st.finalResponse}`);
  st = deriveState(st, { type: "agent_settled" }, 4) ?? st;
  ok("agent_settled -> completed", st.state === "completed");
  ok("completed records runDurationMs", typeof st.runDurationMs === "number");
  // dialog -> awaiting_input
  st = deriveState(st, { type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow rm -rf?" }, 5) ?? st;
  ok("dialog -> awaiting_input", st.state === "awaiting_input", `state=${st.state}`);
  ok("pendingDialog captured", st.pendingDialog?.id === "d1" && st.pendingDialog?.method === "confirm");
}

console.log("\n[2c] IpcServer auth + snapshot + broadcast + lease");
{
  const id = "ipc-syn";
  const addr = socketAddress(id);
  const nonce = newNonce();
  let state = initialState(id);
  const j = new Journal(join(await mkdtemp(join(tmpdir(), "ipc-")), "j.jsonl"));
  await j.open();
  await j.append("agent_start");

  const srv = new IpcServer(
    addr,
    nonce,
    { onRpc: async () => {}, onAnswer: () => {}, onShutdown: async () => {} },
    { getState: () => state, replay: (f) => j.replay(f), lastSeq: () => j.lastSeq },
  );
  await srv.start();

  const c = await connectRetry(addr);
  const inbox: any[] = [];
  pipeInto(c, inbox);
  c.write(JSON.stringify({ type: "hello", nonce, clientId: "client-A", lastSeq: 0 }) + "\n");
  await sleep(150);
  ok("auth_ok received", inbox.some((m) => m.type === "auth_ok"));
  ok("snapshot received", inbox.some((m) => m.type === "snapshot"));
  ok("replayed 1 event", inbox.filter((m) => m.type === "event").length === 1, `events=${inbox.filter((m) => m.type === "event").length}`);

  // broadcast a new event + state change
  const ev = await j.append("tool_execution_start", { toolName: "edit" });
  state = { ...state, state: "working", activity: "tool: edit" };
  srv.broadcastEvent(ev);
  srv.broadcastState(state);
  await sleep(150);
  ok("client received broadcast event", inbox.some((m) => m.type === "event" && m.event?.type === "tool_execution_start"));
  ok("client received state update", inbox.some((m) => m.type === "state" && m.state?.state === "working"));

  // lease
  c.write(JSON.stringify({ type: "acquire_lease" }) + "\n");
  await sleep(150);
  ok("lease granted to client-A", inbox.some((m) => m.type === "lease" && m.holder === "client-A"));

  // wrong nonce rejected
  const c2 = await connectRetry(addr);
  const inbox2: any[] = [];
  pipeInto(c2, inbox2);
  c2.write(JSON.stringify({ type: "hello", nonce: "wrong", clientId: "client-B", lastSeq: 0 }) + "\n");
  await sleep(150);
  ok("wrong nonce -> auth_fail", inbox2.some((m) => m.type === "auth_fail"));

  c.destroy();
  c2.destroy();
  await srv.stop();
  await j.close();
}

// ---------------------------------------------------------------------------
// PART 3 — real broker subprocess e2e (tiny prompt through the whole chain).
// ---------------------------------------------------------------------------
console.log("\n[3] Broker subprocess e2e (spawn dist/broker.mjs, IPC, tiny prompt)");
{
  // Isolated state dir so the spec we write and the broker we spawn agree on it
  // (nothing lands in the machine-wide default). The broker inherits process.env,
  // so setting it here reaches the broker child. PI_CLI_ENV -> fake is set at the
  // top of this file.
  const stateTmp = await mkdtemp(join(tmpdir(), "e2e-state-"));
  process.env[STATE_DIR_ENV] = stateTmp;

  const id = "e2e-" + Date.now();
  const nonce = newNonce();
  const tmp = await mkdtemp(join(tmpdir(), "e2e-"));
  const jsonl = join(tmp, "s.jsonl");

  const specStore = new BrokerSpecStore();
  await specStore.write({
    id,
    jsonlPath: jsonl,
    cwd: tmp,
    model: "fake/echo",
    thinkingLevel: "low",
    initialTask: "Reply with exactly the two characters: OK",
    createdAt: Date.now(),
  });

  const child = spawn(process.execPath, [BROKER_MJS, "--id", id, "--nonce", nonce], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const brokerErr: string[] = [];
  child.stdout?.setEncoding("utf8").on("data", () => {}); // drain (broker logs to stderr)
  child.stderr?.setEncoding("utf8").on("data", (d: string) => brokerErr.push(d));

  const addr = socketAddress(id);
  const c = await connectRetry(addr, 40, 250); // broker may take a few seconds to boot pi
  const inbox: any[] = [];
  pipeInto(c, inbox);
  c.write(JSON.stringify({ type: "hello", nonce, clientId: "fe", lastSeq: 0 }) + "\n");

  // Wait until we see agent_start, then agent_settled (timeout 90s).
  const sawStart = await waitFor(() => inbox.some((m) => m.type === "event" && m.event?.type === "agent_start"), 90_000, 300);
  ok("observed agent_start event", sawStart);
  const sawSettled = await waitFor(
    () => inbox.some((m) => m.type === "event" && m.event?.type === "agent_settled"),
    90_000,
    300,
  );
  ok("observed agent_settled event", sawSettled, brokerErr.join("").slice(0, 300));

  // The completed state may arrive as a live "state" broadcast (client connected
  // mid-run) OR only in the connect "snapshot" (a fast worker settles before the
  // client connects — the fake does). Read the latest state-bearing message from
  // either, and wait for it: the state broadcast trails its event by a tick.
  const latestState = () => inbox.filter((m) => m.type === "state" || m.type === "snapshot").map((m) => m.state).pop();
  const sawCompleted = await waitFor(() => latestState()?.state === "completed", 90_000, 100);
  ok("final state is completed", sawCompleted, `state=${latestState()?.state}`);
  const finalState = latestState();
  ok("finalResponse captured", typeof finalState?.finalResponse === "string" && finalState.finalResponse.length > 0, `finalResponse=${finalState?.finalResponse}`);

  // shutdown via IPC
  c.write(JSON.stringify({ type: "acquire_lease" }) + "\n");
  await sleep(150);
  c.write(JSON.stringify({ type: "shutdown" }) + "\n");
  const exited = await waitFor(() => child.exitCode !== null, 10_000, 200);
  ok("broker shut down cleanly via IPC", exited && child.exitCode === 0, `exitCode=${child.exitCode}`);

  c.destroy();
  await rm(tmp, { recursive: true, force: true });
  // The isolated state dir holds every broker artifact for this run; drop it whole.
  await rm(stateTmp, { recursive: true, force: true }).catch(() => {});
  delete process.env[STATE_DIR_ENV];
}

// ---------------------------------------------------------------------------
// PART 4 — G1: a restarted broker rebuilds state from the JSONL journal.
// Kill the broker hard, DELETE the state-store snapshot (forcing the exact G1
// failure mode — BrokerStateStore.read -> undefined -> idle/ready, no reply),
// then restart with a fresh nonce and assert the row keeps its last reply.
// ---------------------------------------------------------------------------
console.log("\n[4] Broker restart rebuilds state from JSONL (kill, drop state-store, restart)");
{
  const stateTmp = await mkdtemp(join(tmpdir(), "restart-state-"));
  process.env[STATE_DIR_ENV] = stateTmp;
  process.env.PI_AGENTVIEW_FAKE_REPLY = "PONG_RESTART";

  const id = "restart-" + Date.now();
  const tmp = await mkdtemp(join(tmpdir(), "restart-"));
  const jsonl = join(tmp, "s.jsonl");

  const specStore = new BrokerSpecStore();
  await specStore.write({
    id,
    jsonlPath: jsonl,
    cwd: tmp,
    model: "fake/echo",
    thinkingLevel: "low",
    initialTask: "Reply with PONG_RESTART",
    createdAt: Date.now(),
  });

  // --- v1: run to completion; capture the reply the row must survive. -------
  const nonce1 = newNonce();
  const v1 = spawn(process.execPath, [BROKER_MJS, "--id", id, "--nonce", nonce1], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const v1err: string[] = [];
  v1.stdout?.setEncoding("utf8").on("data", () => {});
  v1.stderr?.setEncoding("utf8").on("data", (d: string) => v1err.push(d));

  let c = await connectRetry(socketAddress(id), 40, 250);
  let inbox: any[] = [];
  pipeInto(c, inbox);
  c.write(JSON.stringify({ type: "hello", nonce: nonce1, clientId: "fe", lastSeq: 0 }) + "\n");

  const settled1 = await waitFor(
    () => inbox.some((m) => m.type === "event" && m.event?.type === "agent_settled"),
    90_000,
    300,
  );
  ok("v1 reached agent_settled", settled1, v1err.join("").slice(0, 300));
  const latest1 = () => inbox.filter((m) => m.type === "state" || m.type === "snapshot").map((m) => m.state).pop();
  const completed1 = await waitFor(() => latest1()?.state === "completed", 90_000, 100);
  ok("v1 final state is completed", completed1, `state=${latest1()?.state}`);
  ok("v1 captured finalResponse", latest1()?.finalResponse === "PONG_RESTART", `finalResponse=${latest1()?.finalResponse}`);

  // --- kill v1 HARD (no graceful shutdown), then force the G1 failure mode:
  //     delete the state-store snapshot so the JSONL is the only source left. --
  c.destroy();
  v1.kill("SIGKILL");
  // On Windows a signal kill terminates via TerminateProcess: exitCode stays
  // null and signalCode is set. Either means the child is dead.
  const v1Died = await waitFor(() => v1.exitCode !== null || v1.signalCode !== null, 10_000, 100);
  ok("v1 killed", v1Died, `exitCode=${v1.exitCode} signal=${v1.signalCode}`);
  await rm(brokerStatePath(id), { force: true });
  ok("state-store snapshot removed (forces JSONL-only rebuild)", !(await fileExists(brokerStatePath(id))));

  // --- v2: fresh broker + fresh nonce, same id + state dir. Must rebuild. ----
  const nonce2 = newNonce();
  const v2 = spawn(process.execPath, [BROKER_MJS, "--id", id, "--nonce", nonce2], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const v2err: string[] = [];
  v2.stdout?.setEncoding("utf8").on("data", () => {});
  v2.stderr?.setEncoding("utf8").on("data", (d: string) => v2err.push(d));

  c = await connectRetry(socketAddress(id), 40, 250);
  inbox = [];
  pipeInto(c, inbox);
  c.write(JSON.stringify({ type: "hello", nonce: nonce2, clientId: "fe", lastSeq: 0 }) + "\n");
  await waitFor(() => inbox.some((m) => m.type === "auth_ok"), 5_000, 100);

  // The rebuilt snapshot is served on connect (getState -> in-memory rebuild).
  const snap2 = () => inbox.filter((m) => m.type === "snapshot" || m.type === "state").map((m) => m.state).pop();
  const rebuilt = await waitFor(() => typeof snap2()?.finalResponse === "string", 5_000, 100);
  const row2 = snap2();
  ok("v2 rebuilt state from JSONL (completed)", rebuilt && row2?.state === "completed", `state=${row2?.state} err=${v2err.join("").slice(0, 200)}`);
  ok("v2 kept the last reply from JSONL", row2?.finalResponse === "PONG_RESTART", `finalResponse=${row2?.finalResponse}`);

  // shutdown v2 cleanly
  c.write(JSON.stringify({ type: "acquire_lease" }) + "\n");
  await sleep(150);
  c.write(JSON.stringify({ type: "shutdown" }) + "\n");
  const v2Exited = await waitFor(() => v2.exitCode !== null, 10_000, 200);
  ok("v2 shut down cleanly via IPC", v2Exited && v2.exitCode === 0, `exitCode=${v2.exitCode}`);

  c.destroy();
  await rm(tmp, { recursive: true, force: true });
  await rm(stateTmp, { recursive: true, force: true }).catch(() => {});
  delete process.env[STATE_DIR_ENV];
  delete process.env.PI_AGENTVIEW_FAKE_REPLY;
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// --- helpers ---------------------------------------------------------------
function pipeInto(s: Socket, inbox: any[]): void {
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        inbox.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  });
}

async function connectRetry(addr: string, attempts = 30, delayMs = 200): Promise<Socket> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(addr, () => resolve(s));
        s.on("error", reject);
      });
    } catch (e) {
      lastErr = e;
      await sleep(delayMs);
    }
  }
  throw new Error(`could not connect to ${addr}: ${lastErr}`);
}

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
