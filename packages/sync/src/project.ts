// Project identity: one project per git remote, or the path relative to
// $HOME when there is none. See "Project identity" in docs/spec.md.

import { execFile } from "node:child_process";
import { basename, isAbsolute, relative, sep } from "node:path";

/** Encrypted in `projects.meta_enc`. */
export interface ProjectMeta {
  identity: string;
  name: string;
}

export interface LocalProject extends ProjectMeta {
  /** Where this project lives on this machine: the git top level, or the cwd itself. */
  root: string;
}

/** What identity resolution needs from git. Injected so tests don't need real repos. */
export interface Git {
  /** `origin`'s URL, or null without git, a repo, an origin, or the directory. */
  remote(cwd: string): Promise<string | null>;
  /** The repo's top level, or null outside a repo. */
  topLevel(cwd: string): Promise<string | null>;
}

function git(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

export const systemGit: Git = {
  remote: (cwd) => git(["-C", cwd, "remote", "get-url", "origin"]),
  topLevel: (cwd) => git(["-C", cwd, "rev-parse", "--show-toplevel"]),
};

/**
 * Normalises a git remote URL to `host/path`, so the ssh, scp-like and https
 * forms of one repo agree. Local remotes (paths, file://) aren't portable
 * across machines, so they give null.
 */
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(u);
  if (u.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:" || !parsed.hostname) return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else if (scp && !isAbsolute(u)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!path) return null;
  return `${host.toLowerCase()}/${path}`;
}

/** The identity of a path without a usable remote: relative to $HOME when inside it. */
export function pathIdentity(cwd: string, home: string): string {
  const rel = relative(home, cwd);
  if (rel === "") return "path:.";
  if (rel.startsWith("..") || isAbsolute(rel)) return `path:${cwd}`;
  return `path:${rel.split(sep).join("/")}`;
}

/** Resolves and caches the project of each cwd. */
export class ProjectResolver {
  private readonly cache = new Map<string, Promise<LocalProject>>();

  constructor(
    private readonly home: string,
    private readonly git: Git = systemGit,
  ) {}

  resolve(cwd: string): Promise<LocalProject> {
    let p = this.cache.get(cwd);
    if (!p) {
      p = this.compute(cwd);
      this.cache.set(cwd, p);
    }
    return p;
  }

  /** Forget cached answers, e.g. after a repo gained a remote. */
  clear(): void {
    this.cache.clear();
  }

  private async compute(cwd: string): Promise<LocalProject> {
    const [url, top] = await Promise.all([this.git.remote(cwd), this.git.topLevel(cwd)]);
    const remote = url ? normalizeRemote(url) : null;
    if (remote) return { identity: remote, name: basename(remote), root: top ?? cwd };
    return { identity: pathIdentity(cwd, this.home), name: basename(cwd) || cwd, root: cwd };
  }
}
