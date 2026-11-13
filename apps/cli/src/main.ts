#!/usr/bin/env bun
// CLI entry point and process plumbing. The logic lives in service.ts,
// daemon.ts and protocol.ts; this file is exercised by hand and excluded
// from unit coverage in bunfig.toml.
import { parseArgs } from "node:util";
import { type Config, loadConfig } from "./config.ts";
import { handlers, unlockAtStart } from "./daemon.ts";
import { prompt } from "./prompt.ts";
import { DaemonClient, serve } from "./protocol.ts";
import { type DeviceInfo, type Status, VaultService } from "./service.ts";
import type { ProjectSummary, PullResult, PushResult, SessionSummary } from "@agentsessionvault/sync";
import { resolve } from "node:path";

const USAGE = `agentsessionvault: end-to-end encrypted sync for agent sessions

Usage:
  agentsessionvault daemon                  run the daemon in the foreground
  agentsessionvault login [email] [--paste] sign in via the emailed link (--paste: no local server)
  agentsessionvault setup [--generate]      first device: create the account
  agentsessionvault unlock [--recovery]     unlock this device
  agentsessionvault passphrase [--recovery] [--generate]
                                            set a new passphrase
  agentsessionvault status
  agentsessionvault push <session.jsonl>    push a Pi session file
  agentsessionvault pull <session-id> [--out <path>]
  agentsessionvault sessions [--json]
  agentsessionvault projects [--json]
  agentsessionvault map <project> [dir]     sessions of a project go to dir (default: here)
  agentsessionvault devices [--json]
  agentsessionvault devices revoke <device-id>
  agentsessionvault logout

Every command except daemon talks to a running daemon.
`;

