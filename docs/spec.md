# Spec draft: encrypted agent session sync on Supabase

Status: second draft, revised after a review against Supabase's security and coding standards. Lives here until it moves to its own repo under `github.com/Reprazent` (it moves again later).
Working name: `agentsessionvault` (`session-sync` and `agentsync` are taken).

Sync coding agent sessions between my machines, end-to-end encrypted, with Supabase as the backend. Pi first. Claude Code and OpenCode later, with the goal of picking up a session in a different harness than the one that started it.

## Why

Pi keeps sessions in `~/.pi/agent/sessions/`, grouped by absolute working directory. They don't follow me between machines and throwaway VMs. What exists today:

- `ersintarhan/pi-sync` is the closest. It encrypts each session (AES-256-GCM over gzip) into an S3 bucket you bring yourself, with an encrypted manifest. You hand-copy a raw key to every machine via an env var. Push/pull is manual (plus auto-push on exit) and conflicts are last writer wins on mtime, guarded by a lock.
- `SmileyChris/pi-sync` is peer to peer over Tailscale using Automerge. Sessions get copied per hostname, so there's no merging, and both machines have to be online.
- `brglng/pi-session-sync` does a manual two-way sync into a local directory (Dropbox and friends). Unencrypted, but it has the most thought-through path portability.
- `pi-opensync-plugin` ships sessions to OpenSync's hosted dashboard. One way, and the server can read everything.
- `xhluca/session-migrate` and `npow/session-sync` convert sessions between harnesses, locally only.

Nobody combines sync with cross-harness conversion, and nobody offers a hosted service where the server can't read the data. The existing sync tools also treat a session as one opaque file, while Pi's format is an append-only tree that merges cleanly if you sync entries instead of files.

What this project adds:

1. A hosted backend you sign in to. No buckets, IAM keys or `openssl rand`.
2. Key management that doesn't involve copying a raw key around: a passphrase plus a recovery key.
3. Incremental, append-only sync. Only new entries are uploaded, so two machines don't clobber each other.
4. Projects identified by git remote, not by absolute path.
5. A harness-neutral format next to the native one, so sessions can move between harnesses eventually.

## Goals and non-goals

Goals for v1:

- Pi to Pi sync across macOS and Linux, near real time while a session is running.
- The server stores ciphertext plus the minimum metadata needed to sync.
- Adding a second device takes a couple of minutes.
- The repo structure and data model leave room for other harnesses from day one.

Not in v1:

- Resuming a Pi session in Claude Code or OpenCode. The format is designed for it, the adapters come later.
- Sharing sessions with other people. Per-session keys (below) keep that possible.
- A web viewer. If it happens, it decrypts in the browser.
- Syncing config, skills or extensions. `pi-config-sync` and friends cover that.
- Syncing work sessions. This only carries personal and open source sessions for now. Private Supabase code needs a conversation with #team-security first.

## Threat model

Protect against:

- Supabase, or whoever runs the instance, reading session contents. Sessions contain code, file contents, and sometimes secrets pasted into prompts or printed by tools.
- A leaked database dump or storage bucket.
- A lost or stolen device, once it's revoked.

Not protecting against:

- A compromised device that's still signed in and unlocked. It has the keys.
- Traffic analysis. The server sees when I work, how many sessions I have and roughly how big they are.
- A server that withholds or rolls back data. "Server" here means whoever controls the Supabase project: me as the operator, or anyone holding a leaked secret key. The AAD stops chunks being swapped or reordered, but nothing detects a missing tail or an old state being served. Out of scope for the PoC. A hash chain over chunks would close it.
- Length leaks from compressing before encrypting. If attacker-influenced text (a fetched web page) shares a chunk with a secret, chunk sizes can leak a little about the secret. Accepted along with the other metadata.
- Me forgetting both my passphrase and my recovery key. The data is gone at that point, by design.

## Architecture

