// Builds the daemon binaries a release carries, plus SHA256SUMS, into
// dist/release/. The Pi extension downloads these by version:
//   <releases>/v<version>/agentsessionvault-<os>-<arch>
// Usage: bun scripts/build-release.ts [--tag v1.2.3]  (checks the tag matches)

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };

const TARGETS = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
] as const;

const { values } = parseArgs({ options: { tag: { type: "string" } } });
if (values.tag && values.tag !== `v${pkg.version}`) {
  console.error(`tag ${values.tag} doesn't match package.json version ${pkg.version}`);
  process.exit(1);
}

const out = join(import.meta.dir, "..", "dist", "release");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const sums: string[] = [];
for (const [os, arch] of TARGETS) {
  const name = `agentsessionvault-${os}-${arch}`;
  const file = join(out, name);
  const r = Bun.spawnSync(
    ["bun", "build", "--compile", "--minify", `--target=bun-${os}-${arch}`, "apps/cli/src/main.ts", "--outfile", file],
    { cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  sums.push(`${createHash("sha256").update(await readFile(file)).digest("hex")}  ${name}`);
}
await writeFile(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`built v${pkg.version} into ${out}`);
