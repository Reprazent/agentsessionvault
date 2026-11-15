// Assembles the npm package in dist/npm/, which semantic-release publishes
// (pkgRoot). The repo root stays the git/local Pi package that loads the
// TypeScript sources; the npm package ships bundled JavaScript instead, so it
// doesn't need the workspace layout.
//
// One package serves every agent: Pi reads the `pi` key; other agents get
// their own entry points under `exports` as they're added.
// Usage: bun scripts/build-npm.ts

import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "npm");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Pi provides these at runtime; bundling a copy breaks its module mapping.
const HOST = ["@earendil-works/*", "typebox"];

const result = await Bun.build({
  entrypoints: [join(root, "apps/pi-extension/src/index.ts")],
  outdir: out,
  naming: "pi.js",
  target: "node",
  format: "esm",
  external: HOST,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  keywords: pkg.keywords,
  license: "UNLICENSED",
  type: "module",
  repository: { type: "git", url: "git+https://github.com/Reprazent/agentsessionvault.git" },
  homepage: "https://github.com/Reprazent/agentsessionvault#readme",
  exports: { "./pi": "./pi.js" },
  files: ["pi.js", "README.md", "CHANGELOG.md"],
  pi: { extensions: ["./pi.js"] },
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: Object.fromEntries(
    Object.keys(pkg.peerDependencies).map((name) => [name, { optional: true }]),
  ),
};
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const file of ["README.md", "CHANGELOG.md"]) {
  if (existsSync(join(root, file))) await copyFile(join(root, file), join(out, file));
}
console.log(`built ${pkg.name}@${pkg.version} into ${out}`);
