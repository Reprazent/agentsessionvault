import { afterEach, describe as group, expect, test } from "bun:test";
import { DaemonClient } from "@agentsessionvault/daemon-client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonServer, serve } from "../../cli/src/protocol.ts";
import { type DaemonStatus, Vault, type View, describe, statusLine } from "../src/vault.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

const servers: DaemonServer[] = [];
const vaults: Vault[] = [];
afterEach(async () => {
  for (const v of vaults.splice(0)) v.stop();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

const unlocked: DaemonStatus = { signedIn: true, email: "me@x", account: true, unlocked: true, deviceName: "mac", sync: { watching: true, pending: 0 } };

async function daemon(path: string, status: () => DaemonStatus = () => unlocked) {
  const calls: string[] = [];
  const s = await serve(
    path,
    {
      status: async () => (calls.push("status"), status()),
      nudge: async (p) => (calls.push(`nudge ${p.path}`), { watching: true, pending: 0 }),
    },
    { version: "9.9.9" },
  );
  servers.push(s);
  return { s, calls };
}

function vault(path: string, opts: { pollMs?: number } = {}) {
  const views: View[] = [];
  const v = new Vault({ connect: () => DaemonClient.connect(path), onChange: (x) => views.push(x), retryMs: 20, maxRetryMs: 40, ...opts });
  vaults.push(v);
  return { v, views };
}

const sock = async () => join(await mkdtemp(join(tmpdir(), "asv-ext-")), "d.sock");

group("Vault", () => {
  test("connects, says hello, keeps the connection and polls over it", async () => {
    const path = await sock();
    const { s, calls } = await daemon(path);
    const { v, views } = vault(path, { pollMs: 30 });
    v.start();
    v.start(); // idempotent
    await until(() => v.view.state === "connected");
    expect(views[0]).toEqual({ state: "connecting" });
    expect(v.view).toMatchObject({ hello: { version: "9.9.9" }, status: { unlocked: true } });
    expect(s.clientNames()).toEqual(["pi"]);
    await until(() => calls.filter((c) => c === "status").length >= 3);
    expect(s.clients()).toBe(1);
    expect(await v.call("nudge", { path: "/f" })).toEqual({ watching: true, pending: 0 });
    v.stop();
    await until(() => s.clients() === 0);
    await v.refresh(); // no-op when stopped
  });

  test("retries until a daemon answers, and reconnects when it goes away", async () => {
    const path = await sock();
    const { v, views } = vault(path);
    v.start();
    await until(() => views.filter((x) => x.state === "unavailable").length >= 2);
    const waits = views.flatMap((x) => (x.state === "unavailable" ? [x.retryInMs] : []));
    expect(waits.slice(0, 3)).toEqual([20, 40, 40].slice(0, waits.length >= 3 ? 3 : waits.length));
    await expect(v.call("status")).rejects.toThrow("vault daemon unavailable");

    const first = await daemon(path);
    await until(() => v.view.state === "connected");
    await first.s.close();
    servers.splice(servers.indexOf(first.s), 1);
    await until(() => v.view.state !== "connected");
    await daemon(path);
    await until(() => v.view.state === "connected");
  });

  test("stopping while connecting closes the new connection", async () => {
    const path = await sock();
    const { s } = await daemon(path);
    const { v } = vault(path);
    v.start();
    v.stop();
    await sleep(50);
    expect(s.clients()).toBe(0);
    expect(v.view.state).toBe("connecting");
    await expect(v.call("status")).rejects.toThrow("not connected");
  });

  test("a failed refresh leaves the view alone", async () => {
    const path = await sock();
    let fail = false;
    await daemon(path, () => {
      if (fail) throw new Error("nope");
      return unlocked;
    });
    const { v } = vault(path, { pollMs: 10_000 });
    v.start();
    await until(() => v.view.state === "connected");
    fail = true;
    const before = v.view;
    await v.refresh();
    expect(v.view).toBe(before);
  });
});

group("status text", () => {
  const hello = { version: "1", pid: 42 };
  const at = (s: DaemonStatus): View => ({ state: "connected", hello, status: s });
  const t1 = "2026-11-14T10:00:00.000Z";
  const t2 = "2026-11-14T11:00:00.000Z";
  test.each<[View, string]>([
    [{ state: "connecting" }, "vault: connecting"],
    [{ state: "unavailable", error: "x", retryInMs: 1000 }, "vault: unavailable"],
    [at({ signedIn: false, unlocked: false }), "vault: signed out"],
    [at({ signedIn: true, account: false, unlocked: false }), "vault: no account"],
    [at({ signedIn: true, account: true, unlocked: false }), "vault: locked"],
    [at({ ...unlocked, sync: undefined }), "vault: unlocked"],
    [at({ ...unlocked, sync: { watching: true, pending: 2 } }), "vault: 2 queued"],
    [at({ ...unlocked, sync: { watching: true, pending: 0, lastError: { path: "/f", message: "offline", at: t1 } } }), "vault: push failed"],
    [at({ ...unlocked, sync: { watching: true, pending: 0, lastPush: { path: "/f", at: t2 }, lastError: { path: "/f", message: "x", at: t1 } } }), "vault: synced"],
  ])("%j", (v, want) => {
    expect(statusLine(v)).toBe(want);
  });

  test("describe", () => {
    expect(describe({ state: "connecting" })).toContain("Connecting");
    expect(describe({ state: "unavailable", error: "boom", retryInMs: 4000 })).toBe("The vault daemon is unavailable: boom\nRetrying in 4s.");
    expect(describe(at({ signedIn: false, unlocked: false }))).toBe("daemon 1, pid 42\nSigned out. Run `agentsessionvault login <email>` in a terminal.");
    expect(describe(at({ signedIn: true, email: "me@x", account: false, unlocked: false }))).toContain("no account yet");
    expect(describe(at({ signedIn: true, email: "me@x", account: true, unlocked: false }))).toContain("locked. Run `agentsessionvault unlock`");
    expect(describe(at({ ...unlocked, deviceName: undefined, sync: undefined }))).toBe("daemon 1, pid 42\nSigned in as me@x, unlocked on this device.");
    expect(
      describe(at({ ...unlocked, sync: { watching: false, pending: 1, lastPush: { path: "/f", at: t1 }, lastError: { path: "/f", message: "offline", at: t2 } } })),
    ).toBe(`daemon 1, pid 42\nSigned in as me@x, unlocked on mac.\nAuto-push off, 1 queued.\nLast push ${t1}.\nLast error ${t2}: offline`);
  });
});
