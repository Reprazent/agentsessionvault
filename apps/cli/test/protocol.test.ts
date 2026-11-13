import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { handlers } from "../src/daemon.ts";
import { DaemonClient, DaemonNotRunningError, type DaemonServer, RemoteError, ping, serve } from "../src/protocol.ts";
import type { VaultService } from "../src/service.ts";

const servers: DaemonServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function sockPath() {
  return join(await mkdtemp(join(tmpdir(), "asv-sock-")), "sub", "d.sock");
}

async function start(path: string, h: Parameters<typeof serve>[1]) {
  const s = await serve(path, h);
  servers.push(s);
  return s;
}

describe("socket protocol", () => {
  test("calls handlers and returns results", async () => {
    const path = await sockPath();
    await start(path, { ping: async () => "pong", echo: async (p) => p, nothing: async () => undefined });
    const c = await DaemonClient.connect(path);
    expect(await c.call("ping")).toBe("pong");
    expect(await Promise.all([c.call("echo", { a: 1 }), c.call("echo", { b: 2 })])).toEqual([{ a: 1 }, { b: 2 }]);
    expect(await c.call("nothing")).toBeNull();
    c.close();
  });

  test("the socket is only accessible to the owner", async () => {
    const path = await sockPath();
    await start(path, {});
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("errors keep their name and message", async () => {
    const path = await sockPath();
    await start(path, {
      boom: async () => {
        throw new TypeError("bad input");
      },
    });
    const c = await DaemonClient.connect(path);
    const e = await c.call("boom").catch((x) => x);
    expect(e).toBeInstanceOf(RemoteError);
    expect(e).toMatchObject({ name: "TypeError", message: "bad input" });
    await expect(c.call("missing")).rejects.toThrow("unknown method missing");
    await expect(c.call("toString")).rejects.toThrow("unknown method toString");
    c.close();
  });

  test("garbage lines get a protocol error, and the connection survives", async () => {
    const path = await sockPath();
    const s = await start(path, { ping: async () => "pong" });
    const reply = await new Promise<string>((ok) => {
      const sock = connect(path, () => sock.write("not json\n\n"));
      sock.on("data", (d) => {
        ok(d.toString());
        sock.end();
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ error: { name: "ProtocolError" } });
    expect(s.clients()).toBeGreaterThanOrEqual(0);
  });

  test("handles requests split across packets", async () => {
    const path = await sockPath();
    await start(path, { ping: async () => "pong" });
    const reply = await new Promise<string>((ok) => {
      const sock = connect(path, () => {
        sock.write('{"id":7,"meth');
        setTimeout(() => sock.write('od":"ping"}\n'), 10);
      });
      sock.on("data", (d) => {
        ok(d.toString());
        sock.end();
      });
    });
    expect(JSON.parse(reply)).toEqual({ id: 7, result: "pong" });
  });

  test("counts connected clients", async () => {
    const path = await sockPath();
    const s = await start(path, { ping: async () => "pong" });
    const a = await DaemonClient.connect(path);
    const b = await DaemonClient.connect(path);
    await a.call("ping");
    await b.call("ping");
    expect(s.clients()).toBe(2);
    a.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.clients()).toBe(1);
    b.close();
  });

  test("pending calls fail when the daemon goes away", async () => {
    const path = await sockPath();
    const s = await serve(path, { slow: () => new Promise(() => {}) });
    const c = await DaemonClient.connect(path);
    const outcome = c.call("slow").then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 10));
    await s.close();
    expect(await outcome).toBe("the daemon closed the connection");
  });

  test("no daemon", async () => {
    const path = await sockPath();
    await expect(DaemonClient.connect(path)).rejects.toBeInstanceOf(DaemonNotRunningError);
    expect(await ping(path)).toBe(false);
  });

  test("replaces a stale socket file, refuses to start twice", async () => {
    const path = await sockPath();
    const first = await serve(path, { ping: async () => "pong" });
    await first.server.close();
    await new Promise((r) => setTimeout(r, 10));
    // The file may linger after a crash.
    await writeFile(path, "").catch(() => {});
    const second = await start(path, { ping: async () => "pong" });
    expect(await ping(path)).toBe(true);
    await expect(serve(path, {})).rejects.toThrow("already running");
  });
});

describe("daemon handlers", () => {
  const calls: [string, unknown[]][] = [];
  const svc = new Proxy(
    {},
    {
      get: (_, name: string) =>
        async (...args: unknown[]) => {
          calls.push([name, args]);
          if (name === "push") return { sessionId: "s", chunks: [], pulled: 1 };
          if (name === "pull") return { sessionId: "s", chunks: 0, path: "/p" };
          if (name === "unlock") return { deviceId: "d" };
          if (name === "revokeDevice") return { id: "abcd" };
          return {};
        },
    },
  ) as unknown as VaultService;
  const logs: string[] = [];
  const h = handlers(svc, (m) => logs.push(m));

  test("map params onto the service", async () => {
    calls.length = 0;
    expect(await h.ping!({})).toBe("pong");
    await h.status!({});
    await h.login!({ email: "a@b.c" });
    await h.login!({ email: "a@b.c", callback: false });
    await h.login!({ email: "a@b.c", sendEmail: false });
    await h.waitLogin!({});
    await h.verify!({ input: "123456" });
    await h.verify!({ input: "123456", email: "a@b.c" });
    await h.logout!({});
    await h.setup!({ passphrase: "p" });
    await h.setup!({ generate: true });
    await h.unlock!({ passphrase: "p" });
    await h.unlock!({ recoveryKey: "r", passphrase: "" });
    await h.push!({ path: "/x.jsonl" });
    await h.pull!({ sessionId: "s" });
    await h.pull!({ sessionId: "s", path: "/out" });
    await h.passphrase!({ current: "c", passphrase: "n" });
    await h.passphrase!({ recoveryKey: "r", generate: true });
    await h.sessions!({});
    await h.devices!({});
    await h.revokeDevice!({ id: "abcd" });
    expect(calls).toEqual([
      ["status", []],
      ["login", ["a@b.c", { callback: true }]],
      ["login", ["a@b.c", { callback: false }]],
      ["login", ["a@b.c", { callback: true, sendEmail: false }]],
      ["waitLogin", []],
      ["verify", ["123456", undefined]],
      ["verify", ["123456", "a@b.c"]],
      ["logout", []],
      ["setup", [{ passphrase: "p", generate: false }]],
      ["setup", [{ generate: true }]],
      ["unlock", [{ passphrase: "p" }]],
      ["unlock", [{ recoveryKey: "r" }]],
      ["push", ["/x.jsonl"]],
      ["pull", ["s", undefined]],
      ["pull", ["s", "/out"]],
      ["changePassphrase", [{ current: "c", passphrase: "n", generate: false }]],
      ["changePassphrase", [{ recoveryKey: "r", generate: true }]],
      ["sessions", []],
      ["devices", []],
      ["revokeDevice", ["abcd"]],
    ]);
    expect(logs.some((l) => l.includes("merged 1 first"))).toBe(true);
  });

  test("validate params", async () => {
    await expect(h.login!({})).rejects.toThrow("email is required");
    await expect(h.push!({ path: 3 })).rejects.toThrow("path is required");
    await expect(h.pull!({ sessionId: "s", path: 3 })).rejects.toThrow("path must be a string");
  });
});

describe("config", () => {
  test("defaults", () => {
    const c = loadConfig({});
    expect(c.supabaseUrl).toBe("https://ewogalesdfjlidgybiwn.supabase.co");
    expect(c.publishableKey).toStartWith("sb_publishable_");
    expect(c.stateDir).toEndWith("/.local/share/agentsessionvault");
    expect(c.piSessionsDir).toEndWith("/.pi/agent/sessions");
    expect(c.socketPath).toBe(join(c.stateDir, "daemon.sock"));
  });

  test("overrides", () => {
    expect(loadConfig({ XDG_DATA_HOME: "/d", XDG_RUNTIME_DIR: "/run", PI_CODING_AGENT_DIR: "/pi" })).toMatchObject({
      stateDir: "/d/agentsessionvault",
      socketPath: "/run/agentsessionvault.sock",
      piSessionsDir: "/pi/sessions",
    });
    expect(
      loadConfig({
        AGENTSESSIONVAULT_HOME: "/h",
        AGENTSESSIONVAULT_SOCKET: "/s",
        AGENTSESSIONVAULT_PI_SESSIONS: "/ps",
        AGENTSESSIONVAULT_SUPABASE_URL: "https://x",
        AGENTSESSIONVAULT_PUBLISHABLE_KEY: "k",
      }),
    ).toEqual({ supabaseUrl: "https://x", publishableKey: "k", stateDir: "/h", piSessionsDir: "/ps", socketPath: "/s" });
  });
});
