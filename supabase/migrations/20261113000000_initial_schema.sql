-- Initial schema: accounts, devices, projects, sessions, chunks.
-- The server only stores ciphertext and the metadata needed to sync.
-- See docs/spec.md, "Data model".

create schema if not exists "private";
revoke all on schema "private" from "public", "anon", "authenticated";

-- accounts: one row per user, holding the wrapped account key.

create table "public"."accounts" (
  "user_id" uuid primary key references "auth"."users" ("id") on delete cascade,
  "kdf" jsonb not null,
  "account_key_by_pass" jsonb not null,
  "account_key_by_recovery" jsonb not null,
  "account_key_version" int not null default 1 check ("account_key_version" > 0),
  "created_at" timestamptz not null default now(),
  constraint "accounts_kdf_shape" check (
    "kdf" ->> 'alg' = 'pbkdf2-sha256'
    and ("kdf" ->> 'iterations')::int >= 600000
    and "kdf" ? 'salt'
  )
);

-- devices: one row per signed-in Supabase Auth session.

create table "public"."devices" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "public"."accounts" ("user_id") on delete cascade,
  -- Unique so a revoked session can't register itself again.
  "auth_session_id" uuid not null unique,
  "name_enc" jsonb not null,
  "status" text not null default 'active' check ("status" in ('active', 'revoked')),
  "created_at" timestamptz not null default now(),
  "last_seen_at" timestamptz
);

create index "devices_user_id_idx" on "public"."devices" ("user_id");

create table "public"."projects" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" uuid not null references "public"."accounts" ("user_id") on delete cascade,
  "project_tag" bytea not null check (octet_length("project_tag") = 32),
  "meta_enc" jsonb not null,
  unique ("user_id", "project_tag")
);

create table "public"."sessions" (
  "id" uuid primary key,
  "user_id" uuid not null references "public"."accounts" ("user_id") on delete cascade,
  "project_id" uuid references "public"."projects" ("id") on delete set null,
  "harness" text not null check ("harness" in ('pi', 'claude-code', 'opencode')),
  "session_key" jsonb not null,
  "account_key_version" int not null,
  "meta_enc" jsonb not null,
  "head_seq" int not null default 0 check ("head_seq" >= 0),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz
);

create index "sessions_user_id_idx" on "public"."sessions" ("user_id");
create index "sessions_project_id_idx" on "public"."sessions" ("project_id");

create table "public"."chunks" (
  "session_id" uuid not null references "public"."sessions" ("id") on delete cascade,
  "seq" int not null check ("seq" > 0),
  "user_id" uuid not null references "public"."accounts" ("user_id") on delete cascade,
  "object_name" text not null unique,
  "kind" text not null check ("kind" in ('append', 'snapshot')),
  "device_id" uuid not null references "public"."devices" ("id") on delete cascade,
  "size" int not null check ("size" > 0 and "size" <= 2097152),
  "created_at" timestamptz not null default now(),
  primary key ("session_id", "seq")
);

create index "chunks_user_id_idx" on "public"."chunks" ("user_id");
create index "chunks_device_id_idx" on "public"."chunks" ("device_id");

-- The device behind the current request, if it's active. Security definer so
-- policies on "devices" itself don't recurse.

create function "private"."current_device_id"()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select "d"."id"
  from "public"."devices" as "d"
  where "d"."user_id" = (select "auth"."uid"())
    and "d"."auth_session_id" = nullif((select "auth"."jwt"()) ->> 'session_id', '')::uuid
    and "d"."status" = 'active';
$$;

create function "private"."is_active_device"()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select "private"."current_device_id"() is not null;
$$;

grant usage on schema "private" to "authenticated";
revoke all on all functions in schema "private" from "public", "anon";
grant execute on function "private"."current_device_id"(), "private"."is_active_device"() to "authenticated";

-- Row level security. Everything is "to authenticated", one policy per
-- operation, and requires an active device except where noted.

alter table "public"."accounts" enable row level security;
alter table "public"."devices" enable row level security;
alter table "public"."projects" enable row level security;
alter table "public"."sessions" enable row level security;
alter table "public"."chunks" enable row level security;

revoke all on "public"."accounts", "public"."devices", "public"."projects", "public"."sessions", "public"."chunks"
  from "anon", "authenticated";

-- accounts. Insert needs no device: it's the first step of setup.
-- Select needs no device either: a new device reads the wrapped key to unlock
-- before it registers. The row is only useful with the passphrase or recovery key.

grant select, insert on "public"."accounts" to "authenticated";
grant update ("kdf", "account_key_by_pass", "account_key_by_recovery", "account_key_version")
  on "public"."accounts" to "authenticated";

create policy "accounts_select_own" on "public"."accounts"
  for select to "authenticated"
  using ("user_id" = (select "auth"."uid"()));

create policy "accounts_insert_own" on "public"."accounts"
  for insert to "authenticated"
  with check ("user_id" = (select "auth"."uid"()));

