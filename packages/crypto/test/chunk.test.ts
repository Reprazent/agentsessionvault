import { describe, expect, test } from "bun:test";
import { fromHex, utf8 } from "../src/bytes.ts";
import { DecryptionError } from "../src/envelope.ts";
import * as c from "../src/chunk.ts";
import { importSessionKey } from "../src/keys.ts";
import { refGcmDecrypt, refGunzip } from "./reference.ts";

const raw = fromHex("33".repeat(32));
const key = await importSessionKey(raw);
const ctx = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  seq: 7,
  kind: "append" as const,
  keyId: 1,
};
const payload = utf8('{"id":"a","parentId":null}\n{"id":"b","parentId":"a"}\n');

describe("chunk", () => {
  test("round trips", async () => {
    const obj = await c.encryptChunk(key, payload, ctx);
    expect(await c.decryptChunk(key, obj, ctx)).toEqual(payload);
  });

  test("layout matches the spec and node:crypto can read it", async () => {
    const nonce = fromHex("0a".repeat(12));
    const obj = await c.encryptChunk(key, payload, ctx, nonce);
    const hdr = obj.subarray(0, c.HEADER_BYTES);
    expect(new TextDecoder().decode(hdr.subarray(0, 4))).toBe("ASV1");
    expect([...hdr.subarray(4, 7)]).toEqual([1, 1, 1]);
    expect(hdr.subarray(7)).toEqual(nonce);
    expect(c.parseHeader(obj)).toEqual({ version: 1, alg: 1, keyId: 1, nonce });

    const aad = Buffer.concat([
      hdr,
      fromHex("00000000000040008000000000000001"),
      fromHex("00000000000040008000000000000002"),
      fromHex("00000007"),
      Uint8Array.of(1),
    ]);
    const body = obj.subarray(c.HEADER_BYTES);
    const gz = refGcmDecrypt(raw, nonce, aad, body.subarray(0, -16), body.subarray(-16));
    expect(refGunzip(gz)).toEqual(payload);
  });

  for (const [name, change] of [
    ["userId", { userId: "00000000-0000-4000-8000-000000000009" }],
    ["sessionId", { sessionId: "00000000-0000-4000-8000-000000000009" }],
    ["seq", { seq: 8 }],
    ["kind", { kind: "snapshot" }],
  ] as const) {
    test(`moving to another ${name} fails`, async () => {
      const obj = await c.encryptChunk(key, payload, ctx);
      expect(c.decryptChunk(key, obj, { ...ctx, ...change })).rejects.toThrow(DecryptionError);
    });
  }

  test("tampering with the header or body fails", async () => {
    for (const i of [6, 10, c.HEADER_BYTES + 1]) {
      const obj = await c.encryptChunk(key, payload, ctx);
      obj[i]! ^= 1;
      expect(c.decryptChunk(key, obj, ctx)).rejects.toThrow(DecryptionError);
    }
  });

  test("rejects junk, unknown versions and algorithms", async () => {
    expect(() => c.parseHeader(utf8("nope"))).toThrow(DecryptionError);
    const obj = await c.encryptChunk(key, payload, ctx);
    const v = obj.slice();
    v[4] = 2;
    expect(() => c.parseHeader(v)).toThrow(/version/);
    const a = obj.slice();
    a[5] = 9;
    expect(() => c.parseHeader(a)).toThrow(/algorithm/);
  });

  test("validates inputs", async () => {
    expect(c.encryptChunk(key, payload, ctx, new Uint8Array(3))).rejects.toThrow(RangeError);
    expect(c.encryptChunk(key, payload, { ...ctx, kind: "x" as "append" })).rejects.toThrow(TypeError);
    expect(c.encryptChunk(key, payload, { ...ctx, keyId: 256 })).rejects.toThrow(RangeError);
  });

  test("compresses", async () => {
    const big = utf8("x".repeat(100_000));
    expect((await c.encryptChunk(key, big, ctx)).length).toBeLessThan(1000);
  });
});
