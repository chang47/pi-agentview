var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/platform/constants.ts
var BROKER_CHILD_ENV, STATE_DIR_ENV, SPEC_WATCH_MS, RESUME_CONTINUE_PROMPT;
var init_constants = __esm({
  "src/platform/constants.ts"() {
    "use strict";
    BROKER_CHILD_ENV = "PI_AGENTVIEW_BROKER_CHILD";
    STATE_DIR_ENV = "PI_AGENTVIEW_STATE_DIR";
    SPEC_WATCH_MS = 3e4;
    RESUME_CONTINUE_PROMPT = "Your previous turn was interrupted before it finished (this session was moved to the background). Some steps may have only partly completed. First check the current state of the files and repo, do NOT repeat any command or edit that already ran, then continue where you left off.";
  }
});

// src/platform/paths.ts
import { homedir, platform as platform2 } from "node:os";
import { join as join2 } from "node:path";
function isWin2() {
  return platform2() === "win32";
}
function stateDir() {
  const override = process.env[STATE_DIR_ENV];
  if (override) return override;
  if (isWin2()) {
    return join2(process.env.LOCALAPPDATA ?? join2(homedir(), "AppData", "Local"), PKG);
  }
  if (platform2() === "darwin") {
    return join2(homedir(), "Library", "Application Support", PKG);
  }
  return join2(process.env.XDG_STATE_HOME ?? join2(homedir(), ".local", "state"), PKG);
}
function socketsDir() {
  return join2(stateDir(), "sockets");
}
async function ensureSocketDir(address) {
  if (isWin2()) return;
  const { mkdir: mkdir3, unlink: unlink3 } = await import("node:fs/promises");
  const { dirname: dirname4 } = await import("node:path");
  await mkdir3(dirname4(address), { recursive: true });
  await unlink3(address).catch(() => {
  });
}
function sessionsDir() {
  return join2(stateDir(), "sessions");
}
function sessionDir(id) {
  return join2(sessionsDir(), id);
}
function brokerSpecPath(id) {
  return join2(sessionDir(id), "broker-spec.json");
}
function brokerStatePath(id) {
  return join2(sessionDir(id), "broker-state.json");
}
function brokerLockPath(id) {
  return join2(sessionDir(id), "broker.lock");
}
function journalPath(id) {
  return join2(sessionDir(id), "journal.jsonl");
}
function socketAddress(id) {
  if (isWin2()) {
    return `${PIPE_PREFIX}${PKG}-${id}`;
  }
  return join2(socketsDir(), `${id}.sock`);
}
var PKG, PIPE_PREFIX;
var init_paths = __esm({
  "src/platform/paths.ts"() {
    "use strict";
    init_constants();
    PKG = "pi-agentview";
    PIPE_PREFIX = "\\\\.\\pipe\\";
  }
});

// src/broker/rpc-client.ts
import { spawn as spawn2 } from "node:child_process";
import { EventEmitter } from "node:events";

