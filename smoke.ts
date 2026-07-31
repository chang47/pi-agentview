// Phase A smoke test — exercises the REAL platform + store modules on the host.
// Run via jiti:  node <jiti-cli.mjs> smoke.ts
import { createServer, createConnection } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { stateDir, socketAddress } from "./src/platform/paths.js";
import { atomicWrite } from "./src/platform/atomic.js";
import { isAlive, newNonce } from "./src/platform/pid.js";
import { killTree } from "./src/platform/kill.js";
import { RegistryStore, BrokerSpecStore, reconcileRegistry } from "./src/registry.js";

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

console.log(`pi-agentview Phase A smoke test — platform: ${process.platform}, node ${process.version}`);

// --- paths -----------------------------------------------------------------
console.log("\n[paths]");
const sd = stateDir();
ok(
  "stateDir resolves to LOCALAPPDATA on win / XDG elsewhere",
  process.platform === "win32"
    ? /appdata[\\/]+local[\\/]+pi-agentview/i.test(sd)
    : sd.includes("pi-agentview"),
  `got ${sd}`,
);
const sock = socketAddress("smoke");
ok(
  "socketAddress: named pipe on win, fs socket on posix",
  process.platform === "win32"
    ? sock === "\\\\.\\pipe\\pi-agentview-smoke"
    : sock.endsWith("smoke.sock"),
  `got ${JSON.stringify(sock)}`,
);

// --- IPC transport (CRITICAL windows validation: named pipe round-trip) -----
console.log("\n[ipc transport]");
await new Promise<void>((resolve) => {
  const addr = socketAddress("smoke-ipc");
  const server = createServer((conn) => {
    conn.write("hello-from-broker");
    conn.end();
  });
  server.listen(addr, () => {
    const client = createConnection(addr, () => client.setEncoding("utf8"));
    let got = "";
    client.on("data", (d: Buffer | string) => (got += d.toString()));
    client.on("end", () => {
      ok(
        `round-trip over ${process.platform === "win32" ? "named pipe" : "unix socket"}`,
        got === "hello-from-broker",
        `got ${JSON.stringify(got)}`,
      );
      server.close(() => resolve());
    });
    client.on("error", (e) => {
      ok("round-trip", false, String(e));
      server.close(() => resolve());
    });
  });
});

// --- atomic writes ---------------------------------------------------------
console.log("\n[atomic]");
const tmp = await mkdtemp(join(tmpdir(), "av-"));
const fp = join(tmp, "f.json");
await atomicWrite(fp, '{"a":1}');
ok("write then read back", (await readFile(fp, "utf8")) === '{"a":1}');
await atomicWrite(fp, '{"a":2}');
ok("rename-over-existing replaces", (await readFile(fp, "utf8")) === '{"a":2}');
await rm(tmp, { recursive: true, force: true });

// --- pid -------------------------------------------------------------------
console.log("\n[pid]");
ok("isAlive(self) === true", isAlive(process.pid));
ok("isAlive(99_999_999) === false", !isAlive(99_999_999));
ok("nonce is 32 hex chars", /^[0-9a-f]{32}$/.test(newNonce()));

// --- killTree --------------------------------------------------------------
console.log("\n[killTree]");
{
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const cpid = child.pid as number;
  await new Promise((r) => setTimeout(r, 400));
  ok("child spawned and alive", isAlive(cpid));
  await killTree(cpid, 1000);
  await new Promise((r) => setTimeout(r, 400));
  ok("child dead after killTree", !isAlive(cpid));
}

// --- registry + reconcile --------------------------------------------------
console.log("\n[registry + reconcile]");
const rid = "smoke-" + Date.now();
const reg = new RegistryStore();
const specStore = new BrokerSpecStore();
await specStore.write({
  id: rid,
  jsonlPath: `C:/fake/${rid}.jsonl`,
  cwd: "C:/fake",
  initialTask: "smoke task abc",
  createdAt: Date.now(),
});
const { added } = await reconcileRegistry(reg);
ok("reconcile reconstructs row from orphaned spec", added.some((a) => a.id === rid));
const row = await reg.get(rid);
ok("derived title from initialTask", !!row && row.title.includes("smoke task abc"), `title=${row?.title}`);
await reg.remove(rid);
await specStore.remove(rid);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
