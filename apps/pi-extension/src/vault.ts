// The extension's side of the daemon connection, without Pi: keeps one
// connection open (which keeps the daemon running), reconnects when it
// drops, and turns the daemon's status into a short line for the footer.

import type { DaemonClient, Hello } from "../../../packages/daemon-client/src/index.ts";

/** The part of the daemon's `status` the extension uses. */
export interface DaemonStatus {
  signedIn: boolean;
  email?: string | undefined;
  account?: boolean | undefined;
  unlocked: boolean;
  deviceName?: string | undefined;
  sync?: {
    watching: boolean;
    pending: number;
    lastPush?: { path: string; at: string };
    lastError?: { path: string; message: string; at: string };
  } | undefined;
}

export type View =
  | { state: "connecting" }
  | { state: "unavailable"; error: string; retryInMs: number }
  | { state: "connected"; hello: Hello; status: DaemonStatus };

export interface VaultOptions {
  /** Connects, starting the daemon if needed. */
  connect: () => Promise<DaemonClient>;
  onChange: (v: View) => void;
  /** How often to refresh the status over the open connection. */
  pollMs?: number;
  /** First reconnect delay; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
}

export class Vault {
  private client: DaemonClient | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = true;
  view: View = { state: "connecting" };

  constructor(private readonly o: VaultOptions) {}

  /** Connects and keeps the connection up until stop(). Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.client?.close();
    this.client = undefined;
  }

  /** Calls the daemon over the open connection. */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error(this.view.state === "unavailable" ? `vault daemon unavailable: ${this.view.error}` : "not connected to the vault daemon yet");
    return this.client.call<T>(method, params);
  }

  /** Re-reads the status now, e.g. after a turn. */
  async refresh(): Promise<void> {
    const c = this.client;
    if (!c || this.view.state !== "connected") return;
    try {
      this.set({ ...this.view, status: await c.call<DaemonStatus>("status") });
    } catch {
      // The close handler takes care of a dropped connection.
    }
  }

  private set(v: View): void {
    this.view = v;
    this.o.onChange(v);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set({ state: "connecting" });
    let c: DaemonClient | undefined;
    try {
      c = await this.o.connect();
      const hello = await c.call<Hello>("hello", { client: "pi" });
      const status = await c.call<DaemonStatus>("status");
      if (this.stopped) return c.close();
      this.client = c;
      this.failures = 0;
      c.onClose(() => this.dropped(c!));
      this.set({ state: "connected", hello, status });
      this.schedulePoll();
    } catch (e) {
      c?.close();
      if (this.stopped) return;
      this.failures++;
      const retryInMs = Math.min((this.o.retryMs ?? 1000) * 2 ** (this.failures - 1), this.o.maxRetryMs ?? 30_000);
      this.set({ state: "unavailable", error: (e as Error).message, retryInMs });
      this.timer = setTimeout(() => void this.connect(), retryInMs);
    }
  }

  private dropped(c: DaemonClient): void {
    if (this.client !== c || this.stopped) return;
    this.client = undefined;
    if (this.timer) clearTimeout(this.timer);
    // The daemon went away (stopped, crashed, upgraded): start another.
    void this.connect();
  }

  private schedulePoll(): void {
    this.timer = setTimeout(async () => {
      await this.refresh();
      if (!this.stopped && this.client) this.schedulePoll();
    }, this.o.pollMs ?? 5000);
  }
}

/** The footer text. */
export function statusLine(v: View): string {
  if (v.state === "connecting") return "vault: connecting";
  if (v.state === "unavailable") return "vault: unavailable";
  const s = v.status;
  if (!s.signedIn) return "vault: signed out";
  if (!s.account) return "vault: no account";
  if (!s.unlocked) return "vault: locked";
  const sync = s.sync;
  if (!sync) return "vault: unlocked";
  if (sync.lastError && (!sync.lastPush || sync.lastError.at > sync.lastPush.at)) return "vault: push failed";
  if (sync.pending > 0) return `vault: ${sync.pending} queued`;
  return "vault: synced";
}

/** The longer text for `/vault`. */
export function describe(v: View): string {
  if (v.state === "connecting") return "Connecting to the vault daemon…";
  if (v.state === "unavailable") return `The vault daemon is unavailable: ${v.error}\nRetrying in ${Math.round(v.retryInMs / 1000)}s.`;
  const s = v.status;
  const lines = [`daemon ${v.hello.version}, pid ${v.hello.pid}`];
  if (!s.signedIn) lines.push("Signed out. Run `agentsessionvault login <email>` in a terminal.");
  else if (!s.account) lines.push(`Signed in as ${s.email}, no account yet. Run \`agentsessionvault setup\`.`);
  else if (!s.unlocked) lines.push(`Signed in as ${s.email}, locked. Run \`agentsessionvault unlock\`.`);
  else {
    lines.push(`Signed in as ${s.email}, unlocked on ${s.deviceName ?? "this device"}.`);
    const sync = s.sync;
    if (sync) {
      lines.push(`Auto-push ${sync.watching ? "on" : "off"}, ${sync.pending} queued.`);
      if (sync.lastPush) lines.push(`Last push ${sync.lastPush.at}.`);
      if (sync.lastError) lines.push(`Last error ${sync.lastError.at}: ${sync.lastError.message}`);
    }
  }
  return lines.join("\n");
}
