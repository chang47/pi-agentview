// pi-agentview extension entry.
//
// Wires: Left-Arrow editor -> /agents, the /agents command (open view, create/
// resume/remove), broker reconciliation, attached ownership claims, and
// auto-background when a session is left.
//
// HOST ROLE (critical): this extension is installed at USER scope, so pi loads
// it into EVERY pi process — including the headless `pi --mode rpc` workers that
// our own brokers spawn. A worker must never act as a fleet manager: if it did
// it would claim its own session as "attached" (phantom foreground rows with the
// wrong name), reconcile/spawn brokers recursively, and block its own startup.
// Only an interactive TUI host that is NOT a broker child manages the fleet.

import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentsEditor } from "./extension/editor.js";
import { AgentViewComponent, type ViewResult } from "./extension/view.js";
import { BrokerManager } from "./extension/controller.js";
import { ForegroundClaimStore } from "./registry.js";
import { newNonce } from "./platform/pid.js";
import { BROKER_CHILD_ENV, CLAIM_HEARTBEAT_MS, PLACEHOLDER_TITLE } from "./platform/constants.js";

/** True when this process is an RPC worker spawned by one of our brokers. */
const isBrokerChild = process.env[BROKER_CHILD_ENV] === "1";

/** Only an interactive TUI host manages the fleet (see HOST ROLE above). */
function isFleetHost(ctx: { mode?: string }): boolean {
  return !isBrokerChild && ctx.mode === "tui";
}

