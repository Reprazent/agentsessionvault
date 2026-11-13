import { type Bytes, concat, randomBytes, u32, u8, utf8, uuidBytes, equal } from "./bytes.ts";
import { DecryptionError, NONCE_BYTES, TAG_BYTES } from "./envelope.ts";

export const MAGIC = utf8("ASV1");
export const CHUNK_VERSION = 1;
export const ALG_AES256GCM_GZIP = 1;
export const HEADER_BYTES = MAGIC.length + 3 + NONCE_BYTES;

export type ChunkKind = "append" | "snapshot";
const KIND_CODE: Record<ChunkKind, number> = { append: 1, snapshot: 2 };

export interface ChunkContext {
  userId: string;
  sessionId: string;
  seq: number;
  kind: ChunkKind;
  /** Version of the session key, 0-255. */
  keyId: number;
}

export interface ChunkHeader {
  version: number;
  alg: number;
  keyId: number;
  nonce: Bytes;
}

function header(keyId: number, nonce: Bytes): Bytes {
  return concat(MAGIC, u8(CHUNK_VERSION), u8(ALG_AES256GCM_GZIP), u8(keyId), nonce);
}

function aad(hdr: Bytes, ctx: Omit<ChunkContext, "keyId">): Bytes {
  if (!(ctx.kind in KIND_CODE)) throw new TypeError(`unknown chunk kind ${String(ctx.kind)}`);
  return concat(hdr, uuidBytes(ctx.userId), uuidBytes(ctx.sessionId), u32(ctx.seq), u8(KIND_CODE[ctx.kind]));
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const body = new Blob([new Uint8Array(data)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream("gzip"));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream("gzip"));

export function parseHeader(obj: Uint8Array): ChunkHeader {
  if (obj.length < HEADER_BYTES + TAG_BYTES || !equal(obj.subarray(0, MAGIC.length), MAGIC)) {
    throw new DecryptionError("not a chunk");
  }
  const [version, alg, keyId] = obj.subarray(MAGIC.length, MAGIC.length + 3) as unknown as [number, number, number];
  if (version !== CHUNK_VERSION) throw new DecryptionError(`unsupported chunk version ${version}`);
  if (alg !== ALG_AES256GCM_GZIP) throw new DecryptionError(`unsupported chunk algorithm ${alg}`);
  return { version, alg, keyId, nonce: obj.slice(MAGIC.length + 3, HEADER_BYTES) };
}

/** gzip, then AES-256-GCM with the session key. Returns the full object bytes. */
export async function encryptChunk(
  sessionKey: CryptoKey,
  payload: Uint8Array,
  ctx: ChunkContext,
  nonce: Bytes = randomBytes(NONCE_BYTES),
): Promise<Bytes> {
  if (nonce.length !== NONCE_BYTES) throw new RangeError("bad nonce length");
  const hdr = header(ctx.keyId, nonce);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(hdr, ctx), tagLength: TAG_BYTES * 8 },
    sessionKey,
    await gzip(payload),
  );
  return concat(hdr, new Uint8Array(ct));
}

/**
 * Decrypts a chunk object. The caller supplies where it expects the chunk to
 * be; a chunk moved to another session, seq or kind fails.
 * Use parseHeader() first to pick the session key by keyId.
 */
export async function decryptChunk(
  sessionKey: CryptoKey,
  obj: Uint8Array,
  ctx: Omit<ChunkContext, "keyId">,
): Promise<Bytes> {
  parseHeader(obj);
  const hdr = obj.slice(0, HEADER_BYTES);
  let compressed: Bytes;
  try {
    compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: hdr.slice(MAGIC.length + 3), additionalData: aad(hdr, ctx), tagLength: TAG_BYTES * 8 },
        sessionKey,
        obj.slice(HEADER_BYTES),
      ),
    );
  } catch {
    throw new DecryptionError("chunk failed to decrypt");
  }
  return gunzip(compressed);
}