```
 machine A                               Supabase                         machine B
 ┌──────────────┐                ┌───────────────────────┐          ┌──────────────┐
 │ pi extension │──┐             │ Auth                  │       ┌──│ pi extension │
 └──────────────┘  │  ciphertext │ Postgres (RLS)        │       │  └──────────────┘
 ┌──────────────┐  ├────────────▶│   accounts, devices,  │◀──────┤  ┌──────────────┐
 │ CC hook/CLI  │──┘   + index   │   sessions, chunks    │       └──│ OpenCode     │
 └──────────────┘                │ Storage (chunks)      │          │ plugin       │
        │                        │ Realtime (new chunks) │          └──────────────┘
   sync core: crypto,            │ Edge Functions        │
   chunking, adapters            └───────────────────────┘
```

One process per machine talks to the network: the `agentsessionvault` daemon (the CLI in daemon mode). It holds the keys, does all crypto and format work, watches session files and runs push and pull. Harness integrations (the Pi extension, later the Claude Code hooks and OpenCode plugin) are thin clients. They talk to the daemon over a Unix socket (`$XDG_RUNTIME_DIR/agentsessionvault.sock`, or under the state directory, mode 0600) to nudge a push after a turn, show status, and pass through `/vault` commands. They never see keys or tokens. The daemon lives as long as the harnesses using it. The first harness client starts it, every client keeps a socket connection open, and the daemon pushes what's pending and exits shortly after the last client disconnects. Two Pi windows share one daemon, so the passphrase is only needed once while either is open. Nothing syncs while no harness is running, and the daemon catches up on its next start.

`agentsessionvault daemon` runs the daemon in the foreground, outside any harness, until it's stopped. It counts as a client itself, so it stays up regardless of harness connections, and it asks for the passphrase on the terminal if `AGENTSESSIONVAULT_PASSPHRASE` isn't set. The other CLI commands (`push`, `pull`, `status`, ...) are socket clients like the harness integrations. This is what milestone 2 uses before the Pi extension exists, and it stays useful for debugging. It is not a service install.

The server checks auth and row ownership and stores bytes. Edge Functions only exist for things RLS can't express: the storage quota and purging deleted objects.

## Monorepo layout

pnpm workspaces, TypeScript everywhere. Pi extensions are TypeScript already, OpenCode plugins are too, and WebCrypto works in Node, Bun and the browser.

Runtime: the CLI and daemon are a single executable compiled with `bun build --compile`. One file is easy to drop onto a VM. The Pi extension is TypeScript loaded through jiti, inside either Node (Pi's npm package, Node >= 22.19) or Bun (Pi's standalone binary), so it only uses `node:` built-ins for the socket and has no other dependencies. `packages/crypto` only uses WebCrypto, so it also runs in a browser for a later viewer.

```
agentsessionvault/
├── supabase/
│   ├── config.toml
│   ├── migrations/          # schema, RLS policies, storage policies
│   ├── functions/           # edge functions: upload-url (quota), purge
│   └── tests/               # pgTAP tests for RLS
├── packages/
│   ├── crypto/              # KDF, key wrapping, chunk encryption. No I/O.
│   ├── format/              # neutral session schema + validation
│   ├── sync/                # sync engine: local state, chunking, push/pull, merge
│   ├── client/              # typed Supabase client (auth, tables, storage)
│   ├── adapter-pi/          # native Pi JSONL <-> entries <-> neutral
│   ├── adapter-claude-code/ # later
│   └── adapter-opencode/    # later
├── apps/
│   ├── pi-extension/        # /vault commands, lifecycle hooks
│   ├── cli/                 # login, setup, status, a daemon for harnesses without plugins
│   └── opencode-plugin/     # later
└── docs/
```

Rules:

- `crypto` and `format` have no dependencies on Supabase or any harness. They're the parts worth testing hardest and the parts a third party would audit.
- Adapters only translate. They don't know about the network.
- Only the daemon reads or writes the local state directory (`~/.local/share/agentsessionvault/`). The CLI's other commands and the harness clients go through the socket.
- Generated database types come from `supabase gen types` into `packages/client`.

## Key hierarchy

Two layers of keys, the same pattern password managers use.

```
passphrase ──PBKDF2(salt)────▶ passphrase key ──┐
recovery key (random, shown once) ──────────────┴─ unlocks ─▶ account key (random)
                                                                    │ locks
                                                                    ▼
                                                   one session key per session (random)
                                                                    │ encrypts
                                                                    ▼
                                                                 chunks
```

