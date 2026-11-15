// Live pull: Realtime tells the daemon about chunks other devices commit, and
// it pulls those sessions right away. Realtime is only the trigger. Every
// (re)subscribe starts with a catch-up over all sessions, so a dropped
// connection or a daemon that wasn't running loses nothing.
//
// A session a harness has open isn't pulled into: it's remembered as remote
// ahead and pulled once the harness closes it.

import type { ChunkSubscription, PullResult, SessionSummary } from "@agentsessionvault/sync";
import { SessionOpenError } from "./errors.ts";

export interface LiveTarget {
  subscribe(sub: ChunkSubscription): () => void;
  sessions(): Promise<SessionSummary[]>;
  /** Pulls a session; `guard` throws SessionOpenError for an open target. */
  pull(sessionId: string, guard: (path: string) => void): Promise<PullResult>;
}

export interface LiveOptions {
  target: LiveTarget;
  /** This device: its own commits need no pull. */
  deviceId: string;
  openSessions: () => string[];
  log: (m: string) => void;
  /** Collects a burst of chunks for one session into one pull. */
  debounceMs?: number;
  /** Retry delay after a failed pull. */
  retryMs?: number;
  /** Errors that mean "stop until unlocked again". */
  isFatal?: (e: unknown) => boolean;
}

export interface LiveStatus {
  connected: boolean;
  /** Session files open in a harness that have newer chunks elsewhere. */
  remoteAhead: string[];
  lastPull?: { sessionId: string; path: string; at: string };
  lastError?: { message: string; at: string };
}

export class LivePuller {
  private unsubscribe: (() => void) | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Session id -> the open file it's ahead of. */
  private readonly ahead = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private connected = false;
  private lastPull: LiveStatus["lastPull"];
  private lastError: LiveStatus["lastError"];
  private readonly debounceMs: number;
  private readonly retryMs: number;

  constructor(private readonly o: LiveOptions) {
    this.debounceMs = o.debounceMs ?? 500;
    this.retryMs = o.retryMs ?? 30_000;
  }

  get status(): LiveStatus {
    return {
      connected: this.connected,
      remoteAhead: [...new Set(this.ahead.values())],
      ...(this.lastPull ? { lastPull: this.lastPull } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  start(): void {
    this.unsubscribe = this.o.target.subscribe({
      onInsert: (c) => {
        if (c.device_id !== this.o.deviceId) this.schedule(c.session_id, this.debounceMs);
      },
      onState: (connected, error) => {
        if (this.closed || connected === this.connected) return;
        this.connected = connected;
        this.o.log(connected ? "live pull: connected" : `live pull: disconnected (${error ?? "unknown"})`);
        if (connected) void this.catchUp();
      },
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Waits for queued pulls; for tests and shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      const q = this.queue;
      await q;
      if (q === this.queue && this.timers.size === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Harness windows opened or closed sessions: pull the closed ones that fell behind. */
  sessionsChanged(open: string[]): void {
    const still = new Set(open);
    for (const [id, path] of this.ahead) if (!still.has(path)) this.schedule(id, 0);
  }

  /** Everything this device is missing: after (re)connecting, nothing was heard meanwhile. */
  private async catchUp(): Promise<void> {
    try {
      for (const s of await this.o.target.sessions()) {
        if (!s.deleted && (!s.local || s.local.pulledSeq < s.head_seq)) this.schedule(s.id, 0);
      }
    } catch (e) {
      this.fail(e, "catch-up");
    }
  }

  private schedule(id: string, delay: number): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.queue = this.queue.then(() => this.pull(id));
      }, delay),
    );
  }

  private async pull(id: string): Promise<void> {
    if (this.closed) return;
    const open = new Set(this.o.openSessions());
    try {
      const r = await this.o.target.pull(id, (path) => {
        if (open.has(path)) throw new SessionOpenError(path);
      });
      this.ahead.delete(id);
      if (r.chunks) {
        this.lastPull = { sessionId: id, path: r.path, at: new Date().toISOString() };
        this.o.log(`live pull ${id}: ${r.chunks} chunk(s) -> ${r.path}`);
      }
    } catch (e) {
      if (e instanceof SessionOpenError) {
        if (!this.ahead.has(id)) this.o.log(`live pull ${id}: open in a harness, later`);
        this.ahead.set(id, e.path);
        return;
      }
      this.fail(e, id);
      if (!this.o.isFatal?.(e)) this.schedule(id, this.retryMs);
    }
  }

  private fail(e: unknown, what: string): void {
    const message = (e as Error).message;
    this.lastError = { message: `${what}: ${message}`, at: new Date().toISOString() };
    this.o.log(`live pull ${what} failed: ${message}`);
  }
}
