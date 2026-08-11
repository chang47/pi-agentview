// Extension-layer smoke test: pure render helpers + a real BrokerManager
// create -> rows -> remove cycle (spawns live brokers, no model calls).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrokerManager, resolveTitle } from "./src/extension/controller.js";
import { rowsFor, groupRows, formatElapsed, statusGlyph, stateLabel } from "./src/extension/render.js";
import { BrokerSpecStore } from "./src/registry.js";
import { brokerSpecPath, sessionDir, sessionsDir } from "./src/platform/paths.js";
import type { BrokerState, RegistryEntry } from "./src/types.js";

let pass = 0;
let fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`extension smoke test — platform: ${process.platform}`);

// --- render (pure) ---------------------------------------------------------
console.log("\n[render]");
ok("formatElapsed seconds", formatElapsed(45_000) === "45s");
ok("formatElapsed minutes", formatElapsed(125_000) === "2m5s");
ok("formatElapsed undefined", formatElapsed(undefined) === "");
ok("statusGlyph working is ●", statusGlyph("working") === "●");
ok("statusGlyph completed is ✓", statusGlyph("completed") === "✓");
ok("stateLabel awaiting_input", stateLabel("awaiting_input") === "Awaiting Input");

{
  const now = 10_000;
  const entries: RegistryEntry[] = [
    { id: "a", title: "A", jsonlPath: "/a", cwd: "/", createdAt: 0, specPath: "", socketAddress: "" },
    { id: "b", title: "B", jsonlPath: "/b", cwd: "/", createdAt: 0, specPath: "", socketAddress: "" },
    { id: "c", title: "C", jsonlPath: "/c", cwd: "/", createdAt: 0, specPath: "", socketAddress: "" },
  ];
  const states = new Map<string, BrokerState | undefined>([
    ["a", { id: "a", state: "completed", activity: "done", completedAt: 9_000, lastEventSeq: 1, updatedAt: 9_000 }],
    ["b", { id: "b", state: "working", activity: "tool: bash", runStartedAt: 5_000, lastEventSeq: 2, updatedAt: 9_000 }],
    ["c", { id: "c", state: "awaiting_input", activity: "Allow?", waitingSince: 8_000, lastEventSeq: 3, updatedAt: 9_000 }],
  ]);
  const rows = rowsFor(entries, states, now);
  const groups = groupRows(rows);
  ok("3 rows produced", rows.length === 3);
  ok("groups ordered by urgency (awaiting first)", groups[0]?.state === "awaiting_input", groups[0]?.state);
  ok("then working, then completed", groups[1]?.state === "working" && groups[2]?.state === "completed");
  ok("working row elapsed from runStartedAt", rows.find((r) => r.id === "b")?.elapsedMs === 5_000);
}

// --- BrokerManager create -> rows -> remove (real brokers, no model) -------
console.log("\n[BrokerManager]");
{
  const mgr = new BrokerManager();
  const tmp = await mkdtemp(join(tmpdir(), "ext-"));
  const id = await mgr.create({
    title: "idle probe",
    cwd: tmp,
    jsonlPath: join(tmp, "s.jsonl"),
    model: "zai/glm-5.2",
    thinkingLevel: "low",
    // no initialTask -> worker boots idle, no model call
  });

  // Wait for the broker to spawn, connect, and report a state.
  let appeared = false;
  for (let i = 0; i < 80; i++) {
    const rows = mgr.rows();
    const row = rows.find((r) => r.id === id);
    if (row) {
      appeared = true;
      break;
    }
    await sleep(250);
  }
  ok("created session appears in rows()", appeared);

  await mgr.remove(id);
  await sleep(300);
  ok("removed session gone from rows()", !mgr.rows().some((r) => r.id === id));

  await rm(tmp, { recursive: true, force: true });
}

