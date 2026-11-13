import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient, type Hello, connectOrStart, daemonPaths, ping } from "../src/index.ts";

const MAIN = resolve(import.meta.dir, "../../../apps/cli/src/main.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real daemon (the CLI from source) in its own state directory. */
async function env() {
  const home = await mkdtemp(join(tmpdir(), "asv-start-"));
  const socketPath = join(home, "custom.sock");
  return {
    home,
    socketPath,
    logFile: join(home, "daemon.log"),
    command: [process.execPath, MAIN, "daemon", "--idle-exit", "--idle-seconds", "0.3"],
    // No AGENTSESSIONVAULT_SOCKET: connectOrStart passes socketPath on.
    env: { ...process.env, AGENTSESSIONVAULT_HOME: home, AGENTSESSIONVAULT_PI_SESSIONS: join(home, "pi") },
  };
}

describe("connectOrStart", () => {
  test("starts one daemon for concurrent clients; it exits after the last leaves", async () => {
    const e = await env();
    const [a, b, c] = await Promise.all([connectOrStart(e), connectOrStart(e), connectOrStart(e)]);
    const pids = await Promise.all([a, b, c].map(async (x) => (await x.client.call<Hello>("hello", { client: "test" })).pid));
    expect(new Set(pids).size).toBe(1);
    expect([a, b, c].some((x) => x.started)).toBe(true);

    // A client that's already there doesn't start anything.
    const d = await connectOrStart(e);
    expect(d.started).toBe(false);
    for (const x of [a, b, c]) x.client.close();
    await sleep(500);
    expect(await ping(e.socketPath)).toBe(true); // d is still connected
    let gone = false;
    d.client.onClose(() => (gone = true));
    d.client.close();
    // Polling with ping would be a client and keep it alive; watch the pid.
    const alive = () => {
      try {
        process.kill(pids[0]!, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await sleep(100);
    expect(alive()).toBe(false);
    expect(await ping(e.socketPath)).toBe(false);
    expect(gone).toBe(true);
    const log = await readFile(e.logFile, "utf8");
    expect(log).toContain("exits after 0.3s without clients");
    expect(log).toContain("stopping: no clients for 0.3s");
  }, 20_000);

  test("a missing command fails fast; a daemon that dies says where to look", async () => {
    const e = await env();
    await expect(connectOrStart({ ...e, command: [join(e.home, "nope")] })).rejects.toThrow("couldn't start the daemon");
    await expect(connectOrStart({ ...e, command: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 300 })).rejects.toThrow(
      `the daemon didn't start (exited with 3); see ${e.logFile}`,
    );
    await expect(connectOrStart({ ...e, command: [] })).rejects.toThrow("command is empty");
  });

  test("other connection errors aren't treated as 'not running'", async () => {
    const e = await env();
    const bad = join(e.home, "x".repeat(200), "d.sock");
    await expect(DaemonClient.connect(bad)).rejects.toThrow();
    await expect(connectOrStart({ ...e, socketPath: bad })).rejects.not.toThrow("didn't start");
  });
});

describe("daemonPaths", () => {
  test("defaults and overrides", () => {
    const d = daemonPaths({});
    expect(d.stateDir).toEndWith("/.local/share/agentsessionvault");
    expect(d.socketPath).toBe(join(d.stateDir, "daemon.sock"));
    expect(d.logFile).toBe(join(d.stateDir, "daemon.log"));
    expect(daemonPaths({ XDG_DATA_HOME: "/x", XDG_RUNTIME_DIR: "/run" })).toEqual({
      stateDir: "/x/agentsessionvault",
      socketPath: "/run/agentsessionvault.sock",
      logFile: "/x/agentsessionvault/daemon.log",
    });
    expect(daemonPaths({ AGENTSESSIONVAULT_HOME: "/h", AGENTSESSIONVAULT_SOCKET: "/s" }).socketPath).toBe("/s");
  });
});
