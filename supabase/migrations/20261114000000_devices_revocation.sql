-- Devices stay as long as they have chunks, revocation is recorded and
-- final, and a revoked or idle sign-in can't refresh its token anymore.

-- 1. Chunks keep their device. Deleting a device that pushed chunks fails;
-- deleting a whole account still works, because its chunks go in the same
-- statement (no action is checked at the end of it, unlike restrict).

alter table "public"."chunks" drop constraint "chunks_device_id_fkey";
alter table "public"."chunks"
  add constraint "chunks_device_id_fkey"
  foreign key ("device_id") references "public"."devices" ("id") on delete no action;

-- 2. Revocation bookkeeping. Clients only get to set status; the trigger
-- fills these in.

alter table "public"."devices"
  add column "revoked_at" timestamptz,
  add column "revoked_by" uuid references "public"."devices" ("id") on delete set null;

create index "devices_revoked_by_idx" on "public"."devices" ("revoked_by");

-- On revoke: record when and by which device, and delete the device's Auth
-- session, so its refresh token stops working. Its current access token
-- keeps passing JWT checks until it expires (at most an hour), but RLS
-- already shuts it out. A revoked device stays revoked.

create function "private"."devices_before_update"()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old."status" = 'revoked' and new."status" <> 'revoked' then
    raise exception 'a revoked device stays revoked' using errcode = '42501';
  end if;

  if old."status" = 'active' and new."status" = 'revoked' then
    new."revoked_at" := now();
    new."revoked_by" := "private"."current_device_id"();
    delete from "auth"."sessions" where "id" = new."auth_session_id";
  else
    new."revoked_at" := old."revoked_at";
    new."revoked_by" := old."revoked_by";
  end if;

  return new;
end;
$$;

revoke all on function "private"."devices_before_update"() from "public", "anon", "authenticated";

create trigger "devices_before_update"
  before update on "public"."devices"
  for each row execute function "private"."devices_before_update"();

-- 3. Sign-ins that haven't refreshed for 7 days end. Supabase's own session
-- limits (inactivity_timeout) need the Pro plan; this does the same on the
-- free tier. Deleting a session deletes its refresh tokens. Auth bumps
-- sessions.updated_at on every refresh.

create function "private"."end_idle_sessions"()
returns integer
language sql
security definer
set search_path = ''
as $$
  with "ended" as (
    delete from "auth"."sessions"
    where greatest("updated_at", "created_at") < now() - interval '7 days'
    returning 1
  )
  select count(*)::integer from "ended";
$$;

revoke all on function "private"."end_idle_sessions"() from "public", "anon", "authenticated";

create extension if not exists "pg_cron" with schema "pg_catalog";
grant usage on schema "cron" to "postgres";

select "cron"."schedule"('end-idle-sessions', '17 * * * *', 'select "private"."end_idle_sessions"()');
