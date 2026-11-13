import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

const repo = new URL("..", import.meta.url).pathname;
const db = new PGlite();

// Minimal Supabase stand-ins. This approximates hosted Supabase (no real
// auth, storage or pgTAP); `pnpm test:db` against the hosted project is the
// source of truth.
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage; create schema extensions;
grant usage on schema auth, storage, extensions to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on all functions in schema auth to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
create publication supabase_realtime;
grant usage on schema public to anon, authenticated;

-- pgTAP shim: just enough for our tests.
create table extensions._tap (n serial, ok boolean, description text);
grant all on extensions._tap, extensions._tap_n_seq to public;
create function plan(int) returns text language sql as $$ select '1..' || $1 $$;
create function _ok(boolean, text) returns text language plpgsql as $$
begin insert into extensions._tap (ok, description) values (coalesce($1, false), $2);
return case when coalesce($1,false) then 'ok' else 'not ok' end || ' - ' || $2; end $$;
create function lives_ok(text, text) returns text language plpgsql as $$
begin execute $1; return _ok(true, $2);
exception when others then return _ok(false, $2 || ' (died: ' || sqlstate || ' ' || sqlerrm || ')'); end $$;
create function throws_ok(text, text, text, text) returns text language plpgsql as $$
begin execute $1; return _ok(false, $4 || ' (did not throw)');
exception when others then
  return _ok(sqlstate = $2, $4 || case when sqlstate = $2 then '' else ' (got ' || sqlstate || ' ' || sqlerrm || ')' end); end $$;
create function "is"(anyelement, anyelement, text) returns text language plpgsql as $$
begin return _ok($1 is not distinct from $2, $3 || case when $1 is not distinct from $2 then '' else ' (got ' || coalesce($1::text,'null') || ')' end); end $$;
create function finish() returns setof text language sql as $$
  select 'FAILED ' || description from extensions._tap where not ok
  union all select count(*) filter (where ok) || '/' || count(*) || ' passed' from extensions._tap $$;
grant execute on all functions in schema public to public;
`);

const sqlFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => `${dir}/${f}`);

for (const f of sqlFiles(`${repo}/supabase/migrations`)) await db.exec(readFileSync(f, "utf8"));

let failed = 0;
for (const f of sqlFiles(`${repo}/supabase/tests/database`)) {
  await db.exec("truncate extensions._tap");
  const test = readFileSync(f, "utf8")
    .replace(/create extension if not exists "pgtap".*\n/, "")
    .replace(/select \* from finish\(\);/, "reset role; select * from finish();");
  const res = await db.exec(test);
  const lines = res.flatMap((r) => r.rows.map((row) => Object.values(row)[0])).filter((v) => typeof v === "string");
  const summary = lines.findLast((v) => /^\d+\/\d+ passed$/.test(v));
  const plan = lines.find((v) => v.startsWith("1.."));
  for (const v of lines) if (v.startsWith("FAILED")) console.log(`  ${v}`);
  const [ok, total] = summary!.split(" ")[0]!.split("/").map(Number);
  const planned = Number(plan?.slice(3));
  if (ok !== total || total !== planned) failed++;
  console.log(`${ok === total && total === planned ? "ok" : "FAIL"} ${f.split("/").pop()}: ${summary} (planned ${planned})`);
}
process.exit(failed ? 1 : 0);
