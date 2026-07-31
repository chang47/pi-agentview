// IPC client: connects to a session's broker, authenticates, subscribes to
// state/event/lease updates, and forwards commands. Mirrors broker/ipc.ts.

import { createConnection, type Socket } from "node:net";
import type { BrokerState, JournalEvent } from "../types.js";
import type { RpcMessage } from "../broker/rpc-client.js";

export interface IpcClientOptions {
  address: string;
  nonce: string;
  clientId: string;
  onState: (state: BrokerState) => void;
  onEvent?: (event: JournalEvent) => void;
  onLease?: (holder: string | null) => void;
  onDisconnect?: () => void;
}

export class IpcClient {
  private socket: Socket | null = null;
  private buffer = "";
  private lastSeq = 0;
  private state: BrokerState | undefined;
  private closed = false;

  constructor(private opts: IpcClientOptions) {}

  get currentState(): BrokerState | undefined {
    return this.state;
  }

  async connect(): Promise<void> {
    // Reset: a client instance may be reconnected after the broker restarts.
    // `closed` used to latch true forever, silently swallowing every later send.
    this.closed = false;
    this.buffer = "";
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(this.opts.address, () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });
    this.socket = sock;
    // Never let a broker connection hold the host process open. Observed while
    // testing: a script that finished its work hung indefinitely because these
    // sockets kept the event loop alive — the same hazard applies to pi exiting.
    sock.unref();
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("close", () => {
      this.closed = true;
      this.opts.onDisconnect?.();
    });
    sock.on("error", () => {
      /* surfaced via close */
    });
    // Resume from the highest sequence we already applied so a reconnect
    // replays only what we missed.
    this.send({ type: "hello", nonce: this.opts.nonce, clientId: this.opts.clientId, lastSeq: this.lastSeq });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (msg["type"]) {
        case "snapshot":
        case "state":
          this.state = msg["state"] as BrokerState;
          if (this.state) this.opts.onState(this.state);
          break;
        case "event": {
          const ev = msg["event"] as JournalEvent | undefined;
          // Track the high-water mark so a reconnect can ask for a delta
          // instead of replaying the whole ring (or nothing).
          if (ev && typeof ev.seq === "number" && ev.seq > this.lastSeq) this.lastSeq = ev.seq;
          if (ev) this.opts.onEvent?.(ev);
          break;
        }
        case "lease":
          this.opts.onLease?.((msg["holder"] as string | null) ?? null);
          break;
      }
    }
  }

  acquireLease(): void {
    this.send({ type: "acquire_lease" });
  }
  releaseLease(): void {
    this.send({ type: "release_lease" });
  }
  sendRpc(command: RpcMessage): void {
    this.send({ type: "rpc", command });
  }
  answer(ans: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    this.send({ type: "answer", ...ans });
  }
  shutdown(): void {
    this.send({ type: "shutdown" });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.socket && !this.closed) this.socket.write(JSON.stringify(msg) + "\n");
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
