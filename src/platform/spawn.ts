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

const ENV_CLI = "PI_AGENTVIEW_PI_CLI";

let cliCache: string | undefined;

/** Absolute path to the pi CLI entry (e.g. .../dist/cli.js). */
export function resolvePiCliPath(): string {
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
  const env = { ...opts.env, [ENV_CLI]: resolvePiCliPath() };
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
