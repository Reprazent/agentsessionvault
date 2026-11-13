import { homedir } from "node:os";
import { join } from "node:path";

/** The hosted project. The publishable key is meant to ship in clients. */
export const DEFAULT_SUPABASE_URL = "https://ewogalesdfjlidgybiwn.supabase.co";
export const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_2wSWsxbpVavKDf3N9H6cZg_eiWZ1kso";

export interface Config {
  supabaseUrl: string;
  publishableKey: string;
  /** Daemon state: auth session, per-session sync state. Mode 0700. */
  stateDir: string;
  /** Pi's sessions directory, where pulled sessions go. */
  piSessionsDir: string;
  socketPath: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = homedir();
  const stateDir =
    env.AGENTSESSIONVAULT_HOME ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "agentsessionvault");
  return {
    supabaseUrl: env.AGENTSESSIONVAULT_SUPABASE_URL ?? DEFAULT_SUPABASE_URL,
    publishableKey: env.AGENTSESSIONVAULT_PUBLISHABLE_KEY ?? DEFAULT_PUBLISHABLE_KEY,
    stateDir,
    piSessionsDir:
      env.AGENTSESSIONVAULT_PI_SESSIONS ?? join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "sessions"),
    socketPath:
      env.AGENTSESSIONVAULT_SOCKET ??
      (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "agentsessionvault.sock") : join(stateDir, "daemon.sock")),
  };
}
