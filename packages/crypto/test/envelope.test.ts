import { describe, expect, test } from "bun:test";
import { fromBase64, fromHex, toBase64, utf8 } from "../src/bytes.ts";
import { DecryptionError, open, openJson, seal, sealJson } from "../src/envelope.ts";
import { refAad, refGcmDecrypt } from "./reference.ts";

const raw = fromHex("22".repeat(32));
const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
const ctx = { userId: "u1", rowId: "r1", field: "sessions.meta_enc", keyId: "account-key-v1" };

describe("envelope", () => {
  test("round trips and has the documented shape", async () => {
    const env = await seal(key, utf8("hello"), ctx);
    expect(Object.keys(env).sort()).toEqual(["algorithm", "data", "key_id", "nonce", "tag"]);
    expect(env.algorithm).toBe("A256GCM");
    expect(env.key_id).toBe("account-key-v1");
    expect(new TextDecoder().decode(await open(key, env, ctx))).toBe("hello");
  });

  test("node:crypto can decrypt it with the documented AAD", async () => {
    const env = await seal(key, utf8("hello"), ctx);
    const aad = refAad("asv-envelope-v1", "u1", "r1", "sessions.meta_enc", "account-key-v1");
    const pt = refGcmDecrypt(raw, fromBase64(env.nonce), aad, fromBase64(env.data), fromBase64(env.tag));
    expect(new TextDecoder().decode(pt)).toBe("hello");
  });

  test("nonces are random", async () => {
    const a = await seal(key, utf8("x"), ctx);
    const b = await seal(key, utf8("x"), ctx);
    expect(a.nonce).not.toBe(b.nonce);
  });

  for (const field of ["userId", "rowId", "field"] as const) {
    test(`moving to another ${field} fails`, async () => {
      const env = await seal(key, utf8("x"), ctx);
      await expect(open(key, env, { ...ctx, [field]: "other" })).rejects.toThrow(DecryptionError);
    });
  }

  test("tampering fails", async () => {
    const env = await seal(key, utf8("hello"), ctx);
    const data = fromBase64(env.data);
    data[0]! ^= 1;
    await expect(open(key, { ...env, data: toBase64(data) }, ctx)).rejects.toThrow(DecryptionError);
    await expect(open(key, { ...env, key_id: "account-key-v2" }, ctx)).rejects.toThrow(DecryptionError);
  });

  test("malformed envelopes fail cleanly", async () => {
    const env = await seal(key, utf8("hello"), ctx);
    await expect(open(key, { ...env, algorithm: "X" as "A256GCM" }, ctx)).rejects.toThrow(DecryptionError);
    await expect(open(key, { ...env, nonce: "!!" }, ctx)).rejects.toThrow(DecryptionError);
    await expect(open(key, { ...env, tag: toBase64(new Uint8Array(4)) }, ctx)).rejects.toThrow(DecryptionError);
    await expect(seal(key, utf8("x"), ctx, new Uint8Array(8))).rejects.toThrow(RangeError);
  });

  test("json helpers", async () => {
    const env = await sealJson(key, { title: "t", n: 1 }, ctx);
    expect(await openJson(key, env, ctx)).toEqual({ title: "t", n: 1 });
  });
});
