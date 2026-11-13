import { type Bytes, fromBase64, randomBytes, toBase64 } from "./bytes.ts";
import { type Envelope, open, seal } from "./envelope.ts";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  type KdfParams,
  KEY_BYTES,
  MIN_PASSPHRASE_LENGTH,
  Purpose,
  SALT_BYTES,
  deriveAesKey,
  derivePassphraseKey,
  generateKey,
} from "./keys.ts";
import { parseRecoveryKey } from "./recovery.ts";

/** Columns of the accounts row that carry key material. */
export interface AccountKeys {
  kdf: KdfParams;
  account_key_by_pass: Envelope;
  account_key_by_recovery: Envelope;
  account_key_version: number;
}

export class WeakPassphraseError extends Error {
  override name = "WeakPassphraseError";
}

export function checkPassphrase(passphrase: string): void {
  if ([...passphrase.normalize("NFC")].length < MIN_PASSPHRASE_LENGTH) {
    throw new WeakPassphraseError(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

const passField = "accounts.account_key_by_pass";
const recoveryField = "accounts.account_key_by_recovery";
const keyId = (version: number) => `account-key-v${version}`;

async function wrapWith(
  secret: Uint8Array,
  accountKey: Uint8Array,
  userId: string,
  field: string,
  version: number,
): Promise<Envelope> {
  const k = await deriveAesKey(secret, Purpose.wrapAccountKey);
  return seal(k, accountKey, { userId, rowId: userId, field, keyId: keyId(version) });
}

/**
 * First-device setup. Creates the account key and both wrapped copies.
 * Returns the raw account key (keep in memory only) and the recovery key
 * bytes (show once, then drop).
 */
export async function createAccount(
  userId: string,
  passphrase: string,
  opts: { iterations?: number } = {},
): Promise<{ row: AccountKeys; accountKey: Bytes; recoveryKey: Bytes }> {
  checkPassphrase(passphrase);
  const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const accountKey = generateKey();
  const recoveryKey = generateKey();
  const passKey = await derivePassphraseKey(passphrase, salt, iterations);
  const version = 1;
  return {
    accountKey,
    recoveryKey,
    row: {
      kdf: { alg: "pbkdf2-sha256", iterations, salt: toBase64(salt) },
      account_key_by_pass: await wrapWith(passKey, accountKey, userId, passField, version),
      account_key_by_recovery: await wrapWith(recoveryKey, accountKey, userId, recoveryField, version),
      account_key_version: version,
    },
  };
}

async function unwrap(secret: Uint8Array, env: Envelope, userId: string, field: string): Promise<Bytes> {
  const k = await deriveAesKey(secret, Purpose.wrapAccountKey);
  const key = await open(k, env, { userId, rowId: userId, field });
  if (key.length !== KEY_BYTES) throw new RangeError("account key has wrong length");
  return key;
}

export async function unlockWithPassphrase(userId: string, row: AccountKeys, passphrase: string): Promise<Bytes> {
  if (row.kdf.alg !== "pbkdf2-sha256") throw new TypeError(`unsupported kdf ${String(row.kdf.alg)}`);
  const passKey = await derivePassphraseKey(passphrase, fromBase64(row.kdf.salt), row.kdf.iterations);
  return unwrap(passKey, row.account_key_by_pass, userId, passField);
}

export async function unlockWithRecoveryKey(userId: string, row: AccountKeys, recoveryKey: string): Promise<Bytes> {
  return unwrap(parseRecoveryKey(recoveryKey), row.account_key_by_recovery, userId, recoveryField);
}

/** New passphrase (and fresh salt); the account key and recovery copy stay. */
export async function changePassphrase(
  userId: string,
  row: AccountKeys,
  accountKey: Uint8Array,
  newPassphrase: string,
  opts: { iterations?: number } = {},
): Promise<AccountKeys> {
  checkPassphrase(newPassphrase);
  const iterations = opts.iterations ?? Math.max(row.kdf.iterations, DEFAULT_PBKDF2_ITERATIONS);
  const salt = randomBytes(SALT_BYTES);
  const passKey = await derivePassphraseKey(newPassphrase, salt, iterations);
  return {
    ...row,
    kdf: { alg: "pbkdf2-sha256", iterations, salt: toBase64(salt) },
    account_key_by_pass: await wrapWith(passKey, accountKey, userId, passField, row.account_key_version),
  };
}
