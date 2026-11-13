import {
  type AccountSubkeys,
  type ChunkKind,
  decryptChunk,
  encryptChunk,
  importSessionKey,
  newSessionKey,
  openMeta,
  sealMeta,
  toBase64,
  unwrapSessionKey,
} from "@agentsessionvault/crypto";
import { completeLinesFrom, lineKey, lines, mergeBytes, parseHeader, sessionRelPath, sessionTitle } from "@agentsessionvault/adapter-pi";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConflictError, NotFoundError, type Remote, type RemoteSession } from "./remote.ts";
import { type LocalSessionState, StateStore } from "./state.ts";

/** Encrypted in `sessions.meta_enc`. */
export interface SessionMeta {
  title?: string | undefined;
  cwd: string;
  /** The Pi header timestamp, also used for the file name. */
  created_at: string;
}

export interface SyncOptions {
  remote: Remote;
  keys: AccountSubkeys;
  /** Daemon state directory; session state goes under sessions/. */
  stateDir: string;
  /** Pi's sessions directory, where pulled sessions go by default. */
  sessionsDir: string;
  /** Raw payload bytes per chunk, before gzip. One line can exceed it. */
  maxChunkBytes?: number;
  /** Commit attempts per chunk before giving up on conflicts. */
  maxAttempts?: number;
}

export interface PushResult {
  sessionId: string;
  created: boolean;
  chunks: { seq: number; kind: ChunkKind; size: number }[];
  pulled: number;
}

export interface PullResult {
  sessionId: string;
  path: string;
  chunks: number;
  appendedBytes: number;
}

export interface SessionSummary {
  id: string;
  title?: string | undefined;
  cwd?: string;
  created_at?: string;
  head_seq: number;
  updated_at: string;
  deleted: boolean;
  local?: { path: string; pulledSeq: number; pushedOffset: number };
}

const HARNESS = "pi";
const enc = new TextEncoder();

async function sha256(b: Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)));
}

async function readOrEmpty(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array();
    throw e;
  }
}

/** Splits complete JSONL bytes into groups of whole lines of at most max bytes (a longer line stands alone). */
export function splitLines(bytes: Uint8Array, max: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  let pos = 0;
  while (pos < bytes.length) {
    const nl = bytes.indexOf(0x0a, pos);
    const end = nl === -1 ? bytes.length : nl + 1;
    if (end - start > max && pos > start) {
      out.push(bytes.subarray(start, pos));
      start = pos;
    }
    pos = end;
  }
  if (pos > start) out.push(bytes.subarray(start, pos));
  return out;
}

export class SyncEngine {
  private readonly remote: Remote;
  private readonly keys: AccountSubkeys;
  private readonly state: StateStore;
  private readonly sessionsDir: string;
  private readonly maxChunkBytes: number;
  private readonly maxAttempts: number;
  private readonly sessionKeys = new Map<string, CryptoKey>();
  /** One push or pull at a time per session. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(o: SyncOptions) {
    this.remote = o.remote;
    this.keys = o.keys;
    this.state = new StateStore(o.stateDir);
    this.sessionsDir = o.sessionsDir;
    this.maxChunkBytes = o.maxChunkBytes ?? 1024 * 1024;
    this.maxAttempts = o.maxAttempts ?? 5;
  }

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  private async sessionKey(s: RemoteSession): Promise<CryptoKey> {
    let k = this.sessionKeys.get(s.id);
    if (!k) {
      k = await importSessionKey(await unwrapSessionKey(this.keys, s.id, s.session_key));
      this.sessionKeys.set(s.id, k);
    }
    return k;
  }

  private ctx(sessionId: string, seq: number, kind: ChunkKind) {
    return { userId: this.remote.userId, sessionId, seq, kind };
  }

  /** Push the new part of a local Pi session file. Pulls first, and again on conflicts. */
  async push(path: string): Promise<PushResult> {
    const header = parseHeader(new TextDecoder().decode(await readFile(path)));
    return this.exclusive(header.id, () => this.pushLocked(path));
  }

