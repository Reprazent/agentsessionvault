// The daemon's state machine: signed out -> signed in -> (account exists) ->
// unlocked. Holds the account subkeys in memory only. Every socket method
// maps to one public method here.

import {
  type AccountSubkeys,
  accountSubkeys,
  createAccount,
  formatRecoveryKey,
  generatePassphrase,
  openMeta,
  sealMeta,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "@agentsessionvault/crypto";
import { type DeviceRow, VaultClient, jwtSessionId } from "@agentsessionvault/client";
import type { AccountKeys } from "@agentsessionvault/crypto";
import type { Remote } from "@agentsessionvault/sync";
import type { Session } from "@supabase/supabase-js";
import { ConflictError, type PullResult, type PushResult, type SessionSummary, SyncEngine } from "@agentsessionvault/sync";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { type CallbackServer, startCallbackServer } from "./callback.ts";
import type { Config } from "./config.ts";

export class LockedError extends Error {
  override name = "LockedError";
  constructor() {
    super("locked; run `agentsessionvault unlock`");
  }
}

export class NoAccountError extends Error {
  override name = "NoAccountError";
  constructor() {
    super("no account yet; run `agentsessionvault setup`");
  }
}

export interface Status {
  signedIn: boolean;
  email?: string | undefined;
  userId?: string;
  /** Unknown when signed out. */
  account?: boolean;
  unlocked: boolean;
  deviceId?: string;
  deviceName?: string;
  pendingLogin?: string;
}

export interface DeviceInfo {
  id: string;
  name?: string;
  status: DeviceRow["status"];
  current: boolean;
  created_at: string;
  last_seen_at: string | null;
}

/** What the service needs from the server. VaultClient in production, a fake in tests. */
export interface Backend {
  sendLoginEmail(email: string, redirectTo?: string): Promise<void>;
  verifyLogin(email: string, input: string): Promise<unknown>;
  session(): Promise<Session | null>;
  requireSession(): Promise<Session>;
  signOut(): Promise<void>;
  getAccount(userId: string): Promise<AccountKeys | null>;
  createAccount(userId: string, row: AccountKeys): Promise<void>;
  currentDevice(): Promise<DeviceRow | null>;
  registerDevice(id: string, nameEnc: DeviceRow["name_enc"]): Promise<void>;
  listDevices(): Promise<DeviceRow[]>;
  touchDevice(id: string): Promise<void>;
  remote(userId: string): Remote;
}

interface Unlocked {
  userId: string;
  authSessionId: string;
  keys: AccountSubkeys;
  deviceId: string;
  engine: SyncEngine;
}

export class VaultService {
  readonly client: Backend;
  private unlocked: Unlocked | undefined;
  private pendingEmail: string | undefined;
  private callback: CallbackServer | undefined;

  constructor(
    private readonly cfg: Config,
    client?: Backend,
  ) {
    this.client =
      client ??
      new VaultClient({ url: cfg.supabaseUrl, publishableKey: cfg.publishableKey, authFile: join(cfg.stateDir, "auth.json") });
  }

  async init(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
  }

  async status(): Promise<Status> {
    const session = await this.client.session();
    if (!session) return { signedIn: false, unlocked: false, ...(this.pendingEmail ? { pendingLogin: this.pendingEmail } : {}) };
    const u = this.unlocked;
    // A refreshed token for another sign-in invalidates what we unlocked.
    if (u && (u.userId !== session.user.id || u.authSessionId !== jwtSessionId(session.access_token))) this.unlocked = undefined;
    return {
      signedIn: true,
      email: session.user.email,
      userId: session.user.id,
      account: this.unlocked ? true : (await this.client.getAccount(session.user.id)) !== null,
      unlocked: !!this.unlocked,
      ...(this.unlocked ? { deviceId: this.unlocked.deviceId, deviceName: hostname() } : {}),
    };
  }

  /**
   * Sends the sign-in email. Unless callback is false, the link redirects to a
   * one-shot server on 127.0.0.1 that completes the login; see waitLogin.
   * Pasting the link or code into verify works either way.
   */
  async login(
    email: string,
    opts: { callback?: boolean; timeoutMs?: number; sendEmail?: boolean } = {},
  ): Promise<{ email: string; callback: boolean; callbackUrl?: string }> {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new TypeError("that doesn't look like an email address");
    this.callback?.close();
    this.callback = opts.callback === false ? undefined : await startCallbackServer({ timeoutMs: opts.timeoutMs });
    try {
      // sendEmail: false is for scripts/dev-login.ts, which makes the link with the admin API.
      if (opts.sendEmail !== false) await this.client.sendLoginEmail(e, this.callback?.url);
    } catch (err) {
      this.callback?.close();
      this.callback = undefined;
      throw err;
    }
    this.pendingEmail = e;
    return { email: e, callback: !!this.callback, ...(opts.sendEmail === false && this.callback ? { callbackUrl: this.callback.url } : {}) };
  }

  /** Waits for the email link to hit the callback server, then completes the login. */
  async waitLogin(): Promise<Status> {
    const cb = this.callback;
    if (!cb) throw new TypeError("no login is waiting for a link; run `agentsessionvault login`");
    const url = await cb.result;
    if (this.callback !== cb) throw new Error("login was restarted");
    return this.verify(url.toString());
  }

  /** Completes login with the code or link from the email. */
  async verify(input: string, email?: string): Promise<Status> {
    const e = email ?? this.pendingEmail;
    if (!e) throw new TypeError("run `agentsessionvault login` first");
    await this.client.verifyLogin(e, input);
    this.pendingEmail = undefined;
    this.callback?.close();
    this.callback = undefined;
    this.unlocked = undefined;
    return this.status();
  }

  async logout(): Promise<void> {
    this.unlocked = undefined;
    this.callback?.close();
    this.callback = undefined;
    await this.client.signOut();
  }

  /** First device: creates the account. Returns the recovery key, shown once. */
  async setup(opts: { passphrase?: string; generate?: boolean }): Promise<{ recoveryKey: string; passphrase?: string }> {
    const session = await this.client.requireSession();
    if (await this.client.getAccount(session.user.id)) throw new ConflictError("an account already exists; use `agentsessionvault unlock`");
    const passphrase = opts.generate ? generatePassphrase() : opts.passphrase;
    if (!passphrase) throw new TypeError("a passphrase is required");
    const { row, accountKey, recoveryKey } = await createAccount(session.user.id, passphrase);
    await this.client.createAccount(session.user.id, row);
    await this.activate(session.user.id, accountKey, row.account_key_version);
    const formatted = formatRecoveryKey(recoveryKey);
    recoveryKey.fill(0);
    return { recoveryKey: formatted, ...(opts.generate ? { passphrase } : {}) };
  }

  async unlock(opts: { passphrase?: string; recoveryKey?: string }): Promise<Status> {
    const session = await this.client.requireSession();
    const row = await this.client.getAccount(session.user.id);
    if (!row) throw new NoAccountError();
    const accountKey = opts.recoveryKey
      ? await unlockWithRecoveryKey(session.user.id, row, opts.recoveryKey)
      : opts.passphrase
        ? await unlockWithPassphrase(session.user.id, row, opts.passphrase)
        : (() => {
            throw new TypeError("a passphrase or recovery key is required");
          })();
    await this.activate(session.user.id, accountKey, row.account_key_version);
    return this.status();
  }

  private async activate(userId: string, accountKey: Uint8Array, version: number): Promise<void> {
    const keys = await accountSubkeys(userId, accountKey, version);
    accountKey.fill(0);
    const session = await this.client.requireSession();
    let device = await this.client.currentDevice();
    if (!device) {
      const id = randomUUID();
      await this.client.registerDevice(id, await sealMeta(keys, id, "devices.name_enc", { name: hostname() }));
      device = await this.client.currentDevice();
    }
    const deviceId = device!.id;
    await this.client.touchDevice(deviceId);
    this.unlocked = {
      userId,
      authSessionId: jwtSessionId(session.access_token),
      keys,
      deviceId,
      engine: new SyncEngine({
        remote: this.client.remote(userId),
        keys,
        stateDir: this.cfg.stateDir,
        sessionsDir: this.cfg.piSessionsDir,
      }),
    };
  }

  private async requireUnlocked(): Promise<Unlocked> {
    if (this.unlocked) return this.unlocked;
    const session = await this.client.requireSession();
    if (!(await this.client.getAccount(session.user.id))) throw new NoAccountError();
    throw new LockedError();
  }

  async push(path: string): Promise<PushResult> {
    return (await this.requireUnlocked()).engine.push(resolve(path));
  }

  async pull(sessionId: string, path?: string): Promise<PullResult> {
    return (await this.requireUnlocked()).engine.pull(sessionId, path ? { path: resolve(path) } : {});
  }

  async sessions(): Promise<SessionSummary[]> {
    return (await this.requireUnlocked()).engine.sessions();
  }

  async devices(): Promise<DeviceInfo[]> {
    const u = await this.requireUnlocked();
    const rows = await this.client.listDevices();
    return Promise.all(
      rows.map(async (d) => {
        let name: string | undefined;
        try {
          name = (await openMeta<{ name: string }>(u.keys, d.id, "devices.name_enc", d.name_enc)).name;
        } catch {
          name = undefined;
        }
        return {
          id: d.id,
          ...(name ? { name } : {}),
          status: d.status,
          current: d.id === u.deviceId,
          created_at: d.created_at,
          last_seen_at: d.last_seen_at,
        };
      }),
    );
  }
}
