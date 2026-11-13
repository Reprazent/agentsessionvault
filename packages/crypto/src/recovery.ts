import { type Bytes } from "./bytes.ts";
import { KEY_BYTES } from "./keys.ts";

// Crockford base32: no I, L, O, U. Input is forgiving (case, i/l -> 1, o -> 0).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class InvalidRecoveryKeyError extends Error {
  override name = "InvalidRecoveryKeyError";
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(s: string, length: number): Bytes {
  const clean = s
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const out = new Uint8Array(length);
  let bits = 0,
    value = 0,
    i = 0;
  for (const c of clean) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new InvalidRecoveryKeyError(`invalid character ${c}`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (i >= length) throw new InvalidRecoveryKeyError("too long");
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (i !== length || (value & ((1 << bits) - 1)) !== 0) throw new InvalidRecoveryKeyError("wrong length");
  return out;
}

/** 32 bytes -> 52 base32 chars in groups of 4: XXXX-XXXX-... */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new RangeError(`recovery key must be ${KEY_BYTES} bytes`);
  return encodeBase32(key).match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(s: string): Bytes {
  return decodeBase32(s, KEY_BYTES);
}

/** 24 base32 chars (120 bits) in groups of 4, comfortably over the 16 char minimum. */
export function generatePassphrase(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(15))).match(/.{4}/g)!.join("-");
}