  private async pushLocked(path: string): Promise<PushResult> {
    let file = new Uint8Array(await readFile(path));
    const text = new TextDecoder().decode(file);
    const header = parseHeader(text);
    const id = header.id;
    const meta: SessionMeta = { title: sessionTitle(text), cwd: header.cwd, created_at: header.timestamp };

    let st: LocalSessionState = (await this.state.load(id)) ?? {
      sessionId: id,
      path,
      pushedOffset: 0,
      prefixHash: await sha256(new Uint8Array()),
      pulledSeq: 0,
    };
    st.path = path;

    let session = await this.remote.getSession(id);
    let created = false;
    if (!session) {
      const { raw, envelope } = await newSessionKey(this.keys, id);
      try {
        await this.remote.createSession({
          id,
          harness: HARNESS,
          session_key: envelope,
          account_key_version: this.keys.version,
          meta_enc: await sealMeta(this.keys, id, "sessions.meta_enc", meta),
        });
        this.sessionKeys.set(id, await importSessionKey(raw));
        created = true;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
      session = (await this.remote.getSession(id))!;
    } else if (session.deleted_at === null) {
      const old = await openMeta<SessionMeta>(this.keys, id, "sessions.meta_enc", session.meta_enc);
      if (old.title !== meta.title) await this.remote.updateSessionMeta(id, await sealMeta(this.keys, id, "sessions.meta_enc", meta));
    }

    // Merge what others pushed, so we don't send it back.
    const seen = new Set<string>();
    let pulled = 0;
    const merge = async () => {
      const r = await this.pullInto(session!, st, seen);
      pulled += r.chunks;
      st = r.state;
      file = new Uint8Array(await readFile(path));
    };
    await merge();

    // A rewrite (shrunk or changed prefix) means a snapshot of the whole file.
    let kind: ChunkKind = "append";
    if (st.pushedOffset > file.length || (await sha256(file.subarray(0, st.pushedOffset))) !== st.prefixHash) {
      kind = "snapshot";
      st.pushedOffset = 0;
    }

    const { bytes } = completeLinesFrom(file, st.pushedOffset);
    const groups = splitLines(bytes, this.maxChunkBytes);
    const chunks: PushResult["chunks"] = [];
    let offset = st.pushedOffset;
    for (const group of groups) {
      offset += group.length;
      const payload =
        kind === "snapshot"
          ? group
          : enc.encode(
              lines(new TextDecoder().decode(group))
                .filter((l) => {
                  const k = lineKey(l);
                  return !k || !seen.has(k);
                })
                .map((l) => `${l}\n`)
                .join(""),
            );
      if (payload.length > 0) chunks.push(await this.commit(session, payload, kind, merge, () => st));
      st.pushedOffset = offset;
      st.prefixHash = await sha256(file.subarray(0, offset));
      await this.state.save(st);
      kind = "append";
    }
    await this.state.save(st);
    return { sessionId: id, created, chunks, pulled };
  }

  private async commit(
    session: RemoteSession,
    payload: Uint8Array,
    kind: ChunkKind,
    merge: () => Promise<void>,
    state: () => LocalSessionState,
  ): Promise<{ seq: number; kind: ChunkKind; size: number }> {
    const key = await this.sessionKey(session);
    for (let attempt = 1; ; attempt++) {
      const head = (await this.remote.getSession(session.id))!.head_seq;
      const seq = head + 1;
      const obj = await encryptChunk(key, payload, { ...this.ctx(session.id, seq, kind), keyId: 0 });
      const name = await this.remote.uploadChunk(session.id, seq, obj);
      try {
        await this.remote.commitChunk(session.id, seq, name, kind, obj.length);
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= this.maxAttempts) throw e;
        await merge();
        continue;
      }
      const st = state();
      if (st.pulledSeq === seq - 1) st.pulledSeq = seq;
      return { seq, kind, size: obj.length };
    }
  }

  /** Merge remote chunks into the local file. Without a known path, places it under Pi's sessions directory. */
  async pull(sessionId: string, opts: { path?: string } = {}): Promise<PullResult> {
    return this.exclusive(sessionId, async () => {
      const session = await this.remote.getSession(sessionId);
      if (!session) throw new NotFoundError(`session ${sessionId} not found`);
      let st = await this.state.load(sessionId);
      if (!st || opts.path) {
        let path = opts.path;
        if (!path) {
          const meta = await openMeta<SessionMeta>(this.keys, sessionId, "sessions.meta_enc", session.meta_enc);
          path = join(this.sessionsDir, sessionRelPath({ id: sessionId, cwd: meta.cwd, timestamp: meta.created_at }));
        }
        // A different file starts from scratch: everything gets merged into it.
        if (!st || st.path !== path) st = { sessionId, path, pushedOffset: 0, prefixHash: await sha256(new Uint8Array()), pulledSeq: 0 };
      }
      const r = await this.pullInto(session, st, new Set());
      return { sessionId, path: r.state.path, chunks: r.chunks, appendedBytes: r.appendedBytes };
    });
  }

  private async pullInto(
    session: RemoteSession,
    st: LocalSessionState,
    seen: Set<string>,
  ): Promise<{ state: LocalSessionState; chunks: number; appendedBytes: number }> {
    const rows = await this.remote.listChunks(session.id, st.pulledSeq);
    let appendedBytes = 0;
    for (const row of rows) {
      if (row.seq !== st.pulledSeq + 1) throw new Error(`chunk ${st.pulledSeq + 1} of ${session.id} is missing`);
      const plain = await decryptChunk(
        await this.sessionKey(session),
        await this.remote.downloadChunk(row.object_name),
        this.ctx(session.id, row.seq, row.kind),
      );
      for (const l of lines(new TextDecoder().decode(plain))) {
        const k = lineKey(l);
        if (k) seen.add(k);
      }
      const local = await readOrEmpty(st.path);
      const add = mergeBytes(local, plain);
      const fullyPushed = st.pushedOffset === local.length;
      if (add.length > 0) {
        await mkdir(dirname(st.path), { recursive: true });
        await appendFile(st.path, add);
        appendedBytes += add.length;
      }
      if (fullyPushed) {
        const now = new Uint8Array(await readFile(st.path));
        st.pushedOffset = now.length;
        st.prefixHash = await sha256(now);
      }
      st.pulledSeq = row.seq;
      await this.state.save(st);
    }
    return { state: st, chunks: rows.length, appendedBytes };
  }

  /** All sessions on the server, with decrypted metadata and what this device has. */
  async sessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const s of await this.remote.listSessions()) {
      let meta: Partial<SessionMeta> = {};
      try {
        meta = await openMeta<SessionMeta>(this.keys, s.id, "sessions.meta_enc", s.meta_enc);
      } catch {
        // Undecryptable metadata (e.g. an old account key) shouldn't hide the session.
      }
      const st = await this.state.load(s.id);
      out.push({
        id: s.id,
        ...meta,
        head_seq: s.head_seq,
        updated_at: s.updated_at,
        deleted: s.deleted_at !== null,
        ...(st ? { local: { path: st.path, pulledSeq: st.pulledSeq, pushedOffset: st.pushedOffset } } : {}),
      });
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
}
