// Signing in, creating the account and unlocking, from inside a harness.
// Written against a small Ui interface rather than Pi, so the flows can be
// tested with a script of answers. Secrets go straight to the daemon; the
// extension keeps none of them.

import type { DaemonStatus } from "./vault.ts";

export interface Ui {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** A text answer; undefined when cancelled or dismissed via the signal. */
  input(title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Like input, but masked. */
  secret(title: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  /** Shows text that has to be read (and copied) before going on. */
  show(title: string, text: string): Promise<void>;
}

export type Call = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export const MIN_PASSPHRASE = 16;
const ATTEMPTS = 3;

/** The next step for a status, as a /vault command, or undefined when nothing's needed. */
export function nextStep(s: DaemonStatus): "login" | "setup" | "unlock" | undefined {
  if (!s.signedIn) return "login";
  if (!s.account) return "setup";
  if (!s.unlocked) return "unlock";
  return undefined;
}

/**
 * Emails a sign-in link, then waits for whichever comes first: the link
 * opened in a browser on this machine, or the code (or link) pasted in.
 * Escape leaves the browser route waiting in the background. Then continues
 * with setup or unlock.
 */
export async function login(call: Call, ui: Ui, email?: string): Promise<DaemonStatus | undefined> {
  const address = email?.trim() || (await ui.input("Email for your vault", "you@example.com"))?.trim();
  if (!address) return undefined;
  const { email: sent, callback } = await call<{ email: string; callback: boolean }>("login", { email: address, callback: true });
  ui.notify(`Sent a sign-in email to ${sent}. Open the link on this machine, or paste the code here.`);

  const linked = new AbortController();
  const viaBrowser: Promise<DaemonStatus> = callback
    ? call<DaemonStatus>("waitLogin").then((s) => {
        linked.abort();
        return s;
      })
    : new Promise<never>(() => {});
  viaBrowser.catch(() => {}); // Loses to a pasted code, or times out.

  for (let attempt = 1; ; attempt++) {
    const input = await ui.input("Code or link from the email", "or open the link in a browser here", linked.signal);
    if (linked.signal.aborted) return continueAfterLogin(call, ui, await viaBrowser);
    if (input === undefined) {
      if (!callback) return undefined;
      ui.notify("Still waiting for the link in the background. /vault login starts over.");
      viaBrowser.then(
        (s) => ui.notify(`Signed in as ${s.email}. Next: /vault ${nextStep(s) ?? "status"}.`),
        () => {},
      );
      return undefined;
    }
    if (!input.trim()) continue;
    try {
      return continueAfterLogin(call, ui, await call<DaemonStatus>("verify", { input: input.trim(), email: sent }));
    } catch (e) {
      ui.notify(`That didn't work: ${(e as Error).message}`, "warning");
      if (attempt >= ATTEMPTS) return undefined;
    }
  }
}

async function continueAfterLogin(call: Call, ui: Ui, s: DaemonStatus): Promise<DaemonStatus> {
  ui.notify(`Signed in as ${s.email}.`);
  if (!s.account) return (await setup(call, ui, s)) ?? s;
  if (!s.unlocked) return (await unlock(call, ui, { status: s })) ?? s;
  return s;
}

/** First device: creates the account and shows the recovery key once. */
export async function setup(call: Call, ui: Ui, status?: DaemonStatus): Promise<DaemonStatus | undefined> {
  const s = status ?? (await call<DaemonStatus>("status"));
  if (!s.signedIn) return (ui.notify("Sign in first: /vault login", "warning"), undefined);
  if (s.account) return (ui.notify("This account already exists. Unlock it with /vault unlock.", "warning"), undefined);

  const CHOOSE = "Choose a passphrase";
  const GENERATE = "Generate one for me";
  const how = await ui.select(`Create the vault for ${s.email}. Your passphrase never leaves this machine and nobody can reset it.`, [CHOOSE, GENERATE]);
  if (!how) return undefined;
  let params: Record<string, unknown> = { generate: true };
  if (how === CHOOSE) {
    const passphrase = await newPassphrase(ui);
    if (!passphrase) return undefined;
    params = { passphrase };
  }
  ui.notify("Creating the account…");
  const r = await call<{ recoveryKey: string; passphrase?: string }>("setup", params);
  const parts = [];
  if (r.passphrase) parts.push("Your passphrase (store it in your password manager):", "", `    ${r.passphrase}`, "");
  parts.push(
    "Your recovery key. It's shown once. Store it somewhere other than the passphrase:",
    "",
    `    ${r.recoveryKey}`,
    "",
    "Without the passphrase or this key, nobody can decrypt your sessions, including you.",
  );
  await ui.show("Store these now", parts.join("\n"));
  const after = await call<DaemonStatus>("status");
  ui.notify("Vault created and unlocked. Sessions sync from now on.");
  return after;
}

async function newPassphrase(ui: Ui): Promise<string | undefined> {
  for (;;) {
    const a = await ui.secret(`New passphrase (at least ${MIN_PASSPHRASE} characters)`);
    if (a === undefined) return undefined;
    if (a.length < MIN_PASSPHRASE) {
      ui.notify(`That's under ${MIN_PASSPHRASE} characters.`, "warning");
      continue;
    }
    const b = await ui.secret("The same passphrase again");
    if (b === undefined) return undefined;
    if (a === b) return a;
    ui.notify("Those didn't match. Try again.", "warning");
  }
}

/** Unlocks with the passphrase, or the recovery key; a few tries. */
export async function unlock(
  call: Call,
  ui: Ui,
  opts: { recovery?: boolean; status?: DaemonStatus } = {},
): Promise<DaemonStatus | undefined> {
  const s = opts.status ?? (await call<DaemonStatus>("status"));
  if (!s.signedIn) return (ui.notify("Sign in first: /vault login", "warning"), undefined);
  if (!s.account) return (ui.notify("No account yet. Create it with /vault setup.", "warning"), undefined);
  if (s.unlocked) return (ui.notify("Already unlocked."), s);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const secret = await ui.secret(opts.recovery ? "Recovery key" : `Vault passphrase for ${s.email}`);
    if (!secret) return undefined;
    try {
      const after = await call<DaemonStatus>("unlock", opts.recovery ? { recoveryKey: secret } : { passphrase: secret });
      ui.notify(`Unlocked on ${after.deviceName ?? "this device"}.`);
      return after;
    } catch (e) {
      // Another window may have unlocked meanwhile.
      const now = await call<DaemonStatus>("status").catch(() => undefined);
      if (now?.unlocked) return now;
      const hint = attempt === ATTEMPTS && !opts.recovery ? " Forgot it? /vault unlock --recovery" : "";
      ui.notify(`${(e as Error).message}${hint}`, "warning");
    }
  }
  return undefined;
}

export async function logout(call: Call, ui: Ui): Promise<boolean> {
  if (!(await ui.confirm("Sign out of the vault?", "Sync stops on this device until you sign in again. Local sessions stay."))) return false;
  await call("logout");
  ui.notify("Signed out.");
  return true;
}
