// Byte helpers. WebCrypto wants ArrayBuffer-backed views, so everything here
// returns Uint8Array<ArrayBuffer>.

export type Bytes = Uint8Array<ArrayBuffer>;

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function utf8(s: string): Bytes {
  return new TextEncoder().encode(s) as Bytes;
}

export function u8(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`not a u8: ${n}`);
  return Uint8Array.of(n);
}

export function u32(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a u32: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

export function uuidBytes(uuid: string): Bytes {
  const hex = uuid.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new TypeError(`not a uuid: ${uuid}`);
  return fromHex(hex);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new TypeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromBase64(s: string): Bytes {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new TypeError("invalid base64");
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Unambiguous AAD encoding: every field is a u32 length followed by its bytes.
 * Strings are UTF-8, numbers are u32.
 */
export function encodeAad(fields: (string | number | Uint8Array)[]): Bytes {
  return concat(
    ...fields.flatMap((f) => {
      const b = typeof f === "string" ? utf8(f) : typeof f === "number" ? u32(f) : f;
      return [u32(b.length), b];
    }),
  );
}
