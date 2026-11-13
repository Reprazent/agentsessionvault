// Watches Pi's sessions directory and pushes session files after they settle.
// Pi appends a line per entry while a turn runs; a short debounce turns that
// into one push per burst. Failed pushes retry with backoff.

import { NotAPiSessionError } from "@agentsessionvault/adapter-pi";
import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface WatchTarget {
  /** Whether the file has unpushed bytes; cheap, no network. */
  pending(path: string): Promise<boolean>;
  push(path: string): Promise<unknown>;
}

export interface WatcherOptions {
  dir: string;
  target: WatchTarget;
  log: (m: string) => void;
  /** Quiet time after the last change before pushing. */
  debounceMs?: number;
  /** First retry delay after a failed push; doubles up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Errors that mean "stop until something changes", e.g. locked or signed out. */
  isFatal?: (e: unknown) => boolean;
}

export interface WatchStatus {
  watching: boolean;
  /**
   * Files queued for a check or push, including retries. A late watch event
   * can queue a file whose push already went out; its check then finds
   * nothing to push.
   */
  pending: number;
  lastPush?: { path: string; at: string };
  lastError?: { path: string; message: string; at: string };
}

interface FileState {
  timer?: ReturnType<typeof setTimeout> | undefined;
  running?: Promise<void> | undefined;
  /** Changed again while a push ran. */
  dirty?: boolean;
  failures: number;
}

export class Watcher {
  private fsw: FSWatcher | undefined;
  private readonly files = new Map<string, FileState>();
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private closed = false;
  readonly status: WatchStatus = { watching: false, pending: 0 };

  constructor(private readonly o: WatcherOptions) {
    this.debounceMs = o.debounceMs ?? 2000;
    this.retryMs = o.retryMs ?? 5000;
    this.maxRetryMs = o.maxRetryMs ?? 5 * 60_000;
  }

  /** Starts watching, then queues every file with unpushed bytes. */
  async start(): Promise<void> {
    this.fsw = watch(this.o.dir, { recursive: true }, (_event, name) => {
      if (name) this.changed(join(this.o.dir, name.toString()));
    });
    this.fsw.on("error", (e) => this.o.log(`watch error: ${e.message}`));
    this.status.watching = true;
    await this.scan();
  }

  /** Queues every session file with unpushed bytes, e.g. after starting or unlocking. */
  async scan(): Promise<number> {
    let n = 0;
    for (const path of await sessionFiles(this.o.dir)) {
      if (await this.isPending(path)) {
        this.schedule(path, 0);
        n++;
      }
    }
    return n;
  }

  /** A file changed: push it once it's been quiet for the debounce time. */
  changed(path: string): void {
    if (this.closed || !isSessionFile(this.o.dir, path)) return;
    this.schedule(path, this.debounceMs);
  }

  /** Push now instead of waiting: one file, or everything queued. Resolves when done. */
  async flush(path?: string): Promise<void> {
    const paths = path ? [path] : [...this.files.keys()];
    await Promise.all(
      paths.map(async (p) => {
        const f = this.files.get(p);
        if (f?.timer) clearTimeout(f.timer);
        if (f) f.timer = undefined;
        await f?.running;
        if (path || f) await this.run(p);
      }),
    );
  }

  close(): void {
    this.closed = true;
    this.fsw?.close();
    this.status.watching = false;
    for (const f of this.files.values()) if (f.timer) clearTimeout(f.timer);
    this.files.clear();
    this.status.pending = 0;
  }

  private schedule(path: string, delay: number): void {
    const f = this.files.get(path) ?? { failures: 0 };
    this.files.set(path, f);
    this.status.pending = this.files.size;
    if (f.running) {
      f.dirty = true;
      return;
    }
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      f.timer = undefined;
      void this.run(path);
    }, delay);
  }

  private async isPending(path: string): Promise<boolean> {
    try {
      return await this.o.target.pending(path);
    } catch (e) {
      // Not a session (yet), or gone: nothing to push.
      if (e instanceof NotAPiSessionError || (e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  private run(path: string): Promise<void> {
    const f = this.files.get(path) ?? { failures: 0 };
    this.files.set(path, f);
    if (f.running) return f.running;
    f.running = (async () => {
      try {
        if (await this.isPending(path)) {
          await this.o.target.push(path);
          this.status.lastPush = { path, at: new Date().toISOString() };
        }
        f.failures = 0;
      } catch (e) {
        f.running = undefined;
        const message = (e as Error).message;
        this.status.lastError = { path, message, at: new Date().toISOString() };
        if (this.o.isFatal?.(e)) {
          this.o.log(`push ${path} stopped: ${message}`);
          this.drop(path);
          return;
        }
        f.failures++;
        const delay = Math.min(this.retryMs * 2 ** (f.failures - 1), this.maxRetryMs);
        this.o.log(`push ${path} failed (${message}), retrying in ${Math.round(delay / 1000)}s`);
        f.dirty = false;
        if (!this.closed) this.schedule(path, delay);
        return;
      }
      f.running = undefined;
      if (f.dirty && !this.closed) {
        f.dirty = false;
        this.schedule(path, this.debounceMs);
      } else {
        this.drop(path);
      }
    })();
    return f.running;
  }

  private drop(path: string): void {
    const f = this.files.get(path);
    if (f?.timer) return;
    this.files.delete(path);
    this.status.pending = this.files.size;
  }
}

/** `.jsonl` files in Pi's `--<cwd>--` directories; `_unmapped/` and others are skipped. */
function isSessionFile(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  return parts.length === 2 && parts[0]!.startsWith("--") && parts[1]!.endsWith(".jsonl");
}

async function sessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(root).catch(() => [] as string[])) {
    if (!d.startsWith("--")) continue;
    const files = await readdir(join(root, d)).catch(() => [] as string[]);
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(root, d, f));
  }
  return out.sort();
}
