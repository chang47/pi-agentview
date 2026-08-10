// Detached process spawning + pi CLI resolution.
//
// resolvePiCommand() spawns `node <pi-cli.js>` directly instead of going through
// the `pi`/`pi.cmd` shell shim. This avoids Node's DEP0190 warning (shell:true +
// args), works identically on Windows and POSIX, and pipes stdio straight to pi.
//
// The extension resolves the CLI path once (via import.meta.resolve) and passes
// it to the bundled broker through the PI_AGENTVIEW_PI_CLI env var; the broker
// reads that first, falling back to resolving it itself.

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR_ENV } from "./constants.js";

const ENV_CLI = "PI_AGENTVIEW_PI_CLI";

let cliCache: string | undefined;

/** Absolute path to the pi CLI entry (e.g. .../dist/cli.js). */
export function resolvePiCliPath(): string {
  // TESTABILITY SEAM: honor an explicit PI_AGENTVIEW_PI_CLI override first, so a
  // fake pi propagates through the whole chain — the extension resolves it here,
  // spawnBroker() injects it into the broker env, and the broker's
  // resolvePiCommand() reads it for the worker. Production leaves this unset in
  // the extension; only the broker child has it set (to the real pi, injected by
  // spawnBroker below), so real use is unchanged.
  const override = process.env[ENV_CLI];
  if (override) return override;
  if (cliCache) return cliCache;
  // "." resolves via the ESM import condition; derive the package root from it,
  // then read package.json by path (its `exports` hides subpaths from resolvers).
  const mainPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const root = resolve(mainPath, "../.."); // .../dist/index.js -> package root
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    bin: Record<string, string> | string;
  };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi ?? Object.values(pkg.bin)[0];
  if (!binRel) throw new Error("pi package.json has no bin entry");
  cliCache = join(root, binRel);
  return cliCache;
}

/** Invocation for spawning a headless pi RPC worker: `node <cli.js>`. */
export function resolvePiCommand(): { command: string; preArgs: string[]; shell: boolean } {
  const cli = process.env[ENV_CLI] ?? resolvePiCliPath();
  return { command: process.execPath, preArgs: [cli], shell: false };
}

export interface SpawnBrokerOptions {
  brokerPath: string; // absolute path to bundled broker (dist/broker.mjs)
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Spawn the broker detached so it survives the foreground pi/terminal closing.
 *  Injects the resolved pi CLI path so the broker never needs shell:true. */
export function spawnBroker(opts: SpawnBrokerOptions): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...opts.env, [ENV_CLI]: resolvePiCliPath() };
  // Carry the state-dir isolation override to the broker so the fleet manager and
  // the brokers it spawns share one state dir under test. Unset in production.
  const stateDirOverride = process.env[STATE_DIR_ENV];
  if (stateDirOverride) env[STATE_DIR_ENV] = stateDirOverride;
  const child = spawn(process.execPath, [opts.brokerPath, ...(opts.args ?? [])], {
    detached: true,
    stdio: opts.stdio ?? "ignore",
    cwd: opts.cwd,
    env,
    windowsHide: true,
  });
  child.unref(); // don't keep the parent alive waiting on the broker
  return child;
}
