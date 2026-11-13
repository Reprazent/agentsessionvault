import { describe, expect, test } from "bun:test";
import * as b from "../src/bytes.ts";

describe("bytes", () => {
  test("hex round trip and validation", () => {
    expect(b.toHex(b.fromHex("00ff10"))).toBe("00ff10");
    expect(() => b.fromHex("abc")).toThrow();
    expect(() => b.fromHex("zz")).toThrow();
  });

  test("base64 round trip and validation", () => {
    const x = b.randomBytes(33);
    expect(b.fromBase64(b.toBase64(x))).toEqual(x);
    expect(() => b.fromBase64("!!!")).toThrow(TypeError);
  });

  test("integers are range checked", () => {
    expect(b.u32(0x01020304)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(() => b.u32(-1)).toThrow(RangeError);
    expect(() => b.u32(2 ** 32)).toThrow(RangeError);
    expect(() => b.u8(256)).toThrow(RangeError);
    expect(() => b.u8(1.5)).toThrow(RangeError);
  });

  test("uuidBytes", () => {
    expect(b.toHex(b.uuidBytes("01234567-89AB-cdef-0123-456789abcdef"))).toBe("0123456789abcdef0123456789abcdef");
    expect(() => b.uuidBytes("nope")).toThrow(TypeError);
  });

  test("encodeAad is length-prefixed and unambiguous", () => {
    expect(b.toHex(b.encodeAad(["ab", 1, Uint8Array.of(9)]))).toBe("0000000261620000000400000001" + "0000000109");
    expect(b.encodeAad(["ab", "c"])).not.toEqual(b.encodeAad(["a", "bc"]));
  });

  test("equal", () => {
    expect(b.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(b.equal(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(b.equal(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });
});
