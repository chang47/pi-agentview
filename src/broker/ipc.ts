// Reconnectable local IPC server (named pipe on Windows, unix socket elsewhere).
//
// Protocol (JSONL, same \\n framing as RPC):
//   Client -> Broker:
//     {type:"hello", nonce, clientId, lastSeq}     auth + catch-up request (first msg)
//     {type:"acquire_lease"} / {type:"release_lease"}
//     {type:"rpc", command:<RpcMessage>}           forward to pi (requires lease)
//     {type:"answer", id, value?, confirmed?, cancelled?}  answer a dialog (lease)
//     {type:"shutdown"}                            request broker shutdown (lease)
//   Broker -> Client:
//     {type:"auth_ok", lastSeq} / {type:"auth_fail"}
//     {type:"snapshot", state}
//     {type:"state", state}
//     {type:"event", event:<JournalEvent>}
//     {type:"lease", holder:<string|null>}
//
// Security: nonce must match the lockfile. Multiple observers allowed; exactly
// one mutation lease holder at a time.

import { createServer, type Server, type Socket } from "node:net";
import type { BrokerState, JournalEvent } from "../types.js";
import type { RpcMessage } from "./rpc-client.js";

export interface IpcHandlers {
  onRpc: (command: RpcMessage) => Promise<void>;
  onAnswer: (ans: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
  onShutdown: () => Promise<void>;
}

export interface SnapshotProvider {
  getState: () => BrokerState;
  replay: (fromSeq: number) => JournalEvent[];
  /** Highest sequence number the broker has journaled. */
  lastSeq: () => number;
}

interface ClientConn {
  socket: Socket;
  authed: boolean;
  clientId?: string;
  buffer: string;
}

export class IpcServer {
  private server: Server | null = null;
  private conns = new Map<Socket, ClientConn>();
  private leaseHolder: string | undefined;

  constructor(
    private readonly address: string,
    private readonly nonce: string,
    private readonly handlers: IpcHandlers,
    private readonly snap: SnapshotProvider,
  ) {}

  async start(): Promise<void> {
    // POSIX only: a unix socket is a real filesystem entry, so (a) its parent
    // directory must exist — it never did, which meant listen() failed with
    // ENOENT and the broker could not start at all on Linux/macOS — and (b) a
    // file left behind by a crashed broker makes listen() fail EADDRINUSE.
    // Windows named pipes need neither: they are kernel objects that vanish
    // with the owning process.
    if (process.platform !== "win32") {
      const { mkdir, unlink } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(this.address), { recursive: true });
      await unlink(this.address).catch(() => {});
    }
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.server!.once("error", onError);
      this.server!.listen(this.address, () => {
        this.server!.off("error", onError);
        resolve();
      });
    });
  }

  private onConnection(socket: Socket): void {
    const conn: ClientConn = { socket, authed: false, buffer: "" };
    this.conns.set(socket, conn);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(conn, chunk));
    socket.on("close", () => this.cleanup(socket));
    socket.on("error", () => this.cleanup(socket));
  }

  private onData(conn: ClientConn, chunk: string): void {
    conn.buffer += chunk;
    let nl: number;
    while ((nl = conn.buffer.indexOf("\n")) >= 0) {
      let line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      void this.handleMessage(conn, msg);
    }
  }

  private async handleMessage(conn: ClientConn, msg: Record<string, unknown>): Promise<void> {
    if (!conn.authed) {
      if (msg["type"] === "hello") {
        const nonce = msg["nonce"];
        if (nonce === this.nonce) {
          conn.authed = true;
          conn.clientId = (msg["clientId"] as string | undefined) ?? `anon-${Date.now()}`;
          const lastSeq = Number(msg["lastSeq"]) || 0;
          const pending = this.snap.replay(lastSeq);
          // auth_ok.lastSeq is the broker's high-water sequence number, NOT the
          // count of replayed events (which is what it used to send — a client
          // that resumed from it would silently skip or re-read history).
          this.send(conn, { type: "auth_ok", lastSeq: this.snap.lastSeq() });
          this.send(conn, { type: "snapshot", state: this.snap.getState() });
          for (const e of pending) this.send(conn, { type: "event", event: e });
          // Inform the new client of the current lease owner.
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
        // First authenticated requester wins; idempotent if already holder.
        if (this.leaseHolder === undefined || this.leaseHolder === conn.clientId) {
          this.leaseHolder = conn.clientId;
          this.broadcast({ type: "lease", holder: this.leaseHolder ?? null });
        }
        break;
      }
      case "release_lease": {
        if (this.leaseHolder === conn.clientId) {
          this.leaseHolder = undefined;
          this.broadcast({ type: "lease", holder: null });
        }
        break;
      }
      case "rpc": {
        if (!this.hasLease(conn)) break;
        await this.handlers.onRpc(msg["command"] as RpcMessage);
        break;
      }
      case "answer": {
        if (!this.hasLease(conn)) break;
        this.handlers.onAnswer({
          id: String(msg["id"]),
          value: msg["value"] as string | undefined,
          confirmed: msg["confirmed"] as boolean | undefined,
          cancelled: msg["cancelled"] as boolean | undefined,
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

  private hasLease(conn: ClientConn): boolean {
    return this.leaseHolder !== undefined && this.leaseHolder === conn.clientId;
  }

  // --- broadcasts -----------------------------------------------------------

  broadcastState(state: BrokerState): void {
    this.broadcast({ type: "state", state });
  }

  broadcastSnapshot(state: BrokerState): void {
    // Sent per-client on auth by the broker (which also replays events).
    for (const conn of this.conns.values()) {
      if (conn.authed) this.send(conn, { type: "snapshot", state });
    }
  }

  broadcastEvent(event: JournalEvent): void {
    this.broadcast({ type: "event", event });
  }

  replayTo(conn: ClientConn, events: JournalEvent[]): void {
    for (const e of events) this.send(conn, { type: "event", event: e });
  }

  leaseHolderId(): string | undefined {
    return this.leaseHolder;
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg) + "\n";
    for (const conn of this.conns.values()) {
      if (conn.authed) conn.socket.write(data);
    }
  }

  private send(conn: ClientConn, msg: unknown): void {
    conn.socket.write(JSON.stringify(msg) + "\n");
  }

  private cleanup(socket: Socket): void {
    const conn = this.conns.get(socket);
    if (conn && this.leaseHolder === conn.clientId) {
      this.leaseHolder = undefined;
      this.broadcast({ type: "lease", holder: null });
    }
    this.conns.delete(socket);
  }

  authedClientCount(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.authed) n++;
    return n;
  }

  /** Expose conns for the broker to send per-client snapshots/replay on auth. */
  getAuthedClients(): ClientConn[] {
    return [...this.conns.values()].filter((c) => c.authed);
  }

  async stop(): Promise<void> {
    for (const conn of this.conns.values()) conn.socket.destroy();
    this.conns.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    // Remove a lingering unix socket file on POSIX.
    if (process.platform !== "win32") {
      const { unlink } = await import("node:fs/promises");
      await unlink(this.address).catch(() => {});
    }
  }
}
