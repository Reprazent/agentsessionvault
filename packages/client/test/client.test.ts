import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuthStorage, jwtSessionId, parseLoginProof } from "../src/index.ts";

const jwt = (claims: object) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("FileAuthStorage", () => {
  test("round-trips items in a 0600 file and removes it when empty", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "asv-auth-")), "nested", "auth.json");
    const s = new FileAuthStorage(path);
    expect(await s.getItem("k")).toBeNull();
    await s.setItem("k", "v");
    await s.setItem("other", "w");
    expect(await s.getItem("k")).toBe("v");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await s.removeItem("k");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: "w" });
    await s.removeItem("other");
    await expect(stat(path)).rejects.toThrow("ENOENT");
  });

  test("a corrupt file is an error, not an empty session", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "asv-auth-")), "auth.json");
    await writeFile(path, "{nope");
    await expect(new FileAuthStorage(path).getItem("k")).rejects.toThrow(SyntaxError);
  });
});

describe("jwtSessionId", () => {
  test("reads the session_id claim", () => {
    expect(jwtSessionId(jwt({ sub: "u", session_id: "s-1" }))).toBe("s-1");
  });
  test("rejects tokens without one", () => {
    expect(() => jwtSessionId("nope")).toThrow("not a JWT");
    expect(() => jwtSessionId(jwt({ sub: "u" }))).toThrow("no session_id");
  });
});

describe("parseLoginProof", () => {
  test("a code", () => {
    expect(parseLoginProof(" 12345678 \n")).toEqual({ kind: "code", code: "12345678" });
    expect(parseLoginProof("123456")).toEqual({ kind: "code", code: "123456" });
  });

  test("the link from the email", () => {
    const link = "https://ref.supabase.co/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=http://localhost:3000";
    expect(parseLoginProof(link)).toEqual({ kind: "token_hash", tokenHash: "pkce_abc123", type: "magiclink" });
    expect(parseLoginProof(link.replace("magiclink", "signup"))).toMatchObject({ type: "signup" });
    expect(parseLoginProof("https://x/verify?token_hash=h&type=email")).toMatchObject({ tokenHash: "h", type: "email" });
    expect(parseLoginProof("https://x/verify?token=h")).toMatchObject({ type: "magiclink" });
  });

  test("the URL the link redirected to", () => {
    expect(parseLoginProof("http://localhost:3000/#access_token=a.b.c&refresh_token=r1&expires_in=3600&type=magiclink")).toEqual({
      kind: "session",
      accessToken: "a.b.c",
      refreshToken: "r1",
    });
  });

  test("a PKCE code in the query", () => {
    expect(parseLoginProof("http://127.0.0.1:5555/callback/n?code=abc")).toEqual({ kind: "auth_code", code: "abc" });
  });

  test("an expired link says so", () => {
    expect(() => parseLoginProof("http://localhost:3000/#error=access_denied&error_description=Email+link+is+invalid+or+has+expired")).toThrow(
      "Email link is invalid or has expired",
    );
  });

  test("anything else", () => {
    expect(() => parseLoginProof("hello")).toThrow("expected the code");
    expect(() => parseLoginProof("https://example.com/")).toThrow("no token, code or session");
  });
});
