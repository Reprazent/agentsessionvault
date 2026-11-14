// Client side of the daemon socket: newline-delimited JSON over a Unix socket.
//   request:  {"id": 1, "method": "push", "params": {...}}
//   response: {"id": 1, "result": ...} or {"id": 1, "error": {"name", "message"}}
// The daemon stays up while any client is connected, so harness clients keep
// one connection open. Only node: built-ins, so harness extensions can use it.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { type Socket, connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the daemon keeps its state and listens. The CLI and harness clients
 * both use this, so they agree without configuration.
 */
export function daemonPaths(env: Record<string, string | undefined> = process.env): { stateDir: string; socketPath: string; logFile: string } {
  const stateDir =
    env.AGENTSESSIONVAULT_HOME ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agentsessionvault");
  return {
    stateDir,
    socketPath:
      env.AGENTSESSIONVAULT_SOCKET ??
      (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "agentsessionvault.sock") : join(stateDir, "daemon.sock")),
    logFile: join(stateDir, "daemon.log"),
  };
}

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Response = { id: number; result: unknown } | { id: number; error: { name: string; message: string } };

/** What `hello` returns. */
export interface Hello {
  version: string;
  pid: number;
}

export class RemoteError extends Error {
  constructor(
    override name: string,
    message: string,
  ) {
    super(message);
  }
}

export class DaemonNotRunningError extends Error {
  override name = "DaemonNotRunningError";
  constructor(path: string) {
    super(`the daemon isn't running (no socket at ${path}); start it with \`asv daemon\``);
  }
}

/** Splits a byte stream into lines and calls fn for each complete one. */
export function lineReader(fn: (line: string) => void) {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  };
}

export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private closeListeners: (() => void)[] = [];
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on(
      "data",
      lineReader((line) => {
        const res = JSON.parse(line) as Response;
        const p = this.pending.get(res.id);
        if (!p) return;
        this.pending.delete(res.id);
        if ("error" in res) p.fail(new RemoteError(res.error.name, res.error.message));
        else p.ok(res.result);
      }),
    );
    const failAll = (e?: Error) => {
      for (const p of this.pending.values()) p.fail(e instanceof Error ? e : new Error("the daemon closed the connection"));
      this.pending.clear();
    };
    socket.on("error", failAll);
    socket.on("close", () => {
      failAll();
      this.closed = true;
      for (const f of this.closeListeners.splice(0)) f();
    });
  }

  static connect(path: string): Promise<DaemonClient> {
    return new Promise((ok, fail) => {
      const s = connect(path);
      s.once("connect", () => {
        s.off("error", onError);
        ok(new DaemonClient(s));
      });
      const onError = (e: NodeJS.ErrnoException) =>
        fail(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? new DaemonNotRunningError(path) : e);
      s.once("error", onError);
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the daemon closed the connection"));
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.socket.write(`${JSON.stringify({ id, method, params } satisfies Request)}\n`);
    });
  }

  /** Called once when the connection ends, e.g. the daemon exited. */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeListeners.push(fn);
  }

  close(): void {
    this.socket.end();
  }
}

/** True if a daemon answers on the socket. */
export async function ping(path: string): Promise<boolean> {
  try {
    const c = await DaemonClient.connect(path);
    try {
      await c.call("ping");
      return true;
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

export interface StartOptions {
  socketPath: string;
  /**
   * The daemon command, e.g. ["asv", "daemon", "--idle-exit"].
   * A function is only called when a daemon has to be started.
   */
  command: string[] | (() => Promise<string[]>);
  /** Where the started daemon's output goes (appended). */
  logFile: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for it to answer. */
  timeoutMs?: number;
}

/**
 * Connects to the daemon, starting it in the background first if nothing
 * answers. If two clients start one at once, the daemon that loses the race
 * exits and both end up connected to the winner.
 */
export async function connectOrStart(o: StartOptions): Promise<{ client: DaemonClient; started: boolean }> {
  try {
    return { client: await DaemonClient.connect(o.socketPath), started: false };
  } catch (e) {
    if (!(e instanceof DaemonNotRunningError)) throw e;
  }
  const [cmd, ...args] = typeof o.command === "function" ? await o.command() : o.command;
  if (!cmd) throw new TypeError("command is empty");
  mkdirSync(dirname(o.logFile), { recursive: true, mode: 0o700 });
  const log = openSync(o.logFile, "a", 0o600);
  let exited: string | undefined;
  let spawnError: Error | undefined;
  try {
    // The daemon must listen where we look, whatever its defaults say.
    const env = { ...(o.env ?? process.env), AGENTSESSIONVAULT_SOCKET: o.socketPath };
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", log, log], env });
    child.once("error", (e) => (spawnError = e));
    child.once("exit", (code, signal) => (exited = `exited with ${signal ?? code}`));
    child.unref();
  } finally {
    closeSync(log);
  }
  const end = Date.now() + (o.timeoutMs ?? 5000);
  for (;;) {
    try {
      return { client: await DaemonClient.connect(o.socketPath), started: true };
    } catch (e) {
      if (!(e instanceof DaemonNotRunningError)) throw e;
    }
    if (spawnError) throw new Error(`couldn't start the daemon with \`${cmd}\`: ${spawnError.message}`);
    // An exit can be the lost race; give the winner the remaining time.
    if (Date.now() > end) {
      throw new Error(`the daemon didn't start${exited ? ` (${exited})` : ""}; see ${o.logFile}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
export * from "./binary.ts";
