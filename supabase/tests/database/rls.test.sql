begin;
create extension if not exists "pgtap" with schema "extensions";

select plan(33);

-- Fixtures, as the table owner. Two users; alice has two auth sessions
-- (an active device and a revoked one), bob has one.

insert into "auth"."users" ("id", "email") values
  ('a0000000-0000-4000-8000-000000000001', 'alice@example.com'),
  ('b0000000-0000-4000-8000-000000000001', 'bob@example.com');

create function pg_temp.act_as("p_user" uuid, "p_session" uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
           json_build_object('sub', "p_user", 'role', 'authenticated', 'session_id', "p_session")::text, true);
$$;


-- Setup: inserting your own account works without a device.

select pg_temp.act_as('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001');

select lives_ok(
  $$ insert into "public"."accounts" ("user_id", "kdf", "account_key_by_pass", "account_key_by_recovery")
     values ('a0000000-0000-4000-8000-000000000001',
             '{"alg":"pbkdf2-sha256","iterations":600000,"salt":"AAAAAAAAAAAAAAAAAAAAAA=="}', '{}', '{}') $$,
  'a user can create their own account'
);

select throws_ok(
  $$ insert into "public"."accounts" ("user_id", "kdf", "account_key_by_pass", "account_key_by_recovery")
     values ('b0000000-0000-4000-8000-000000000001',
             '{"alg":"pbkdf2-sha256","iterations":600000,"salt":"x"}', '{}', '{}') $$,
  '42501', null,
  'a user cannot create an account for someone else'
);

select is((select count(*) from "public"."accounts"), 1::bigint, 'a user can read their account before registering a device');

-- No device yet: everything else is invisible.

select is((select count(*) from "public"."devices"), 0::bigint, 'no devices visible without an active device');
select throws_ok(
  $$ insert into "public"."sessions" ("id", "user_id", "harness", "session_key", "account_key_version", "meta_enc")
     values ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'pi', '{}', 1, '{}') $$,
  '42501', null,
  'cannot create sessions without an active device'
);

-- Registering a device: only for the current auth session.

select throws_ok(
  $$ insert into "public"."devices" ("user_id", "auth_session_id", "name_enc")
     values ('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000999', '{}') $$,
  '42501', null,
  'cannot register a device for another auth session'
);

select throws_ok(
  $$ insert into "public"."devices" ("user_id", "auth_session_id", "name_enc", "status")
     values ('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001', '{}', 'revoked') $$,
  '42501', null,
  'cannot register a device in another status than active'
);

select lives_ok(
  $$ insert into "public"."devices" ("id", "user_id", "auth_session_id", "name_enc")
     values ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
             'a1111111-0000-4000-8000-000000000001', '{}') $$,
  'can register the current auth session as a device'
);

select is((select count(*) from "public"."devices"), 1::bigint, 'the new device sees itself');

-- Sessions and chunks.

select lives_ok(
  $$ insert into "public"."sessions" ("id", "user_id", "harness", "session_key", "account_key_version", "meta_enc")
     values ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'pi', '{}', 1, '{}') $$,
  'an active device can create a session'
);

select throws_ok(
  $$ update "public"."sessions" set "head_seq" = 5 where "id" = 'c0000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'head_seq cannot be updated directly'
);

select throws_ok(
  $$ insert into "public"."chunks" ("session_id", "seq", "user_id", "object_name", "kind", "device_id", "size")
     values ('c0000000-0000-4000-8000-000000000001', 1, 'a0000000-0000-4000-8000-000000000001',
             'x', 'append', 'd0000000-0000-4000-8000-000000000001', 10) $$,
  '42501', null,
  'chunks cannot be inserted directly'
);

select lives_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 1,
       'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/1-abcdefghijklmnop.bin', 'append', 100) $$,
  'commit_chunk appends seq 1'
);

select is(
  (select "head_seq" from "public"."sessions" where "id" = 'c0000000-0000-4000-8000-000000000001'),
  1, 'commit_chunk bumps head_seq'
);

