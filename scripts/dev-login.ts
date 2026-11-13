// Dev only: signs the running daemon in without sending an email, to stay
// clear of the built-in sender's rate limit while testing.
//
//   pnpm dev:login you@example.com
//
// Asks the daemon to start its callback server without emailing, makes a
// magic link for that address with the admin API (creating the user if
// needed), follows Supabase's redirect and hands the result to the callback,
// like the callback page's script would. Honours AGENTSESSIONVAULT_HOME and
// AGENTSESSIONVAULT_SOCKET, so it works for a second daemon too.
//
// The secret key comes from the Supabase CLI at runtime and stays in memory.
// These links use the implicit flow, so this doesn't exercise PKCE.
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../apps/cli/src/config.ts";
import { DaemonClient } from "../apps/cli/src/protocol.ts";
import type { Status } from "../apps/cli/src/service.ts";

const email = process.argv[2];
if (!email) {
  console.error("usage: pnpm dev:login <email>");
  process.exit(1);
}

const cfg = loadConfig();
const keys = JSON.parse(
  Bun.spawnSync(["supabase", "projects", "api-keys", "--remote", "--reveal", "--output-format", "json"], { stderr: "ignore" }).stdout.toString() ||
    "{}",
) as { keys?: { type: string; api_key: string }[] };
const secret = keys.keys?.find((k) => k.type === "secret")?.api_key;
if (!secret) {
  console.error("could not get the secret key; is the Supabase CLI logged in and the project linked?");
  process.exit(1);
}
const admin = createClient(cfg.supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const daemon = await DaemonClient.connect(cfg.socketPath);
try {
  const { email: normalised, callbackUrl } = await daemon.call<{ email: string; callbackUrl?: string }>("login", {
    email,
    sendEmail: false,
  });
  if (!callbackUrl) throw new Error("the daemon didn't start a callback server; is it up to date?");
  const waiting = daemon.call<Status>("waitLogin");

  let link = await admin.auth.admin.generateLink({ type: "magiclink", email: normalised, options: { redirectTo: callbackUrl } });
  if (link.error?.code === "user_not_found" || link.error?.status === 404) {
    const created = await admin.auth.admin.createUser({ email: normalised, email_confirm: true });
    if (created.error) throw created.error;
    console.error(`created user ${normalised}`);
    link = await admin.auth.admin.generateLink({ type: "magiclink", email: normalised, options: { redirectTo: callbackUrl } });
  }
  if (link.error) throw link.error;

  const location = (await fetch(link.data.properties.action_link, { redirect: "manual" })).headers.get("location") ?? "";
  if (!location.startsWith(`${callbackUrl}#`)) throw new Error(`unexpected redirect: ${location.split("#")[0] || "(none)"}`);
  const [page, fragment] = location.split("#") as [string, string];
  await fetch(`${page}/fragment?${fragment}`, { method: "POST" });

  const st = await waiting;
  console.log(`signed in as ${st.email}${st.account ? (st.unlocked ? ", unlocked" : "; run `asv unlock`") : "; run `asv setup`"}`);
} finally {
  daemon.close();
}
