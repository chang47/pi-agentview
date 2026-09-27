// Transcript parser tests: pi session JSONL → the readable items the focus pane shows.
// Offline + deterministic. Run via jiti:  node <jiti> test/transcript.ts [path/to/real/session.jsonl]
// (an optional real session path is parsed as a smoke check; it's never required.)

import { parseTranscript, loadTranscript } from "../src/extension/transcript.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

// Shapes copied from a real pi session JSONL (content trimmed).
const jsonl = [
  { type: "session_info", name: "spec fusion" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "build the spec-fusion extension" }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning", thinkingSignature: "x" },
        { type: "text", text: "Checking codex first." },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "which codex 2>&1;\n codex --version", timeout: 60 } },
        { type: "text", text: "Codex is installed." },
      ],
    },
  },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "/usr/bin/codex ... huge output" }] } },
  { type: "custom_message", content: null },
  { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: '{"path":"src/index.ts"}' }] } },
  { type: "message", message: { role: "user", content: "a plain-string user message" } },
  { type: "message", message: { role: "assistant", content: [] } },
]
  .map((o) => JSON.stringify(o))
  .join("\n")
  .concat('\n{"type":"message","message":{"role":"assist'); // half-written trailing line (live session)

console.log("transcript parser");
const items = parseTranscript(jsonl);

ok("keeps user text (block form)", items[0]?.kind === "user" && items[0].text === "build the spec-fusion extension", JSON.stringify(items[0]));
ok("drops thinking blocks", !JSON.stringify(items).includes("secret reasoning"));
ok("drops toolResult output", !JSON.stringify(items).includes("huge output"));
ok(
  "keeps assistant text and tool calls in the order produced",
  items[1]?.kind === "assistant" && items[1].text === "Checking codex first." && items[2]?.kind === "tool" && items[3]?.kind === "assistant" && items[3].text === "Codex is installed.",
  JSON.stringify(items.slice(1, 4)),
);
ok(
  "tool call condensed to name + its telling arg on one line",
  items[2]?.kind === "tool" && items[2].name === "bash" && items[2].summary === "which codex 2>&1; codex --version",
  JSON.stringify(items[2]),
);
ok(
  "tool arguments given as a JSON string are parsed",
  items[4]?.kind === "tool" && items[4].name === "read" && items[4].summary === "src/index.ts",
  JSON.stringify(items[4]),
);
ok("keeps user text (plain-string form)", items[5]?.kind === "user" && items[5].text === "a plain-string user message", JSON.stringify(items[5]));
ok("empty assistant turn + half-written line produce nothing", items.length === 6, `got ${items.length}: ${JSON.stringify(items)}`);
ok("missing file → empty transcript (pi creates it lazily)", (await loadTranscript("/nope/does-not-exist.jsonl")).length === 0);
ok("no path → empty transcript", (await loadTranscript(undefined)).length === 0);

const real = process.argv[2];
if (real) {
  const r = await loadTranscript(real);
  const kinds = new Set(r.map((i) => i.kind));
  ok(`real session parses (${r.length} items: ${[...kinds].join(", ")})`, r.length > 0);
}

console.log(fail ? `\n❌ FAILURES — ${pass} passed, ${fail} failed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
