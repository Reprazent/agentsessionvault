// agentsessionvault for Pi: a thin client of the daemon. It starts the
// daemon if none is running, keeps a connection open so the daemon stays
// up while Pi does, shows the sync status in the footer, and nudges a push
// when a run settles. Keys and tokens stay in the daemon.

import { connectOrStart, daemonPaths } from "@agentsessionvault/daemon-client";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Vault, describe, statusLine } from "./vault.ts";

const STATUS_KEY = "agentsessionvault";

/** The daemon command; AGENTSESSIONVAULT_BIN overrides the binary, e.g. for development. */
export function daemonCommand(env: Record<string, string | undefined> = process.env): string[] {
  return [env.AGENTSESSIONVAULT_BIN || "agentsessionvault", "daemon", "--idle-exit"];
}

export default function agentsessionvault(pi: ExtensionAPI): void {
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
      connect: async () =>
        (await connectOrStart({ socketPath: paths.socketPath, logFile: paths.logFile, command: daemonCommand() })).client,
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
