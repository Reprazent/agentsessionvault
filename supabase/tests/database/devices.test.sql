begin;
create extension if not exists "pgtap" with schema "extensions";

select plan(16);

-- Fixtures as the owner: alice with two devices (two sign-ins), one chunk
-- pushed from the first, and an idle sign-in without a device.

insert into "auth"."users" ("id", "email") values
  ('a0000000-0000-4000-8000-000000000001', 'alice@example.com');

insert into "auth"."sessions" ("id", "user_id", "created_at", "updated_at") values
  ('a1111111-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', now(), now()),
  ('a1111111-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', now(), now()),
  ('a1111111-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '8 days'),
  ('a1111111-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', now() - interval '30 days', now() - interval '6 days');

insert into "public"."accounts" ("user_id", "kdf", "account_key_by_pass", "account_key_by_recovery")
values ('a0000000-0000-4000-8000-000000000001', '{"alg":"pbkdf2-sha256","iterations":600000,"salt":"x"}', '{}', '{}');

insert into "public"."devices" ("id", "user_id", "auth_session_id", "name_enc") values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001', '{}'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000002', '{}');

insert into "public"."sessions" ("id", "user_id", "harness", "session_key", "account_key_version", "meta_enc")
values ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'pi', '{}', 1, '{}');

insert into "public"."chunks" ("session_id", "seq", "user_id", "object_name", "kind", "device_id", "size")
values ('c0000000-0000-4000-8000-000000000001', 1, 'a0000000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/1-abcdefghijklmnop.bin',
        'append', 'd0000000-0000-4000-8000-000000000001', 10);

-- Devices with chunks can't be deleted, not even by the owner.

select throws_ok(
  $$ delete from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  '23503', null,
  'a device that pushed chunks cannot be deleted'
);

create function pg_temp.act_as("p_session" uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
           json_build_object('sub', 'a0000000-0000-4000-8000-000000000001', 'role', 'authenticated', 'session_id', "p_session")::text, true);
$$;

-- Revocation, from the second device.

select pg_temp.act_as('a1111111-0000-4000-8000-000000000002');

select throws_ok(
  $$ update "public"."devices" set "revoked_at" = now() where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'clients cannot set revoked_at themselves'
);

select throws_ok(
  $$ delete from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'clients cannot delete devices'
);

select lives_ok(
  $$ update "public"."devices" set "status" = 'revoked' where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  'an active device revokes another'
);

select is(
  (select "revoked_by" from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000001'),
  'd0000000-0000-4000-8000-000000000002'::uuid,
  'the revocation records which device did it'
);

select isnt(
  (select "revoked_at" from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000001'),
  null::timestamptz,
  'and when'
);

select is(
  (select count(*) from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000002' and "revoked_at" is null),
  1::bigint,
  'other devices are untouched'
);

select throws_ok(
  $$ update "public"."devices" set "status" = 'active' where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'a revoked device cannot be reactivated'
);

select lives_ok(
  $$ update "public"."devices" set "name_enc" = '{"x":1}' where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  'other updates to a revoked device still work'
);

reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select "revoked_at" is not null and "revoked_by" = 'd0000000-0000-4000-8000-000000000002'::uuid
   from "public"."devices" where "id" = 'd0000000-0000-4000-8000-000000000001'),
  true,
  'and keep the revocation record'
);

select is(
  (select count(*) from "auth"."sessions" where "id" = 'a1111111-0000-4000-8000-000000000001'),
  0::bigint,
  'revoking deletes the device''s auth session, so it cannot refresh'
);

select is(
  (select count(*) from "auth"."sessions" where "id" = 'a1111111-0000-4000-8000-000000000002'),
  1::bigint,
  'the revoking device keeps its session'
);

-- Idle sign-ins.

select is("private"."end_idle_sessions"(), 1, 'end_idle_sessions ends sign-ins idle for over 7 days');

select is(
  (select array_agg("id"::text order by "id") from "auth"."sessions" where "user_id" = 'a0000000-0000-4000-8000-000000000001'),
  array['a1111111-0000-4000-8000-000000000002', 'a1111111-0000-4000-8000-000000000004'],
  'and keeps the ones used within 7 days'
);

select pg_temp.act_as('a1111111-0000-4000-8000-000000000002');
select throws_ok($$ select "private"."end_idle_sessions"() $$, '42501', null, 'clients cannot call end_idle_sessions');

-- Deleting the account still removes everything, chunks and devices alike.

reset role;
select set_config('request.jwt.claims', '', true);
select lives_ok(
  $$ delete from "auth"."users" where "id" = 'a0000000-0000-4000-8000-000000000001' $$,
  'deleting a user with chunks and devices works'
);

select * from finish();
rollback;
