-- Total committed chunk bytes for a user, for the upload-url quota check.
-- Only the service role (inside the edge function) may call it.

create function "public"."storage_used"("p_user_id" uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum("c"."size"), 0)::bigint
  from "public"."chunks" as "c"
  where "c"."user_id" = "p_user_id";
$$;

revoke all on function "public"."storage_used"(uuid) from "public", "anon", "authenticated";
grant execute on function "public"."storage_used"(uuid) to "service_role";
grant select on "public"."chunks" to "service_role";
