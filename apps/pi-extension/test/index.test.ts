import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonServer, serve } from "../../cli/src/protocol.ts";
import agentsessionvault, { SecretInput, VERSION, daemonCommand, extension, once, piUi } from "../src/index.ts";

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
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("agentsessionvault.pi.once")];
});

/** Just enough of Pi: event handlers, commands, a context with a footer. */
function fakePi(opts?: Parameters<typeof extension>[1], answers: unknown[] = [], mode = "rpc") {
  const on = new Map<string, Fn>();
  const commands = new Map<string, { handler: Fn }>();
  const statuses: (string | undefined)[] = [];
  const notes: [string, string | undefined][] = [];
  let file: string | undefined = "/sessions/--p--/s.jsonl";
  const asked: string[] = [];
  const answer = async (q: string) => {
    asked.push(q);
    return answers.shift();
  };
  const ctx = {
    hasUI: true,
    mode,
    ui: {
      setStatus: (_k: string, t: string | undefined) => statuses.push(t),
      notify: (m: string, t?: string) => notes.push([m, t]),
      input: (t: string) => answer(`input: ${t}`),
      confirm: (t: string) => answer(`confirm: ${t}`),
      select: (t: string) => answer(`select: ${t}`),
      editor: (t: string) => answer(`editor: ${t}`),
      custom: (_f: unknown) => answer("custom"),
    },
    sessionManager: { getSessionFile: () => file },
  };
  const commandOpts = new Map<string, any>();
  const pi = {
    on: (e: string, f: Fn) => on.set(e, f),
    registerCommand: (n: string, o: { handler: Fn }) => (commands.set(n, o), commandOpts.set(n, o)),
  };
  if (opts) extension(pi as never, opts);
  else agentsessionvault(pi as never);
  return {
    emit: (e: string, ev: object = {}) => on.get(e)!(ev, ctx),
    command: (n: string, args = "") => commands.get(n)!.handler(args, ctx),
    complete: (prefix: string) => commandOpts.get("vault").getArgumentCompletions(prefix),
    ctx,
    asked,
    statuses,
    notes,
    setFile: (f: string | undefined) => (file = f),
  };
}

test("daemonCommand", async () => {
  expect(await daemonCommand({ AGENTSESSIONVAULT_BIN: "/dev/asv" })).toEqual(["/dev/asv", "daemon", "--idle-exit"]);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
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

test("downloads the daemon when there's none, and says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asv-pi-"));
  const { assetName } = await import("../../../packages/daemon-client/src/index.ts");
  const srv = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname.endsWith("/SHA256SUMS")
        ? new Response(`${"0".repeat(64)}  ${assetName()}\n`)
        : new Response("not the binary"),
  });
  try {
    process.env.AGENTSESSIONVAULT_HOME = dir;
    process.env.AGENTSESSIONVAULT_SOCKET = join(dir, "d.sock");
    process.env.AGENTSESSIONVAULT_RELEASES_URL = `http://127.0.0.1:${srv.port}`;
    process.env.PATH = "";
    delete process.env.AGENTSESSIONVAULT_BIN;
    const pi = fakePi({ devBuild: join(dir, "no-dev-build") });
    await pi.emit("session_start");
    await until(() => pi.statuses.at(-1) === "vault: unavailable");
    expect(pi.statuses).toContain("vault: downloading daemon");
    await pi.command("vault");
    expect(pi.notes.pop()![0]).toContain("checksum mismatch");
    await pi.emit("session_shutdown", { reason: "quit" });
  } finally {
    srv.stop(true);
  }
});

async function daemonAt(handlers: Parameters<typeof serve>[1], version = VERSION) {
  const dir = await mkdtemp(join(tmpdir(), "asv-pi-"));
  process.env.AGENTSESSIONVAULT_HOME = dir;
  process.env.AGENTSESSIONVAULT_SOCKET = join(dir, "d.sock");
  process.env.AGENTSESSIONVAULT_BIN = join(dir, "missing-binary");
  server = await serve(join(dir, "d.sock"), handlers, { version });
  return dir;
}

