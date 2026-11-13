import type { ChunkKind, Envelope } from "@agentsessionvault/crypto";
import { ConflictError, type NewSession, NotFoundError, type Remote, type RemoteChunk, type RemoteSession } from "./remote.ts";

/** Shared server state for MemoryRemote. Mirrors the rules of commit_chunk. */
export class MemoryServer {
  sessions = new Map<string, RemoteSession>();
  chunks = new Map<string, RemoteChunk[]>();
  objects = new Map<string, Uint8Array>();
  private n = 0;
  /** Called before each commit; lets tests interleave another device. */
  beforeCommit?: undefined | ((sessionId: string, seq: number) => Promise<void> | void);

  remote(userId: string, deviceId: string): MemoryRemote {
    return new MemoryRemote(this, userId, deviceId);
  }

  nextName(userId: string, sessionId: string, seq: number): string {
    return `${userId}/${sessionId}/${seq}-${String(++this.n).padStart(16, "0")}.bin`;
  }
}

/** In-memory Remote for tests and offline experiments. One per device. */
export class MemoryRemote implements Remote {
  constructor(
    private readonly server: MemoryServer,
    readonly userId: string,
    readonly deviceId: string,
  ) {}

  async getSession(id: string) {
    const s = this.server.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async listSessions() {
    return [...this.server.sessions.values()].map((s) => structuredClone(s));
  }

  async createSession(row: NewSession) {
    if (this.server.sessions.has(row.id)) throw new ConflictError(`session ${row.id} exists`);
    this.server.sessions.set(row.id, { ...row, head_seq: 0, updated_at: new Date().toISOString(), deleted_at: null });
    this.server.chunks.set(row.id, []);
  }

  async updateSessionMeta(id: string, meta: Envelope) {
    const s = this.server.sessions.get(id);
    if (!s) throw new NotFoundError(id);
    s.meta_enc = meta;
  }

  async listChunks(sessionId: string, afterSeq: number) {
    return (this.server.chunks.get(sessionId) ?? []).filter((c) => c.seq > afterSeq).map((c) => ({ ...c }));
  }

  async uploadChunk(sessionId: string, seq: number, obj: Uint8Array) {
    const name = this.server.nextName(this.userId, sessionId, seq);
    this.server.objects.set(name, obj.slice());
    return name;
  }

  async commitChunk(sessionId: string, seq: number, objectName: string, kind: ChunkKind, size: number) {
    await this.server.beforeCommit?.(sessionId, seq);
    const s = this.server.sessions.get(sessionId);
    if (!s) throw new NotFoundError(sessionId);
    if (seq !== s.head_seq + 1) throw new ConflictError(`seq ${seq} is not head_seq + 1`);
    this.server.chunks.get(sessionId)!.push({ session_id: sessionId, seq, object_name: objectName, kind, size, device_id: this.deviceId });
    s.head_seq = seq;
    s.updated_at = new Date().toISOString();
  }

  async downloadChunk(objectName: string) {
    const o = this.server.objects.get(objectName);
    if (!o) throw new NotFoundError(objectName);
    return o.slice();
  }
}
