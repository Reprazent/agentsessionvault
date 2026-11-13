import { describe, expect, test } from "bun:test";
import * as a from "../src/account.ts";
import { DecryptionError } from "../src/envelope.ts";
import { formatRecoveryKey } from "../src/recovery.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const pass = "a perfectly fine passphrase";

describe("account keys", async () => {
  const { row, accountKey, recoveryKey } = await a.createAccount(userId, pass);

  test("row shape and defaults", () => {
    expect(row.kdf.alg).toBe("pbkdf2-sha256");
    expect(row.kdf.iterations).toBe(600_000);
    expect(row.account_key_version).toBe(1);
    expect(row.account_key_by_pass.key_id).toBe("account-key-v1");
    expect(JSON.stringify(row)).not.toContain(pass);
  });

  test("unlocks with the passphrase", async () => {
    expect(await a.unlockWithPassphrase(userId, row, pass)).toEqual(accountKey);
  });

  test("unlocks with the formatted recovery key, forgivingly", async () => {
    const formatted = formatRecoveryKey(recoveryKey);
    expect(await a.unlockWithRecoveryKey(userId, row, formatted)).toEqual(accountKey);
    expect(await a.unlockWithRecoveryKey(userId, row, formatted.toLowerCase().replaceAll("-", " "))).toEqual(accountKey);
  });

  test("wrong secrets fail", async () => {
    expect(a.unlockWithPassphrase(userId, row, pass + "!")).rejects.toThrow(DecryptionError);
    expect(a.unlockWithRecoveryKey(userId, row, formatRecoveryKey(new Uint8Array(32)))).rejects.toThrow(DecryptionError);
  });

  test("a row copied to another user does not unlock", async () => {
    expect(a.unlockWithPassphrase("00000000-0000-4000-8000-000000000002", row, pass)).rejects.toThrow(DecryptionError);
  });

  test("the passphrase copy cannot be swapped with the recovery copy", async () => {
    const swapped = { ...row, account_key_by_pass: row.account_key_by_recovery };
    expect(a.unlockWithPassphrase(userId, swapped, pass)).rejects.toThrow(DecryptionError);
  });

  test("weak passphrases and unknown KDFs are refused", async () => {
    expect(a.createAccount(userId, "too short")).rejects.toThrow(a.WeakPassphraseError);
    expect(() => a.checkPassphrase("\u{1F600}".repeat(15))).toThrow(a.WeakPassphraseError);
    const odd = { ...row, kdf: { ...row.kdf, alg: "md5" as "pbkdf2-sha256" } };
    expect(a.unlockWithPassphrase(userId, odd, pass)).rejects.toThrow(TypeError);
  });

  test("changing the passphrase keeps the account key and recovery copy", async () => {
    const next = await a.changePassphrase(userId, row, accountKey, "another fine passphrase");
    expect(next.kdf.salt).not.toBe(row.kdf.salt);
    expect(next.account_key_by_recovery).toEqual(row.account_key_by_recovery);
    expect(await a.unlockWithPassphrase(userId, next, "another fine passphrase")).toEqual(accountKey);
    expect(a.unlockWithPassphrase(userId, next, pass)).rejects.toThrow(DecryptionError);
    expect(a.changePassphrase(userId, row, accountKey, "short")).rejects.toThrow(a.WeakPassphraseError);
  });
});
