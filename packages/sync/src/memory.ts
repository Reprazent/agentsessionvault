import type { ChunkKind, Envelope } from "@agentsessionvault/crypto";
import { type ChunkSubscription, ConflictError, type NewSession, NotFoundError, type Remote, type RemoteChunk, type RemoteProject, type RemoteSession } from "./remote.ts";

/** Shared server state for MemoryRemote. Mirrors the rules of commit_chunk. */
export class MemoryServer {
  /** By `<user id>/<session id>`: session ids are only unique per user. */
  sessions = new Map<string, RemoteSession>();
  projects = new Map<string, RemoteProject>();
  /** By `<user id>/<session id>`, like sessions. */
  chunks = new Map<string, RemoteChunk[]>();
  objects = new Map<string, Uint8Array>();
  /** Realtime stand-in: subscribers by user id. */
  subscribers = new Set<{ userId: string; sub: ChunkSubscription }>();
  private n = 0;
  /** Called before each commit; lets tests interleave another device. */
  beforeCommit?: undefined | ((sessionId: string, seq: number) => Promise<void> | void);

  /** A session row; without a user, the only one with this id. For tests. */
  session(id: string, userId?: string): RemoteSession | undefined {
    if (userId) return this.sessions.get(`${userId}/${id}`);
    const all = [...this.sessions.entries()].filter(([k]) => k.endsWith(`/${id}`));
    if (all.length > 1) throw new Error(`session ${id} exists for several users; pass one`);
    return all[0]?.[1];
  }

  /** A session's chunks; like session(). */
  chunksOf(id: string, userId?: string): RemoteChunk[] | undefined {
    if (userId) return this.chunks.get(`${userId}/${id}`);
    const all = [...this.chunks.entries()].filter(([k]) => k.endsWith(`/${id}`));
    if (all.length > 1) throw new Error(`session ${id} exists for several users; pass one`);
    return all[0]?.[1];
  }

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

  private key(id: string): string {
    return `${this.userId}/${id}`;
  }

  async getSession(id: string) {
    const s = this.server.sessions.get(this.key(id));
    return s ? structuredClone(s) : null;
  }

  async listSessions() {
    return [...this.server.sessions.entries()]
      .filter(([k]) => k.startsWith(`${this.userId}/`))
      .map(([, s]) => structuredClone(s));
  }

  async createSession(row: NewSession) {
    const k = this.key(row.id);
    if (this.server.sessions.has(k)) throw new ConflictError(`session ${row.id} exists`);
    this.server.sessions.set(k, { ...row, project_id: null, head_seq: 0, updated_at: new Date().toISOString(), deleted_at: null });
    this.server.chunks.set(k, []);
  }

  async updateSessionMeta(id: string, meta: Envelope) {
    const s = this.server.sessions.get(this.key(id));
    if (!s) throw new NotFoundError(id);
    s.meta_enc = meta;
  }

  async setSessionProject(id: string, projectId: string) {
    const s = this.server.sessions.get(this.key(id));
    if (!s) throw new NotFoundError(id);
    if (!this.server.projects.has(projectId)) throw new NotFoundError(projectId);
    s.project_id = projectId;
  }

  async listProjects() {
    return [...this.server.projects.values()].map((p) => structuredClone(p));
  }

  async createProject(row: RemoteProject) {
    for (const p of this.server.projects.values()) if (p.project_tag === row.project_tag) throw new ConflictError("project exists");
    this.server.projects.set(row.id, structuredClone(row));
  }

  async listChunks(sessionId: string, afterSeq: number) {
    return (this.server.chunks.get(this.key(sessionId)) ?? []).filter((c) => c.seq > afterSeq).map((c) => ({ ...c }));
  }

  async uploadChunk(sessionId: string, seq: number, obj: Uint8Array) {
    const name = this.server.nextName(this.userId, sessionId, seq);
    this.server.objects.set(name, obj.slice());
    return name;
  }

  async commitChunk(sessionId: string, seq: number, objectName: string, kind: ChunkKind, size: number) {
    await this.server.beforeCommit?.(sessionId, seq);
    const s = this.server.sessions.get(this.key(sessionId));
    if (!s) throw new NotFoundError(sessionId);
    if (seq !== s.head_seq + 1) throw new ConflictError(`seq ${seq} is not head_seq + 1`);
    this.server.chunks.get(this.key(sessionId))!.push({ session_id: sessionId, seq, object_name: objectName, kind, size, device_id: this.deviceId });
    s.head_seq = seq;
    s.updated_at = new Date().toISOString();
    for (const x of this.server.subscribers) {
      if (x.userId === this.userId) x.sub.onInsert({ session_id: sessionId, seq, device_id: this.deviceId });
    }
  }

  subscribeChunks(sub: ChunkSubscription): () => void {
    const entry = { userId: this.userId, sub };
    this.server.subscribers.add(entry);
    queueMicrotask(() => this.server.subscribers.has(entry) && sub.onState(true));
    return () => void this.server.subscribers.delete(entry);
  }

  async downloadChunk(objectName: string) {
    const o = this.server.objects.get(objectName);
    if (!o) throw new NotFoundError(objectName);
    return o.slice();
  }
}