// src/platform/spawn.ts
init_constants();
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
var ENV_CLI = "PI_AGENTVIEW_PI_CLI";
var cliCache;
function resolvePiCliPath() {
  const override = process.env[ENV_CLI];
  if (override) return override;
  if (cliCache) return cliCache;
  const mainPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const root = resolve(mainPath, "../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi ?? Object.values(pkg.bin)[0];
  if (!binRel) throw new Error("pi package.json has no bin entry");
  cliCache = join(root, binRel);
  return cliCache;
}
function resolvePiCommand() {
  const cli = process.env[ENV_CLI] ?? resolvePiCliPath();
  return { command: process.execPath, preArgs: [cli], shell: false };
}

// src/platform/kill.ts
import { spawn } from "node:child_process";
import { platform } from "node:os";

// src/platform/pid.ts
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function waitForExit(pid, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isAlive(pid);
}

// src/platform/kill.ts
var isWin = platform() === "win32";
async function killTree(pid, graceMs = 3e3) {
  if (isWin) {
    await new Promise((resolve2) => {
      const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      p.on("close", () => resolve2());
      p.on("error", () => resolve2());
    });
    return;
  }
  const sig = (s) => {
    try {
      process.kill(-pid, s);
    } catch {
    }
    try {
      process.kill(pid, s);
    } catch {
    }
  };
  sig("SIGTERM");
  if (await waitForExit(pid, graceMs)) return;
  sig("SIGKILL");
  await waitForExit(pid, 1e3);
}

// src/broker/rpc-client.ts
init_constants();
var PiRpcClient = class extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
  }
  proc = null;
  buffer = "";
  nextReqId = 1;
  pending = /* @__PURE__ */ new Map();
  alive = false;
  get isAlive() {
    return this.alive;
  }
  async start() {
    const { command, preArgs, shell } = resolvePiCommand();
    const args = [...preArgs, "--mode", "rpc", "--session", this.opts.jsonlPath];
    if (this.opts.provider) args.push("--provider", this.opts.provider);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.thinkingLevel) args.push("--thinking", this.opts.thinkingLevel);
    this.proc = spawn2(command, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      windowsHide: true,
      // The worker loads USER-scope extensions — including pi-agentview itself.
      // This stamp tells our extension to refuse the fleet-manager role inside
      // the worker. Without it the worker claims its own session as "attached"
      // and recursively reconciles/spawns brokers for the whole fleet.
      env: { ...process.env, [BROKER_CHILD_ENV]: "1" }
    });
    this.alive = true;
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr?.on("data", () => {
    });
    this.proc.on("error", (err) => {
      this.alive = false;
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this.alive = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("rpc worker exited"));
      }
      this.emit("exit", { code, signal });
    });
  }
  onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }
  handleMessage(msg) {
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
    }
    this.emit("message", msg);
    this.emit(msg.type, msg);
  }
  /** Send a command, await its `response`. Rejects on 30s timeout or worker death. */
  send(command) {
    return new Promise((resolve2, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("rpc worker stdin not writable"));
        return;
      }
      const id = `c-${this.nextReqId++}`;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`rpc timeout: ${command.type}`));
        }
      }, 3e4);
      this.pending.set(id, { resolve: resolve2, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }
  /** Fire-and-forget write (prompt during stream, extension_ui_response, abort). */
  write(command) {
    if (!this.proc?.stdin?.writable) throw new Error("rpc worker stdin not writable");
    this.proc.stdin.write(JSON.stringify(command) + "\n");
  }
  /** Stop the worker: close stdin, then force the process tree.
   *  MUST actually end the process — it holds the session JSONL open, and a
   *  survivor becomes an orphan that blocks the file for interactive resume. */
  async stop(graceMs = 2500) {
    const proc = this.proc;
    if (!proc) return;
    const pid = proc.pid;
    try {
      proc.stdin?.end();
    } catch {
    }
    const exited = await new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve2(true);
      };
      proc.once("exit", done);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve2(false);
      }, graceMs);
    });
    if (!exited && pid !== void 0) {
      await killTree(pid, 1e3).catch(() => void 0);
    }
    this.alive = false;
    this.proc = null;
  }
};

