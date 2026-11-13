// Typed Supabase access: the account and device rows, and the sync engine's
// Remote. Exercised by `pnpm test:e2e` against the hosted project, not by unit
// tests, so it's excluded from unit coverage in bunfig.toml.

import { type AccountKeys, type ChunkKind, type Envelope } from "@agentsessionvault/crypto";
import { ConflictError, type NewSession, NotFoundError, type Remote, type RemoteChunk, type RemoteSession } from "@agentsessionvault/sync";
import { FunctionsHttpError, type Session, createClient } from "@supabase/supabase-js";
import type { Database, Json } from "./database.types.ts";
import { FileAuthStorage, NotSignedInError, RevokedDeviceError, jwtSessionId, parseLoginProof } from "./auth.ts";

const BUCKET = "sessions";

export interface DeviceRow {
  id: string;
  status: "active" | "revoked";
  name_enc: Envelope;
  auth_session_id: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface VaultClientOptions {
  url: string;
  publishableKey: string;
  /** Where the auth session is persisted. */
  authFile: string;
}

const asJson = (v: unknown) => v as NonNullable<Json>;

export class VaultClient {
  readonly supabase;

  constructor(o: VaultClientOptions) {
    this.supabase = createClient<Database>(o.url, o.publishableKey, {
      auth: {
        storage: new FileAuthStorage(o.authFile),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
    });
  }

  /**
   * Emails a sign-in code (or link). Creates the user on first use. With
   * redirectTo, the link lands there with ?code=, which only this client can
   * exchange: it holds the PKCE verifier.
   */
  async sendLoginEmail(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) },
    });
    if (error) throw error;
  }

  async verifyLogin(email: string, input: string): Promise<Session> {
    const proof = parseLoginProof(input);
    const auth = this.supabase.auth;
    const { data, error } =
      proof.kind === "code"
        ? await auth.verifyOtp({ email, token: proof.code, type: "email" })
        : proof.kind === "token_hash"
          ? await auth.verifyOtp({ token_hash: proof.tokenHash, type: proof.type })
          : proof.kind === "auth_code"
            ? await auth.exchangeCodeForSession(proof.code)
            : await auth.setSession({ access_token: proof.accessToken, refresh_token: proof.refreshToken });
    if (error) throw error;
    if (!data.session) throw new Error("sign-in returned no session");
    return data.session;
  }

  async session(): Promise<Session | null> {
    const { data, error } = await this.supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async requireSession(): Promise<Session> {
    const s = await this.session();
    if (!s) throw new NotSignedInError();
    return s;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut({ scope: "local" });
  }

  async getAccount(userId: string): Promise<AccountKeys | null> {
    const { data, error } = await this.supabase
      .from("accounts")
      .select("kdf, account_key_by_pass, account_key_by_recovery, account_key_version")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data as unknown as AccountKeys | null;
  }

  async createAccount(userId: string, row: AccountKeys): Promise<void> {
    const { error } = await this.supabase.from("accounts").insert({
      user_id: userId,
      kdf: asJson(row.kdf),
      account_key_by_pass: asJson(row.account_key_by_pass),
      account_key_by_recovery: asJson(row.account_key_by_recovery),
      account_key_version: row.account_key_version,
    });
    if (error?.code === "23505") throw new ConflictError("an account already exists; use unlock");
    if (error) throw error;
  }

  /**
   * Replaces the passphrase copy of the account key. Only applies if the salt
   * is still `previousSalt`, so a concurrent change elsewhere isn't silently
   * overwritten. Needs an active device.
   */
  async updatePassphrase(userId: string, row: AccountKeys, previousSalt: string): Promise<void> {
    const { data, error } = await this.supabase
      .from("accounts")
      .update({ kdf: asJson(row.kdf), account_key_by_pass: asJson(row.account_key_by_pass) })
      .eq("user_id", userId)
      .eq("kdf->>salt", previousSalt)
      .select("user_id");
    if (error) throw error;
    if (!data?.length) throw new ConflictError("the passphrase changed elsewhere, or this device isn't active; unlock again and retry");
  }

  /** This sign-in's device, if it's registered and active. A revoked one is invisible. */
  async currentDevice(): Promise<DeviceRow | null> {
    const session = await this.requireSession();
    const { data, error } = await this.supabase
      .from("devices")
      .select("id, status, name_enc, auth_session_id, created_at, last_seen_at, revoked_at, revoked_by")
      .eq("auth_session_id", jwtSessionId(session.access_token))
      .maybeSingle();
    if (error) throw error;
    return data as unknown as DeviceRow | null;
  }

  /** Registers this sign-in as a device. The caller encrypts the name with the device id as row id. */
  async registerDevice(id: string, nameEnc: Envelope): Promise<void> {
    const session = await this.requireSession();
    const { error } = await this.supabase.from("devices").insert({
      id,
      user_id: session.user.id,
      auth_session_id: jwtSessionId(session.access_token),
      name_enc: asJson(nameEnc),
    });
    if (error?.code === "23505") throw new RevokedDeviceError();
    if (error) throw error;
  }

  async listDevices(): Promise<DeviceRow[]> {
    const { data, error } = await this.supabase
      .from("devices")
      .select("id, status, name_enc, auth_session_id, created_at, last_seen_at, revoked_at, revoked_by")
      .order("created_at");
    if (error) throw error;
    return data as unknown as DeviceRow[];
  }

  /**
   * Revokes a device. The database records when and by whom, and deletes its
   * Auth session so it can't refresh. Final: revoked devices stay revoked.
   */
  async revokeDevice(id: string): Promise<void> {
    const { data, error } = await this.supabase.from("devices").update({ status: "revoked" }).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) throw new NotFoundError(`device ${id} not found`);
  }

  async touchDevice(id: string): Promise<void> {
    const { error } = await this.supabase.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }

  remote(userId: string): SupabaseRemote {
    return new SupabaseRemote(this, userId);
  }
}