- The account key is random and never leaves a client unencrypted. The database stores two encrypted copies of it, one locked with the passphrase key and one with the recovery key. Both are useless without the passphrase or the recovery key.
- The passphrase key comes from the passphrase via PBKDF2-HMAC-SHA256, a deliberately slow hash that makes guessing passphrases from a stolen database expensive. It's the only such function WebCrypto has, so it runs in Node, Bun and a browser without a third-party crypto library. Salt (16 random bytes) and iteration count live on the account row so they can be raised later. Start with 600,000 iterations.
- PBKDF2 resists GPU guessing less well than Argon2 or scrypt, so the passphrase has to carry more weight: `/vault setup` offers a generated passphrase and refuses anything under 16 characters. The passphrase is never used as a Supabase Auth password.
- The account key and the recovery key are never used directly. Each purpose gets its own subkey via HKDF-SHA256 with a label (`wrap-session-key`, `encrypt-meta`, `project-tag`, `wrap-account-key`), so one key never does both encryption and HMAC.
- Every session gets its own random session key, stored on the session row locked with the account key. Changing the passphrase or rotating the account key then only re-locks small keys, it never re-encrypts chunks. It also keeps sharing a single session possible later.
- Locking and chunk encryption are both AES-256-GCM via WebCrypto (12-byte random nonce, 128-bit tag), so there's one primitive to get right. Every encryption has AAD that binds it to its place: `user_id`, the row id, the purpose and the key version for wrapped keys and metadata, and the fields listed under Storage layout for chunks.
- No decryption key is ever stored on the device. Each time the daemon starts, it gets the passphrase, fetches the locked account key from the server, unlocks it, and keeps it in memory only. PBKDF2 at 600,000 iterations costs well under a second, so this happens once per daemon start. No keychain is involved.
- The only thing persisted is the Supabase refresh token, in a 0600 file in the state directory, so the daemon can sign in again without an emailed code every time. It's a bearer credential, not a key. On its own it only gets you ciphertext, and revoking the device kills it.
- Getting the passphrase: `AGENTSESSIONVAULT_PASSPHRASE` if it's set, otherwise a prompt in Pi's UI. How the variable gets filled (password manager, `op run`, typing it in) is up to the caller.
- Only the daemon gets the passphrase:
  - The extension reads the variable and deletes it from `process.env` when it loads, before any tool can run, so nothing the agent starts inherits it.
  - It hands the passphrase to the daemon over the daemon's stdin, or over the socket if the daemon is already running. Never through argv or the daemon's environment, which other processes can read.
  - The daemon keeps it only long enough to unlock the account key, then drops it.
- Known limit: an environment variable set when the harness launched stays in that process's initial environment block, even after deleting it from `process.env`. Any process running as the same user can still read it (`/proc/<pid>/environ` on Linux, `ps eww` on macOS), and an agent with a shell runs as the same user. The UI prompt avoids that. It's a documented limitation, and like a compromised device it's outside the threat model.

Adding a device: sign in with Supabase Auth, type the passphrase (or the recovery key), done. The device registers itself in `devices` so it shows up in `/vault devices`.

Removing a device: mark it revoked. `agentsessionvault devices revoke <id>` (later `/vault devices`) does that from another unlocked device. A trigger records `revoked_at` and `revoked_by`, refuses to reactivate a revoked device, and deletes the device's Auth session so its refresh token stops working. Devices are never deleted while they have chunks: `chunks.device_id` blocks it, so every chunk keeps a record of where it came from. Deleting the whole account still removes everything. Each device row records the Supabase Auth session it signed in with, and every RLS policy checks that the JWT's `session_id` claim belongs to an active device. Revocation therefore takes effect immediately, including for access tokens that are already issued, and needs no Edge Function. `auth_session_id` is unique, so a revoked session can't register itself again. The device still holds the account key for what it already downloaded, and whoever has it can sign in again by email and register as a new device. That's inside the "compromised device" limit of the threat model: the email account is the real gate, and `/vault rotate` is the answer.

Sign-ins that haven't refreshed for 7 days end, so an unused machine has to log in again. Supabase's own session limits need the Pro plan, so an hourly `pg_cron` job (`private.end_idle_sessions`) deletes those Auth sessions instead. The device row stays `active` but is dead, since its sign-in is gone. Each login creates a new device row, which keeps the history simple but means a machine that logs in often has several. Revoking or replacing them automatically comes later.

