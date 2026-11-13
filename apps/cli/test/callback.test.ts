import { describe, expect, test } from "bun:test";
import { startCallbackServer } from "../src/callback.ts";

describe("login callback server", () => {
  test("listens on loopback under a random path", async () => {
    const a = await startCallbackServer();
    const b = await startCallbackServer();
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{22}$/);
    expect(a.url).not.toBe(b.url);
    a.close();
    b.close();
  });

  test("a PKCE code completes it, once", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(`${cb.url}?code=abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signed in");
    expect((await cb.result).searchParams.get("code")).toBe("abc");
    // The server is gone afterwards.
    await new Promise((r) => setTimeout(r, 20));
    await expect(fetch(`${cb.url}?code=again`)).rejects.toThrow();
  });

  test("ignores other paths", async () => {
    const cb = await startCallbackServer();
    const base = new URL(cb.url);
    expect((await fetch(`${base.origin}/callback/guess?code=x`)).status).toBe(404);
    expect((await fetch(`${base.origin}/`)).status).toBe(404);
    cb.close();
    await expect(cb.result).rejects.toThrow("cancelled");
  });

  test("errors from Supabase are shown and passed on", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(`${cb.url}?error=access_denied&error_description=Email+link+is+invalid+or+has+expired`);
    const html = await res.text();
    expect(html).toContain("Sign-in failed");
    expect(html).toContain("Email link is invalid or has expired");
    expect((await cb.result).searchParams.get("error_description")).toBe("Email link is invalid or has expired");
  });

  test("escapes the error it shows", async () => {
    const cb = await startCallbackServer();
    const html = await (await fetch(`${cb.url}?error_description=${encodeURIComponent("<script>x</script>")}`)).text();
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&#60;script&#62;");
    await cb.result;
  });

  test("a session in the fragment comes back through the page's script", async () => {
    const cb = await startCallbackServer();
    const html = await (await fetch(cb.url)).text();
    expect(html).toContain("/fragment?");
    // What the page's script does:
    expect((await fetch(`${cb.url}/fragment?access_token=a.b.c&refresh_token=r`)).status).toBe(405);
    const res = await fetch(`${cb.url}/fragment?access_token=a.b.c&refresh_token=r`, { method: "POST" });
    expect(await res.text()).toBe("Signed in");
    const url = await cb.result;
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("access_token")).toBe("a.b.c");
  });

  test("a failed fragment says so", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(`${cb.url}/fragment?error_description=nope`, { method: "POST" });
    expect(await res.text()).toBe("Sign-in failed");
    await cb.result;
  });

  test("times out", async () => {
    const cb = await startCallbackServer({ timeoutMs: 20 });
    await expect(cb.result).rejects.toThrow("timed out");
  });

  test("fails to start when the host can't be bound", async () => {
    await expect(startCallbackServer({ host: "192.0.2.1" })).rejects.toThrow();
  });
});
