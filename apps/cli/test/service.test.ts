import { beforeEach, describe, expect, test } from "bun:test";
import { type DeviceRow, NotSignedInError, RevokedDeviceError } from "@agentsessionvault/client";
import type { AccountKeys } from "@agentsessionvault/crypto";
import { ConflictError, MemoryServer } from "@agentsessionvault/sync";
import type { Session } from "@supabase/supabase-js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { unlockAtStart } from "../src/daemon.ts";
import { type Backend, LockedError, NoAccountError, VaultService } from "../src/service.ts";

const USER = "a0000000-0000-4000-8000-000000000001";
const PASS = "a long enough passphrase";
const jwt = (sessionId: string) =>
  `h.${Buffer.from(JSON.stringify({ sub: USER, session_id: sessionId })).toString("base64url")}.s`;

/** Shared "server": the account row, devices and sync data. */
class FakeServer {
  account: AccountKeys | null = null;
  devices: (DeviceRow & { user_id: string })[] = [];
  sync = new MemoryServer();
  sentTo: string[] = [];
  redirects: (string | undefined)[] = [];
  n = 0;
}

/** One signed-in client. Mirrors RLS: devices are only visible to an active device. */
class FakeBackend implements Backend {
  current: Session | null = null;
  constructor(readonly server: FakeServer) {}

  async sendLoginEmail(email: string, redirectTo?: string) {
    if (email.startsWith("fail")) throw new Error("Email address not authorized");
    this.server.sentTo.push(email);
    this.server.redirects.push(redirectTo);
  }
  async verifyLogin(email: string, input: string) {
    if (input !== "123456" && !input.includes("code=good")) throw new Error("Token has expired or is invalid");
    this.current = {
      access_token: jwt(`s-${++this.server.n}`),
      user: { id: USER, email },
    } as unknown as Session;
    return this.current;
  }
  async session() {
    return this.current;
  }
  async requireSession() {
    if (!this.current) throw new NotSignedInError();
    return this.current;
  }
  async signOut() {
    this.current = null;
  }
  async getAccount() {
    return this.server.account;
  }
  async createAccount(_: string, row: AccountKeys) {
    if (this.server.account) throw new ConflictError("exists");
    this.server.account = row;
  }
  private sid() {
    return JSON.parse(Buffer.from(this.current!.access_token.split(".")[1]!, "base64url").toString()).session_id as string;
  }
  private active() {
    return this.server.devices.some((d) => d.auth_session_id === this.sid() && d.status === "active");
  }
  async currentDevice() {
    return this.server.devices.find((d) => d.auth_session_id === this.sid() && d.status === "active") ?? null;
  }
  async registerDevice(id: string, name_enc: DeviceRow["name_enc"]) {
    if (this.server.devices.some((d) => d.auth_session_id === this.sid())) throw new RevokedDeviceError();
    this.server.devices.push({ id, user_id: USER, auth_session_id: this.sid(), name_enc, status: "active", created_at: new Date().toISOString(), last_seen_at: null });
  }
  async listDevices() {
    return this.active() ? this.server.devices.map((d) => ({ ...d })) : [];
  }
  async touchDevice(id: string) {
    const d = this.server.devices.find((x) => x.id === id)!;
    d.last_seen_at = new Date().toISOString();
  }
  remote(userId: string) {
    return this.server.sync.remote(userId, "device");
  }
}

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
});

async function device() {
  const root = await mkdtemp(join(tmpdir(), "asv-svc-"));
  const backend = new FakeBackend(server);
  const svc = new VaultService({ supabaseUrl: "", publishableKey: "", stateDir: join(root, "state"), piSessionsDir: join(root, "pi"), socketPath: "" }, backend);
  await svc.init();
  return { root, svc, backend };
}

async function signedIn() {
  const d = await device();
  await d.svc.login("Me@Example.com ", { callback: false });
  await d.svc.verify("123456");
  return d;
}

