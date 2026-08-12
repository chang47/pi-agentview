// Interaction harness: drive the REAL AgentViewComponent (real handleInput + real
// render) with scripted keystrokes and an injectable mock manager, and capture a
// filmstrip of frames plus a log of everything the component asked the manager to
// do. This is the "reproduce a bug and look at it" tool: script a roster + keys,
// then inspect the frames and the call log — no real broker, no model.

import { AgentViewComponent, type ViewResult } from "../../src/extension/view.js";
import type { BrokerManager } from "../../src/extension/controller.js";
import type { ManagedRow } from "../../src/extension/render.js";
import type { ManagedId } from "../../src/types.js";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ansiColor } from "./theme.js";

// Named key constants, matching what AgentViewComponent.handleInput expects.
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  space: " ",
  enter: "\r",
  esc: "\x1b",
  backspace: "\x7f",
} as const;

export interface Call {
  fn: "remove" | "sendReply" | "setTitle" | "tick";
  args: unknown[];
}

/** A stand-in BrokerManager: a mutable roster + a call log. sendReply can be made
 *  to fail (returns false) to exercise the delivery-error path. */
export class MockManager {
  private roster: ManagedRow[];
  replyOk = true;
  calls: Call[] = [];

  constructor(rows: ManagedRow[]) {
    this.roster = rows;
  }
  setRows(rows: ManagedRow[]): void {
    this.roster = rows;
  }
  rows(): ManagedRow[] {
    return this.roster;
  }
  async tick(): Promise<void> {
    /* no-op; a real tick refreshes broker state */
  }
  async remove(id: ManagedId): Promise<void> {
    this.calls.push({ fn: "remove", args: [id] });
    this.roster = this.roster.filter((r) => r.id !== id);
  }
  sendReply(id: ManagedId, text: string): boolean {
    this.calls.push({ fn: "sendReply", args: [id, text] });
    return this.replyOk;
  }
  async setTitle(id: ManagedId, text: string): Promise<void> {
    this.calls.push({ fn: "setTitle", args: [id, text] });
    const r = this.roster.find((x) => x.id === id);
    if (r) r.title = text;
  }
}

const fakeTui = { requestRender() {} } as unknown as TUI;
const fakeTheme = { fg: (name: string, s: string) => ansiColor(name, s) } as unknown as Theme;

/** One scripted step: press a key, type a string (char by char), or swap the
 *  roster (simulating a broker state update arriving). A frame is captured after
 *  each step; `label` annotates it. */
export type Step =
  | { key: string; label?: string }
  | { text: string; label?: string }
  | { rows: ManagedRow[]; label?: string };

export interface ScenarioResult {
  frames: string[][]; // ANSI frame per step (including an "initial" frame first)
  labels: string[];
  calls: Call[]; // what the component asked the manager to do, in order
  done: ViewResult[]; // resume/remove/create/close results emitted
  /** Titles handed to the foreground-rename hook (real one is pi.setSessionName). */
  renamedForeground: string[];
  mgr: MockManager;
}

export interface RunOpts {
  width?: number;
  /** Make sendReply fail (returns false) from the outset — the unreachable-broker path. */
  replyOk?: boolean;
}

/** Run a scripted interaction against a fresh AgentViewComponent. */
export function runScenario(initialRows: ManagedRow[], steps: Step[], opts: RunOpts = {}): ScenarioResult {
  const width = opts.width ?? 76;
  const mgr = new MockManager(initialRows);
  if (opts.replyOk !== undefined) mgr.replyOk = opts.replyOk;
  const done: ViewResult[] = [];
  const renamedForeground: string[] = [];
  const comp = new AgentViewComponent(
    fakeTui,
    fakeTheme,
    mgr as unknown as BrokerManager,
    (r) => done.push(r),
    (title) => renamedForeground.push(title),
  );

  const frames: string[][] = [];
  const labels: string[] = [];
  const capture = (label: string): void => {
    frames.push(comp.render(width));
    labels.push(label);
  };

  capture("initial");
  for (const step of steps) {
    if ("rows" in step) mgr.setRows(step.rows);
    else if ("text" in step) for (const ch of step.text) comp.handleInput(ch);
    else comp.handleInput(step.key);
    capture(step.label ?? ("text" in step ? `type "${step.text}"` : "key" in step ? keyName(step.key) : "rows"));
  }

  // Stop the component's 1s refresh interval so the process can exit cleanly,
  // WITHOUT invoking close() (which would emit a spurious done result).
  const timer = (comp as unknown as { timer?: NodeJS.Timeout }).timer;
  if (timer) clearInterval(timer);

  return { frames, labels, calls: mgr.calls, done, renamedForeground, mgr };
}

function keyName(k: string): string {
  for (const [name, code] of Object.entries(KEY)) if (code === k) return name;
  return JSON.stringify(k);
}
