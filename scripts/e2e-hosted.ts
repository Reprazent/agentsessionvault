// End-to-end check against the linked hosted project, without email:
// creates a throwaway user with the admin API, signs two "devices" in with
// tokens from generateLink, and runs setup, unlock, push, pull and a branch
// merge through VaultService. Deletes the user and its objects afterwards.
//
// The secret key is fetched from the Supabase CLI at runtime and only kept in
// memory. Run with `pnpm test:e2e`.
import { createClient } from "@supabase/supabase-js";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultClient } from "../packages/client/src/index.ts";
import { loadConfig } from "../apps/cli/src/config.ts";
import { VaultService } from "../apps/cli/src/service.ts";

const cfg = loadConfig({});
const keys = JSON.parse(
  Bun.spawnSync(["supabase", "projects", "api-keys", "--remote", "--reveal", "--output-format", "json"], { stderr: "ignore" }).stdout.toString(),
) as { keys: { type: string; api_key: string }[] };
const secret = keys.keys.find((k) => k.type === "secret")?.api_key;
if (!secret) throw new Error("could not get the secret key from `supabase projects api-keys`");
const admin = createClient(cfg.supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const email = `e2e-${crypto.randomUUID().slice(0, 8)}@agentsessionvault.invalid`;
const passphrase = "correct horse battery staple e2e";
const sid = crypto.randomUUID();
let userId: string | undefined;

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

async function device(name: string) {
  const root = await mkdtemp(join(tmpdir(), `asv-e2e-${name}-`));
  const svc = new VaultService({ ...cfg, stateDir: join(root, "state"), piSessionsDir: join(root, "pi"), socketPath: "" });
  await svc.init();
  return { root, svc };
}

async function magicLink() {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  return data.properties;
}

const header = JSON.stringify({ type: "session", version: 3, id: sid, timestamp: new Date().toISOString(), cwd: "/e2e/project" });
const entry = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });

