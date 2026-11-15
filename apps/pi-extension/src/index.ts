// agentsessionvault for Pi: a thin client of the daemon. It starts the
// daemon if none is running, keeps a connection open so the daemon stays
// up while Pi does, shows the sync status in the footer, and nudges a push
// when a run settles. Keys and tokens stay in the daemon.

// A relative import, not the workspace package: installed from git, Pi runs
// `npm install` at the repo root, which doesn't link pnpm workspaces.
import { connectOrStart, daemonPaths, resolveDaemonBinary } from "../../../packages/daemon-client/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, type Component, type TUI } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../../package.json" with { type: "json" };
import { type Call, type Ui, login, logout, nextStep, setup, unlock } from "./flows.ts";
import { type View, Vault, describe, statusLine } from "./vault.ts";

const STATUS_KEY = "agentsessionvault";
export const VERSION: string = pkg.version;
/** `pnpm --filter @agentsessionvault/cli build` output, in a checkout. */
const DEV_BUILD = join(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/asv");

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

/** What happens once per Pi process, not once per session (/new, /resume, /reload). */
interface Once {
  offeredUnlock: boolean;
  notedSignedOut: boolean;
  warnedVersion: Set<string>;
}
const ONCE_KEY = Symbol.for("agentsessionvault.pi.once");
export function once(): Once {
  const g = globalThis as { [ONCE_KEY]?: Once };
  return (g[ONCE_KEY] ??= { offeredUnlock: false, notedSignedOut: false, warnedVersion: new Set() });
}

const SUBCOMMANDS = [
  { value: "status", label: "status", description: "Sync status" },
  { value: "login", label: "login", description: "Sign in with an emailed link: /vault login [email]" },
  { value: "setup", label: "setup", description: "First device: create the vault" },
  { value: "unlock", label: "unlock", description: "Unlock this device (--recovery: with the recovery key)" },
  { value: "logout", label: "logout", description: "Sign out on this device" },
  { value: "restart", label: "restart", description: "Restart the daemon, e.g. after an update" },
];

/** A masked single-line input: pi-tui's Input does the editing, this draws bullets. */
export class SecretInput implements Component {
  private readonly input = new Input();
  constructor(
    private readonly title: string,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly style: { accent: (s: string) => string; dim: (s: string) => string },
    done: (value: string | undefined) => void,
  ) {
    this.input.onSubmit = (v) => done(v);
    this.input.onEscape = () => done(undefined);
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const n = [...this.input.getValue()].length;
    return [
      this.style.accent(this.title).slice(0, Math.max(width, 1) * 4),
      `> ${"•".repeat(Math.min(n, Math.max(width - 3, 0)))}█`,
      this.style.dim("enter to submit, esc to cancel"),
    ];
  }
  invalidate(): void {}
}

/** The flows' Ui on top of Pi's. Masked input needs the TUI; elsewhere it's a plain input. */
export function piUi(ctx: ExtensionContext): Ui {
  return {
    notify: (m, t) => ctx.ui.notify(m, t ?? "info"),
    input: (title, placeholder, signal) => ctx.ui.input(title, placeholder, signal ? { signal } : undefined),
    secret: (title) =>
      ctx.mode === "tui"
        ? ctx.ui.custom<string | undefined>((tui, theme, _kb, done) =>
            new SecretInput(title, tui, { accent: (s) => theme.fg("accent", s), dim: (s) => theme.fg("dim", s) }, done),
          )
        : ctx.ui.input(title),
    select: (title, options) => ctx.ui.select(title, options),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    show: async (title, text) => {
      // An editor, so the text can be selected and copied; what comes back is ignored.
      await ctx.ui.editor(`${title} (close when done)`, text);
    },
  };
}

export default function agentsessionvault(pi: ExtensionAPI): void {
  extension(pi);
}

/** The extension, with what tests need to change. */
export function extension(pi: ExtensionAPI, opts: { devBuild?: string } = {}): void {
  let vault: Vault | undefined;
  let ui: ExtensionContext | undefined;
  let seen = 0;
  let busy = false;

  const call: Call = (method, params) => {
    if (!vault) return Promise.reject(new Error("agentsessionvault isn't running in this session."));
    return vault.call(method, params);
  };
  /** One dialog flow at a time; refreshes the footer afterwards. */
  const run = async (ctx: ExtensionContext, f: (ui: Ui) => Promise<unknown>) => {
    if (busy) return ctx.ui.notify("A vault prompt is already open.", "warning");
    busy = true;
    try {
      await f(piUi(ctx));
    } catch (e) {
      ctx.ui.notify((e as Error).message, "error");
    } finally {
      busy = false;
      await vault?.refresh();
    }
  };

  // A daemon (new, or after a restart) answered: say what's off, once per process.
  const onConnected = (v: Extract<View, { state: "connected" }>, ctx: ExtensionContext) => {
    const o = once();
    if (v.hello.version !== VERSION && !o.warnedVersion.has(v.hello.version)) {
      o.warnedVersion.add(v.hello.version);
      ctx.ui.notify(
        `The vault daemon is version ${v.hello.version}, this extension ${VERSION}. /vault restart starts the matching one.`,
        "warning",
      );
    }
    const step = nextStep(v.status);
    if (step === "login" && !o.notedSignedOut) {
      o.notedSignedOut = true;
      ctx.ui.notify("Vault: signed out, sessions don't sync. /vault login to start.", "info");
    } else if (step === "setup" && !o.notedSignedOut) {
      o.notedSignedOut = true;
      ctx.ui.notify("Vault: signed in, no account yet. /vault setup creates it.", "info");
    } else if (step === "unlock" && !o.offeredUnlock && ctx.mode === "tui") {
      o.offeredUnlock = true;
      void run(ctx, (u) => unlock(call, u, { status: v.status }));
    }
  };

  const stop = () => {
    vault?.stop();
    vault = undefined;
  };
  // Not from the factory: Pi also loads extensions for runs without a session.
  pi.on("session_start", async (_event, ctx) => {
    ui = ctx;
    if (vault) return;
    seen = 0;
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
        if (!ui?.hasUI) return;
        ui.ui.setStatus(STATUS_KEY, statusLine(v));
        if (v.state === "connected" && vault && vault.connections !== seen) {
          seen = vault.connections;
          onConnected(v, ui);
        }
      },
    });
    vault.start();
  });

  // Also on /new, /resume, fork and reload: the runtime, and on reload this
  // extension, is recreated. The daemon outlives the gap (it waits 5s).
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
    description: "agentsessionvault: sync status, login, setup, unlock, logout, restart",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.trim()));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (!vault) return ctx.ui.notify("agentsessionvault isn't running in this session.", "warning");
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const v = vault;
      switch (sub) {
        case "status":
          await v.refresh();
          return ctx.ui.notify(describe(v.view), v.view.state === "connected" ? "info" : "warning");
        case "login":
          return run(ctx, (u) => login(call, u, rest[0]));
        case "setup":
          return run(ctx, (u) => setup(call, u));
        case "unlock":
          return run(ctx, (u) => unlock(call, u, { recovery: rest.includes("--recovery") || rest.includes("recovery") }));
        case "logout":
          return run(ctx, (u) => logout(call, u));
        case "restart":
          return run(ctx, (u) => restart(v, u));
        default:
          return ctx.ui.notify(`Unknown: /vault ${sub}. Try ${SUBCOMMANDS.map((c) => c.value).join(", ")}.`, "warning");
      }
    },
  });
}

/**
 * Stops the running daemon (SIGTERM: it flushes pushes first) and waits for
 * the reconnect, which starts this extension's version. Keys are gone after
 * that, so it offers to unlock again.
 */
export async function restart(v: Vault, ui: Ui, timeoutMs = 15_000): Promise<void> {
  if (v.view.state !== "connected") throw new Error("not connected to the vault daemon");
  const old = v.view.hello;
  const before = v.connections;
  if (!(await ui.confirm("Restart the vault daemon?", `Stops daemon ${old.version} (pid ${old.pid}) for all Pi windows. You'll unlock again.`))) return;
  process.kill(old.pid, "SIGTERM");
  const end = Date.now() + timeoutMs;
  while (!(v.view.state === "connected" && v.connections > before)) {
    if (Date.now() > end) throw new Error("the daemon didn't come back; see ~/.local/share/agentsessionvault/daemon.log");
    await new Promise((r) => setTimeout(r, 100));
  }
  const now = v.view;
  ui.notify(`Daemon ${now.hello.version} running (pid ${now.hello.pid}).`);
  if (nextStep(now.status) === "unlock") await unlock((m, p) => v.call(m, p), ui, { status: now.status });
}
