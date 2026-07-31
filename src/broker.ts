// Broker bundle entry. Delegates to the orchestrator in ./broker/main.ts.
// The extension spawns this (bundled to dist/broker.mjs) as a detached process.
import { runBroker } from "./broker/main.js";

runBroker(process.argv.slice(2)).catch((e) => {
  console.error("[broker] fatal:", e);
  process.exit(1);
});
