// Daemon socket protocol: newline-delimited JSON over a Unix socket.
//   request:  {"id": 1, "method": "push", "params": {...}}
//   response: {"id": 1, "result": ...} or {"id": 1, "error": {"name", "message"}}
// Clients keep the connection open as long as they want the daemon around.

import { chmod, mkdir, rm } from "node:fs/promises";
import { type Server, type Socket, connect, createServer } from "node:net";
import { dirname } from "node:path";

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Response = { id: number; result: unknown } | { id: number; error: { name: string; message: string } };

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

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
    super(`the daemon isn't running (no socket at ${path}); start it with \`agentsessionvault daemon\``);
  }
}

/** Splits a byte stream into lines and calls fn for each complete one. */
function lineReader(fn: (line: string) => void) {
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

export interface DaemonServer {
  server: Server;
  clients: () => number;
  close: () => Promise<void>;
}

/**
 * Listens on a 0600 socket. Refuses to start if another daemon answers on it,
 * and removes a stale socket file otherwise.
 */
export async function serve(path: string, handlers: Record<string, Handler>, log: (msg: string) => void = () => {}): Promise<DaemonServer> {
  if (await ping(path)) throw new Error(`a daemon is already running on ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const drop = () => sockets.delete(socket);
    socket.on("close", drop);
    socket.on("error", drop);
    socket.on(
      "data",
      lineReader(async (line) => {
        let req: Request;
        try {
          req = JSON.parse(line) as Request;
        } catch {
          socket.write(`${JSON.stringify({ id: 0, error: { name: "ProtocolError", message: "not JSON" } })}\n`);
          return;
        }
        const h = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
        let res: Response;
        if (!h) res = { id: req.id, error: { name: "ProtocolError", message: `unknown method ${req.method}` } };
        else
          try {
            res = { id: req.id, result: (await h(req.params ?? {})) ?? null };
          } catch (e) {
            const err = e as Error;
            log(`${req.method} failed: ${err.name}: ${err.message}`);
            res = { id: req.id, error: { name: err.name ?? "Error", message: err.message ?? String(e) } };
          }
        if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
      }),
    );
  });
  // Create the socket with no permissions for others from the start.
  const oldMask = process.umask(0o177);
  try {
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(path, () => {
        server.off("error", fail);
        ok();
      });
    });
  } finally {
    process.umask(oldMask);
  }
  await chmod(path, 0o600);

  return {
    server,
    clients: () => sockets.size,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(path, { force: true });
    },
  };
}

export class DaemonClient {
  private nextId = 1;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

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
    socket.on("close", () => failAll());
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
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.socket.write(`${JSON.stringify({ id, method, params } satisfies Request)}\n`);
    });
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
