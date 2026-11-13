import type { ChunkKind, Envelope } from "@agentsessionvault/crypto";

/** A `sessions` row as clients see it. */
export interface RemoteSession {
  id: string;
  harness: string;
  session_key: Envelope;
  account_key_version: number;
  meta_enc: Envelope;
  head_seq: number;
  updated_at: string;
  deleted_at: string | null;
}

/** A `chunks` row as clients see it. */
export interface RemoteChunk {
  session_id: string;
  seq: number;
  object_name: string;
  kind: ChunkKind;
  size: number;
  device_id: string;
}

export type NewSession = Pick<RemoteSession, "id" | "harness" | "session_key" | "account_key_version" | "meta_enc">;

/** Someone else got there first: another commit at this seq, or the session already exists. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/**
 * What the sync engine needs from the server. The Supabase implementation
 * lives in @agentsessionvault/client; tests use an in-memory one.
 */
export interface Remote {
  readonly userId: string;
  getSession(id: string): Promise<RemoteSession | null>;
  listSessions(): Promise<RemoteSession[]>;
  /** Throws ConflictError if the id exists. */
  createSession(row: NewSession): Promise<void>;
  updateSessionMeta(id: string, meta: Envelope): Promise<void>;
  listChunks(sessionId: string, afterSeq: number): Promise<RemoteChunk[]>;
  /** Uploads an encrypted chunk object and returns its object name. Not visible until committed. */
  uploadChunk(sessionId: string, seq: number, obj: Uint8Array): Promise<string>;
  /** The commit point. Throws ConflictError unless seq is head_seq + 1. */
  commitChunk(sessionId: string, seq: number, objectName: string, kind: ChunkKind, size: number): Promise<void>;
  downloadChunk(objectName: string): Promise<Uint8Array>;
}
