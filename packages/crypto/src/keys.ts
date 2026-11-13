import { type Bytes, randomBytes, utf8 } from "./bytes.ts";

export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 16;

/** HKDF labels. One per purpose, so no key is used for two things. */
export const Purpose = {
  wrapAccountKey: "wrap-account-key",
  wrapSessionKey: "wrap-session-key",
  encryptMeta: "encrypt-meta",
  projectTag: "project-tag",
} as const;
export type Purpose = (typeof Purpose)[keyof typeof Purpose];

const HKDF_SALT = utf8("agentsessionvault/v1");

export interface KdfParams {
  alg: "pbkdf2-sha256";
  iterations: number;
  /** base64, 16 bytes */
  salt: string;
}

/** 32 random bytes: account keys, session keys and recovery keys. */
export function generateKey(): Bytes {
  return randomBytes(KEY_BYTES);
}

/** PBKDF2-HMAC-SHA256 over the passphrase. Returns 32 bytes of key material. */
export async function derivePassphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Bytes> {
  if (iterations < MIN_PBKDF2_ITERATIONS) throw new RangeError(`iterations below ${MIN_PBKDF2_ITERATIONS}`);
  if (salt.length !== SALT_BYTES) throw new RangeError(`salt must be ${SALT_BYTES} bytes`);
  const base = await crypto.subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

async function hkdfBits(ikm: Uint8Array, purpose: Purpose): Promise<Bytes> {
  if (ikm.length !== KEY_BYTES) throw new RangeError(`key must be ${KEY_BYTES} bytes`);
  const base = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: utf8(purpose) },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Non-extractable AES-256-GCM subkey for one purpose. */
export async function deriveAesKey(ikm: Uint8Array, purpose: Exclude<Purpose, "project-tag">): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await hkdfBits(ikm, purpose), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Non-extractable HMAC-SHA256 subkey, only for project tags. */
export async function deriveHmacKey(ikm: Uint8Array, purpose: "project-tag"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await hkdfBits(ikm, purpose), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Session keys encrypt chunks directly (no HKDF), so they are imported as-is. */
export async function importSessionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new RangeError(`key must be ${KEY_BYTES} bytes`);
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}