/** `agentsessionvault daemon`: runs in the foreground until stopped. */
async function runDaemon(cfg: Config): Promise<never> {
  const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const svc = new VaultService(cfg, undefined, { log });
  await svc.init();
  const server = await serve(cfg.socketPath, handlers(svc, log), log);
  log(`listening on ${cfg.socketPath}`);
  const stop = async () => {
    log("stopping");
    await server.close();
    await svc.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await unlockAtStart(svc, log, {
    env: process.env,
    isTTY: !!process.stdin.isTTY,
    prompt: (q) => prompt(q, { hidden: true }),
  });
  return new Promise<never>(() => {});
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

async function withDaemon<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> {
  const c = await DaemonClient.connect(loadConfig().socketPath);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

function printStatus(s: Status) {
  if (!s.signedIn) return out(s.pendingLogin ? `signed out (waiting for the code sent to ${s.pendingLogin})` : "signed out");
  out(`signed in as ${s.email}`);
  if (!s.account) return out("no account yet: run `agentsessionvault setup`");
  out(s.unlocked ? `unlocked, device ${s.deviceId} (${s.deviceName})` : "locked: run `agentsessionvault unlock`");
  if (s.sync) {
    out(`auto-push: ${s.sync.watching ? "on" : "off"}, ${s.sync.pending} pending${s.sync.lastPush ? `, last ${s.sync.lastPush.at}` : ""}`);
    if (s.sync.lastError) out(`  last error ${s.sync.lastError.at}: ${s.sync.lastError.message}`);
  }
}

async function newPassphrase(): Promise<string> {
  err("Choose a passphrase of at least 16 characters. It never leaves this machine,");
  err("and nobody can reset it for you. `setup --generate` makes one up instead.");
  for (;;) {
    const a = await prompt("Passphrase: ", { hidden: true });
    if (a.length < 16) {
      err("That's under 16 characters.");
      continue;
    }
    if ((await prompt("Again: ", { hidden: true })) === a) return a;
    err("Those didn't match.");
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      generate: { type: "boolean" },
      recovery: { type: "boolean" },
      out: { type: "string", short: "o" },
      json: { type: "boolean" },
      paste: { type: "boolean" },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    out(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  switch (cmd) {
    case "daemon":
      await runDaemon(loadConfig());
      return 0;

    case "status":
      return withDaemon(async (c) => (printStatus(await c.call<Status>("status")), 0));

    case "login":
      return withDaemon(async (c) => {
        const email = args[0] ?? (await prompt("Email: "));
        const { email: sent, callback } = await c.call<{ email: string; callback: boolean }>("login", {
          email,
          callback: !values.paste,
        });
        err(`Sent a sign-in email to ${sent}.`);
        if (callback) {
          err("Open the link in a browser on this machine and you're done.");
          err("If you've opened this elsewhere, copy the link from the email and paste it here.");
        } else {
          err("Paste the code, or the link from the email (copy it, don't click it).");
          err("If you already clicked it, paste the address of the page it opened.");
        }
        const viaBrowser = callback
          ? c.call<Status>("waitLogin").then(
              (s) => ({ s }),
              (e: Error) => ({ e }),
            )
          : new Promise<never>(() => {});
        const viaPaste = (async () => {
          for (let attempt = 1; ; attempt++) {
            const input = await prompt("Code or link: ");
            try {
              return { s: await c.call<Status>("verify", { input, email: sent }) };
            } catch (e) {
              err(`That didn't work: ${(e as Error).message}`);
              if (attempt >= 3) return { e: e as Error };
            }
          }
        })().catch((e: Error) => ({ e }));
        const r: { s?: Status; e?: Error } = await Promise.race([viaBrowser, viaPaste]);
        if (r.e) {
          err(`\nerror: ${r.e.message}`);
          return 1;
        }
        if (callback) err("");
        printStatus(r.s!);
        return 0;
      });

    case "setup":
      return withDaemon(async (c) => {
        const st = await c.call<Status>("status");
        if (!st.signedIn) throw new Error("not signed in; run `agentsessionvault login` first");
        if (st.account) throw new Error("an account already exists; run `agentsessionvault unlock`");
        const params = values.generate ? { generate: true } : { passphrase: await newPassphrase() };
        err("Creating the account (this takes a second)...");
        const r = await c.call<{ recoveryKey: string; passphrase?: string }>("setup", params);
        if (r.passphrase) {
          out("\nYour passphrase (store it in your password manager):\n");
          out(`    ${r.passphrase}\n`);
        }
        out("\nYour recovery key. It's shown once. Store it somewhere other than the passphrase:\n");
        out(`    ${r.recoveryKey}\n`);
        out("Without the passphrase or this key, nobody can decrypt your sessions, including you.");
        return 0;
      });

    case "unlock":
      return withDaemon(async (c) => {
        const params = values.recovery
          ? { recoveryKey: await prompt("Recovery key: ", { hidden: true }) }
          : { passphrase: await prompt("Passphrase: ", { hidden: true }) };
        printStatus(await c.call<Status>("unlock", params));
        return 0;
      });

    case "passphrase":
      return withDaemon(async (c) => {
        const st = await c.call<Status>("status");
        if (!st.unlocked) throw new Error("unlock first: `agentsessionvault unlock` (or `unlock --recovery` if you forgot it)");
        const proof = values.recovery
          ? { recoveryKey: await prompt("Recovery key: ", { hidden: true }) }
          : { current: await prompt("Current passphrase: ", { hidden: true }) };
        const next = values.generate ? { generate: true } : { passphrase: await newPassphrase() };
        err("Changing the passphrase (this takes a second)...");
        const r = await c.call<{ passphrase?: string }>("passphrase", { ...proof, ...next });
        if (r.passphrase) {
          out("\nYour new passphrase (store it in your password manager):\n");
          out(`    ${r.passphrase}\n`);
        }
        out("Passphrase changed. Other devices need it the next time they unlock. The recovery key is unchanged.");
        return 0;
      });

    case "push": {
      const path = args[0];
      if (!path) throw new TypeError("usage: agentsessionvault push <session.jsonl>");
      return withDaemon(async (c) => {
        const r = await c.call<PushResult>("push", { path: (await import("node:path")).resolve(path) });
        const bytes = r.chunks.reduce((n, ch) => n + ch.size, 0);
        out(
          r.chunks.length
            ? `${r.sessionId}: pushed ${r.chunks.length} chunk(s), ${bytes} bytes, now at seq ${r.chunks.at(-1)!.seq}${r.created ? " (new)" : ""}`
            : `${r.sessionId}: nothing new to push`,
        );
        if (r.pulled) out(`  merged ${r.pulled} chunk(s) from other devices first`);
        return 0;
      });
    }

    case "pull": {
      const id = args[0];
      if (!id) throw new TypeError("usage: agentsessionvault pull <session-id> [--out <path>]");
      return withDaemon(async (c) => {
        const outPath = values.out ? (await import("node:path")).resolve(values.out) : undefined;
        const r = await c.call<PullResult>("pull", { sessionId: id, ...(outPath ? { path: outPath } : {}) });
        out(r.chunks ? `${r.sessionId}: merged ${r.chunks} chunk(s), ${r.appendedBytes} new bytes` : `${r.sessionId}: up to date`);
        out(`  ${r.path}`);
        return 0;
      });
    }

    case "sessions":
      return withDaemon(async (c) => {
        const list = await c.call<SessionSummary[]>("sessions");
        if (values.json) return (out(JSON.stringify(list, null, 2)), 0);
        if (!list.length) return (out("no sessions yet"), 0);
        for (const s of list) {
          const flags = [s.deleted ? "deleted" : "", s.local ? "local" : "remote only"].filter(Boolean).join(", ");
          out(`${s.id}  seq ${s.head_seq}  ${s.updated_at.slice(0, 16).replace("T", " ")}  ${flags}`);
          out(`    ${s.title ?? "(untitled)"}  ${s.project ? `[${s.project}]  ` : ""}${s.cwd ?? ""}`);
        }
        return 0;
      });

    case "projects":
      return withDaemon(async (c) => {
        const list = await c.call<ProjectSummary[]>("projects");
        if (values.json) return (out(JSON.stringify(list, null, 2)), 0);
        if (!list.length) return (out("no projects yet"), 0);
        for (const p of list) {
          out(`${p.id.slice(0, 8)}  ${p.name ?? "(undecryptable)"}  ${p.identity ?? ""}  ${p.sessions} session(s)`);
          out(`    ${p.local ? `${p.local.dir}${p.local.how === "map" ? " (mapped)" : ""}` : "not on this machine: pulls go to _unmapped/"}`);
        }
        return 0;
      });

    case "map": {
      const project = args[0];
      if (!project) throw new TypeError("usage: agentsessionvault map <project> [dir]");
      const dir = resolve(args[1] ?? process.cwd());
      return withDaemon(async (c) => {
        const r = await c.call<{ project: ProjectSummary; moved: string[] }>("map", { project, dir });
        out(`${r.project.name ?? r.project.id} -> ${dir}`);
        for (const m of r.moved) out(`  moved ${m}`);
        return 0;
      });
    }

    case "devices":
      if (args[0] === "revoke") {
        const id = args[1];
        if (!id) throw new TypeError("usage: agentsessionvault devices revoke <device-id>");
        return withDaemon(async (c) => {
          const d = await c.call<DeviceInfo>("revokeDevice", { id });
          out(`revoked ${d.id} (${d.name ?? "unnamed"})${d.revoked_at ? ` at ${d.revoked_at}` : ""}`);
          out("Its sign-in has lost access and can't refresh. It keeps what it already downloaded.");
          return 0;
        });
      }
      if (args[0]) throw new TypeError(`unknown devices subcommand: ${args[0]}`);
      return withDaemon(async (c) => {
        const list = await c.call<DeviceInfo[]>("devices");
        if (values.json) return (out(JSON.stringify(list, null, 2)), 0);
        const byId = new Map(list.map((d) => [d.id, d.name ?? d.id.slice(0, 8)]));
        for (const d of list) {
          out(`${d.current ? "*" : " "} ${d.id}  ${d.status.padEnd(7)}  ${d.name ?? "(unnamed)"}  last seen ${d.last_seen_at ?? "never"}`);
          if (d.revoked_at) out(`    revoked ${d.revoked_at}${d.revoked_by ? ` by ${byId.get(d.revoked_by) ?? d.revoked_by}` : ""}`);
        }
        return 0;
      });

    case "logout":
      return withDaemon(async (c) => (await c.call("logout"), out("signed out"), 0));

    default:
      err(`unknown command: ${cmd}\n`);
      err(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      err(`error: ${e.message}`);
      process.exit(1);
    },
  );
}
