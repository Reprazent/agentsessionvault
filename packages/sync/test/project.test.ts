import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectResolver, normalizeRemote, pathIdentity, systemGit } from "../src/index.ts";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:Acme/App.git", "github.com/Acme/App"],
    ["github.com:acme/app", "github.com/acme/app"],
    ["ssh://git@github.com/acme/app.git", "github.com/acme/app"],
    ["ssh://git@GitHub.com:2222/acme/app/", "github.com/acme/app"],
    ["https://github.com/acme/app", "github.com/acme/app"],
    ["https://user:token@github.com/acme/app.git/", "github.com/acme/app"],
    ["https://gitlab.com/group/sub/project.git", "gitlab.com/group/sub/project"],
    ["git://example.org/a%20b.git", "example.org/a b"],
  ])("%s", (url, want) => {
    expect(normalizeRemote(url)).toBe(want);
  });

  test.each(["/srv/git/app.git", "../app", "file:///srv/git/app.git", "https://", "https://github.com/", "git@github.com:", "nonsense"])(
    "%s is not portable",
    (url) => {
      expect(normalizeRemote(url)).toBeNull();
    },
  );
});

describe("pathIdentity", () => {
  test("relative to home, the home itself, and outside it", () => {
    expect(pathIdentity("/home/me/repos/x", "/home/me")).toBe("path:repos/x");
    expect(pathIdentity("/home/me", "/home/me")).toBe("path:.");
    expect(pathIdentity("/srv/x", "/home/me")).toBe("path:/srv/x");
    expect(pathIdentity("/home/meadow", "/home/me")).toBe("path:/home/meadow");
  });
});

describe("ProjectResolver", () => {
  test("caches per cwd until cleared", async () => {
    let calls = 0;
    const r = new ProjectResolver("/home/me", {
      remote: async () => (++calls, "git@github.com:a/b.git"),
      topLevel: async () => "/home/me/b",
    });
    expect(await r.resolve("/home/me/b/src")).toEqual({ identity: "github.com/a/b", name: "b", root: "/home/me/b" });
    await r.resolve("/home/me/b/src");
    expect(calls).toBe(1);
    r.clear();
    await r.resolve("/home/me/b/src");
    expect(calls).toBe(2);
  });

  test("a local-only remote falls back to the path; root falls back to the cwd", async () => {
    const r = new ProjectResolver("/home/me", { remote: async () => "/srv/app.git", topLevel: async () => null });
    expect(await r.resolve("/")).toEqual({ identity: "path:/", name: "/", root: "/" });
  });

  test("with real git", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "asv-git-")));
    const sub = join(dir, "sub");
    await mkdir(sub);
    expect(await systemGit.remote(sub)).toBeNull();
    expect(await systemGit.topLevel(join(dir, "missing"))).toBeNull();
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    expect(await new ProjectResolver(dir).resolve(sub)).toEqual({ identity: "github.com/acme/app", name: "app", root: dir });
  });
});