// --- reconcile picks up an orphaned spec -----------------------------------
console.log("\n[reconcile]");
{
  const mgr = new BrokerManager();
  const tmp = await mkdtemp(join(tmpdir(), "rec-"));
  const specStore = new BrokerSpecStore();
  const orphanId = "rec-" + Date.now();
  await specStore.write({ id: orphanId, jsonlPath: join(tmp, "o.jsonl"), cwd: tmp, createdAt: Date.now() });
  await mgr.reconcile();
  let appeared = false;
  for (let i = 0; i < 80; i++) {
    if (mgr.rows().some((r) => r.id === orphanId)) {
      appeared = true;
      break;
    }
    await sleep(250);
  }
  ok("reconcile restarted broker for orphaned spec", appeared);
  await mgr.remove(orphanId);
  await rm(tmp, { recursive: true, force: true });
}

// --- title stays stable across attach/detach --------------------------------
// REGRESSION: a session has two title lanes — the live claim written by the
// owning terminal, and the durable registry row. They were never reconciled, so
// a session created as "session 3" displayed as "session" while attached (the
// claim could derive nothing yet) and "session 3" once backgrounded: the row
// appeared to rename itself on every session switch.
console.log("\n[title reconciliation]");
{
  ok(
    "registry title wins over a placeholder claim (the reported bug)",
    resolveTitle("session", "fallback", "session 3") === "session 3",
  );
  ok(
    "explicit Pi session name beats the registry title",
    resolveTitle("renamed in terminal", "name", "session 3") === "renamed in terminal",
  );
  ok(
    "registry title beats a prompt-derived claim title",
    resolveTitle("fix the parser bug", "prompt", "session 3") === "session 3",
  );
  ok(
    "prompt-derived title used when the registry has only a placeholder",
    resolveTitle("fix the parser bug", "prompt", "session") === "fix the parser bug",
  );
  ok("both placeholders -> placeholder", resolveTitle("session", "fallback", "session") === "session");
  ok("never returns empty", resolveTitle("", "fallback", undefined) === "session");
  // The same inputs must resolve identically whichever lane is asking —
  // that is what makes the name stable across a switch.
  ok(
    "attached and background resolve to the SAME title",
    resolveTitle("session", "fallback", "session 3") === resolveTitle(undefined, undefined, "session 3"),
  );
}

// --- cleanup must never destroy conversation data --------------------------
// REGRESSION: gcOrphanDirs() once deleted any session dir without a broker
// spec. pi creates the parent dir for a new session immediately but writes the
// JSONL lazily, so a live brand-new session looked exactly like an orphan and
// its directory was removed out from under the running worker (ENOENT).
console.log("\n[cleanup safety]");
{
  const mgr = new BrokerManager();
  const stamp = Date.now();

  // (a) a dir holding session data, no spec -> MUST survive
  const dataDir = join(sessionsDir(), `gctest-data-${stamp}`);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "session.jsonl"), '{"type":"session"}\n', "utf8");

  // (b) a dir holding only broker indexes, no spec -> may be swept
  const orphanDir = join(sessionsDir(), `gctest-orphan-${stamp}`);
  await mkdir(orphanDir, { recursive: true });
  await writeFile(join(orphanDir, "broker-state.json"), "{}", "utf8");

  await mgr.reconcile();

  ok("GC preserves a dir containing a session JSONL", existsSync(join(dataDir, "session.jsonl")));
  ok("GC sweeps a broker-index-only orphan dir", !existsSync(orphanDir));

  await rm(dataDir, { recursive: true, force: true });
}

// --- create(): one id for both the data and the indexes --------------------
{
  const mgr = new BrokerManager();
  const tmp = await mkdtemp(join(tmpdir(), "idc-"));
  const id = await mgr.create({ title: "id consistency", cwd: tmp, model: "zai/glm-5.2", thinkingLevel: "low" });
  const entry = mgr.entry(id);
  // REGRESSION: the caller used to mint a second id for the JSONL path, so the
  // data dir and the broker-index dir were different directories.
  ok("jsonlPath lives inside this session's own dir", !!entry && entry.jsonlPath.includes(id), entry?.jsonlPath);

  // remove() is specified to PRESERVE the JSONL.
  await writeFile(join(sessionDir(id), "session.jsonl"), '{"type":"session"}\n', "utf8");
  await mgr.remove(id);
  ok("remove() preserves the session JSONL", existsSync(join(sessionDir(id), "session.jsonl")));
  ok("remove() drops the broker spec", !existsSync(brokerSpecPath(id)));

  await rm(sessionDir(id), { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
