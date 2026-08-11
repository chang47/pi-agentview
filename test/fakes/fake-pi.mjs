#!/usr/bin/env node
// Fake pi — a scripted stand-in for `pi --mode rpc`, for OFFLINE deterministic tests.
//
// The dashboard resolves the pi binary through the PI_AGENTVIEW_PI_CLI env var
// (see src/platform/spawn.ts). Point it at THIS file and the broker spawns a
// scripted agent instead of a real one: no model, no API key, no network, and the
// same reply every run. Everything else (broker, IPC, journal, state derivation,
// the TUI) runs for real.
//
// The broker invokes it as:  node fake-pi.mjs --mode rpc --session <jsonl> [--provider p --model m --thinking t]
// It speaks the subset of pi's RPC JSONL protocol the broker actually consumes
// (docs/rpc.md): one JSON object per line on stdout; commands arrive LF-framed on
// stdin.
//
// Scenarios (env PI_AGENTVIEW_FAKE_SCENARIO): "ok" (default) | "slow" | "error" | "dialog".
// Reply text (env PI_AGENTVIEW_FAKE_REPLY): defaults to "OK".
// Custom script (env PI_AGENTVIEW_FAKE_SCRIPT=<json>): [{event,text?,delayMs?,toolName?,target?,args?}, ...]
//   emitted verbatim on each prompt (overrides the scenario). `target`/`args` on a
//   tool_execution_start|update step surface the tool's target (path/command/…).

import { appendFile } from "node:fs/promises";

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const sessionFile = argOf("--session") ?? "";
const scenario = process.env.PI_AGENTVIEW_FAKE_SCENARIO ?? "ok";
const reply = process.env.PI_AGENTVIEW_FAKE_REPLY ?? "OK";

// --- output helpers ---------------------------------------------------------
/** Emit one protocol event as a JSON line on stdout. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function log(...a) {
  // Diagnostics go to stderr; the broker drains stderr and never parses it.
  process.stderr.write("[fake-pi] " + a.join(" ") + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// A session header is the first line a real `pi --mode rpc` prints. The broker
// journals it (deriveState ignores it), so it's optional — emitted for fidelity.
emit({ type: "session", version: 3, id: "fake-session", cwd: process.cwd(), sessionFile });
log(`started scenario=${scenario} session=${sessionFile}`);

// --- scripted transcript per prompt ----------------------------------------
let pendingDialogResolve = null;

/** Append a couple of valid JSONL lines so "remove preserves the JSONL" stays realistic. */
async function touchSessionFile(userMessage) {
  if (!sessionFile) return;
  try {
    await appendFile(
      sessionFile,
      JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: userMessage }] }) + "\n" +
        JSON.stringify({ type: "message", ...assistant(reply) }) + "\n",
    );
  } catch (e) {
    log("touchSessionFile failed:", String(e));
  }
}

async function runScript(steps) {
  for (const s of steps) {
    if (s.delayMs) await sleep(s.delayMs);
    if (s.event === "message_end") emit({ type: "message_end", message: assistant(s.text ?? reply) });
    else if (s.event === "tool_execution_start" || s.event === "tool_execution_update") {
      const e = { type: s.event, toolName: s.toolName ?? "tool" };
      if (s.target !== undefined) e.target = s.target;
      if (s.args !== undefined) e.args = s.args;
      emit(e);
    } else emit({ type: s.event });
  }
}

async function handlePrompt(message) {
  await touchSessionFile(message);

  const custom = process.env.PI_AGENTVIEW_FAKE_SCRIPT;
  if (custom) {
    try {
      await runScript(JSON.parse(custom));
      return;
    } catch (e) {
      log("bad PI_AGENTVIEW_FAKE_SCRIPT, falling back:", String(e));
    }
  }

  const step = scenario === "slow" ? 120 : 8;

  emit({ type: "agent_start" });
  await sleep(step);

  if (scenario === "dialog") {
    // Ask a blocking question; settle only after the broker forwards the answer.
    emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Proceed with the change?" });
    await new Promise((resolve) => {
      pendingDialogResolve = resolve;
    });
  }

  // Carry the tool's target (the parsed tool-call args) so the row shows
  // "tool: edit src/tokenizer.ts", exercising deriveState's target extraction.
  emit({ type: "tool_execution_start", toolName: "edit", args: { file_path: "src/tokenizer.ts" } });
  await sleep(step);

  if (scenario === "error") {
    // A run that ends without a successful settle: message but state stays working
    // until the worker is torn down (models an interrupted/failed run).
    emit({ type: "message_end", message: assistant("something went wrong") });
    log("scenario=error: not settling");
    return;
  }

  emit({ type: "message_end", message: assistant(reply) });
  await sleep(step);
  emit({ type: "agent_settled" });
}

// --- stdin command loop -----------------------------------------------------
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    let line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handleCommand(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

async function handleCommand(msg) {
  switch (msg.type) {
    case "get_state":
      // Correlated request: echo the id, mirror the real pi's shape.
      emit({ type: "response", id: msg.id, command: "get_state", data: { sessionFile, sessionId: "fake-session" } });
      return;
    case "get_messages":
      emit({ type: "response", id: msg.id, command: "get_messages", data: { messages: [] } });
      return;
    case "prompt":
    case "follow_up":
    case "steer":
      await handlePrompt(String(msg.message ?? ""));
      return;
    case "extension_ui_response":
      if (pendingDialogResolve) {
        const r = pendingDialogResolve;
        pendingDialogResolve = null;
        r();
      }
      return;
    case "abort":
      emit({ type: "agent_settled" });
      return;
    default:
      // Unknown correlated command -> generic ack so send() never hangs.
      if (msg.id) emit({ type: "response", id: msg.id, command: msg.type });
      return;
  }
}