// src/broker/journal.ts
import { open, readFile } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
import { mkdir } from "node:fs/promises";
var RING_CAP = 2e3;
var Journal = class {
  constructor(path) {
    this.path = path;
  }
  seq = 0;
  ring = [];
  fh = null;
  async open() {
    try {
      const data = await readFile(this.path, "utf8");
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
        } catch {
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await mkdir(dirname2(this.path), { recursive: true });
    this.fh = await open(this.path, "a");
  }
  /** Append an event, assign the next seq, persist, keep in the ring. */
  async append(type, payload) {
    const ev = { seq: ++this.seq, type, timestamp: Date.now(), payload };
    this.ring.push(ev);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    await this.fh.write(JSON.stringify(ev) + "\n");
    return ev;
  }
  /** Events with seq > fromSeq (for client catch-up after reconnect). */
  replay(fromSeq) {
    return this.ring.filter((e) => e.seq > fromSeq);
  }
  get lastSeq() {
    return this.seq;
  }
  async close() {
    await this.fh?.close().catch(() => {
    });
    this.fh = null;
  }
};

// src/broker/ipc.ts
init_paths();
import { createServer } from "node:net";
var IpcServer = class {
  constructor(address, nonce, handlers, snap) {
    this.address = address;
    this.nonce = nonce;
    this.handlers = handlers;
    this.snap = snap;
  }
  server = null;
  conns = /* @__PURE__ */ new Map();
  leaseHolder;
  async start() {
    await ensureSocketDir(this.address);
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise((resolve2, reject) => {
      const onError = (e) => reject(e);
      this.server.once("error", onError);
      this.server.listen(this.address, () => {
        this.server.off("error", onError);
        resolve2();
      });
    });
  }
  onConnection(socket) {
    const conn = { socket, authed: false, buffer: "" };
    this.conns.set(socket, conn);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(conn, chunk));
    socket.on("close", () => this.cleanup(socket));
    socket.on("error", () => this.cleanup(socket));
  }
  onData(conn, chunk) {
    conn.buffer += chunk;
    let nl;
    while ((nl = conn.buffer.indexOf("\n")) >= 0) {
      let line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void this.handleMessage(conn, msg);
    }
  }
  async handleMessage(conn, msg) {
    if (!conn.authed) {
      if (msg["type"] === "hello") {
        const nonce = msg["nonce"];
        if (nonce === this.nonce) {
          conn.authed = true;
          conn.clientId = msg["clientId"] ?? `anon-${Date.now()}`;
          const lastSeq = Number(msg["lastSeq"]) || 0;
          const pending = this.snap.replay(lastSeq);
          this.send(conn, { type: "auth_ok", lastSeq: this.snap.lastSeq() });
          this.send(conn, { type: "snapshot", state: this.snap.getState() });
          for (const e of pending) this.send(conn, { type: "event", event: e });
          this.send(conn, { type: "lease", holder: this.leaseHolder ?? null });
        } else {
          this.send(conn, { type: "auth_fail" });
          conn.socket.end();
        }
      }
      return;
    }
    switch (msg["type"]) {
      case "acquire_lease": {
        if (this.leaseHolder === void 0 || this.leaseHolder === conn.clientId) {
          this.leaseHolder = conn.clientId;
          this.broadcast({ type: "lease", holder: this.leaseHolder ?? null });
        }
        break;
      }
      case "release_lease": {
        if (this.leaseHolder === conn.clientId) {
          this.leaseHolder = void 0;
          this.broadcast({ type: "lease", holder: null });
        }
        break;
      }
      case "rpc": {
        if (!this.hasLease(conn)) break;
        await this.handlers.onRpc(msg["command"]);
        break;
      }
      case "answer": {
        if (!this.hasLease(conn)) break;
        this.handlers.onAnswer({
          id: String(msg["id"]),
          value: msg["value"],
          confirmed: msg["confirmed"],
          cancelled: msg["cancelled"]
        });
        break;
      }
      case "shutdown": {
        if (!this.hasLease(conn)) break;
        await this.handlers.onShutdown();
        break;
      }
    }
  }
  hasLease(conn) {
    return this.leaseHolder !== void 0 && this.leaseHolder === conn.clientId;
  }
  // --- broadcasts -----------------------------------------------------------
  broadcastState(state) {
    this.broadcast({ type: "state", state });
  }
  broadcastSnapshot(state) {
    for (const conn of this.conns.values()) {
      if (conn.authed) this.send(conn, { type: "snapshot", state });
    }
  }
  broadcastEvent(event) {
    this.broadcast({ type: "event", event });
  }
  replayTo(conn, events) {
    for (const e of events) this.send(conn, { type: "event", event: e });
  }
  leaseHolderId() {
    return this.leaseHolder;
  }
  broadcast(msg) {
    const data = JSON.stringify(msg) + "\n";
    for (const conn of this.conns.values()) {
      if (conn.authed) conn.socket.write(data);
    }
  }
  send(conn, msg) {
    conn.socket.write(JSON.stringify(msg) + "\n");
  }
  cleanup(socket) {
    const conn = this.conns.get(socket);
    if (conn && this.leaseHolder === conn.clientId) {
      this.leaseHolder = void 0;
      this.broadcast({ type: "lease", holder: null });
    }
    this.conns.delete(socket);
  }
  authedClientCount() {
    let n = 0;
    for (const c of this.conns.values()) if (c.authed) n++;
    return n;
  }
  /** Expose conns for the broker to send per-client snapshots/replay on auth. */
  getAuthedClients() {
    return [...this.conns.values()].filter((c) => c.authed);
  }
  async stop() {
    for (const conn of this.conns.values()) conn.socket.destroy();
    this.conns.clear();
    await new Promise((resolve2) => {
      if (!this.server) return resolve2();
      this.server.close(() => resolve2());
    });
    if (process.platform !== "win32") {
      const { unlink: unlink3 } = await import("node:fs/promises");
      await unlink3(this.address).catch(() => {
      });
    }
  }
};