select is(
  (select "device_id" from "public"."chunks" where "seq" = 1),
  'd0000000-0000-4000-8000-000000000001'::uuid, 'the chunk records the calling device'
);

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 1,
       'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/1-qrstuvwxyzabcdef.bin', 'append', 100) $$,
  '23505', null,
  'a second commit at the same seq conflicts'
);

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 3,
       'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/3-qrstuvwxyzabcdef.bin', 'append', 100) $$,
  '23505', null,
  'skipping a seq conflicts'
);

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 2,
       'b0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/2-qrstuvwxyzabcdef.bin', 'append', 100) $$,
  '22023', null,
  'the object name has to be under the caller, session and seq'
);

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 2,
       'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/2-qrstuvwxyzabcdef.bin', 'append', 0) $$,
  '23514', null,
  'sizes have to be positive'
);

select throws_ok(
  $$ delete from "public"."chunks" $$,
  '42501', null,
  'chunks are append-only'
);

-- Bob sees none of it, and can't commit into alice's session.

reset role;
select set_config('request.jwt.claims', '', true);
insert into "public"."accounts" ("user_id", "kdf", "account_key_by_pass", "account_key_by_recovery")
values ('b0000000-0000-4000-8000-000000000001', '{"alg":"pbkdf2-sha256","iterations":600000,"salt":"x"}', '{}', '{}');
insert into "public"."devices" ("id", "user_id", "auth_session_id", "name_enc")
values ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'b1111111-0000-4000-8000-000000000001', '{}');

select pg_temp.act_as('b0000000-0000-4000-8000-000000000001', 'b1111111-0000-4000-8000-000000000001');

select is((select count(*) from "public"."accounts"), 1::bigint, 'bob sees only his account');
select is((select count(*) from "public"."devices"), 1::bigint, 'bob sees only his devices');
select is((select count(*) from "public"."sessions"), 0::bigint, 'bob sees no sessions of alice');
select is((select count(*) from "public"."chunks"), 0::bigint, 'bob sees no chunks of alice');

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 2,
       'b0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/2-qrstuvwxyzabcdef.bin', 'append', 100) $$,
  'P0002', null,
  'bob cannot commit into alice''s session'
);

-- Silently matches no rows; checked from alice's side below.
update "public"."sessions" set "deleted_at" = now();

-- Revocation: alice signs in on a second device, which revokes the first.

select pg_temp.act_as('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000002');
insert into "public"."devices" ("id", "user_id", "auth_session_id", "name_enc")
values ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000002', '{}');

select is(
  (select "deleted_at" from "public"."sessions" where "id" = 'c0000000-0000-4000-8000-000000000001'),
  null::timestamptz, 'bob could not soft-delete alice''s session'
);

select lives_ok(
  $$ update "public"."devices" set "status" = 'revoked' where "id" = 'd0000000-0000-4000-8000-000000000001' $$,
  'an active device can revoke another'
);

select throws_ok(
  $$ update "public"."devices" set "user_id" = 'b0000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'devices cannot change owner'
);

-- The revoked session, with its still-valid JWT, loses access immediately.

select pg_temp.act_as('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001');

select is((select count(*) from "public"."sessions"), 0::bigint, 'a revoked device sees no sessions');
select is((select count(*) from "public"."chunks"), 0::bigint, 'a revoked device sees no chunks');

select throws_ok(
  $$ insert into "public"."devices" ("user_id", "auth_session_id", "name_enc")
     values ('a0000000-0000-4000-8000-000000000001', 'a1111111-0000-4000-8000-000000000001', '{}') $$,
  '23505', null,
  'a revoked auth session cannot register itself again'
);

select throws_ok(
  $$ select "public"."commit_chunk"('c0000000-0000-4000-8000-000000000001', 2,
       'a0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/2-qrstuvwxyzabcdef.bin', 'append', 100) $$,
  '42501', null,
  'a revoked device cannot commit chunks'
);

-- Anonymous users get nothing.

select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select * from "public"."accounts" $$, '42501', null, 'anon cannot read accounts');

select * from finish();
rollback;
