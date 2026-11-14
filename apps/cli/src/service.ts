// The daemon's state machine: signed out -> signed in -> (account exists) ->
// unlocked. Holds the account subkeys in memory only. Every socket method
// maps to one public method here.

import {
  type AccountSubkeys,
  accountSubkeys,
  changePassphrase,
  createAccount,
  formatRecoveryKey,
  generatePassphrase,
  openMeta,
  sealMeta,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from "@agentsessionvault/crypto";
import { type DeviceRow, NotSignedInError, RevokedDeviceError, VaultClient, jwtSessionId } from "@agentsessionvault/client";
import type { AccountKeys } from "@agentsessionvault/crypto";
import type { Remote } from "@agentsessionvault/sync";
import type { Session } from "@supabase/supabase-js";
import {
  ConflictError,
  NotFoundError,
  type ProjectSummary,
  type PullResult,
  type PushResult,
  type SessionSummary,
  SyncEngine,
} from "@agentsessionvault/sync";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { type CallbackServer, startCallbackServer } from "./callback.ts";
import type { Config } from "./config.ts";
import { type WatchStatus, Watcher } from "./watcher.ts";

/** Auto-push from Pi's sessions directory; the daemon turns it on. */
export interface WatchOptions {
  log: (m: string) => void;
  debounceMs?: number;
  retryMs?: number;
}

export class LockedError extends Error {
  override name = "LockedError";
  constructor() {
    super("locked; run `asv unlock`");
  }
}

export class NoAccountError extends Error {
  override name = "NoAccountError";
  constructor() {
    super("no account yet; run `asv setup`");
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
  /** Auto-push, while unlocked and watching. */
  sync?: WatchStatus;
}

export interface DeviceInfo {
  id: string;
  name?: string;
  status: DeviceRow["status"];
  current: boolean;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
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
  updatePassphrase(userId: string, row: AccountKeys, previousSalt: string): Promise<void>;
  currentDevice(): Promise<DeviceRow | null>;
  registerDevice(id: string, nameEnc: DeviceRow["name_enc"]): Promise<void>;
  listDevices(): Promise<DeviceRow[]>;
  touchDevice(id: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  remote(userId: string): Remote;
}

interface Unlocked {
  userId: string;
  authSessionId: string;
  keys: AccountSubkeys;
  deviceId: string;
  engine: SyncEngine;
}

/** Retrying won't help these; unlocking again restarts the watcher. */
export function stopsAutoPush(e: unknown): boolean {
  return e instanceof NotSignedInError || e instanceof RevokedDeviceError;
}

export class VaultService {
  readonly client: Backend;
  private unlocked: Unlocked | undefined;
  private pendingEmail: string | undefined;
  private callback: CallbackServer | undefined;
  private watcher: Watcher | undefined;

  constructor(
    private readonly cfg: Config,
    client?: Backend,
    private readonly watch?: WatchOptions,
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
    if (u && (u.userId !== session.user.id || u.authSessionId !== jwtSessionId(session.access_token))) this.lock();
    return {
      signedIn: true,
      email: session.user.email,
      userId: session.user.id,
      account: this.unlocked ? true : (await this.client.getAccount(session.user.id)) !== null,
      unlocked: !!this.unlocked,
      ...(this.unlocked ? { deviceId: this.unlocked.deviceId, deviceName: hostname() } : {}),
      ...(this.unlocked && this.watcher ? { sync: { ...this.watcher.status } } : {}),
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
    if (!cb) throw new TypeError("no login is waiting for a link; run `asv login`");
    const url = await cb.result;
    if (this.callback !== cb) throw new Error("login was restarted");
    return this.verify(url.toString());
  }

  /** Completes login with the code or link from the email. */
  async verify(input: string, email?: string): Promise<Status> {
    const e = email ?? this.pendingEmail;
    if (!e) throw new TypeError("run `asv login` first");
    await this.client.verifyLogin(e, input);
    this.pendingEmail = undefined;
    this.callback?.close();
    this.callback = undefined;
    this.lock();
    return this.status();
  }

  /** Forget the keys and stop pushing. */
  private lock(): void {
    this.unlocked = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Stops background work; for shutting down the daemon. */
  async close(): Promise<void> {
    await this.watcher?.flush(); // never rejects: failures are retried or logged
    this.lock();
    this.callback?.close();
  }

  async logout(): Promise<void> {
    this.lock();
    this.callback?.close();
    this.callback = undefined;
    await this.client.signOut();
  }

  /** First device: creates the account. Returns the recovery key, shown once. */
  async setup(opts: { passphrase?: string; generate?: boolean }): Promise<{ recoveryKey: string; passphrase?: string }> {
    const session = await this.client.requireSession();
    if (await this.client.getAccount(session.user.id)) throw new ConflictError("an account already exists; use `asv unlock`");
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

  /**
   * Sets a new passphrase. Needs an unlocked device and the current passphrase
   * or the recovery key, because only the account key's subkeys are kept in
   * memory. With the recovery key, this is the reset for a forgotten passphrase.
   * Other devices keep working until they unlock again.
   */
  async changePassphrase(opts: {
    current?: string;
    recoveryKey?: string;
    passphrase?: string;
    generate?: boolean;
  }): Promise<{ passphrase?: string }> {
    const u = await this.requireUnlocked();
    const row = await this.client.getAccount(u.userId);
    if (!row) throw new NoAccountError();
    const next = opts.generate ? generatePassphrase() : opts.passphrase;
    if (!next) throw new TypeError("a new passphrase is required");
    const accountKey = opts.recoveryKey
      ? await unlockWithRecoveryKey(u.userId, row, opts.recoveryKey)
      : opts.current
        ? await unlockWithPassphrase(u.userId, row, opts.current)
        : (() => {
            throw new TypeError("the current passphrase or the recovery key is required");
          })();
    try {
      const updated = await changePassphrase(u.userId, row, accountKey, next);
      await this.client.updatePassphrase(u.userId, updated, row.kdf.salt);
    } finally {
      accountKey.fill(0);
    }
    return opts.generate ? { passphrase: next } : {};
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
    await this.startWatching();
  }

  private async startWatching(): Promise<void> {
    if (!this.watch || !this.unlocked) return;
    this.watcher?.close();
    const engine = this.unlocked.engine;
    const w = new Watcher({
      dir: this.cfg.piSessionsDir,
      target: { pending: (p) => engine.pending(p), push: (p) => engine.push(p) },
      log: this.watch.log,
      ...(this.watch.debounceMs !== undefined ? { debounceMs: this.watch.debounceMs } : {}),
      ...(this.watch.retryMs !== undefined ? { retryMs: this.watch.retryMs } : {}),
      isFatal: stopsAutoPush,
    });
    this.watcher = w;
    await mkdir(this.cfg.piSessionsDir, { recursive: true });
    await w.start();
  }

  /**
   * A client says a session changed (Pi after a turn): push it now rather
   * than after the debounce. Without a path, pushes everything queued.
   */
  async nudge(path?: string): Promise<WatchStatus> {
    await this.requireUnlocked();
    if (!this.watcher) {
      if (path) await this.push(path);
      return { watching: false, pending: 0 };
    }
    await this.watcher.flush(path ? resolve(path) : undefined);
    return { ...this.watcher.status };
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

  async projects(): Promise<ProjectSummary[]> {
    return (await this.requireUnlocked()).engine.listProjects();
  }

  /** Points a project at a local directory and moves its unmapped sessions there. */
  async mapProject(ref: string, dir: string): Promise<{ project: ProjectSummary; moved: string[] }> {
    return (await this.requireUnlocked()).engine.mapProject(ref, resolve(dir));
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
          revoked_at: d.revoked_at,
          revoked_by: d.revoked_by,
        };
      }),
    );
  }

  /**
   * Revokes another device by id or unique id prefix. Its sign-in loses access
   * at once and can't refresh; the row stays, for its chunks and the record.
   */
  async revokeDevice(ref: string): Promise<DeviceInfo> {
    const r = ref.trim().toLowerCase();
    if (r.length < 4) throw new TypeError("give at least 4 characters of the device id");
    const devices = await this.devices();
    const matches = devices.filter((d) => d.id.startsWith(r));
    if (matches.length === 0) throw new NotFoundError(`no device matches ${ref}`);
    if (matches.length > 1) throw new TypeError(`${ref} matches ${matches.length} devices; give more of the id`);
    const d = matches[0]!;
    if (d.current) throw new TypeError("that's this device; use `asv logout`, or revoke it from another device");
    if (d.status === "revoked") return d;
    await this.client.revokeDevice(d.id);
    return (await this.devices()).find((x) => x.id === d.id)!;
  }
}
