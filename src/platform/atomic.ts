// Atomic file writes. POSIX rename is an atomic replace; on Windows, Node's
// fs.rename uses MoveFileEx(REPLACE_EXISTING) — atomic unless the destination is
// open/locked (EPERM/EACCES/EBUSY/ENOTEMPTY), which we retry with backoff.

import { writeFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 40;

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ECIRCUIT"]);

export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data, "utf8");

  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code && RETRYABLE.has(code)) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (i + 1)));
        continue;
      }
      // Non-retryable: clean up the temp file and throw.
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // Last resort: remove target (small race window) then rename.
  try {
    await unlink(path);
  } catch {
    /* target may not exist; ignore */
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw lastErr ?? e;
  }
}
