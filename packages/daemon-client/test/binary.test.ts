import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, findOnPath, resolveDaemonBinary } from "../src/index.ts";

const BIN = new TextEncoder().encode("#!/bin/sh\necho daemon\n");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A release server: files by path, and a log of what was fetched. */
function releases(files: Record<string, Uint8Array | string>) {
  const fetched: string[] = [];
  const f = (async (url: string) => {
    fetched.push(url);
    const body = files[new URL(url).pathname];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body as BodyInit);
  }) as unknown as typeof fetch;
  return { fetch: f, fetched };
}

const base = { version: "1.2.3", platform: "darwin", arch: "arm64", env: { AGENTSESSIONVAULT_RELEASES_URL: "https://r.test/dl" } };

describe("assetName", () => {
  test("supported and unsupported platforms", () => {
    expect(assetName("linux", "x64")).toBe("agentsessionvault-linux-x64");
    expect(assetName()).toStartWith("agentsessionvault-");
    expect(() => assetName("win32", "x64")).toThrow("no agentsessionvault binary for win32-x64");
    expect(() => assetName("linux", "ia32")).toThrow("linux-ia32");
  });
});

describe("resolveDaemonBinary", () => {
  test("downloads, verifies and keeps the binary for this version", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "asv-bin-"));
    const r = releases({
      "/dl/v1.2.3/SHA256SUMS": `${sha(new Uint8Array([1]))}  agentsessionvault-linux-x64\n${sha(BIN).toUpperCase()} *agentsessionvault-darwin-arm64\n`,
      "/dl/v1.2.3/agentsessionvault-darwin-arm64": BIN,
    });
    const shown: string[] = [];
    const path = await resolveDaemonBinary({ ...base, binDir, fetch: r.fetch, onDownload: (u) => shown.push(u) });
    expect(path).toBe(join(binDir, "1.2.3", "agentsessionvault"));
    expect(new Uint8Array(await readFile(path))).toEqual(BIN);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(shown).toEqual(["https://r.test/dl/v1.2.3/agentsessionvault-darwin-arm64"]);
    expect(await readdir(join(binDir, "1.2.3"))).toEqual(["agentsessionvault"]);
    // Second time: no network.
    expect(await resolveDaemonBinary({ ...base, binDir, fetch: r.fetch })).toBe(path);
    expect(r.fetched).toHaveLength(2);
  });

  test("AGENTSESSIONVAULT_BIN, then a dev build, win without downloading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asv-bin-"));
    const r = releases({});
    expect(await resolveDaemonBinary({ ...base, binDir: dir, fetch: r.fetch, env: { AGENTSESSIONVAULT_BIN: "/x/asv" } })).toBe("/x/asv");
    const dev = join(dir, "dev-asv");
    await writeFile(dev, BIN);
    // Not executable yet: skipped, and the download fails.
    await expect(resolveDaemonBinary({ ...base, binDir: dir, fetch: r.fetch, devBuild: dev, env: { ...base.env, PATH: "" } })).rejects.toThrow("HTTP 404");
    await chmod(dev, 0o755);
    expect(await resolveDaemonBinary({ ...base, binDir: dir, fetch: r.fetch, devBuild: dev })).toBe(dev);
  });

  test("a bad checksum or a missing entry keeps nothing; PATH is the last resort", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "asv-bin-"));
    const bad = releases({ "/dl/v1.2.3/SHA256SUMS": `${"0".repeat(64)}  agentsessionvault-darwin-arm64\n`, "/dl/v1.2.3/agentsessionvault-darwin-arm64": BIN });
    await expect(resolveDaemonBinary({ ...base, binDir, fetch: bad.fetch, env: { ...base.env, PATH: "" } })).rejects.toThrow("checksum mismatch");
    expect(await readdir(binDir).catch(() => [])).toEqual([]);
    const missing = releases({ "/dl/v1.2.3/SHA256SUMS": "abc  agentsessionvault-linux-x64\n" });
    await expect(resolveDaemonBinary({ ...base, binDir, fetch: missing.fetch, env: { ...base.env, PATH: "" } })).rejects.toThrow("isn't in");

    const pathDir = join(binDir, "path");
    await mkdir(pathDir);
    await writeFile(join(pathDir, "agentsessionvault"), BIN, { mode: 0o755 });
    expect(await resolveDaemonBinary({ ...base, binDir, fetch: bad.fetch, env: { ...base.env, PATH: `::${pathDir}` } })).toBe(join(pathDir, "agentsessionvault"));
    // Unsupported platform falls back too.
    expect(await resolveDaemonBinary({ ...base, platform: "win32", binDir, fetch: bad.fetch, env: { ...base.env, PATH: pathDir } })).toBe(join(pathDir, "agentsessionvault"));
  });

  test("the default release URL", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "asv-bin-"));
    const r = releases({});
    await expect(resolveDaemonBinary({ ...base, env: { PATH: "" }, binDir, fetch: r.fetch })).rejects.toThrow("HTTP 404");
    expect(r.fetched).toEqual(["https://github.com/Reprazent/agentsessionvault/releases/download/v1.2.3/SHA256SUMS"]);
  });

  test("findOnPath skips non-executables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asv-bin-"));
    await writeFile(join(dir, "tool"), "");
    expect(findOnPath("tool", dir)).toBeUndefined();
    expect(findOnPath("tool", undefined)).toBeUndefined();
  });
});
