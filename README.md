# agentsessionvault

Syncs your coding agent sessions between machines, end-to-end encrypted. Sessions are encrypted on your machine with a key derived from your passphrase. The server (Supabase) only stores ciphertext and can't read them. The design is in [docs/spec.md](docs/spec.md).

It works with [Pi](https://github.com/earendil-works/pi) for now. Claude Code and OpenCode are planned.

This is a proof of concept. Sessions push automatically as you work, but pulling a session onto another machine is still a manual `asv pull`. Live pull is next.

## Getting started

You need Pi on macOS or Linux (arm64 or x64). Sign-in works by email link, and for now the project sends those with Supabase's built-in sender, which only delivers to members of the Supabase organisation. Ask to be added before you start.

### 1. Install the extension

    pi install git:github.com/Reprazent/agentsessionvault@v0.2.0

Use the newest tag from the [releases page](https://github.com/Reprazent/agentsessionvault/releases). To upgrade later, run the same command with the new tag.

Start Pi. The first time, the extension downloads the matching `asv` binary from that release and checks it against the release's `SHA256SUMS`. The footer says `vault: downloading daemon` meanwhile, then `vault: signed out`.

### 2. Sign in

    /vault login you@example.com

Click the link in the email on the same machine and Pi carries on by itself. On a machine without a browser (a VM over SSH, say), copy the link from the email and paste it into Pi instead.

### 3. Create your vault, or unlock it

On your first machine, Pi continues with setup. Choose a passphrase of at least 16 characters, or let it generate one. Then it shows a recovery key, once. Store both in a password manager. Nobody can reset the passphrase for you, and without the passphrase or the recovery key your synced sessions are gone for good.

On every other machine, Pi asks for the passphrase instead. That adds the machine as a new device.

The footer then reads `vault: synced`. From then on, every Pi session is pushed a couple of seconds after it changes.

### Day to day

The vault runs a small background daemon that holds your keys. Pi starts it and it stops 5 seconds after the last Pi window closes. Keys only live in memory, so when the daemon starts again, Pi asks for the passphrase once. Press escape to skip it; sessions then just don't sync until you `/vault unlock`.

| Command | |
|---|---|
| `/vault` | Sync status, and the daemon's version |
| `/vault login [email]` | Sign in, then continue with setup or unlock |
| `/vault setup` | Create the vault on your first machine |
| `/vault unlock [--recovery]` | Unlock with the passphrase, or with the recovery key |
| `/vault logout` | Sign out on this machine |
| `/vault restart` | Restart the daemon, e.g. when Pi warns it's older than the extension |

The footer shows `vault: signed out`, `locked`, `synced`, `2 queued` or `push failed`. The daemon's log is `~/.local/share/agentsessionvault/daemon.log`.

### Getting a session onto another machine

For now that takes the CLI (see below): `asv sessions` lists what's in the vault, `asv pull <session-id>` writes it into Pi's session directory, and `/resume` in Pi picks it up. Don't pull into a session that's open in Pi.

## The CLI

The extension's download is also the CLI. It isn't on your `PATH` yet, so either alias it:

    alias asv=~/.local/share/agentsessionvault/bin/0.2.0/asv

or, from a checkout, run `bun apps/cli/src/main.ts`. All commands talk to a running daemon. They don't start one, so keep Pi open or run `asv daemon` in another terminal. A daemon started that way stays up until you stop it, and asks for the passphrase on start (or reads `AGENTSESSIONVAULT_PASSPHRASE`).

    asv login you@example.com    # click the link in the email, or paste it
    asv setup                    # first machine: passphrase, prints the recovery key
    asv unlock                   # other machines (--recovery for the recovery key)
    asv passphrase               # new passphrase; --recovery if you forgot the old one
    asv status
    asv push <session file>      # by hand; the daemon also does this on its own
    asv sessions
    asv pull <session-id>        # into ~/.pi/agent/sessions, or --out <path>
    asv projects                 # one per git remote, else per path under $HOME
    asv map <project> [dir]      # put a project's sessions in dir (default: here)
    asv devices
    asv devices revoke <id>      # an id prefix is enough

`login --paste` skips the local callback server. The callback listens on `127.0.0.1` with a random port and path, and sign-in uses PKCE, so the code in the redirect is only useful to this daemon. The email has no code to type, because the free tier doesn't allow custom templates with the default sender.

While unlocked, the daemon watches `~/.pi/agent/sessions` and pushes a session 2 seconds after Pi last wrote to it. On unlocking, it first pushes whatever changed while it wasn't running. Failed pushes retry with backoff, and `asv status` shows what's queued and the last error.

Pulled sessions go to this machine's checkout of the same project: a `map` you made, the original directory if it holds the same project here, or a directory with Pi sessions for the same git remote. Otherwise they wait in `~/.pi/agent/sessions/_unmapped/<project>/`, where Pi doesn't list them, until you `asv map` the project.

A session you push from a second machine before pulling it there gets merged first, so nothing is duplicated. In rare cases an existing session re-sends some entries, which is harmless because entries merge by id.

State lives in `~/.local/share/agentsessionvault/`: `auth.json` holds the sign-in, `sessions/` the sync state per session, `bin/` the downloaded binaries. No keys are ever written there. Other settings: `AGENTSESSIONVAULT_HOME` (the state directory), `AGENTSESSIONVAULT_SOCKET`, `AGENTSESSIONVAULT_PI_SESSIONS` (which Pi sessions the daemon watches), `AGENTSESSIONVAULT_BIN` (which binary the extension starts), `AGENTSESSIONVAULT_SUPABASE_URL` and `AGENTSESSIONVAULT_PUBLISHABLE_KEY`.

## Development

Tools are pinned in `mise.toml` (node, bun, pnpm, the Supabase CLI). No Docker needed.

    mise install
    pnpm install

### Running the extension from a checkout

1. Build the CLI binary. The extension prefers `apps/cli/dist/asv` in its own checkout over a download:

       pnpm --filter @agentsessionvault/cli build

2. Install the checkout as a Pi package. Pi loads it in place, so edits apply on the next start or `/reload`:

       pi install .

   For one run only: `pi -e .`. To remove it: `pi remove .`.

Rebuild after changing CLI or daemon code. A running daemon keeps the old code until it stops: quit all Pi windows and wait 5 seconds, or `pkill -f 'asv daemon'`. `/vault` shows the running daemon's version and pid.

To keep a development setup apart from your real one, start Pi with `AGENTSESSIONVAULT_HOME` set; the daemon inherits it. Set `AGENTSESSIONVAULT_PI_SESSIONS` too, or that daemon watches and pushes your real Pi sessions.

To try a second device on one machine, give it its own state directory:

    AGENTSESSIONVAULT_HOME=/tmp/asv-b AGENTSESSIONVAULT_PI_SESSIONS=/tmp/asv-b/pi asv daemon
    AGENTSESSIONVAULT_HOME=/tmp/asv-b asv login you@example.com

The built-in email sender allows a few emails an hour, which testing uses up quickly. With a daemon running, `pnpm dev:login you@example.com` signs it in without an email. It creates the link with the admin API (using the secret key from the logged-in Supabase CLI), creates the user if needed and completes the redirect to the daemon's callback. It respects `AGENTSESSIONVAULT_HOME` and `AGENTSESSIONVAULT_SOCKET`. It doesn't exercise the PKCE email path.

### How the GitHub install works

The repo root is the Pi package. Pi clones it at the tag and runs `npm install`, which installs nothing because there are no runtime dependencies. The extension, the CLI and the daemon share one version, from the root `package.json`. On first start the extension downloads `asv-<os>-<arch>` for its version from the GitHub release `v<version>`, verifies it against `SHA256SUMS` and keeps it in `~/.local/share/agentsessionvault/bin/<version>/`. If that fails, it falls back to `asv` on the `PATH`. `AGENTSESSIONVAULT_RELEASES_URL` points it at another server for testing.

### Releasing

Releases are automatic. On every push to `main`, `.github/workflows/main.yml` tests, deploys to production (see Deploying) and then runs [semantic-release](https://semantic-release.gitbook.io/). It reads the conventional commits since the last tag: `fix:` makes a patch release, `feat:` a minor one, and `BREAKING CHANGE:` (or `feat!:`) a major one. Other types (`docs:`, `refactor:`, `chore:`) don't release.

For a release, it sets the version in the root `package.json`, builds the four binaries and `SHA256SUMS` with `bun scripts/build-release.ts`, commits `package.json` as `chore(release): v<version> [skip ci]`, tags that commit and publishes the GitHub release with notes and binaries. An extension installed at that tag downloads exactly those binaries. Config: `.releaserc.json`.

`bun scripts/build-release.ts` checks a build locally. `pnpm release:dry` shows what the next release would be (needs `GITHUB_TOKEN`).

### Testing

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

#### `pnpm test` (crypto)

Covers `packages/crypto`: key derivation, key wrapping, envelopes, the chunk format and recovery keys. The tests check output against an independent `node:crypto` implementation, plus tampering and moving ciphertext between rows.

#### `pnpm test:db:local` (approximate)

The Supabase CLI's local stack needs Docker, so this runs in [PGlite](https://pglite.dev) instead (`scripts/db-check-pglite.ts`). It stubs `auth.uid()`, `auth.jwt()`, `storage.buckets`/`objects` and the `supabase_realtime` publication. It also provides a minimal pgTAP shim (`plan`, `lives_ok`, `throws_ok`, `is`, `finish`). The script exits non-zero if any test fails or the count doesn't match `plan()`.

It's a quick feedback loop, not the source of truth. Real Supabase auth, storage and pgTAP can behave differently, and tests may only use the functions the shim provides.

#### `pnpm test:e2e` (hosted)

Creates a throwaway user with the admin API and signs devices in with tokens from `generateLink`, so no email is sent. It drives `VaultService` (the daemon's core) through the whole flow and deletes the user and its objects afterwards. The secret key comes from `supabase projects api-keys --reveal` at runtime and is never written to disk. `packages/client/src/supabase.ts` is only covered by this, so it's excluded from the unit coverage threshold.

#### `pnpm test:db` (hosted)

Needs a linked project and the database password in `SUPABASE_DB_PASSWORD`. Put it in `mise.local.toml` (gitignored):

    [env]
    SUPABASE_DB_PASSWORD = "..."

Then:

    supabase login
    supabase link --project-ref <ref>
    supabase db push --remote
    pnpm test:db          # asks for confirmation; pass --yes to skip it

`supabase test db --remote` still runs `pg_prove` in Docker, so `scripts/db-test-remote.ts` sends each test file through `supabase db query --remote` instead. That returns a single result set, so the script swaps `finish()` for a read of pgTAP's counters. It reports passed, run and planned counts per file, but not which test failed. Use `pnpm test:db:local` or the SQL editor for that. Test files must end with `select * from finish(); rollback;`.

The tests run in a transaction and roll back, but they still run against that database. The only hosted project right now is production, so keep that in mind.

`supabase db advisors --remote` should report only one warning: `commit_chunk` is a `security definer` function that signed-in users can call. That's on purpose. It's the only way to append chunks, and it checks the caller itself.

### Deploying

Production deploys from `main`. After the tests pass, the `deploy` job in `.github/workflows/main.yml` runs:

    supabase link --project-ref "$SUPABASE_PROJECT_ID"
    supabase db push --remote --yes
    supabase functions deploy upload-url --use-api --no-verify-jwt --yes

`db push` only applies migrations production doesn't have yet (it prints them with `--dry-run` first). `--use-api` bundles the function on Supabase's side, so no Docker. The function checks the token itself. The release job runs after the deploy, so a new client never meets an old schema; migrations have to keep the previous release working.

The job runs in the GitHub Environment `production`, which only `main` may deploy to. It holds:

| Name | Kind | |
|---|---|---|
| `SUPABASE_PROJECT_ID` | variable | the project ref |
| `SUPABASE_DB_PASSWORD` | secret | the database password |
| `SUPABASE_ACCESS_TOKEN` | secret | a Supabase personal access token for CI |

The access token needs these permissions (from the Management API's `x-fga-permissions`):

| Permission | Used by |
|---|---|
| `project_admin_read` | `supabase link` |
| `api_gateway_keys_read`, `api_gateway_keys_secret_read` | `supabase link` |
| `storage_config_read` | `supabase link` |
| `database_pooling_config_read` | `supabase link`, for the session pooler's address. Without it `link` still succeeds, but `db push` tries the IPv6-only direct host, which GitHub's runners can't reach. |
| `edge_functions_write` | `supabase functions deploy` |

Migrations use the database password, not the token.

Don't run `db push` against production by hand; merge to `main` instead.
