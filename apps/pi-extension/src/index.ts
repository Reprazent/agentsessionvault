// agentsessionvault for Pi: a thin client of the daemon. It starts the
// daemon if none is running, keeps a connection open so the daemon stays
// up while Pi does, shows the sync status in the footer, and nudges a push
// when a run settles. Keys and tokens stay in the daemon.

// A relative import, not the workspace package: installed from git, Pi runs
// `npm install` at the repo root, which doesn't link pnpm workspaces.
import { connectOrStart, daemonPaths, resolveDaemonBinary } from "../../../packages/daemon-client/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../../package.json" with { type: "json" };
import { Vault, describe, statusLine } from "./vault.ts";

const STATUS_KEY = "agentsessionvault";
export const VERSION: string = pkg.version;
/** `pnpm --filter @agentsessionvault/cli build` output, in a checkout. */
const DEV_BUILD = join(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/agentsessionvault");

/**
 * The daemon command: AGENTSESSIONVAULT_BIN, a build in this checkout, or the
 * release binary for this version, downloaded to <state>/bin/<version>/.
 */
export async function daemonCommand(
  env: Record<string, string | undefined> = process.env,
  onDownload?: (url: string) => void,
  devBuild: string = DEV_BUILD,
): Promise<string[]> {
  const bin = await resolveDaemonBinary({
    version: VERSION,
    binDir: join(daemonPaths(env).stateDir, "bin"),
    devBuild,
    env,
    ...(onDownload ? { onDownload } : {}),
  });
  return [bin, "daemon", "--idle-exit"];
}

export default function agentsessionvault(pi: ExtensionAPI): void {
  extension(pi);
}

/** The extension, with what tests need to change. */
export function extension(pi: ExtensionAPI, opts: { devBuild?: string } = {}): void {
  let vault: Vault | undefined;
  let ui: ExtensionContext | undefined;

  const stop = () => {
    vault?.stop();
    vault = undefined;
  };
  // Not from the factory: Pi also loads extensions for runs without a session.
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx;
    if (vault) return;
    const paths = daemonPaths();
    vault = new Vault({
      connect: async () => {
        // Only resolved (and maybe downloaded) when no daemon answers.
        const command = () =>
          daemonCommand(
            process.env,
            () => {
              if (ui?.hasUI) ui.ui.setStatus(STATUS_KEY, "vault: downloading daemon");
            },
            opts.devBuild,
          );
        return (await connectOrStart({ socketPath: paths.socketPath, logFile: paths.logFile, command })).client;
      },
      onChange: (v) => {
        if (ui?.hasUI) ui.ui.setStatus(STATUS_KEY, statusLine(v));
      },
    });
    vault.start();
  });

  // Also on /new, /resume, fork and reload: the runtime, and on reload this
  // extension, is recreated. The daemon outlives the gap (it waits 30s).
  pi.on("session_shutdown", async () => {
    stop();
    ui = undefined;
  });

  // A run is over: push this session now instead of after the debounce.
  pi.on("agent_settled", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const v = vault;
    if (!v || !file || v.view.state !== "connected" || !v.view.status.unlocked) return;
    await v.call("nudge", { path: file }).catch(() => {});
    await v.refresh();
  });

  pi.registerCommand("vault", {
    description: "agentsessionvault: sync status",
    handler: async (_args, ctx) => {
      if (!vault) return ctx.ui.notify("agentsessionvault isn't running in this session.", "warning");
      await vault.refresh();
      ctx.ui.notify(describe(vault.view), vault.view.state === "connected" ? "info" : "warning");
    },
  });
}