test("in the TUI, a locked daemon asks for the passphrase once per process", async () => {
  let unlocked = false;
  const tried: unknown[] = [];
  await daemonAt({
    status: async () => ({ signedIn: true, email: "me@x.io", account: true, unlocked }),
    unlock: async (p) => {
      tried.push(p);
      unlocked = true;
      return { signedIn: true, email: "me@x.io", account: true, unlocked, deviceName: "laptop" };
    },
  });
  const pi = fakePi(undefined, ["correct horse battery staple"], "tui");
  await pi.emit("session_start");
  await until(() => pi.statuses.at(-1) === "vault: unlocked");
  expect(pi.asked).toEqual(["custom"]);
  expect(tried).toEqual([{ passphrase: "correct horse battery staple" }]);
  expect(pi.notes).toContainEqual(["Unlocked on laptop.", "info"]);
  await pi.emit("session_shutdown");

  // /new: a new runtime, same process. Locked again (say, a restart), but no second prompt.
  unlocked = false;
  const again = fakePi(undefined, [], "tui");
  await again.emit("session_start");
  await until(() => again.statuses.at(-1) === "vault: locked");
  await sleep(20);
  expect(again.asked).toEqual([]);
  expect(once().offeredUnlock).toBe(true);
  await again.emit("session_shutdown");
});

test("notes a signed-out daemon and a version mismatch once", async () => {
  await daemonAt({ status: async () => ({ signedIn: false, unlocked: false }) }, "0.0.1");
  const pi = fakePi();
  await pi.emit("session_start");
  await until(() => pi.notes.length >= 2);
  expect(pi.notes).toEqual([
    [`The vault daemon is version 0.0.1, this extension ${VERSION}. /vault restart starts the matching one.`, "warning"],
    ["Vault: signed out, sessions don't sync. /vault login to start.", "info"],
  ]);
  await pi.emit("session_shutdown");
  const again = fakePi();
  await again.emit("session_start");
  await until(() => again.statuses.at(-1) === "vault: signed out");
  expect(again.notes).toEqual([]);
  await again.emit("session_shutdown");
});

test("signed in without an account says so", async () => {
  await daemonAt({ status: async () => ({ signedIn: true, email: "me@x.io", account: false, unlocked: false }) });
  const pi = fakePi();
  await pi.emit("session_start");
  await until(() => pi.notes.length >= 1);
  expect(pi.notes[0]![0]).toContain("/vault setup");
  await pi.emit("session_shutdown");
});

test("/vault subcommands run the flows against the daemon", async () => {
  let st: Record<string, unknown> = { signedIn: true, email: "me@x.io", account: true, unlocked: false };
  let gate: Promise<void> | undefined;
  await daemonAt({
    status: async () => st,
    unlock: async (p) => {
      await gate;
      if (p.passphrase !== "pw" && p.recoveryKey !== "rk") throw new Error("wrong passphrase");
      return (st = { ...st, unlocked: true });
    },
    logout: async () => ((st = { signedIn: false, unlocked: false }), {}),
    login: async (p) => ({ email: p.email, callback: false }),
    setup: async () => ({ recoveryKey: "RK" }),
  });
  const answers: unknown[] = [];
  const pi = fakePi(undefined, answers);
  await pi.emit("session_start");
  await until(() => pi.statuses.at(-1) === "vault: locked");

  answers.push("rk");
  await pi.command("vault", "unlock --recovery");
  expect(pi.asked.at(-1)).toBe("input: Recovery key");
  expect(pi.statuses.at(-1)).toBe("vault: unlocked");

  await pi.command("vault", " status ");
  expect(pi.notes.at(-1)![0]).toContain("unlocked");

  answers.push(true);
  await pi.command("vault", "logout");
  expect(pi.statuses.at(-1)).toBe("vault: signed out");

  answers.push(undefined); // cancel the code prompt
  await pi.command("vault", "login me@x.io");
  expect(pi.notes.at(-1)![0]).toContain("Sent a sign-in email to me@x.io");

  await pi.command("vault", "setup");
  expect(pi.notes.at(-1)).toEqual(["Sign in first: /vault login", "warning"]);

  // One flow at a time.
  st = { signedIn: true, email: "me@x.io", account: true, unlocked: false };
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  answers.push("pw");
  const first = pi.command("vault", "unlock");
  await sleep(20);
  await pi.command("vault", "unlock");
  expect(pi.notes.at(-1)).toEqual(["A vault prompt is already open.", "warning"]);
  open();
  await first;

  await pi.command("vault", "frobnicate");
  expect(pi.notes.at(-1)![0]).toContain("Unknown: /vault frobnicate");

  // A failing daemon call shows as an error.
  await server!.close();
  server = undefined;
  await pi.command("vault", "unlock");
  expect(pi.notes.at(-1)![1]).toBe("error");

  expect(pi.complete("lo").map((c: { value: string }) => c.value)).toEqual(["login", "logout"]);
  expect(pi.complete("zz")).toBeNull();
  await pi.emit("session_shutdown");
});

