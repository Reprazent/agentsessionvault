// Finding the daemon binary for a harness client, downloading it if needed.
// Releases carry one binary per platform plus SHA256SUMS; the client fetches
// the one matching its own version, so the extension and the daemon it
// starts always come from the same release.

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const RELEASES_URL = "https://github.com/Reprazent/agentsessionvault/releases/download";

/** The release asset name for a platform, e.g. asv-darwin-arm64. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    throw new Error(`no asv binary for ${platform}-${arch}`);
  }
  return `asv-${platform}-${arch}`;
}

export interface ResolveOptions {
  /** The client's version; picks the release `v<version>`. */
  version: string;
  /** Where downloaded binaries live, one directory per version. */
  binDir: string;
  /** A development build to prefer when it exists, e.g. apps/cli/dist/asv in a checkout. */
  devBuild?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** Called before a download starts, e.g. to show it. */
  onDownload?: (url: string) => void;
}

/**
 * The daemon binary to run, in order: AGENTSESSIONVAULT_BIN, a development
 * build, a downloaded binary for this version (downloading it now if
 * missing), or `asv` on the PATH if the download fails.
 */
export async function resolveDaemonBinary(o: ResolveOptions): Promise<string> {
  const env = o.env ?? process.env;
  if (env.AGENTSESSIONVAULT_BIN) return env.AGENTSESSIONVAULT_BIN;
  if (o.devBuild && isExecutable(o.devBuild)) return o.devBuild;
  const target = join(o.binDir, o.version, "asv");
  if (isExecutable(target)) return target;
  try {
    await download({ ...o, target, baseUrl: env.AGENTSESSIONVAULT_RELEASES_URL || RELEASES_URL });
    return target;
  } catch (e) {
    const onPath = findOnPath("asv", env.PATH);
    if (onPath) return onPath;
    throw e;
  }
}

async function download(o: ResolveOptions & { target: string; baseUrl: string }): Promise<void> {
  const name = assetName(o.platform, o.arch);
  const base = `${o.baseUrl}/v${o.version}`;
  const get = o.fetch ?? fetch;
  const fetchOk = async (url: string) => {
    const res = await get(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`couldn't download ${url}: HTTP ${res.status}`);
    return res;
  };
  const sums = await (await fetchOk(`${base}/SHA256SUMS`)).text();
  const want = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file === name || file === `*${name}`)?.[0];
  if (!want) throw new Error(`${name} isn't in ${base}/SHA256SUMS`);
  o.onDownload?.(`${base}/${name}`);
  const bin = new Uint8Array(await (await fetchOk(`${base}/${name}`)).arrayBuffer());
  const got = createHash("sha256").update(bin).digest("hex");
  if (got !== want.toLowerCase()) throw new Error(`checksum mismatch for ${name}: expected ${want}, got ${got}`);
  await mkdir(join(o.target, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${o.target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, bin, { mode: 0o700 });
    await chmod(tmp, 0o700);
    await rename(tmp, o.target);
  } finally {
    await rm(tmp, { force: true });
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(cmd: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p) && isExecutable(p)) return p;
  }
  return undefined;
}
