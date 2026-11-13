import { type SupportedStorage } from "@supabase/supabase-js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Supabase Auth's storage, as a 0600 JSON file. Holds the session (access and
 * refresh token). A bearer credential, not a key: it only gets you ciphertext,
 * and revoking the device kills it.
 */
export class FileAuthStorage implements SupportedStorage {
  constructor(private readonly path: string) {}

  private async all(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async write(data: Record<string, string>): Promise<void> {
    if (Object.keys(data).length === 0) return rm(this.path, { force: true });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async getItem(key: string) {
    return (await this.all())[key] ?? null;
  }

  async setItem(key: string, value: string) {
    await this.write({ ...(await this.all()), [key]: value });
  }

  async removeItem(key: string) {
    const { [key]: _, ...rest } = await this.all();
    await this.write(rest);
  }
}

export class RevokedDeviceError extends Error {
  override name = "RevokedDeviceError";
  constructor() {
    super("this sign-in belongs to a revoked device; run `agentsessionvault login` again");
  }
}

export class NotSignedInError extends Error {
  override name = "NotSignedInError";
  constructor() {
    super("not signed in; run `agentsessionvault login`");
  }
}

/** The JWT's session_id claim, which ties a device row to this sign-in. */
export function jwtSessionId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) throw new TypeError("not a JWT");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { session_id?: unknown };
  if (typeof claims.session_id !== "string") throw new TypeError("JWT has no session_id claim");
  return claims.session_id;
}

/**
 * What a user pastes after `login`: the emailed code, the link from the email
 * (copied, not clicked), or the URL the link redirected to.
 */
export type LoginProof =
  | { kind: "code"; code: string }
  | { kind: "token_hash"; tokenHash: string; type: "magiclink" | "signup" | "email" }
  | { kind: "session"; accessToken: string; refreshToken: string }
  | { kind: "auth_code"; code: string };

export function parseLoginProof(input: string): LoginProof {
  const s = input.trim();
  if (/^\d{6,10}$/.test(s)) return { kind: "code", code: s };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new TypeError("expected the code, or the link from the email");
  }
  const frag = new URLSearchParams(url.hash.replace(/^#/, ""));
  const accessToken = frag.get("access_token");
  const refreshToken = frag.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
  const error = frag.get("error_description") ?? url.searchParams.get("error_description");
  if (error) throw new TypeError(`the link didn't work: ${error}`);
  const token = url.searchParams.get("token") ?? url.searchParams.get("token_hash");
  if (token) {
    const t = url.searchParams.get("type");
    return { kind: "token_hash", tokenHash: token, type: t === "signup" || t === "email" ? t : "magiclink" };
  }
  const code = url.searchParams.get("code");
  if (code) return { kind: "auth_code", code };
  throw new TypeError("that link has no token, code or session");
}

