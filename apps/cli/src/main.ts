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
import type { PullResult, PushResult, SessionSummary } from "@agentsessionvault/sync";

const USAGE = `agentsessionvault: end-to-end encrypted sync for agent sessions

Usage:
  agentsessionvault daemon                  run the daemon in the foreground
  agentsessionvault login [email]           sign in with an emailed code or link
  agentsessionvault setup [--generate]      first device: create the account
  agentsessionvault unlock [--recovery]     unlock this device
  agentsessionvault status
  agentsessionvault push <session.jsonl>    push a Pi session file
  agentsessionvault pull <session-id> [--out <path>]
  agentsessionvault sessions [--json]
  agentsessionvault devices [--json]
  agentsessionvault logout

Every command except daemon talks to a running daemon.
`;

/** `agentsessionvault daemon`: runs in the foreground until stopped. */
async function runDaemon(cfg: Config): Promise<never> {
  const log = (m: string) => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
  const svc = new VaultService(cfg);
  await svc.init();
  const server = await serve(cfg.socketPath, handlers(svc, log), log);
  log(`listening on ${cfg.socketPath}`);
  const stop = async () => {
    log("stopping");
    await server.close();
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
        const { email: sent } = await c.call<{ email: string }>("login", { email });
        err(`Sent a sign-in email to ${sent}.`);
        err("Paste the code, or the link from the email (copy it, don't click it).");
        err("If you already clicked it, paste the address of the page it opened.");
        for (let attempt = 1; ; attempt++) {
          const input = await prompt("Code or link: ");
          try {
            printStatus(await c.call<Status>("verify", { input, email: sent }));
            return 0;
          } catch (e) {
            err(`That didn't work: ${(e as Error).message}`);
            if (attempt >= 3) return 1;
          }
        }
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
          out(`    ${s.title ?? "(untitled)"}  ${s.cwd ?? ""}`);
        }
        return 0;
      });

    case "devices":
      return withDaemon(async (c) => {
        const list = await c.call<DeviceInfo[]>("devices");
        if (values.json) return (out(JSON.stringify(list, null, 2)), 0);
        for (const d of list) out(`${d.current ? "*" : " "} ${d.id}  ${d.status.padEnd(7)}  ${d.name ?? "(unnamed)"}  last seen ${d.last_seen_at ?? "never"}`);
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