describe("login", () => {
  test("sends the email, then verifies with what the user pastes", async () => {
    const { svc } = await device();
    expect(await svc.status()).toEqual({ signedIn: false, unlocked: false });
    expect(await svc.login(" Me@Example.com", { callback: false })).toEqual({ email: "me@example.com", callback: false });
    expect(server.sentTo).toEqual(["me@example.com"]);
    expect(server.redirects).toEqual([undefined]);
    expect(await svc.status()).toEqual({ signedIn: false, unlocked: false, pendingLogin: "me@example.com" });
    await expect(svc.verify("000000")).rejects.toThrow("invalid");
    const st = await svc.verify("123456");
    expect(st).toMatchObject({ signedIn: true, email: "me@example.com", userId: USER, account: false, unlocked: false });
  });

  test("the email link redirects to the local callback, which completes the login", async () => {
    const { svc } = await device();
    expect(await svc.login("me@example.com")).toEqual({ email: "me@example.com", callback: true });
    const url = server.redirects[0]!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\//);
    const waiting = svc.waitLogin();
    expect((await fetch(`${url}?code=good`)).status).toBe(200);
    expect(await waiting).toMatchObject({ signedIn: true, email: "me@example.com" });
    await expect(svc.waitLogin()).rejects.toThrow("no login is waiting");
  });

  test("a bad code from the callback fails the wait", async () => {
    const { svc } = await device();
    await svc.login("me@example.com");
    const outcome = svc.waitLogin().catch((e: Error) => e.message);
    await fetch(`${server.redirects[0]}?code=bad`);
    expect(await outcome).toContain("invalid");
  });

  test("pasting instead closes the callback server", async () => {
    const { svc } = await device();
    await svc.login("me@example.com");
    const waiting = svc.waitLogin();
    await svc.verify("123456");
    await expect(waiting).rejects.toThrow("cancelled");
    await new Promise((r) => setTimeout(r, 20));
    await expect(fetch(`${server.redirects[0]}?code=good`)).rejects.toThrow();
  });

  test("logging in again replaces the waiting login", async () => {
    const { svc } = await device();
    await svc.login("me@example.com");
    const first = svc.waitLogin();
    await svc.login("me@example.com");
    await expect(first).rejects.toThrow("cancelled");
    expect(server.redirects[1]).not.toBe(server.redirects[0]);
    await svc.logout();
  });

  test("sendEmail: false only starts the callback, for dev-login", async () => {
    const { svc } = await device();
    const r = await svc.login("me@example.com", { sendEmail: false });
    expect(r.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(server.sentTo).toEqual([]);
    expect((await svc.login("me@example.com")).callbackUrl).toBeUndefined();
    await svc.logout();
  });

  test("a failed email closes the callback server", async () => {
    const { svc } = await device();
    await expect(svc.login("fail@example.com")).rejects.toThrow("not authorized");
    await expect(svc.waitLogin()).rejects.toThrow("no login is waiting");
  });

  test("rejects bad emails and verify without login", async () => {
    const { svc } = await device();
    await expect(svc.login("nope")).rejects.toThrow("email address");
    await expect(svc.verify("123456")).rejects.toThrow("login` first");
    expect((await svc.verify("123456", "x@y.z")).signedIn).toBe(true);
  });

  test("logout locks and signs out", async () => {
    const { svc } = await signedIn();
    await svc.setup({ passphrase: PASS });
    await svc.logout();
    expect(await svc.status()).toEqual({ signedIn: false, unlocked: false });
  });
});

describe("setup", () => {
  test("creates the account, registers the device and unlocks", async () => {
    const { svc } = await signedIn();
    const r = await svc.setup({ passphrase: PASS });
    expect(r.recoveryKey).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(r.passphrase).toBeUndefined();
    expect(server.account?.kdf.iterations).toBe(600_000);
    const st = await svc.status();
    expect(st).toMatchObject({ account: true, unlocked: true, deviceName: hostname() });
    expect(server.devices).toHaveLength(1);
    expect(server.devices[0]!.last_seen_at).not.toBeNull();
    const [d] = await svc.devices();
    expect(d).toMatchObject({ id: st.deviceId, name: hostname(), status: "active", current: true });
  });

  test("can generate the passphrase", async () => {
    const { svc } = await signedIn();
    const r = await svc.setup({ generate: true });
    expect(r.passphrase!.length).toBeGreaterThanOrEqual(16);
    const other = await signedIn();
    expect((await other.svc.unlock({ passphrase: r.passphrase! })).unlocked).toBe(true);
  });

  test("refuses when signed out, without a passphrase, a weak one, or a second time", async () => {
    await expect((await device()).svc.setup({ passphrase: PASS })).rejects.toBeInstanceOf(NotSignedInError);
    const { svc } = await signedIn();
    await expect(svc.setup({})).rejects.toThrow("passphrase is required");
    await expect(svc.setup({ passphrase: "short" })).rejects.toThrow("16");
    await svc.setup({ passphrase: PASS });
    await expect(svc.setup({ passphrase: PASS })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("unlock", () => {
  test("with the passphrase or the recovery key, on another device", async () => {
    const a = await signedIn();
    const { recoveryKey } = await a.svc.setup({ passphrase: PASS });

    const b = await signedIn();
    expect(await b.svc.status()).toMatchObject({ account: true, unlocked: false });
    await expect(b.svc.unlock({ passphrase: "wrong but long enough" })).rejects.toThrow("decrypt");
    expect((await b.svc.unlock({ passphrase: PASS })).unlocked).toBe(true);

    const c = await signedIn();
    expect((await c.svc.unlock({ recoveryKey })).unlocked).toBe(true);
    expect(server.devices).toHaveLength(3);
    expect((await c.svc.devices()).filter((d) => d.current)).toHaveLength(1);
  });

  test("unlocking again reuses the device", async () => {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    await a.svc.unlock({ passphrase: PASS });
    expect(server.devices).toHaveLength(1);
  });

  test("needs an account and a secret", async () => {
    const { svc } = await signedIn();
    await expect(svc.unlock({ passphrase: PASS })).rejects.toBeInstanceOf(NoAccountError);
    await svc.setup({ passphrase: PASS });
    await expect(svc.unlock({})).rejects.toThrow("passphrase or recovery key");
  });

  test("a revoked device's sign-in can't come back", async () => {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    server.devices[0]!.status = "revoked";
    await expect(a.svc.unlock({ passphrase: PASS })).rejects.toBeInstanceOf(RevokedDeviceError);
  });

  test("a new sign-in invalidates the unlocked state", async () => {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    await a.backend.verifyLogin("me@example.com", "123456");
    expect((await a.svc.status()).unlocked).toBe(false);
  });
});

describe("sync through the service", () => {
  test("needs signing in, an account and unlocking", async () => {
    await expect((await device()).svc.push("/x")).rejects.toBeInstanceOf(NotSignedInError);
    const { svc } = await signedIn();
    await expect(svc.push("/x")).rejects.toBeInstanceOf(NoAccountError);
    await (await signedIn()).svc.setup({ passphrase: PASS });
    await expect(svc.push("/x")).rejects.toBeInstanceOf(LockedError);
    await expect(svc.pull("x")).rejects.toBeInstanceOf(LockedError);
    await expect(svc.sessions()).rejects.toBeInstanceOf(LockedError);
    await expect(svc.devices()).rejects.toBeInstanceOf(LockedError);
  });

  test("push, list and pull with relative and explicit paths", async () => {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    const sid = "01a1d47c-9870-7461-a887-70599c34d8ab";
    const file = join(a.root, "s.jsonl");
    await writeFile(file, `{"type":"session","version":3,"id":"${sid}","timestamp":"2026-11-13T10:38:17.712Z","cwd":"/p"}\n`);
    const cwd = process.cwd();
    process.chdir(a.root);
    try {
      expect((await a.svc.push("s.jsonl")).created).toBe(true);
    } finally {
      process.chdir(cwd);
    }
    expect((await a.svc.sessions()).map((s) => s.id)).toEqual([sid]);

    const b = await signedIn();
    await b.svc.unlock({ passphrase: PASS });
    const r = await b.svc.pull(sid);
    expect(r.path).toBe(join(b.root, "pi", "--p--", `2026-11-13T10-38-17-712Z_${sid}.jsonl`));
    const out = join(b.root, "out.jsonl");
    expect((await b.svc.pull(sid, out)).path).toBe(out);
    expect(await readFile(out, "utf8")).toBe(await readFile(file, "utf8"));
  });

  test("device names that don't decrypt still list", async () => {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    server.devices[0]!.name_enc = { ...server.devices[0]!.name_enc, tag: "AAAAAAAAAAAAAAAAAAAAAA==" };
    expect((await a.svc.devices())[0]!.name).toBeUndefined();
  });
});

describe("unlockAtStart", () => {
  const io = (o: { env?: Record<string, string | undefined>; isTTY?: boolean; answers?: string[] } = {}) => {
    const answers = [...(o.answers ?? [])];
    const asked: string[] = [];
    return {
      asked,
      io: {
        env: o.env ?? {},
        isTTY: o.isTTY ?? false,
        prompt: async (q: string) => {
          asked.push(q);
          const a = answers.shift();
          if (a === undefined) throw new Error("no input");
          return a;
        },
      },
    };
  };

  async function withAccount() {
    const a = await signedIn();
    await a.svc.setup({ passphrase: PASS });
    return signedIn();
  }

  test("explains what to do when signed out or without an account", async () => {
    const logs: string[] = [];
    await unlockAtStart((await device()).svc, (m) => logs.push(m), io().io);
    await unlockAtStart((await signedIn()).svc, (m) => logs.push(m), io().io);
    expect(logs).toEqual(["signed out; run `agentsessionvault login`", "signed in as me@example.com; no account yet, run `agentsessionvault setup`"]);
  });

  test("uses and deletes AGENTSESSIONVAULT_PASSPHRASE", async () => {
    const b = await withAccount();
    const t = io({ env: { AGENTSESSIONVAULT_PASSPHRASE: PASS, OTHER: "x" } });
    await unlockAtStart(b.svc, () => {}, t.io);
    expect((await b.svc.status()).unlocked).toBe(true);
    expect(t.io.env).toEqual({ OTHER: "x" });
  });

  test("a wrong variable falls back to the prompt, which retries", async () => {
    const b = await withAccount();
    const logs: string[] = [];
    const t = io({ env: { AGENTSESSIONVAULT_PASSPHRASE: "wrong but long enough" }, isTTY: true, answers: ["also wrong, long enough", PASS] });
    await unlockAtStart(b.svc, (m) => logs.push(m), t.io);
    expect((await b.svc.status()).unlocked).toBe(true);
    expect(t.asked).toEqual(["Passphrase for me@example.com: ", "Passphrase for me@example.com: "]);
    expect(logs).toContain("wrong passphrase");
    expect(logs.at(-1)).toBe("unlocked as me@example.com");
  });

  test("without a terminal it stays locked", async () => {
    const b = await withAccount();
    const logs: string[] = [];
    await unlockAtStart(b.svc, (m) => logs.push(m), io().io);
    expect(logs).toEqual(["locked; run `agentsessionvault unlock`"]);
  });

  test("an empty answer, too many attempts, or a socket unlock end the prompt", async () => {
    const logs: string[] = [];
    const b = await withAccount();
    await unlockAtStart(b.svc, (m) => logs.push(m), io({ isTTY: true, answers: [""] }).io);
    expect(logs.at(-1)).toBe("still locked; run `agentsessionvault unlock`");

    // The terminal went away.
    await unlockAtStart(b.svc, (m) => logs.push(m), io({ isTTY: true }).io);
    expect(logs.at(-1)).toBe("still locked; run `agentsessionvault unlock`");

    const tooMany = io({ isTTY: true, answers: ["short", "short", "short", PASS] });
    await unlockAtStart(b.svc, (m) => logs.push(m), tooMany.io);
    expect(tooMany.asked).toHaveLength(3);
    expect(logs.filter((l) => l === "wrong passphrase").length).toBeGreaterThanOrEqual(3);

    // Unlocked over the socket while the prompt was open.
    const raced = io({ isTTY: true, answers: ["anything at all, long"] });
    raced.io.prompt = async () => {
      await b.svc.unlock({ passphrase: PASS });
      return "anything at all, long";
    };
    await unlockAtStart(b.svc, (m) => logs.push(m), raced.io);
    expect((await b.svc.status()).unlocked).toBe(true);
  });
});