export default function (pi: ExtensionAPI): void {
  const mgr = new BrokerManager();
  const claims = new ForegroundClaimStore();
  const foregroundNonce = newNonce();
  let lastResumedId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let claimedFile: string | undefined;
  // Whether an agent run is in flight for the session THIS host currently owns.
  // Tracked from first-class events (agent_start .. agent_settled) so that when
  // the user backgrounds a session we can tell the broker to auto-continue a
  // dropped turn (BrokerSpec.resumeOnStart). agent_settled is the terminal
  // signal (subagents emit agent_end, not agent_settled), so it stays true for
  // the whole top-level run. Fresh per session — pi recreates this closure on
  // every session replacement.
  let agentRunning = false;

  // Derive a row title: prefer the explicit session name, else the first user
  // prompt, else a neutral fallback. NEVER cwd/username (the "iamjo" bug).
  const extractUserText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
        .join("");
    }
    return "";
  };
  // Returns the title AND where it came from. The source matters because the
  // registry holds a second, durable title for the same session (set at create
  // or by a rename); without knowing whether this one is an explicit name or a
  // guess, the two lanes overwrite each other and the row appears to change its
  // name every time you switch sessions.
  const deriveTitle = (ctx: ExtensionContext): { title: string; source: "name" | "prompt" | "fallback" } => {
    try {
      const named = pi.getSessionName();
      if (named && named.trim()) return { title: named.trim(), source: "name" };
    } catch {
      /* getSessionName can throw on a disposed session */
    }
    try {
      for (const e of ctx.sessionManager.getBranch()) {
        const msg = (e as { type?: string; message?: { role?: string; content?: unknown } }).message;
        if (msg?.role === "user") {
          const t = extractUserText(msg.content).trim();
          if (t) return { title: t.replace(/\s+/g, " ").slice(0, 60), source: "prompt" };
        }
      }
    } catch {
      /* branch may be empty or mid-load at session_start */
    }
    return { title: PLACEHOLDER_TITLE, source: "fallback" };
  };

  // A claim proves "a live terminal owns this JSONL". Liveness is PID + FRESHNESS:
  // a PID alone is not proof of ownership (Windows recycles PIDs aggressively, and
  // this project spawns many long-lived node processes that soak them up). The
  // heartbeat below keeps updatedAt fresh; readers treat a stale claim as dead.
  const writeClaim = async (ctx: ExtensionContext) => {
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) return;
      // The session file can change under us (new/resume); drop the previous claim.
      if (claimedFile && claimedFile !== file) {
        await claims.remove(claimedFile).catch(() => undefined);
      }
      claimedFile = file;
      const derived = deriveTitle(ctx);
      await claims.upsert({
        sessionId: file, // key by jsonlPath so removal by file clears it
        jsonlPath: file,
        title: derived.title,
        titleSource: derived.source,
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
        ownerPid: process.pid,
        nonce: foregroundNonce,
        updatedAt: Date.now(),
      });
    } catch {
      /* claims are best-effort indexes */
    }
  };

  // Re-stamping the claim on a timer does double duty: it keeps the freshness
  // proof alive AND re-derives the title, so a row stops reading "session" once
  // the user sends their first prompt or renames the session.
  const startHeartbeat = (ctx: ExtensionContext) => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => void writeClaim(ctx), CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.(); // never keep pi alive on our account
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  // Background the current foreground session if it isn't already tracked.
  // Writes only durable spec+registry (no broker spawn — the foreground still
  // owns the JSONL); a later reconcile() spawns the broker once the file is free.
  const backgroundCurrentIfUntracked = async (ctx: ExtensionContext): Promise<void> => {
    const jsonl = ctx.sessionManager.getSessionFile();
    if (!jsonl) return;
    if (await mgr.isTracked(jsonl)) return; // already a background task
    await mgr.registerExisting(jsonl, {
      // A placeholder is passed through as "no title" so registerExisting can
      // fall back to reading the JSONL, rather than freezing "session" forever.
      title: deriveTitle(ctx).title,
      cwd: ctx.cwd,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: ctx.thinkingLevel,
      // A DELIBERATE background of a running session: let the broker pick the
      // dropped turn back up when it opens this JSONL (fires once, reconcile-
      // first). An unexpected crash never reaches here, so it stays untouched.
      resumeOnStart: agentRunning,
    });
  };

  pi.on("session_start", async (event, ctx) => {
    if (!isFleetHost(ctx)) return;

    // A freshly-entered session has no run in flight yet (defensive: this closure
    // is normally recreated per session, but never assume a run leaked across).
    agentRunning = false;

    // Claim FIRST so reconcile can see that this terminal owns this file, and so
    // a crash between here and the first heartbeat still leaves a prunable claim.
    await writeClaim(ctx);
    startHeartbeat(ctx);

    // The previous session's claim is released by its own session_shutdown, but
    // that runs on the OLD runtime; clear it here too in case teardown was skipped.
    if (event.previousSessionFile && event.previousSessionFile !== ctx.sessionManager.getSessionFile()) {
      await claims.remove(event.previousSessionFile).catch(() => undefined);
    }

    // Returning a previously-resumed session to the background pool. NOTE: pi
    // recreates the extension on every session replacement, so lastResumedId is
    // only set when the resume completed without a runtime swap; reconcile() is
    // the durable path that actually restarts brokers.
    if (lastResumedId && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
      const id = lastResumedId;
      lastResumedId = undefined;
      void mgr.returnToPool(id).catch(() => undefined);
    }

    // Repopulate from the durable registry (in-memory state is lost across
    // switches). Deliberately NOT awaited: reconcile spawns brokers and connects
    // over IPC, which measured ~28s of blocked startup when awaited here. The
    // view polls every second, so rows fill in as they connect.
    const fgFile = ctx.sessionManager.getSessionFile();
    void mgr.reconcile(fgFile ?? undefined).catch(() => undefined);

    // Replace the input editor so Left-Arrow-on-empty opens Agent View.
    // KNOWN LIMITATION: this clobbers any editor another extension installed
    // (e.g. a vim-mode editor). Pi's compose pattern needs the other editor to
    // accept a delegate, which a foreign subclass generally won't.
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new AgentsEditor(tui, theme, keybindings));
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    // Auto-background the session we're leaving on any swap (/new or resume).
    await backgroundCurrentIfUntracked(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    stopHeartbeat();
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file) await claims.remove(file);
      if (claimedFile && claimedFile !== file) await claims.remove(claimedFile);
      claimedFile = undefined;
    } catch {
      /* ignore */
    }
    // Belt-and-braces: drop anything still claimed by this PID so a mismatch
    // between getSessionFile() and what we wrote can't leak a phantom row.
    await claims.removeByOwner(process.pid).catch(() => undefined);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    await writeClaim(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    await writeClaim(ctx);
  });
  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    await writeClaim(ctx);
  });
  // The title usually only becomes derivable after the first user turn.
  pi.on("agent_start", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    agentRunning = true; // a turn is now in flight (see resumeOnStart above)
    await writeClaim(ctx);
  });
  // The top-level run has fully settled — nothing to auto-continue if backgrounded now.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!isFleetHost(ctx)) return;
    agentRunning = false;
  });

  pi.registerCommand("agents", {
    description: "Open Agent View — manage background sessions",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!isFleetHost(ctx)) {
        ctx.ui.notify("Agent View is only available in an interactive pi session.", "warning");
        return;
      }
      const result: ViewResult = await ctx.ui.custom<ViewResult>((tui, theme, _kb, done) =>
        new AgentViewComponent(tui, theme, mgr, done, (title) => pi.setSessionName(title)),
      );

      if (!result) return;

      if (result.action === "create") {
        await createSession(ctx);
        return;
      }

      if (result.action === "remove") {
        await mgr.remove(result.id);
        return;
      }

      // resume: background the session we're leaving, stop the target broker
      // (release its JSONL), then hand that file to interactive Pi.
      if (result.action === "resume") {
        const entry = mgr.entry(result.id);
        if (!entry) return;
        if (await mgr.isAttachedElsewhere(entry.jsonlPath)) {
          ctx.ui.notify("That session is attached in another terminal — close it there first.", "warning");
          return;
        }
        await backgroundCurrentIfUntracked(ctx);
        // Must fully release the JSONL before pi opens it: pi's switchSession
        // opens the target SessionManager before our session_shutdown runs, so
        // there is no later chance to let go.
        const released = await mgr.stopBrokerForResume(result.id);
        if (!released) {
          ctx.ui.notify("Could not release that session's worker — not switching (would double-write the JSONL).", "error");
          return;
        }
        lastResumedId = result.id;
        await ctx.switchSession(entry.jsonlPath);
      }
    },
  });

  async function createSession(ctx: ExtensionCommandContext): Promise<void> {
    const title = await ctx.ui.input("Session title", "feature X");
    const cwd = (await ctx.ui.input("Working directory", ctx.cwd)) || ctx.cwd;
    const task = await ctx.ui.input("Initial task (optional)", "what should it do first?");

    // Let create() own the id AND derive the JSONL path from it. This used to
    // mint a second id here, so the session's data dir and its broker-index dir
    // were different directories — which made the data dir look orphaned.
    await mgr.create({
      title: title || (task ? task.replace(/\s+/g, " ").slice(0, 60) : "session"),
      cwd,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: ctx.thinkingLevel,
      initialTask: task || undefined,
    });
  }
}
