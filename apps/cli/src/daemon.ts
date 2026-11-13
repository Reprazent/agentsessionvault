import type { Handler } from "./protocol.ts";
import type { VaultService } from "./service.ts";

const str = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== "string" || !v) throw new TypeError(`${k} is required`);
  return v;
};
const optStr = (p: Record<string, unknown>, k: string): string | undefined => {
  const v = p[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new TypeError(`${k} must be a string`);
  return v;
};

export function handlers(svc: VaultService, log: (m: string) => void): Record<string, Handler> {
  const h: Record<string, Handler> = {
    ping: async () => "pong",
    status: () => svc.status(),
    login: (p) => svc.login(str(p, "email"), { callback: p.callback !== false }),
    waitLogin: () => svc.waitLogin(),
    verify: (p) => svc.verify(str(p, "input"), optStr(p, "email")),
    logout: () => svc.logout(),
    setup: async (p) => {
      const r = await svc.setup({ ...(optStr(p, "passphrase") ? { passphrase: optStr(p, "passphrase")! } : {}), generate: p.generate === true });
      log("account created, unlocked");
      return r;
    },
    unlock: async (p) => {
      const passphrase = optStr(p, "passphrase");
      const recoveryKey = optStr(p, "recoveryKey");
      const r = await svc.unlock({ ...(passphrase ? { passphrase } : {}), ...(recoveryKey ? { recoveryKey } : {}) });
      log(`unlocked as device ${r.deviceId}`);
      return r;
    },
    push: async (p) => {
      const r = await svc.push(str(p, "path"));
      log(`push ${r.sessionId}: ${r.chunks.length} chunk(s)${r.pulled ? `, merged ${r.pulled} first` : ""}`);
      return r;
    },
    pull: async (p) => {
      const r = await svc.pull(str(p, "sessionId"), optStr(p, "path"));
      log(`pull ${r.sessionId}: ${r.chunks} chunk(s) -> ${r.path}`);
      return r;
    },
    sessions: () => svc.sessions(),
    devices: () => svc.devices(),
  };
  // Always async, so validation errors reject instead of throwing.
  return Object.fromEntries(Object.entries(h).map(([k, f]) => [k, async (p: Record<string, unknown>) => f(p)]));
}

export interface StartupIo {
  env: Record<string, string | undefined>;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
}

/**
 * Unlock at startup: AGENTSESSIONVAULT_PASSPHRASE, else a terminal prompt.
 * The variable is deleted from the environment either way, so nothing the
 * daemon starts inherits it.
 */
export async function unlockAtStart(svc: VaultService, log: (m: string) => void, io: StartupIo): Promise<void> {
  const st = await svc.status();
  if (!st.signedIn) return log("signed out; run `agentsessionvault login`");
  if (!st.account) return log(`signed in as ${st.email}; no account yet, run \`agentsessionvault setup\``);

  const fromEnv = io.env.AGENTSESSIONVAULT_PASSPHRASE;
  delete io.env.AGENTSESSIONVAULT_PASSPHRASE;
  if (fromEnv) {
    try {
      await svc.unlock({ passphrase: fromEnv });
      return log(`unlocked from AGENTSESSIONVAULT_PASSPHRASE as ${st.email}`);
    } catch (e) {
      log(`AGENTSESSIONVAULT_PASSPHRASE didn't unlock: ${(e as Error).message}`);
    }
  }
  if (!io.isTTY) return log("locked; run `agentsessionvault unlock`");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pass = await io.prompt(`Passphrase for ${st.email}: `).catch(() => "");
    if (!pass) break;
    if ((await svc.status()).unlocked) return;
    try {
      await svc.unlock({ passphrase: pass });
      return log(`unlocked as ${st.email}`);
    } catch (e) {
      log((e as Error).name === "DecryptionError" ? "wrong passphrase" : (e as Error).message);
    }
  }
  log("still locked; run `agentsessionvault unlock`");
}

