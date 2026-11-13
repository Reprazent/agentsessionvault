// upload-url: hands out a signed upload URL for one chunk object, after
// checking the caller's storage quota. Clients have no insert policy on the
// bucket, so this is the only way to upload.
//
// POST { session_id, seq, size } with the user's access token
// -> 200 { object_name, token }   then storage.uploadToSignedUrl(object_name, token, bytes)
// -> 400 bad request, 401 no user, 403 no active device, 404 no such session,
//    409 seq is not head_seq + 1, 413 over quota or chunk too large
//
// The quota counts committed chunk rows. Parallel calls can both pass the
// check, and an uploaded object without a row isn't counted until it's
// cleaned up. Both are bounded by the chunk size limit; fine for a PoC.

import { createClient } from "npm:@supabase/supabase-js@2";

const QUOTA_BYTES = 100 * 1000 * 1000;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const BUCKET = "sessions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string) => json(status, { error });

function randomSuffix(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method not allowed");

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return fail(401, "missing access token");

  let body: { session_id?: unknown; seq?: unknown; size?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "body is not JSON");
  }
  const { session_id, seq, size } = body;
  if (typeof session_id !== "string" || !UUID.test(session_id)) return fail(400, "session_id must be a UUID");
  if (!Number.isInteger(seq) || (seq as number) < 1) return fail(400, "seq must be a positive integer");
  if (!Number.isInteger(size) || (size as number) < 1) return fail(400, "size must be a positive integer");
  if ((size as number) > MAX_CHUNK_BYTES) return fail(413, `chunks are limited to ${MAX_CHUNK_BYTES} bytes`);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // As the user: RLS decides what they can see.
  const asUser = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = auth.slice(7);
  const { data: userData, error: userError } = await asUser.auth.getUser(token);
  if (userError || !userData.user) return fail(401, "invalid access token");
  const userId = userData.user.id;

  // Devices are only visible to an active device, so any row means active.
  const { data: devices, error: devError } = await asUser.from("devices").select("id").limit(1);
  if (devError) return fail(500, "device check failed");
  if (!devices?.length) return fail(403, "no active device for this sign-in");

  const { data: session, error: sessError } = await asUser
    .from("sessions")
    .select("head_seq")
    .eq("id", session_id)
    .maybeSingle();
  if (sessError) return fail(500, "session lookup failed");
  if (!session) return fail(404, "session not found");
  if (seq !== session.head_seq + 1) return fail(409, `seq must be ${session.head_seq + 1}`);

  // As the service role: totals across the user's rows, and signing the URL.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: used, error: usedError } = await admin.rpc("storage_used", { p_user_id: userId });
  if (usedError) return fail(500, "quota check failed");
  if (Number(used) + (size as number) > QUOTA_BYTES) return fail(413, `over quota (${QUOTA_BYTES} bytes)`);

  const objectName = `${userId}/${session_id}/${seq}-${randomSuffix()}.bin`;
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectName);
  if (signError || !signed) return fail(500, "could not sign upload");

  return json(200, { object_name: objectName, token: signed.token });
});
