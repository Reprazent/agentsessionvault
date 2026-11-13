import { describe, expect, test } from "bun:test";
import { fromHex } from "../src/bytes.ts";
import * as r from "../src/recovery.ts";

describe("recovery key encoding", () => {
  test("known vector", () => {
    expect(r.encodeBase32(fromHex("00"))).toBe("00");
    expect(r.encodeBase32(fromHex("ff"))).toBe("ZW");
    expect(r.formatRecoveryKey(fromHex("00".repeat(32)))).toBe(Array(13).fill("0000").join("-"));
  });

  test("round trips random keys", () => {
    for (let i = 0; i < 50; i++) {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const s = r.formatRecoveryKey(key);
      expect(s).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(r.parseRecoveryKey(s)).toEqual(key);
    }
  });

  test("treats confusable characters as their digits", () => {
    const key = fromHex("00".repeat(32));
    expect(r.parseRecoveryKey(r.formatRecoveryKey(key).replaceAll("0", "o"))).toEqual(key);
    expect(r.decodeBase32("1G", 1)).toEqual(r.decodeBase32("iG", 1));
    expect(r.decodeBase32("1G", 1)).toEqual(r.decodeBase32("lg", 1));
  });

  test("rejects bad input", () => {
    expect(() => r.parseRecoveryKey("UUUU")).toThrow(r.InvalidRecoveryKeyError);
    expect(() => r.parseRecoveryKey("0000")).toThrow(r.InvalidRecoveryKeyError);
    expect(() => r.parseRecoveryKey("0".repeat(60))).toThrow(r.InvalidRecoveryKeyError);
    expect(() => r.decodeBase32("ZZ", 1)).toThrow(r.InvalidRecoveryKeyError);
    expect(() => r.formatRecoveryKey(new Uint8Array(16))).toThrow(RangeError);
  });

  test("generated passphrases pass the length check", () => {
    const p = r.generatePassphrase();
    expect(p).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);
    expect(p).not.toBe(r.generatePassphrase());
  });
});