// src/broker/state.ts
function initialState(id) {
  return {
    id,
    state: "idle",
    activity: "ready",
    lastEventSeq: 0,
    updatedAt: Date.now()
  };
}
function assistantText(message) {
  const m = message;
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return void 0;
  const text = m.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  return text || void 0;
}
function summarize(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? oneLine.slice(0, 117) + "\u2026" : oneLine;
}
var TOOL_TARGET_KEYS = [
  "file_path",
  "filePath",
  "path",
  "file",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "name"
];
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
function toolTarget(ev) {
  const args = ev.args ?? ev.arguments ?? ev.input;
  const raw = firstString(ev.target) ?? (args && typeof args === "object" ? firstString(...TOOL_TARGET_KEYS.map((k) => args[k])) : void 0);
  if (!raw) return void 0;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? oneLine.slice(0, 47) + "\u2026" : oneLine;
}
function toolActivity(name, target) {
  return target ? `tool: ${name} ${target}` : `tool: ${name}`;
}
function toolNameFromActivity(activity) {
  const m = /^tool:\s+(\S+)/.exec(activity);
  return m ? m[1] : void 0;
}
function deriveState(prev, ev, seq) {
  const now = Date.now();
  const base = { ...prev, lastEventSeq: seq, updatedAt: now };
  const dialogMethods = /* @__PURE__ */ new Set(["select", "confirm", "input", "editor"]);
  switch (ev.type) {
    case "agent_start":
      return { ...base, state: "working", activity: "running", runStartedAt: now, completedAt: void 0, pendingDialog: void 0 };
    case "tool_execution_start": {
      const name = String(ev.toolName ?? "tool");
      return { ...base, state: ensureWorking(base.state), activity: toolActivity(name, toolTarget(ev)) };
    }
    case "tool_execution_update": {
      const target = toolTarget(ev);
      if (ev.toolName === void 0 && target === void 0) return { ...base };
      const name = ev.toolName !== void 0 ? String(ev.toolName) : toolNameFromActivity(base.activity) ?? "tool";
      return { ...base, state: ensureWorking(base.state), activity: toolActivity(name, target) };
    }
    case "compaction_start":
      return { ...base, state: ensureWorking(base.state), activity: "compacting context" };
    case "auto_retry_start": {
      const attempt = ev.attempt ?? 1;
      return { ...base, state: ensureWorking(base.state), activity: `retrying (attempt ${attempt})` };
    }
    case "message_end": {
      const text = assistantText(ev.message);
      if (text !== void 0) {
        return { ...base, finalResponse: text.slice(0, 4e3), activity: base.state === "awaiting_input" ? base.activity : "responded" };
      }
      return { ...base };
    }
    case "extension_ui_request": {
      const method = ev.method;
      if (!method || !dialogMethods.has(method)) return { ...base };
      const d = {
        id: String(ev.id),
        method,
        title: ev.title,
        message: ev.message,
        options: ev.options
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
        waitingSince: void 0,
        pendingDialog: void 0,
        finalResponse: prev.finalResponse
        // captured at message_end
      };
    }
    case "queue_update":
      return { ...base };
    default:
      return null;
  }
}
function ensureWorking(s) {
  return s === "working" || s === "awaiting_input" ? s : "working";
}

// src/broker/lock.ts
import { readFile as readFile2, unlink as unlink2 } from "node:fs/promises";

// src/platform/atomic.ts
import { writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
var MAX_RETRIES = 6;
var BASE_DELAY_MS = 40;
var RETRYABLE = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ECIRCUIT"]);
async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data, "utf8");
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      const code = e.code;
      if (code && RETRYABLE.has(code)) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (i + 1)));
        continue;
      }
      await unlink(tmp).catch(() => {
      });
      throw e;
    }
  }
  try {
    await unlink(path);
  } catch {
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw lastErr ?? e;
  }
}

// src/broker/lock.ts
async function readLock(path) {
  try {
    return JSON.parse(await readFile2(path, "utf8"));
  } catch {
    return null;
  }
}
async function acquireLock(path, pid, nonce) {
  await atomicWrite(path, JSON.stringify({ pid, nonce, startedAt: Date.now() }));
}
async function releaseLock(path) {
  await unlink2(path).catch(() => {
  });
}