If the device was stolen rather than retired, `/vault rotate` creates a new account key and re-locks every session key with it. This is weaker than it sounds: the session keys themselves don't change, so a thief who already unlocked them can read old chunks and also any future chunks of those sessions, if they ever get at the ciphertext again. Fixing that means starting a new session key for each live session on rotation, which the `key_id` in the chunk header leaves room for. Both `/vault rotate` and that fix come after the PoC.

Changing the passphrase: `agentsessionvault passphrase` (later `/vault passphrase`) asks for the current passphrase, or the recovery key with `--recovery`, which makes it the reset for a forgotten passphrase. The daemon only keeps subkeys in memory, so it unlocks the account key again to re-lock it. It then replaces `kdf` and `account_key_by_pass` with a fresh salt, but only if the salt is unchanged since it read the row, so two devices changing it at once can't clobber each other. Other devices keep working until they next unlock. For now it only re-locks the same account key, which is enough when you just want a different passphrase. It does nothing if the old passphrase leaked, because whoever had it (and a copy of the old row, or the account key) still has the account key. In the future the command needs to rotate: create a new account key, re-lock every session key and re-encrypt all metadata with it, and offer a new recovery key. That's the same work as `/vault rotate`, and it should share the code.

Later, maybe: approving a new device from an existing one (QR code or short code) instead of typing the passphrase. That needs a key pair per device and an approval flow, and v1 doesn't need it.

## Data model

The database knows that sessions and chunks exist and who owns them. It doesn't know what's in them. Titles, paths, cwd, model names and the project's git remote all live inside ciphertext.

```sql
accounts (
  user_id            uuid primary key references auth.users,
  kdf                jsonb not null,      -- {alg: "pbkdf2-sha256", iterations, salt}
  account_key_by_pass jsonb not null,     -- envelope: {key_id, algorithm, nonce, data, tag}
  account_key_by_recovery jsonb not null, -- envelope
  account_key_version int not null default 1,
  created_at         timestamptz not null default now()
)

devices (
  id             uuid primary key,
  user_id        uuid not null references accounts,
  auth_session_id uuid not null,           -- the JWT session_id claim, checked by RLS
  name_enc       jsonb not null,           -- envelope, encrypted with the account key
  status         text not null,            -- active | revoked
  last_seen_at   timestamptz
)

projects (
  id           uuid primary key,
  user_id      uuid not null references accounts,
  project_tag  bytea not null,             -- HMAC(key derived from the account key, normalised git remote or path)
  meta_enc     jsonb not null,             -- envelope: remote URL, display name
  unique (user_id, project_tag)
)

sessions (
  id             uuid primary key,         -- Pi's session id when it's a UUID, else random
  user_id        uuid not null references accounts,
  project_id     uuid references projects,
  harness        text not null,            -- pi | claude-code | opencode
  session_key    jsonb not null,           -- envelope, locked with the account key
  account_key_version int not null,
  meta_enc       jsonb not null,           -- envelope: title, original cwd, created_at, model
  head_seq       int not null default 0,
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
)

chunks (
  session_id   uuid not null references sessions,
  seq          int not null,
  user_id      uuid not null references accounts,  -- denormalised so RLS needs no join
  object_name  text not null,              -- random, see Storage layout
  kind         text not null,              -- append | snapshot
  device_id    uuid not null references devices,
  size         int not null,
  created_at   timestamptz not null default now(),
  primary key (session_id, seq)
)
```

RLS on every table is `user_id = (select auth.uid())` plus the active-device check, granted `to authenticated` only, with one policy per operation. The active-device check is a `security definer` function in a non-exposed `private` schema, so policies on `devices` don't recurse. Two exceptions skip the device check, because they happen before a device exists: inserting and reading your own `accounts` row (setup and unlock), and a session registering itself as an active device. Column-level grants keep `user_id`, `head_seq` and other server-owned columns out of client updates.

