# agentsessionvault

End-to-end encrypted sync for coding agent sessions, on Supabase. See [docs/spec.md](docs/spec.md).

Status: milestone 2. The CLI and daemon can sign in, set up or unlock an account, and push and pull Pi sessions by hand. No file watching, Realtime or Pi extension yet.

## Using the CLI

Run it from the repo with bun, or build the single binary (`pnpm --filter @agentsessionvault/cli build`, output in `apps/cli/dist/`):

    alias asv='bun apps/cli/src/main.ts'

Everything goes through the daemon, so start it first and leave it running in its own terminal:

    asv daemon

It asks for the passphrase on start when there's an account, or reads `AGENTSESSIONVAULT_PASSPHRASE`. Then, in another terminal:

    asv login you@example.com    # click the link in the email (or paste it, see below)
    asv setup                    # first device: passphrase, prints the recovery key
    asv unlock                   # other devices (--recovery for the recovery key)
    asv passphrase               # new passphrase; --recovery if you forgot the old one
    asv status
    asv push ~/.pi/agent/sessions/<dir>/<file>.jsonl
    asv sessions
    asv pull <session-id>        # into ~/.pi/agent/sessions, or --out <path>
    asv devices

`login` starts a one-shot server on `127.0.0.1` (random port and path) inside the daemon, and the email link redirects there. Click it in a browser on the same machine and the terminal finishes by itself. Sign-in uses PKCE, so the code in that redirect is only useful to this daemon.

On another machine (a VM over SSH, say), copy the link from the email and paste it at the prompt instead. If you already clicked it, paste the address of the page it tried to open. `login --paste` skips the local server entirely. The free tier doesn't allow custom email templates with the default sender, so the email has no code. The default sender also only delivers to members of the Supabase organisation.

While testing, the built-in sender's limit of a few emails per hour runs out quickly. With the daemon running, `pnpm dev:login you@example.com` signs it in without sending an email. It makes the link with the admin API (using the secret key from the logged-in Supabase CLI), creates the user if needed and completes the redirect to the daemon's callback. It respects `AGENTSESSIONVAULT_HOME` and `AGENTSESSIONVAULT_SOCKET`. Dev only, and it doesn't exercise the PKCE email path.

To try a second device on one machine, give it its own state directory and socket:

    AGENTSESSIONVAULT_HOME=/tmp/asv-b AGENTSESSIONVAULT_PI_SESSIONS=/tmp/asv-b/pi asv daemon
    AGENTSESSIONVAULT_HOME=/tmp/asv-b asv login you@example.com

Other settings: `AGENTSESSIONVAULT_SOCKET`, `AGENTSESSIONVAULT_SUPABASE_URL`, `AGENTSESSIONVAULT_PUBLISHABLE_KEY`. State lives in `~/.local/share/agentsessionvault/` (`auth.json` holds the sign-in, `sessions/` the sync state per session). No keys are ever written there.

Known limits for now:

- `pull` appends to the session file. Don't pull into a session that's open in Pi.
- Pulled sessions are placed by their original working directory. Matching projects by git remote comes later.
- A session you push from a second device before pulling it there is merged first, so nothing is duplicated. A session that already exists remotely can still re-send some entries in rare cases. Merging by id makes this harmless.

## Setup

Tools are pinned in `mise.toml` (node, bun, pnpm, supabase CLI).

    mise install
    pnpm install

No Docker needed.

## Local testing

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs all `bun test` suites with coverage. Fails under 95% lines or functions. |
| `pnpm typecheck` | Runs `tsc` in every workspace package. |
| `pnpm test:db:local` | Applies `supabase/migrations/` and runs `supabase/tests/database/` in PGlite. |
| `pnpm test:db` | Runs the pgTAP tests against the linked hosted Supabase project, without Docker. |
| `pnpm test:e2e` | Two and three simulated devices against the hosted project: setup, unlock, push, pull, branches, revocation. |
| `pnpm gen:types` | Regenerates `packages/client/src/database.types.ts` from the hosted schema. |

Run a single package or file with bun directly:

    bun test packages/crypto
    bun test packages/crypto/test/chunk.test.ts

### `pnpm test` (crypto)

Covers `packages/crypto`: key derivation, key wrapping, envelopes, the chunk format and recovery keys. The tests check output against an independent `node:crypto` implementation, plus tampering and moving ciphertext between rows.

### `pnpm test:db:local` (approximate)

The Supabase CLI's local stack needs Docker, so this runs in [PGlite](https://pglite.dev) instead (`scripts/db-check-pglite.ts`). It stubs `auth.uid()`, `auth.jwt()`, `storage.buckets`/`objects` and the `supabase_realtime` publication. It also provides a minimal pgTAP shim (`plan`, `lives_ok`, `throws_ok`, `is`, `finish`). The script exits non-zero if any test fails or the count doesn't match `plan()`.

It's a quick feedback loop, not the source of truth. Real Supabase auth, storage and pgTAP can behave differently, and tests may only use the functions the shim provides.

### `pnpm test:e2e` (hosted)

Creates a throwaway user with the admin API and signs devices in with tokens from `generateLink`, so no email is sent. It drives `VaultService` (the daemon's core) through the whole flow and deletes the user and its objects afterwards. The secret key comes from `supabase projects api-keys --reveal` at runtime and is never written to disk. `packages/client/src/supabase.ts` is only covered by this, so it's excluded from the unit coverage threshold.

### Deploying

    supabase db push --remote
    supabase functions deploy upload-url --use-api --no-verify-jwt

`--use-api` bundles the function on Supabase's side, so no Docker. The function checks the token itself.

### `pnpm test:db` (hosted)

Needs a linked project and the database password in `SUPABASE_DB_PASSWORD`. Put it in `mise.local.toml` (gitignored):

    [env]
    SUPABASE_DB_PASSWORD = "..."

Then:

    supabase login
    supabase link --project-ref <ref>
    supabase db push --remote
    pnpm test:db          # asks for confirmation; pass --yes to skip it

`supabase test db --remote` still runs `pg_prove` in Docker, so `scripts/db-test-remote.ts` sends each test file through `supabase db query --remote` instead. That returns a single result set, so the script swaps `finish()` for a read of pgTAP's counters. It reports passed, run and planned counts per file, but not which test failed. Use `pnpm test:db:local` or the SQL editor for that. Test files must end with `select * from finish(); rollback;`.

The tests run in a transaction and roll back, but they still execute against that database. Use a dev project, not production.

`supabase db advisors --remote` should report only one warning: `commit_chunk` is a `security definer` function that signed-in users can call. That's on purpose. It's the only way to append chunks, and it checks the caller itself.