try {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;

  // Device A: sign in with the link from the email, set up the account.
  const a = await device("a");
  check(!(await a.svc.status()).signedIn, "a starts signed out");
  const linkA = await magicLink();
  await a.svc.verify(`${cfg.supabaseUrl}/auth/v1/verify?token=${linkA.hashed_token}&type=magiclink`, email);
  const sa = await a.svc.status();
  check(sa.signedIn && sa.account === false && !sa.unlocked, "a signs in via the email link, no account yet");
  const { recoveryKey } = await a.svc.setup({ passphrase });
  check(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(recoveryKey), "setup returns a recovery key");
  check((await a.svc.status()).unlocked, "a is unlocked after setup");

  const fileA = join(a.root, "session.jsonl");
  await writeFile(fileA, `${header}\n${entry("e1", null, "Hello from A")}\n`);
  const pushA = await a.svc.push(fileA);
  check(pushA.created && pushA.chunks.length === 1, "a pushes a new session");

  // Server only sees ciphertext.
  const { data: rows } = await admin.from("sessions").select("meta_enc").eq("id", sid).single();
  check(!JSON.stringify(rows).includes("Hello from A") && !JSON.stringify(rows).includes("/e2e/project"), "metadata is encrypted");
  const { data: obj } = await admin.storage.from("sessions").download((await admin.from("chunks").select("object_name").eq("session_id", sid).single()).data!.object_name);
  check(new TextDecoder().decode(await obj!.arrayBuffer()).startsWith("ASV1") && !(await obj!.text()).includes("Hello"), "the chunk object is encrypted");

  // Device B: sign in with the code, unlock with the passphrase, pull.
  const b = await device("b");
  const linkB = await magicLink();
  await b.svc.verify(linkB.email_otp, email);
  check((await b.svc.status()).account === true, "b signs in with the code and sees the account");
  let threw = false;
  try {
    await b.svc.unlock({ passphrase: "wrong passphrase, long enough" });
  } catch {
    threw = true;
  }
  check(threw && !(await b.svc.status()).unlocked, "a wrong passphrase doesn't unlock");
  await b.svc.unlock({ passphrase });
  check((await b.svc.status()).unlocked, "b unlocks with the passphrase");
  check((await b.svc.devices()).length === 2, "b sees both devices");

  const pullB = await b.svc.pull(sid);
  check(pullB.path.startsWith(join(b.root, "pi", "--e2e-project--")), "b pulls into Pi's layout");
  check((await readFile(pullB.path, "utf8")) === (await readFile(fileA, "utf8")), "b's copy matches a's");

  // Both continue the session; the result is two branches on both sides.
  await appendFile(fileA, `${entry("a2", "e1", "A continues")}\n`);
  await appendFile(pullB.path, `${entry("b2", "e1", "B continues")}\n`);
  await a.svc.push(fileA);
  const pushB = await b.svc.push(pullB.path);
  check(pushB.pulled === 1 && pushB.chunks[0]?.seq === 3, "b merges a's entry before pushing at seq 3");
  await a.svc.pull(sid);
  const ids = async (p: string) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l).id).sort();
  check(JSON.stringify(await ids(fileA)) === JSON.stringify(await ids(pullB.path)), "both devices end with the same entries");
  check((await ids(fileA)).length === 4, "and both branches are there");

  const [summary] = await b.svc.sessions();
  check(summary?.title === "Hello from A" && summary.cwd === "/e2e/project" && summary.head_seq === 3, "sessions lists decrypted metadata");

  // Device C: recovery key.
  // Device C signs in through the local callback server: Supabase redirects
  // the link there. generateLink makes implicit-flow links, so the session
  // arrives in the fragment; we do what the callback page's script does.
  const c = await device("c");
  const cbUrl = await (async () => {
    const svc = c.svc as unknown as { callback?: { url: string; close(): void } };
    const { startCallbackServer } = await import("../apps/cli/src/callback.ts");
    svc.callback = await startCallbackServer();
    (c.svc as unknown as { pendingEmail: string }).pendingEmail = email;
    return svc.callback.url;
  })();
  const { data: linkC } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: cbUrl } });
  const location = (await fetch(linkC.properties!.action_link, { redirect: "manual" })).headers.get("location")!;
  check(location.startsWith(`${cbUrl}#`), "supabase redirects the link to the local callback");
  const waiting = c.svc.waitLogin();
  const pageHtml = await (await fetch(location.split("#")[0]!)).text();
  await fetch(`${location.split("#")[0]}/fragment?${location.split("#")[1]}`, { method: "POST" });
  check(pageHtml.includes("/fragment?") && (await waiting).signedIn, "c signs in through the callback");
  await c.svc.unlock({ recoveryKey: recoveryKey.toLowerCase() });
  check((await c.svc.pull(sid)).chunks === 3, "c unlocks with the recovery key and pulls");

  // Revoke b from a; b loses access with its current token.
  const bId = (await b.svc.status()).deviceId!;
  const { error: revokeError } = await (a.svc.client as VaultClient).supabase.from("devices").update({ status: "revoked" }).eq("id", bId);
  check(!revokeError, "a revokes b");
  check((await b.svc.client.remote(userId).listSessions()).length === 0, "b sees no sessions after revocation");
  threw = false;
  try {
    await b.svc.push(pullB.path);
  } catch {
    threw = true;
  }
  check(threw, "b can't push after revocation");
  threw = false;
  try {
    await b.svc.unlock({ passphrase });
  } catch (e) {
    threw = (e as Error).name === "RevokedDeviceError";
  }
  check(threw, "b's sign-in can't register again");

  console.log("\nall good");
} finally {
  if (userId) {
    const { data: objs } = await admin.storage.from("sessions").list(`${userId}/${sid}`);
    if (objs?.length) await admin.storage.from("sessions").remove(objs.map((o) => `${userId}/${sid}/${o.name}`));
    await admin.auth.admin.deleteUser(userId);
    console.log(`cleaned up ${email} and ${objs?.length ?? 0} objects`);
  }
}
