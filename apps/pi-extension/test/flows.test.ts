import { describe, expect, test } from "bun:test";
import { type Call, type Ui, MIN_PASSPHRASE, login, logout, nextStep, setup, unlock } from "../src/flows.ts";
import type { DaemonStatus } from "../src/vault.ts";

type Answer = string | undefined | boolean | ((signal?: AbortSignal) => Promise<string | undefined>);

/** A Ui that answers from a script, in order, and records what it was asked and told. */
function scripted(answers: Answer[]) {
  const asked: string[] = [];
  const notes: string[] = [];
  const shown: string[] = [];
  const next = (kind: string, title: string, signal?: AbortSignal): Promise<any> => {
    asked.push(`${kind}: ${title}`);
    if (!answers.length) throw new Error(`no scripted answer for ${kind}: ${title}`);
    const a = answers.shift();
    return typeof a === "function" ? a(signal) : Promise.resolve(a);
  };
  const ui: Ui = {
    notify: (m, t) => notes.push(t && t !== "info" ? `${t}: ${m}` : m),
    input: (title, _p, signal) => next("input", title, signal),
    secret: (title) => next("secret", title),
    select: (title) => next("select", title),
    confirm: (title) => next("confirm", title),
    show: async (title, text) => {
      shown.push(`${title}\n${text}`);
    },
  };
  return { ui, asked, notes, shown };
}

