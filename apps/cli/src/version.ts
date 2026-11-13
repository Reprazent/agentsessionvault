import pkg from "../../../package.json" with { type: "json" };

/**
 * One version for the repo, from the root package.json. Releases are tagged
 * v<version>; harness clients download the daemon of their own version and
 * compare it with what a running daemon reports.
 */
export const VERSION: string = pkg.version;
