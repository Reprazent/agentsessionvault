import { describe, expect, test } from "bun:test";
import { fromHex, toHex, utf8 } from "../src/bytes.ts";
import { seal } from "../src/envelope.ts";
import * as k from "../src/keys.ts";
import { refHkdf, refPbkdf2 } from "./reference.ts";

const salt = fromHex("000102030405060708090a0b0c0d0e0f");

describe("derivePassphraseKey", () => {
  test("matches node:crypto PBKDF2", async () => {
    const got = await k.derivePassphraseKey("correct horse battery staple", salt, 600_000);
    expect(toHex(got)).toBe(toHex(refPbkdf2("correct horse battery staple", salt, 600_000)));
  });

  test("normalises the passphrase to NFC", async () => {
    const a = await k.derivePassphraseKey("caf\u00e9-passphrase-123", salt, 600_000);
    const b = await k.derivePassphraseKey("cafe\u0301-passphrase-123", salt, 600_000);
    expect(a).toEqual(b);
  });

  test("rejects weak parameters", async () => {
    expect(k.derivePassphraseKey("x", salt, 1000)).rejects.toThrow(RangeError);
    expect(k.derivePassphraseKey("x", salt.subarray(1), 600_000)).rejects.toThrow(RangeError);
  });
});

describe("HKDF subkeys", () => {
  const ikm = fromHex("11".repeat(32));
  const nonce = fromHex("00".repeat(12));

  test("AES subkeys match node:crypto HKDF and differ per purpose", async () => {
    const pt = utf8("x");
    const ctx = { userId: "u", rowId: "r", field: "f", keyId: "k" };
    const viaDerived = await seal(await k.deriveAesKey(ikm, k.Purpose.encryptMeta), pt, ctx, nonce);
    const ref = await crypto.subtle.importKey("raw", refHkdf(ikm, "encrypt-meta"), "AES-GCM", false, ["encrypt"]);
    expect(viaDerived).toEqual(await seal(ref, pt, ctx, nonce));
    const other = await seal(await k.deriveAesKey(ikm, k.Purpose.wrapSessionKey), pt, ctx, nonce);
    expect(other.data).not.toBe(viaDerived.data);
  });

  test("HMAC subkey matches node:crypto HKDF", async () => {
    const mine = await crypto.subtle.sign("HMAC", await k.deriveHmacKey(ikm, k.Purpose.projectTag), utf8("x"));
    const refKey = await crypto.subtle.importKey("raw", refHkdf(ikm, "project-tag"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(new Uint8Array(mine)).toEqual(new Uint8Array(await crypto.subtle.sign("HMAC", refKey, utf8("x"))));
  });

  test("keys have to be 32 bytes", async () => {
    expect(k.deriveAesKey(ikm.subarray(1), k.Purpose.encryptMeta)).rejects.toThrow(RangeError);
    expect(k.importSessionKey(ikm.subarray(1))).rejects.toThrow(RangeError);
  });

  test("derived keys are not extractable", async () => {
    const key = await k.deriveAesKey(ikm, k.Purpose.encryptMeta);
    expect(key.extractable).toBe(false);
    expect((await k.importSessionKey(k.generateKey())).extractable).toBe(false);
  });
});