/** A daemon: handlers by method, and a log of calls. */
function daemon(h: Record<string, (p: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  const call: Call = async <T,>(m: string, p: Record<string, unknown> = {}) => {
    calls.push([m, p]);
    const f = h[m];
    if (!f) throw new Error(`unexpected call ${m}`);
    return (await f(p)) as T;
  };
  return { call, calls };
}

const out: DaemonStatus = { signedIn: false, unlocked: false };
const noAccount: DaemonStatus = { signedIn: true, email: "me@x.io", account: false, unlocked: false };
const locked: DaemonStatus = { signedIn: true, email: "me@x.io", account: true, unlocked: false };
const open: DaemonStatus = { ...locked, unlocked: true, deviceName: "laptop" };
const PASS = "correct horse battery staple";

test("nextStep", () => {
  expect(nextStep(out)).toBe("login");
  expect(nextStep(noAccount)).toBe("setup");
  expect(nextStep(locked)).toBe("unlock");
  expect(nextStep(open)).toBeUndefined();
});

describe("login", () => {
  test("a pasted code, then unlock", async () => {
    let state = locked;
    const d = daemon({
      login: (p) => ({ email: p.email, callback: true }),
      waitLogin: () => new Promise(() => {}),
      verify: (p) => {
        if (p.input !== "123456") throw new Error("invalid code");
        return locked;
      },
      unlock: () => (state = open),
      status: () => state,
    });
    const s = scripted(["me@x.io", "", "000000", " 123456 ", PASS]);
    expect(await login(d.call, s.ui)).toEqual(open);
    expect(s.asked).toEqual([
      "input: Email for your vault",
      "input: Code or link from the email",
      "input: Code or link from the email",
      "input: Code or link from the email",
      "secret: Vault passphrase for me@x.io",
    ]);
    expect(s.notes).toEqual([
      "Sent a sign-in email to me@x.io. Open the link on this machine, or paste the code here.",
      "warning: That didn't work: invalid code",
      "Signed in as me@x.io.",
      "Unlocked on laptop.",
    ]);
    expect(d.calls.findLast(([m]) => m === "verify")![1]).toEqual({ input: "123456", email: "me@x.io" });
  });

  test("the link opened in a browser closes the prompt, then setup", async () => {
    let linked!: (s: DaemonStatus) => void;
    const d = daemon({
      login: () => ({ email: "me@x.io", callback: true }),
      waitLogin: () => new Promise((r) => (linked = r)),
      setup: () => ({ recoveryKey: "RK-1", passphrase: "gen pass" }),
      status: () => open,
    });
    const s = scripted([
      (signal) =>
        new Promise((r) => {
          signal!.addEventListener("abort", () => r(undefined));
          linked(noAccount);
        }),
      "Generate one for me",
    ]);
    expect(await login(d.call, s.ui, "me@x.io")).toEqual(open);
    expect(d.calls.find(([m]) => m === "setup")![1]).toEqual({ generate: true });
    expect(s.shown[0]).toContain("gen pass");
    expect(s.shown[0]).toContain("RK-1");
  });

  test("escape keeps waiting for the link in the background", async () => {
    let linked!: (s: DaemonStatus) => void;
    const d = daemon({ login: () => ({ email: "me@x.io", callback: true }), waitLogin: () => new Promise((r) => (linked = r)) });
    const s = scripted([undefined]);
    expect(await login(d.call, s.ui, "me@x.io")).toBeUndefined();
    expect(s.notes.at(-1)).toContain("Still waiting");
    linked(locked);
    await Bun.sleep(1);
    expect(s.notes.at(-1)).toBe("Signed in as me@x.io. Next: /vault unlock.");
  });

  test("no email, no callback, too many bad codes, already open", async () => {
    expect(await login(daemon({}).call, scripted([undefined]).ui)).toBeUndefined();
    const paste = daemon({ login: () => ({ email: "me@x.io", callback: false }), verify: () => Promise.reject(new Error("nope")) });
    expect(await login(paste.call, scripted([undefined]).ui, "me@x.io")).toBeUndefined();
    const s = scripted(["a", "b", "c"]);
    expect(await login(paste.call, s.ui, "me@x.io")).toBeUndefined();
    expect(s.notes.filter((n) => n.includes("nope"))).toHaveLength(3);
    const ok = daemon({ login: () => ({ email: "me@x.io", callback: false }), verify: () => open });
    expect(await login(ok.call, scripted(["code"]).ui, "me@x.io")).toEqual(open);
  });
});

describe("setup", () => {
  test("a chosen passphrase, checked for length and typos", async () => {
    const d = daemon({ status: () => open, setup: () => ({ recoveryKey: "RK-2" }) });
    const s = scripted(["Choose a passphrase", "short", PASS, "typo", PASS, PASS]);
    expect(await setup(d.call, s.ui, noAccount)).toEqual(open);
    expect(d.calls.find(([m]) => m === "setup")![1]).toEqual({ passphrase: PASS });
    expect(s.notes).toEqual([
      `warning: That's under ${MIN_PASSPHRASE} characters.`,
      "warning: Those didn't match. Try again.",
      "Creating the account…",
      "Vault created and unlocked. Sessions sync from now on.",
    ]);
    expect(s.shown[0]).toContain("RK-2");
    expect(s.shown[0]).not.toContain("password manager");
  });

  test("cancelling at any step, and the wrong state", async () => {
    const d = daemon({ status: () => noAccount });
    expect(await setup(d.call, scripted([undefined]).ui)).toBeUndefined();
    expect(await setup(d.call, scripted(["Choose a passphrase", undefined]).ui)).toBeUndefined();
    expect(await setup(d.call, scripted(["Choose a passphrase", PASS, undefined]).ui)).toBeUndefined();
    const s = scripted([]);
    expect(await setup(d.call, s.ui, out)).toBeUndefined();
    expect(await setup(d.call, s.ui, locked)).toBeUndefined();
    expect(s.notes).toEqual(["warning: Sign in first: /vault login", "warning: This account already exists. Unlock it with /vault unlock."]);
  });
});

describe("unlock", () => {
  test("retries a wrong passphrase, then hints at the recovery key", async () => {
    const d = daemon({
      status: () => locked,
      unlock: () => {
        throw new Error("wrong passphrase");
      },
    });
    const s = scripted(["a", "b", "c"]);
    expect(await unlock(d.call, s.ui)).toBeUndefined();
    expect(s.notes).toEqual([
      "warning: wrong passphrase",
      "warning: wrong passphrase",
      "warning: wrong passphrase Forgot it? /vault unlock --recovery",
    ]);
  });

  test("with the recovery key; unlocked elsewhere meanwhile; cancelled; wrong state", async () => {
    const rec = daemon({ status: () => locked, unlock: (p) => (p.recoveryKey === "RK" ? open : locked) });
    expect(await unlock(rec.call, scripted(["RK"]).ui, { recovery: true })).toEqual(open);
    expect(rec.calls.at(-1)).toEqual(["unlock", { recoveryKey: "RK" }]);

    let state = locked;
    const race = daemon({
      status: () => state,
      unlock: () => {
        state = open;
        throw new Error("busy");
      },
    });
    expect(await unlock(race.call, scripted(["x"]).ui)).toEqual(open);
    expect(await unlock(race.call, scripted([""]).ui, { status: locked })).toBeUndefined();

    const s = scripted([]);
    expect(await unlock(race.call, s.ui, { status: out })).toBeUndefined();
    expect(await unlock(race.call, s.ui, { status: noAccount })).toBeUndefined();
    expect(await unlock(race.call, s.ui, { status: open })).toEqual(open);
    expect(s.notes).toEqual(["warning: Sign in first: /vault login", "warning: No account yet. Create it with /vault setup.", "Already unlocked."]);
  });
});

test("logout asks first", async () => {
  const d = daemon({ logout: () => ({}) });
  expect(await logout(d.call, scripted([false]).ui)).toBe(false);
  expect(d.calls).toEqual([]);
  expect(await logout(d.call, scripted([true]).ui)).toBe(true);
  expect(d.calls).toEqual([["logout", {}]]);
});

test("a background link that never comes, and a daemon that stops answering", async () => {
  let fail!: (e: Error) => void;
  const d = daemon({ login: () => ({ email: "me@x.io", callback: true }), waitLogin: () => new Promise((_r, j) => (fail = j)) });
  const s = scripted([undefined]);
  await login(d.call, s.ui, "me@x.io");
  fail(new Error("timed out"));
  await Bun.sleep(1);
  expect(s.notes.at(-1)).toContain("Still waiting");

  const gone = daemon({
    unlock: () => Promise.reject(new Error("connection closed")),
    status: () => Promise.reject(new Error("connection closed")),
  });
  const u = scripted(["pw", undefined]);
  expect(await unlock(gone.call, u.ui, { status: locked })).toBeUndefined();
  expect(u.notes).toEqual(["warning: connection closed"]);
});