`chunks` carries its own `user_id` so the policy needs no join. Clients can only select from it. Inserts go through `commit_chunk(session_id, seq, object_name, kind, size)`, a `security definer` function with `set search_path = ''`. It takes the device from the JWT rather than an argument, locks the session row, requires `seq = head_seq + 1` (otherwise it raises `23505`, like a unique violation), checks the object name is `<user_id>/<session_id>/<seq>-<random>.bin`, inserts the row and bumps `head_seq`. Foreign keys cascade on delete so removing an account removes its rows, and the purge function removes its objects through the Storage API.

The block above is shorthand. The migrations follow the SQL style guide: lowercase keywords, quoted identifiers, semicolons.

`harness` stays in plain text because the server needs nothing else to route conversions later, and hiding it buys little. I could be talked out of that.

This is more than "user info and salts", deliberately. Sessions and chunks need an index somewhere, and the alternative (one encrypted manifest object per account, as `ersintarhan/pi-sync` does) turns every push into a read-modify-write on a single object with no transactions. Rows with a unique `(session_id, seq)` give atomic appends and conflict detection for free. What leaks is counts, sizes and timestamps, which the storage bucket leaks anyway.

## Storage layout

One private bucket, `sessions`:

```
<user_id>/<session_id>/<seq>-<random>.bin
```

The random suffix is stored on the chunk row as `object_name`. Without it, a device that uploads `<seq>.bin` and dies before inserting the row would leave that path occupied and block every other device at that `seq`.

Storage RLS: the first path segment has to equal `auth.uid()` for reads. Uploads only go through signed upload URLs from the `upload-url` Edge Function, which checks the user's total against the quota first. RLS can't enforce a per-user total, and the `size` on a chunk row is whatever the client claims.

`upload-url` takes `{session_id, seq, size}` and checks the token itself (`auth.getUser`, so it works with asymmetric signing keys and is deployed with `--no-verify-jwt`). It checks for an active device, that the session is visible to the caller and `seq = head_seq + 1` (409 otherwise, so a losing device stops before uploading). It then checks the quota through `storage_used`, an RPC only the service role can execute, and picks the object name itself. Parallel calls can both pass the quota check, and objects without a row aren't counted until cleanup. Both are bounded by the 2 MiB object limit.

A chunk object is:

```
magic "ASV1" | version u8 | alg u8 | key_id u8 | nonce (12 bytes) | AES-256-GCM(session key, gzip(payload), aad)
aad = header | user_id | session_id | seq | kind
```

The AAD binds a chunk to its place, so the server can't swap or reorder chunks without decryption failing.

`payload` for a Pi `append` chunk is a run of raw native JSONL lines. A `snapshot` chunk is the whole file. Each payload is stored native first, because that's lossless and lets Pi sync work without the neutral format being finished. Clients derive the neutral form when they need it.

Aim for chunks between 4 KiB and 1 MiB. Supabase's standard upload covers that. Huge tool outputs get their own chunk. Resumable (TUS) uploads can come later if they turn out to matter.

Quota: 100 MB of stored chunks per user.

## Sync protocol

Local state lives in `~/.local/share/agentsessionvault/`, one small JSON file per session, written atomically: the remote `session_id`, the last `seq` pulled and the byte offset of the local file already uploaded. The set of entry ids seen is rebuilt from the session file itself. Plain JSON is enough for the PoC, and `bun:sqlite` can take over if it isn't.

Push, triggered by the daemon watching the session directories and by nudges from the Pi extension after each turn and on shutdown, debounced to a few seconds. The extension only makes sync quicker. Sessions written without it still get pushed:

1. Read the local file from the stored offset. Hold back the last line if it doesn't end in `\n`, since Pi may still be writing it.
2. If the file shrank or the bytes before the offset changed (a migration or rewrite), push a `snapshot` instead of an `append`.
3. Encrypt as chunk `head_seq + 1`, get a signed upload URL from the `upload-url` function, upload the object, then insert the `chunks` row and bump `sessions.head_seq` in one RPC. The row is the commit point. An object without a row is garbage and gets cleaned up.
4. If the insert hits the unique key, another device got there first. Pull, then retry.

Pull, triggered by Realtime inserts on `chunks` for my sessions, on startup, and from `/vault pull`:

