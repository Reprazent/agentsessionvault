import { type Bytes, encodeAad, fromBase64, randomBytes, toBase64 } from "./bytes.ts";

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const ALGORITHM = "A256GCM" as const;

/** JSON envelope stored in jsonb columns. */
export interface Envelope {
  key_id: string;
  algorithm: typeof ALGORITHM;
  nonce: string;
  data: string;
  tag: string;
}

/** What an encrypted value is bound to. Changing any field breaks decryption. */
export interface EnvelopeContext {
  userId: string;
  /** Row the value lives on (account = user id, session id, device id, ...). */
  rowId: string;
  /** Column or purpose, e.g. "sessions.meta_enc". */
  field: string;
  keyId: string;
}

function aad(ctx: EnvelopeContext): Bytes {
  return encodeAad(["asv-envelope-v1", ctx.userId, ctx.rowId, ctx.field, ctx.keyId]);
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  ctx: EnvelopeContext,
  nonce: Bytes = randomBytes(NONCE_BYTES),
): Promise<Envelope> {
  if (nonce.length !== NONCE_BYTES) throw new RangeError("bad nonce length");
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(ctx), tagLength: TAG_BYTES * 8 },
      key,
      new Uint8Array(plaintext),
    ),
  );
  return {
    key_id: ctx.keyId,
    algorithm: ALGORITHM,
    nonce: toBase64(nonce),
    data: toBase64(out.subarray(0, out.length - TAG_BYTES)),
    tag: toBase64(out.subarray(out.length - TAG_BYTES)),
  };
}

export class DecryptionError extends Error {
  override name = "DecryptionError";
}

export async function open(key: CryptoKey, env: Envelope, ctx: Omit<EnvelopeContext, "keyId">): Promise<Bytes> {
  if (env.algorithm !== ALGORITHM) throw new DecryptionError(`unsupported algorithm ${String(env.algorithm)}`);
  let nonce: Bytes, data: Bytes, tag: Bytes;
  try {
    nonce = fromBase64(env.nonce);
    data = fromBase64(env.data);
    tag = fromBase64(env.tag);
  } catch {
    throw new DecryptionError("malformed envelope");
  }
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError("malformed envelope");
  const ct = new Uint8Array(data.length + TAG_BYTES);
  ct.set(data);
  ct.set(tag, data.length);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad({ ...ctx, keyId: env.key_id }), tagLength: TAG_BYTES * 8 },
        key,
        ct,
      ),
    );
  } catch {
    throw new DecryptionError("envelope failed to decrypt");
  }
}

export async function sealJson(key: CryptoKey, value: unknown, ctx: EnvelopeContext, nonce?: Bytes): Promise<Envelope> {
  return seal(key, new TextEncoder().encode(JSON.stringify(value)), ctx, nonce);
}

export async function openJson<T = unknown>(
  key: CryptoKey,
  env: Envelope,
  ctx: Omit<EnvelopeContext, "keyId">,
): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(key, env, ctx))) as T;
}