const SESSION_COLS = "id, harness, session_key, account_key_version, meta_enc, head_seq, updated_at, deleted_at";

export class SupabaseRemote implements Remote {
  constructor(
    private readonly client: VaultClient,
    readonly userId: string,
  ) {}

  private get db() {
    return this.client.supabase;
  }

  async getSession(id: string): Promise<RemoteSession | null> {
    const { data, error } = await this.db.from("sessions").select(SESSION_COLS).eq("id", id).maybeSingle();
    if (error) throw error;
    return data as unknown as RemoteSession | null;
  }

  async listSessions(): Promise<RemoteSession[]> {
    const { data, error } = await this.db.from("sessions").select(SESSION_COLS).order("updated_at", { ascending: false });
    if (error) throw error;
    return data as unknown as RemoteSession[];
  }

  async createSession(row: NewSession): Promise<void> {
    const { error } = await this.db.from("sessions").insert({
      id: row.id,
      user_id: this.userId,
      harness: row.harness,
      session_key: asJson(row.session_key),
      account_key_version: row.account_key_version,
      meta_enc: asJson(row.meta_enc),
    });
    if (error?.code === "23505") throw new ConflictError(`session ${row.id} exists`);
    if (error) throw error;
  }

  async updateSessionMeta(id: string, meta: Envelope): Promise<void> {
    const { error } = await this.db.from("sessions").update({ meta_enc: asJson(meta) }).eq("id", id);
    if (error) throw error;
  }

  async listChunks(sessionId: string, afterSeq: number): Promise<RemoteChunk[]> {
    const { data, error } = await this.db
      .from("chunks")
      .select("session_id, seq, object_name, kind, size, device_id")
      .eq("session_id", sessionId)
      .gt("seq", afterSeq)
      .order("seq");
    if (error) throw error;
    return data as RemoteChunk[];
  }

  async uploadChunk(sessionId: string, seq: number, obj: Uint8Array): Promise<string> {
    const { data, error } = await this.db.functions.invoke<{ object_name: string; token: string }>("upload-url", {
      body: { session_id: sessionId, seq, size: obj.length },
    });
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
      if (res.status === 409) throw new ConflictError(msg);
      if (res.status === 404) throw new NotFoundError(msg);
      throw new Error(`upload-url: ${res.status} ${msg}`);
    }
    if (error) throw error;
    const up = await this.db.storage
      .from(BUCKET)
      .uploadToSignedUrl(data!.object_name, data!.token, new Blob([obj as Uint8Array<ArrayBuffer>]), {
        contentType: "application/octet-stream",
      });
    if (up.error) throw up.error;
    return data!.object_name;
  }

  async commitChunk(sessionId: string, seq: number, objectName: string, kind: ChunkKind, size: number): Promise<void> {
    const { error } = await this.db.rpc("commit_chunk", {
      p_session_id: sessionId,
      p_seq: seq,
      p_object_name: objectName,
      p_kind: kind,
      p_size: size,
    });
    if (error?.code === "23505") throw new ConflictError(error.message);
    if (error?.code === "P0002") throw new NotFoundError(error.message);
    if (error) throw error;
  }

  async downloadChunk(objectName: string): Promise<Uint8Array> {
    const { data, error } = await this.db.storage.from(BUCKET).download(objectName);
    if (error) throw error;
    return new Uint8Array(await data.arrayBuffer());
  }
}