1. Fetch chunk rows with `seq > last_pulled`, download, decrypt.
2. For Pi, every line is an entry with an `id` and `parentId`. Append the entries whose `id` isn't known locally. Because the format is a tree, two devices continuing the same session just produce two branches, which Pi already knows how to show.
3. A `snapshot` replaces the merged view: rebuild from the snapshot plus the later appends, and keep any local entries not in it.

Local file placement (since milestone 3; in Pi's `--<cwd>--/<timestamp>_<id>.jsonl` layout, or an explicit `--out`): a pulled session is written under the local directory that matches its project. Matching goes by `project_tag` (git remote first, path relative to `$HOME` as the fallback). If no local checkout matches, the session goes to an `_unmapped/` folder and `/vault map` fixes it later. Paths inside entries are left alone in v1. Rewriting tool arguments is how you corrupt a transcript.


Project identity, decided:

- One project per git remote. The remote of the session's `cwd` (`git -C <cwd> remote get-url origin`), normalised so `git@github.com:a/b.git`, `ssh://git@github.com/a/b` and `https://github.com/a/b` are the same: host plus path, lowercased host, no `.git`, no user or scheme. A monorepo opened in a subdirectory is the same project as its root; finer splits can come later.
- Without a remote (no git, no `origin`, or the `cwd` no longer exists, as with old sessions), the identity is the `cwd` relative to `$HOME`, prefixed so it can't collide with a remote (`path:repos/x`). Paths outside `$HOME` stay absolute.
- `project_tag` is the HMAC of that identity with the `project-tag` subkey. `projects.meta_enc` holds the identity and a display name (the last path segment).
- On pull, in order: a `map` from `<state>/projects.json`; the session's original `cwd` if it exists here and resolves to the same project (so a session from a subdirectory lands back in it); a checkout from the local index. The index maps `project_tag` to a checkout on this machine (the git top level), built from Pi's session directories: each belongs to the `cwd` whose name it carries, taken from a session header in it, since pulled sessions keep another machine's `cwd`. Sessions without a project (pushed before projects existed) go back to their original `cwd`. A match puts the session in that checkout's Pi directory. Otherwise it goes to `_unmapped/<name>/` until `map` attaches the project to a checkout and moves its sessions. `map` only moves sessions out of `_unmapped/`, never ones already placed.

Deletes: `/resume` delete in Pi removes the file. The daemon notices and sets `deleted_at`. Other devices move their copy to the trash, they don't delete it outright. Objects get purged after 30 days.

## Harness-neutral format (later, but shapes v1)

Not part of v1's critical path. It's still written down now so the native-first choice above doesn't paint us into a corner.

- A session is a tree of entries: `{id, parentId, ts, role, parts[]}`, with parts like `text`, `thinking`, `tool_call`, `tool_result`, `image`, `compaction`, plus an `extensions` bag keyed by harness for anything without a neutral equivalent.
- Every adapter implements `toNeutral(native)` and `fromNeutral(neutral, target)`. Converting back to the original harness always uses the stored native chunks, never the neutral copy, so the round trip is exact.
- Converting across harnesses loses information: thinking signatures, tool schemas that don't exist on the other side, provider-specific compaction. The adapter has to say what it dropped. `session-migrate` has already mapped most of these formats and is worth reading before writing ours.
- Claude Code can feed sessions in through hooks (like `npow/session-sync`) or the CLI daemon tailing `~/.claude/projects/`. OpenCode has a plugin API. Both need checking against current versions before we commit to either.

## Client UX (Pi)

```
/vault login          # Supabase Auth, emailed one-time code or link (works on headless VMs)
/vault setup          # first device: passphrase, prints recovery key
/vault unlock         # extra device: passphrase (prompt or env var) or recovery key
/vault status         # per session: synced, pending, conflicted
/vault pull
/vault devices        # list, revoke
/vault passphrase     # new passphrase (--recovery to reset a forgotten one)
/vault rotate         # new account key after losing a device
/vault map            # attach unmapped sessions to a local project
```

Once set up, sync just runs. Failures go to a status line and never block the agent. If the daemon isn't reachable, the extension shows that in the status line and Pi carries on as normal.

## Standards and deviations

Checked against Supabase's *Secure Coding: Encrypted Data in Database*, *Security and Privacy*, *Code Standards* and *SQL Style Guide* in Notion.

Followed:

- AES-256-GCM only, with random nonces, and far less than 4 GB under any one key (one key per session, 100 MB per user).
- No third-party crypto libraries. `packages/crypto` uses WebCrypto and nothing else.
- Keys are random bytes. Strings and UUIDs are never keys, and the passphrase only ever goes through the KDF.
- Encrypted values in the database are JSON envelopes with a `key_id`, not opaque binary.
- Keys are not stored in files.
- Schema changes only through migrations, in the SQL style.
- 80% test coverage overall and 95% on new code, CI green before merge, a protected default branch, Dependabot on.
- Secrets are never logged. The Supabase secret key exists only inside Edge Functions, and clients ship the publishable key.

Deviations, on purpose:

- Chunk objects use a binary header instead of the JSON envelope, because base64 would cost a third of the quota. The header still names the algorithm and the key.
- The KDF is PBKDF2, where the standard names bcrypt, scrypt and Argon2 for human-chosen secrets. PBKDF2 is the only one available natively in a browser, and a browser viewer is wanted later.

## Open questions

- Is the metadata in `chunks` and `sessions` acceptable, or do I want padding and batching to blur sizes and timing?
  Answer: metadata is acceptable
- Free tier limits: Supabase Storage size and egress, Realtime connections. Which ones do heavy users hit first?
  Answer: 100 MB of storage per user and no cap on the number of users for now. If the free tier's Storage allowance is 1 GB (to check), that is about 10 full users.
- Self-hosting: the whole thing should run on a self-hosted Supabase. Is that worth testing in CI from the start?
  Answer: I want to use hosted supabase
- Should the CLI daemon be the only thing that talks to the network, with the Pi extension as a thin client? That makes multi-harness simpler and Pi-only setup harder.
  Answer: yes. The daemon is the only networked process, and the extension starts it if needed.
- Daemon lifecycle: should it only be started on demand by the extension, or also installable as a launchd / systemd user service so sessions sync with no harness open?
  Answer: the daemon starts and stops with the harness. No service install.
- Business side: hosted for others, or a personal tool that happens to be open source? The answer changes how much effort goes into the auth flows, quotas and billing.
  Answer: Let's go with hosted for others, but I suspect I will be the only user.
- With open signups the project holds other people's data. Does that need a privacy note and an account deletion command before anyone else signs up?
  Proposal: yes. Keep signups closed until both exist.
- Local development: the Supabase CLI's local stack still needs Docker. pgTAP tests run against the hosted project (`pnpm test:db`), and `pnpm test:db:local` gives a quick approximation in PGlite with stubbed `auth`/`storage` schemas and a minimal pgTAP shim.
- Email: the default Supabase sender is fine for the PoC. It needs custom SMTP before others sign up. It only delivers to members of the Supabase organisation, and on the free tier the templates can't be changed without custom SMTP, so the default email has a link and no code. `login` uses PKCE and a one-shot callback server in the daemon on `127.0.0.1` (random port, random path, closed after one use or 10 minutes). The email link redirects there with `?code=`, which only the daemon can exchange because it holds the verifier. `auth.additional_redirect_urls` allows `http://127.0.0.1:*/**`. Pasting still works for headless machines: the link itself (exchanged with `verifyOtp({token_hash})`), or the URL it redirected to (`?code=`, or a session in the fragment). With custom SMTP, the templates should show `{{ .Token }}`.
- Sequence numbers: two devices pushing to one session contend for `head_seq + 1`. Since Pi entries merge by id, a server-assigned cursor would remove the contention.
  Answer: keep sequential for the PoC.

## First milestones

1. `packages/crypto` with test vectors, plus `supabase/` migrations with RLS tests. No harness code yet.
2. CLI: login, setup, unlock, `daemon`, and push/pull of one Pi session file by hand through the socket.
3. Daemon: file watching, Realtime pull, the socket. Projects: populate `projects` and `sessions.project_id` on push, and place pulled sessions by project (see Local file placement), with `_unmapped/` and `map`. Pushing backfills `project_id` for sessions uploaded without one. Then the Pi extension as a thin client: status line, nudges, `/vault` commands.
4. Two machines, one week of daily use. Fix whatever annoys me.
5. Neutral format and the Claude Code adapter, read-only first (view a Pi session's history from Claude Code).
