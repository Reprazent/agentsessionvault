// Server side of the daemon socket; the protocol and the client live in
// @agentsessionvault/daemon-client. The daemon can exit once no client has
// been connected for a while; harness clients keep a connection open.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";

import { type Hello, type Request, type Response, lineReader, ping } from "@agentsessionvault/daemon-client";

export {
  DaemonClient,
  DaemonNotRunningError,
  type Hello,
  RemoteError,
  type Request,
  type Response,
  ping,
} from "@agentsessionvault/daemon-client";

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export interface ServeOptions {
  log?: (msg: string) => void;
  /** Returned by the built-in `hello` method. */
  version?: string;
  /**
   * Called once no client has been connected for idleMs, counted from the
   * start too, so a daemon nobody connects to goes away. Unset: never idle.
   */
  onIdle?: () => void;
  idleMs?: number;
}

export interface DaemonServer {
  server: Server;
  clients: () => number;
  /** Names clients gave in `hello`, one per connection that sent it. */
  clientNames: () => string[];
  close: () => Promise<void>;
}

/**
 * Listens on a 0600 socket. Refuses to start if another daemon answers on it,
 * and removes a stale socket file otherwise.
 */
export async function serve(path: string, handlers: Record<string, Handler>, opts: ServeOptions = {}): Promise<DaemonServer> {
  const log = opts.log ?? (() => {});
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Two daemons starting at once must not both remove the socket and listen.
  const unlock = await lockFile(`${path}.lock`);
  try {
    if (await ping(path)) throw new AlreadyRunningError(path);
    await rm(path, { force: true });
  } catch (e) {
    await unlock();
    throw e;
  }

  const sockets = new Map<Socket, { name?: string }>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const checkIdle = () => {
    if (!opts.onIdle) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (sockets.size === 0) idleTimer = setTimeout(opts.onIdle, opts.idleMs ?? 30_000);
  };
  const builtins: Record<string, (p: Record<string, unknown>, socket: Socket) => unknown> = {
    hello: (p, socket) => {
      if (typeof p.client === "string") sockets.get(socket)!.name = p.client;
      return { version: opts.version ?? "unknown", pid: process.pid } satisfies Hello;
    },
  };
  const server = createServer((socket) => {
    sockets.set(socket, {});
    checkIdle();
    const drop = () => {
      if (sockets.delete(socket)) checkIdle();
    };
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
        const builtin = Object.hasOwn(builtins, req.method) ? builtins[req.method] : undefined;
        const h: Handler | undefined = builtin
          ? async (p) => builtin(p, socket)
          : Object.hasOwn(handlers, req.method)
            ? handlers[req.method]
            : undefined;
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
    await unlock();
  }
  await chmod(path, 0o600);
  checkIdle();

  return {
    server,
    clients: () => sockets.size,
    clientNames: () => [...sockets.values()].flatMap((c) => (c.name ? [c.name] : [])),
    close: async () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const s of sockets.keys()) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      await rm(path, { force: true });
    },
  };
}

export class AlreadyRunningError extends Error {
  override name = "AlreadyRunningError";
  constructor(path: string) {
    super(`a daemon is already running on ${path}`);
  }
}

/**
 * Takes an exclusive lock file holding our pid. A lock left by a process
 * that's gone is taken over; a live holder is waited for, up to waitMs.
 */
export async function lockFile(path: string, waitMs = 5000): Promise<() => Promise<void>> {
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = Number(await readFile(path, "utf8").catch(() => ""));
    if (!alive(holder)) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${path} (held by pid ${holder})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
