import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonServer, serve } from "../../cli/src/protocol.ts";
import extension, { daemonCommand } from "../src/index.ts";

type Fn = (...a: any[]) => Promise<unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

let server: DaemonServer | undefined;
const env = { ...process.env };
afterEach(async () => {
  await server?.close();
  server = undefined;
  process.env = { ...env };
});

/** Just enough of Pi: event handlers, commands, a context with a footer. */
function fakePi() {
  const on = new Map<string, Fn>();
  const commands = new Map<string, { handler: Fn }>();
  const statuses: (string | undefined)[] = [];
  const notes: [string, string | undefined][] = [];
  let file: string | undefined = "/sessions/--p--/s.jsonl";
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_k: string, t: string | undefined) => statuses.push(t), notify: (m: string, t?: string) => notes.push([m, t]) },
    sessionManager: { getSessionFile: () => file },
  };
  const pi = { on: (e: string, f: Fn) => on.set(e, f), registerCommand: (n: string, o: { handler: Fn }) => commands.set(n, o) };
  extension(pi as never);
  return {
    emit: (e: string, ev: object = {}) => on.get(e)!(ev, ctx),
    command: (n: string) => commands.get(n)!.handler("", ctx),
    statuses,
    notes,
    setFile: (f: string | undefined) => (file = f),
  };
}

test("daemonCommand", () => {
  expect(daemonCommand({})).toEqual(["agentsessionvault", "daemon", "--idle-exit"]);
  expect(daemonCommand({ AGENTSESSIONVAULT_BIN: "/dev/asv" })[0]).toBe("/dev/asv");
});

test("connects on session start, shows status, nudges after a run, disconnects on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asv-pi-"));
  process.env.AGENTSESSIONVAULT_HOME = dir;
  process.env.AGENTSESSIONVAULT_SOCKET = join(dir, "d.sock");
  let unlocked = false;
  const nudged: unknown[] = [];
  server = await serve(join(dir, "d.sock"), {
    status: async () => ({ signedIn: true, account: true, unlocked, sync: unlocked ? { watching: true, pending: 0 } : undefined }),
    nudge: async (p) => {
      if (p.path === "/broken") throw new Error("push failed");
      nudged.push(p.path);
      return {};
    },
  });
  const pi = fakePi();
  await pi.command("vault");
  expect(pi.notes.pop()).toEqual(["agentsessionvault isn't running in this session.", "warning"]);

  await pi.emit("session_start");
  await pi.emit("session_start"); // a second start reuses the connection
  await until(() => pi.statuses.at(-1) === "vault: locked");
  expect(pi.statuses[0]).toBe("vault: connecting");
  expect(server.clients()).toBe(1);

  // Locked: no nudge.
  await pi.emit("agent_settled");
  expect(nudged).toEqual([]);
  unlocked = true;
  await pi.command("vault");
  expect(pi.notes.pop()![0]).toContain("unlocked");
  await pi.emit("agent_settled");
  expect(nudged).toEqual(["/sessions/--p--/s.jsonl"]);
  expect(pi.statuses.at(-1)).toBe("vault: synced");
  // A failed nudge doesn't break the run; the watcher retries anyway.
  pi.setFile("/broken");
  await pi.emit("agent_settled");
  // No session file (ephemeral session): nothing to nudge.
  pi.setFile(undefined);
  await pi.emit("agent_settled");
  expect(nudged).toHaveLength(1);

  await pi.emit("session_shutdown", { reason: "quit" });
  await until(() => server!.clients() === 0);
  await pi.emit("agent_settled");
  expect(nudged).toHaveLength(1);
});

test("an unavailable daemon shows in the footer and in /vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asv-pi-"));
  process.env.AGENTSESSIONVAULT_HOME = dir;
  process.env.AGENTSESSIONVAULT_SOCKET = join(dir, "d.sock");
  process.env.AGENTSESSIONVAULT_BIN = join(dir, "missing-binary");
  const pi = fakePi();
  await pi.emit("session_start");
  await until(() => pi.statuses.at(-1) === "vault: unavailable");
  await pi.command("vault");
  const [msg, level] = pi.notes.pop()!;
  expect(msg).toContain("couldn't start the daemon");
  expect(level).toBe("warning");
  await pi.emit("session_shutdown", { reason: "quit" });
});