create policy "accounts_update_own" on "public"."accounts"
  for update to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()))
  with check ("user_id" = (select "auth"."uid"()));

-- devices. A session may register itself (once, as active) without being an
-- active device yet. Everything else needs an active device.

grant select, insert on "public"."devices" to "authenticated";
grant update ("name_enc", "status", "last_seen_at") on "public"."devices" to "authenticated";

create policy "devices_select_own" on "public"."devices"
  for select to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

create policy "devices_insert_self" on "public"."devices"
  for insert to "authenticated"
  with check (
    "user_id" = (select "auth"."uid"())
    and "status" = 'active'
    and "auth_session_id" = nullif((select "auth"."jwt"()) ->> 'session_id', '')::uuid
  );

create policy "devices_update_own" on "public"."devices"
  for update to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()))
  with check ("user_id" = (select "auth"."uid"()));

-- projects

grant select, insert, delete on "public"."projects" to "authenticated";
grant update ("meta_enc") on "public"."projects" to "authenticated";

create policy "projects_select_own" on "public"."projects"
  for select to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

create policy "projects_insert_own" on "public"."projects"
  for insert to "authenticated"
  with check ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

create policy "projects_update_own" on "public"."projects"
  for update to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()))
  with check ("user_id" = (select "auth"."uid"()));

create policy "projects_delete_own" on "public"."projects"
  for delete to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

-- sessions. head_seq is not updatable by clients, only by commit_chunk.

grant select on "public"."sessions" to "authenticated";
grant insert ("id", "user_id", "project_id", "harness", "session_key", "account_key_version", "meta_enc")
  on "public"."sessions" to "authenticated";
grant update ("project_id", "session_key", "account_key_version", "meta_enc", "deleted_at")
  on "public"."sessions" to "authenticated";

create policy "sessions_select_own" on "public"."sessions"
  for select to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

create policy "sessions_insert_own" on "public"."sessions"
  for insert to "authenticated"
  with check ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

create policy "sessions_update_own" on "public"."sessions"
  for update to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()))
  with check ("user_id" = (select "auth"."uid"()));

-- chunks. Read-only to clients; inserts go through commit_chunk.

grant select on "public"."chunks" to "authenticated";

create policy "chunks_select_own" on "public"."chunks"
  for select to "authenticated"
  using ("user_id" = (select "auth"."uid"()) and (select "private"."is_active_device"()));

-- commit_chunk: the commit point of a push. Inserts the chunk row and bumps
-- head_seq atomically. The device comes from the JWT, not the caller.
-- Conflicts raise unique_violation (23505), so the client pulls and retries.

create function "public"."commit_chunk"(
  "p_session_id" uuid,
  "p_seq" int,
  "p_object_name" text,
  "p_kind" text,
  "p_size" int
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  "v_user_id" uuid := (select "auth"."uid"());
  "v_device_id" uuid := "private"."current_device_id"();
  "v_head_seq" int;
begin
  if "v_user_id" is null or "v_device_id" is null then
    raise exception 'no active device' using errcode = '42501';
  end if;

  select "s"."head_seq" into "v_head_seq"
  from "public"."sessions" as "s"
  where "s"."id" = "p_session_id" and "s"."user_id" = "v_user_id"
  for update;

  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  if "p_seq" <> "v_head_seq" + 1 then
    raise exception 'seq % is not head_seq + 1 (%)', "p_seq", "v_head_seq" + 1 using errcode = '23505';
  end if;

  if "p_object_name" !~ ('^' || "v_user_id"::text || '/' || "p_session_id"::text || '/' || "p_seq"::text || '-[A-Za-z0-9_-]{16,}\.bin$') then
    raise exception 'object name does not match session and seq' using errcode = '22023';
  end if;

  insert into "public"."chunks" ("session_id", "seq", "user_id", "object_name", "kind", "device_id", "size")
  values ("p_session_id", "p_seq", "v_user_id", "p_object_name", "p_kind", "v_device_id", "p_size");

  update "public"."sessions"
  set "head_seq" = "p_seq", "updated_at" = now()
  where "id" = "p_session_id";
end;
$$;

revoke all on function "public"."commit_chunk"(uuid, int, text, text, int) from "public", "anon";
grant execute on function "public"."commit_chunk"(uuid, int, text, text, int) to "authenticated";

-- Realtime: other devices pull when chunks are inserted. RLS applies.

alter publication "supabase_realtime" add table "public"."chunks";

-- Storage: one private bucket. Reads are scoped to <user_id>/ and need an
-- active device. There are no insert policies: uploads only happen through
-- signed upload URLs from the upload-url edge function, which checks quota.

insert into "storage"."buckets" ("id", "name", "public", "file_size_limit")
values ('sessions', 'sessions', false, 2097152);

create policy "sessions_bucket_select_own" on "storage"."objects"
  for select to "authenticated"
  using (
    "bucket_id" = 'sessions'
    and ("storage"."foldername"("name"))[1] = (select "auth"."uid"())::text
    and (select "private"."is_active_device"())
  );