// src/registry.ts
import { readFile as readFile3, mkdir as mkdir2, readdir, stat } from "node:fs/promises";
import { dirname as dirname3, join as join3 } from "node:path";
init_constants();
init_paths();
var BrokerStateStore = class {
  async read(id) {
    try {
      return JSON.parse(await readFile3(brokerStatePath(id), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return void 0;
      return void 0;
    }
  }
  async write(id, state) {
    await mkdir2(dirname3(brokerStatePath(id)), { recursive: true });
    await atomicWrite(brokerStatePath(id), JSON.stringify(state, null, 2));
  }
};
var BrokerSpecStore = class {
  async read(id) {
    try {
      return JSON.parse(await readFile3(brokerSpecPath(id), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return void 0;
      return void 0;
    }
  }
  async write(spec) {
    await mkdir2(dirname3(brokerSpecPath(spec.id)), { recursive: true });
    await atomicWrite(brokerSpecPath(spec.id), JSON.stringify(spec, null, 2));
  }
  async remove(id) {
    try {
      await unlinkQuiet(brokerSpecPath(id));
    } catch {
    }
  }
};
async function unlinkQuiet(p) {
  const { unlink: unlink3 } = await import("node:fs/promises");
  await unlink3(p).catch(() => {
  });
}

// src/broker/main.ts
init_paths();
init_constants();
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i];
    else if (a === "--nonce") out.nonce = argv[++i];
  }
  if (!out.id || !out.nonce) {
    console.error("usage: broker.mjs --id <managedId> --nonce <authNonce>");
    process.exit(2);
  }
  return out;
}
async function runBroker(rawArgv) {
  const { id, nonce } = parseArgs(rawArgv);
  const pid = process.pid;
  const specStore = new BrokerSpecStore();
  const stateStore = new BrokerStateStore();
  const spec = await specStore.read(id);
  if (!spec) {
    console.error(`[broker] no broker-spec.json for id=${id}; refusing to start`);
    process.exit(3);
  }
  const existing = await readLock(brokerLockPath(id));
  if (existing && existing.nonce !== nonce && isAlive(existing.pid)) {
    console.error(`[broker] state dir for ${id} is owned by live pid ${existing.pid}; exiting`);
    process.exit(4);
  }
  await acquireLock(brokerLockPath(id), pid, nonce);
  let state = await stateStore.read(id) ?? initialState(id);
  if (state.state === "working") state = { ...state, state: "idle", activity: "ready" };
  const journal = new Journal(journalPath(id));
  await journal.open();
  const rpc = new PiRpcClient({
    jsonlPath: spec.jsonlPath,
    cwd: spec.cwd,
    provider: spec.model?.split("/")[0],
    model: spec.model,
    thinkingLevel: spec.thinkingLevel
  });
  const ipc = new IpcServer(
    socketAddress(id),
    nonce,
    {
      onRpc: async (command) => {
        try {
          rpc.write(command);
        } catch {
        }
      },
      onAnswer: (ans) => {
        const resp = { type: "extension_ui_response", id: ans.id };
        if (ans.cancelled) resp.cancelled = true;
        else if (ans.confirmed !== void 0) resp.confirmed = ans.confirmed;
        else resp.value = ans.value;
        try {
          rpc.write(resp);
        } catch {
        }
      },
      onShutdown: async () => {
        await shutdown();
      }
    },
    { getState: () => state, replay: (from) => journal.replay(from), lastSeq: () => journal.lastSeq }
  );
  await ipc.start();
  const persistState = async (next) => {
    state = next;
    await stateStore.write(id, state);
    ipc.broadcastState(state);
  };
  rpc.on("message", async (msg) => {
    if (msg.type === "response") return;
    const ev = await journal.append(msg.type, msg);
    ipc.broadcastEvent(ev);
    const next = deriveState(state, msg, ev.seq);
    if (next) await persistState(next);
  });
  rpc.on("exit", async ({ code }) => {
    if (state.state === "working" || state.state === "awaiting_input") {
      await persistState({ ...state, state: "interrupted", activity: `worker exited (code ${code})`, pendingDialog: void 0 });
    } else {
      await persistState({ ...state, activity: `worker exited (code ${code})` });
    }
  });
  await rpc.start();
  const neverRan = journal.lastSeq === 0 && state.lastEventSeq === 0;
  if (spec.initialTask && neverRan) {
    try {
      rpc.write({ type: "prompt", message: spec.initialTask });
    } catch {
    }
  } else if (spec.resumeOnStart) {
    await specStore.write({ ...spec, resumeOnStart: false });
    try {
      rpc.write({ type: "prompt", message: RESUME_CONTINUE_PROMPT });
    } catch {
    }
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(specWatch);
    try {
      await rpc.stop();
    } catch {
    }
    await ipc.stop();
    await journal.close();
    await releaseLock(brokerLockPath(id));
    process.exit(0);
  };
  const specWatch = setInterval(() => {
    void (async () => {
      if (shuttingDown) return;
      if (!await specStore.read(id)) await shutdown();
    })();
  }, SPEC_WATCH_MS);
  specWatch.unref?.();
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

// src/broker.ts
runBroker(process.argv.slice(2)).catch((e) => {
  console.error("[broker] fatal:", e);
  process.exit(1);
});
