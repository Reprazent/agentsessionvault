import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What this device knows about one session. One small JSON file per session,
 * written atomically. Only the daemon touches these.
 */
export interface LocalSessionState {
  sessionId: string;
  /** The local session file. */
  path: string;
  /** Bytes of the local file already pushed (or pulled). */
  pushedOffset: number;
  /** SHA-256 (base64) of the first pushedOffset bytes, to spot rewrites. */
  prefixHash: string;
  /** Highest seq merged into the local file. */
  pulledSeq: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StateStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!UUID.test(id)) throw new TypeError(`not a session id: ${id}`);
    return join(this.dir, "sessions", `${id.toLowerCase()}.json`);
  }

  async load(id: string): Promise<LocalSessionState | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as LocalSessionState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async save(s: LocalSessionState): Promise<void> {
    const f = this.file(s.sessionId);
    await mkdir(join(this.dir, "sessions"), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, f);
  }
}
