// Append-only event journal with monotonic sequence numbers.
// Persisted to journal.jsonl; an in-memory ring supports replay-after-reconnect.

import { open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { JournalEvent } from "../types.js";

const RING_CAP = 2000; // in-memory replay window

export class Journal {
  private seq = 0;
  private ring: JournalEvent[] = [];
  private fh: FileHandle | null = null;

  constructor(private readonly path: string) {}

  async open(): Promise<void> {
    // Recover the high-water seq from any existing journal.
    try {
      const data = await readFile(this.path, "utf8");
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
        } catch {
          /* skip corrupt line */
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(dirname(this.path), { recursive: true });
    this.fh = await open(this.path, "a");
  }

  /** Append an event, assign the next seq, persist, keep in the ring. */
  async append(type: string, payload?: unknown): Promise<JournalEvent> {
    const ev: JournalEvent = { seq: ++this.seq, type, timestamp: Date.now(), payload };
    this.ring.push(ev);
    if (this.ring.length > RING_CAP) this.ring.splice(0, this.ring.length - RING_CAP);
    await this.fh!.write(JSON.stringify(ev) + "\n");
    return ev;
  }

  /** Events with seq > fromSeq (for client catch-up after reconnect). */
  replay(fromSeq: number): JournalEvent[] {
    return this.ring.filter((e) => e.seq > fromSeq);
  }

  get lastSeq(): number {
    return this.seq;
  }

  async close(): Promise<void> {
    await this.fh?.close().catch(() => {});
    this.fh = null;
  }
}
