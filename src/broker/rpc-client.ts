// Pi RPC client: spawns `pi --mode rpc` and speaks the JSONL protocol.
//
// Framing rule (from docs/rpc.md): split on LF only, strip an optional trailing
// CR. Node's `readline` is NOT compliant (it also splits on U+2028/U+2029, which
// are valid inside JSON strings), so we buffer manually.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolvePiCommand } from "../platform/spawn.js";
import { killTree } from "../platform/kill.js";
import { BROKER_CHILD_ENV } from "../platform/constants.js";

export interface RpcMessage {
  type: string;
  id?: string;
  [k: string]: unknown;
}

export interface RpcSpawnOptions {
  jsonlPath: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

/** Wraps a headless `pi --mode rpc` worker: framed I/O, request/response correlation. */
export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextReqId = 1;
  private pending = new Map<string, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private alive = false;

  constructor(private opts: RpcSpawnOptions) {
    super();
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    const { command, preArgs, shell } = resolvePiCommand();
    const args = [...preArgs, "--mode", "rpc", "--session", this.opts.jsonlPath];
    if (this.opts.provider) args.push("--provider", this.opts.provider);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.thinkingLevel) args.push("--thinking", this.opts.thinkingLevel);

    this.proc = spawn(command, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      windowsHide: true,
      // The worker loads USER-scope extensions — including pi-agentview itself.
      // This stamp tells our extension to refuse the fleet-manager role inside
      // the worker. Without it the worker claims its own session as "attached"
      // and recursively reconciles/spawns brokers for the whole fleet.
      env: { ...process.env, [BROKER_CHILD_ENV]: "1" },
    });
    this.alive = true;

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr?.on("data", () => {
      /* drain stderr; broker logs nothing to the model stream */
    });
    this.proc.on("error", (err) => {
      this.alive = false;
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      this.alive = false;
      // Fail every in-flight request instead of letting it hang to its 30s
      // timeout — callers need to know the worker is gone, now.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("rpc worker exited"));
      }
      this.emit("exit", { code, signal });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // skip unparseable lines
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: RpcMessage): void {
    // Command responses correlate by id.
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
    }
    // Events, extension_ui_request, uncorrelated responses -> emit by type + generic.
    this.emit("message", msg);
    this.emit(msg.type, msg);
  }

  /** Send a command, await its `response`. Rejects on 30s timeout or worker death. */
  send(command: RpcMessage): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
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
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  /** Fire-and-forget write (prompt during stream, extension_ui_response, abort). */
  write(command: RpcMessage): void {
    if (!this.proc?.stdin?.writable) throw new Error("rpc worker stdin not writable");
    this.proc.stdin.write(JSON.stringify(command) + "\n");
  }

  /** Stop the worker: close stdin, then force the process tree.
   *  MUST actually end the process — it holds the session JSONL open, and a
   *  survivor becomes an orphan that blocks the file for interactive resume. */
  async stop(graceMs = 2500): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const pid = proc.pid;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    const exited = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      proc.once("exit", done);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, graceMs);
    });
    // Previously this just gave up after the grace period, leaving the worker
    // running with its parent broker gone — the orphan-worker leak.
    if (!exited && pid !== undefined) {
      await killTree(pid, 1000).catch(() => undefined);
    }
    this.alive = false;
    this.proc = null;
  }
}