test("/vault restart stops the daemon and waits for a new one", async () => {
  const dir = await daemonAt({ status: async () => ({ signedIn: false, unlocked: false }) });
  const pi = fakePi(undefined, [false, true]);
  await pi.emit("session_start");
  await until(() => pi.statuses.at(-1) === "vault: signed out");
  // Declined: nothing happens.
  await pi.command("vault", "restart");
  expect(pi.asked.at(-1)).toBe("confirm: Restart the vault daemon?");

  // Our "daemon" is this test process: catch the SIGTERM, then swap in a new server.
  const onTerm = async () => {
    await server!.close();
    server = await serve(join(dir, "d.sock"), { status: async () => ({ signedIn: false, unlocked: false }) }, { version: "9.9.9" });
  };
  process.once("SIGTERM", onTerm);
  await pi.command("vault", "restart");
  expect(pi.notes.some(([m]) => m.startsWith(`Daemon `))).toBe(true);
  await pi.emit("session_shutdown");
}, 20_000);

test("SecretInput masks what's typed", () => {
  let renders = 0;
  let result = null as string | undefined | null;
  const c = new SecretInput("Passphrase", { requestRender: () => void renders++ }, { accent: (s) => `[${s}]`, dim: (s) => s }, (v) => (result = v));
  for (const ch of "hunter2") c.handleInput(ch);
  c.handleInput("\x7f");
  expect(c.render(40)).toEqual(["[Passphrase]", "> ••••••█", "enter to submit, esc to cancel"]);
  expect(renders).toBe(8);
  c.handleInput("\r");
  expect(result).toBe("hunter");
  c.handleInput("\x1b");
  expect(result).toBeUndefined();
  expect(c.render(4)[1]).toBe("> •█");
  c.invalidate();
});

test("piUi maps to Pi's dialogs; secrets are masked only in the TUI", async () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => async (...a: unknown[]) => (calls.push([name, ...a]), name === "confirm" ? true : "x");
  const ui = {
    notify: (...a: unknown[]) => calls.push(["notify", ...a]),
    input: rec("input"),
    select: rec("select"),
    confirm: rec("confirm"),
    editor: rec("editor"),
    custom: async (f: (...a: unknown[]) => unknown) => {
      const c = f({ requestRender() {} }, { fg: (_c: string, s: string) => s }, {}, () => {}) as SecretInput;
      calls.push(["custom", c.render(20)[0]]);
      return "secret";
    },
  };
  const tui = piUi({ mode: "tui", ui } as never);
  tui.notify("hi");
  tui.notify("careful", "warning");
  expect(await tui.input("Email", "you@x", new AbortController().signal)).toBe("x");
  expect(await tui.input("Email")).toBe("x");
  expect(await tui.secret("Passphrase")).toBe("secret");
  expect(await tui.select("Pick", ["a"])).toBe("x");
  expect(await tui.confirm("Sure?", "really")).toBe(true);
  await tui.show("Keys", "RK");
  expect(await piUi({ mode: "rpc", ui } as never).secret("Passphrase")).toBe("x");
  expect(calls.map((c) => c[0])).toEqual(["notify", "notify", "input", "input", "custom", "select", "confirm", "editor", "input"]);
  expect(calls[1]).toEqual(["notify", "careful", "warning"]);
  expect(calls[4]).toEqual(["custom", "Passphrase"]);
  expect(calls[7]).toEqual(["editor", "Keys (close when done)", "RK"]);
});
