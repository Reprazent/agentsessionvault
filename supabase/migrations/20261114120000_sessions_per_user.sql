-- Session ids come from the harness, so they're only unique per account: the
-- same session file can be pushed by two accounts (say, after switching).
-- Key sessions by (user_id, id), and chunks by (user_id, session_id, seq).

alter table "public"."chunks" drop constraint "chunks_session_id_fkey";
alter table "public"."chunks" drop constraint "chunks_pkey";
alter table "public"."sessions" drop constraint "sessions_pkey";

alter table "public"."sessions" add primary key ("user_id", "id");
alter table "public"."chunks" add primary key ("user_id", "session_id", "seq");
alter table "public"."chunks"
  add constraint "chunks_session_fkey"
  foreign key ("user_id", "session_id") references "public"."sessions" ("user_id", "id") on delete cascade;

-- Now covered by the primary key's leading column.
drop index "public"."sessions_user_id_idx";

-- Same as before, except the head_seq update is scoped to the user: by id
-- alone it would also move another account's session with the same id.
create or replace function "public"."commit_chunk"(
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
  where "s"."user_id" = "v_user_id" and "s"."id" = "p_session_id"
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
  where "user_id" = "v_user_id" and "id" = "p_session_id";
end;
$$;
