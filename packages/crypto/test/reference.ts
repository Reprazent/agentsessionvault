// Independent reference implementation using node:crypto, so the WebCrypto
// code is checked against something other than itself.
import { createDecipheriv, hkdfSync, pbkdf2Sync } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const refPbkdf2 = (pass: string, salt: Uint8Array, iter: number) =>
  new Uint8Array(pbkdf2Sync(pass.normalize("NFC"), salt, iter, 32, "sha256"));

export const refHkdf = (ikm: Uint8Array, label: string) =>
  new Uint8Array(hkdfSync("sha256", ikm, Buffer.from("agentsessionvault/v1"), Buffer.from(label), 32));

export function refGcmDecrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array, tag: Uint8Array) {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
}

export const refGunzip = (b: Uint8Array) => new Uint8Array(gunzipSync(b));

function lv(b: Uint8Array) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

export const refAad = (...fields: string[]) => new Uint8Array(Buffer.concat(fields.map((f) => lv(Buffer.from(f)))));
