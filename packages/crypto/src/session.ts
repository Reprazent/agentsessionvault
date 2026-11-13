import { type Bytes, toBase64, utf8 } from "./bytes.ts";
import { type Envelope, type EnvelopeContext, open, openJson, seal, sealJson } from "./envelope.ts";
import { KEY_BYTES, Purpose, deriveAesKey, deriveHmacKey, generateKey } from "./keys.ts";

/** Subkeys derived from an unlocked account key. Hold these, not the raw key. */
export interface AccountSubkeys {
  userId: string;
  version: number;
  wrapSessionKey: CryptoKey;
  encryptMeta: CryptoKey;
  projectTag: CryptoKey;
}

export async function accountSubkeys(userId: string, accountKey: Uint8Array, version: number): Promise<AccountSubkeys> {
  return {
    userId,
    version,
    wrapSessionKey: await deriveAesKey(accountKey, Purpose.wrapSessionKey),
    encryptMeta: await deriveAesKey(accountKey, Purpose.encryptMeta),
    projectTag: await deriveHmacKey(accountKey, Purpose.projectTag),
  };
}

const ctx = (k: AccountSubkeys, rowId: string, field: string): EnvelopeContext => ({
  userId: k.userId,
  rowId,
  field,
  keyId: `account-key-v${k.version}`,
});

export async function newSessionKey(k: AccountSubkeys, sessionId: string): Promise<{ raw: Bytes; envelope: Envelope }> {
  const raw = generateKey();
  return { raw, envelope: await wrapSessionKey(k, sessionId, raw) };
}

export function wrapSessionKey(k: AccountSubkeys, sessionId: string, raw: Uint8Array): Promise<Envelope> {
  return seal(k.wrapSessionKey, raw, ctx(k, sessionId, "sessions.session_key"));
}

export async function unwrapSessionKey(k: AccountSubkeys, sessionId: string, env: Envelope): Promise<Bytes> {
  const raw = await open(k.wrapSessionKey, env, { userId: k.userId, rowId: sessionId, field: "sessions.session_key" });
  if (raw.length !== KEY_BYTES) throw new RangeError("session key has wrong length");
  return raw;
}

/** Encrypt a metadata column (e.g. "sessions.meta_enc") for a given row. */
export function sealMeta(k: AccountSubkeys, rowId: string, field: string, value: unknown): Promise<Envelope> {
  return sealJson(k.encryptMeta, value, ctx(k, rowId, field));
}

export function openMeta<T = unknown>(k: AccountSubkeys, rowId: string, field: string, env: Envelope): Promise<T> {
  return openJson<T>(k.encryptMeta, env, { userId: k.userId, rowId, field });
}

/** Deterministic tag for a normalised project identity. Base64 for transport; the column is bytea. */
export async function projectTag(k: AccountSubkeys, identity: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", k.projectTag, utf8(identity))));
}
