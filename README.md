# agentsessionvault

End-to-end encrypted sync for coding agent sessions, on Supabase. See [docs/spec.md](docs/spec.md).

Status: milestone 3, in progress. The CLI and daemon sign in, set up or unlock an account, push Pi sessions as they change, pull them by hand and place them by project. A first Pi extension starts the daemon and shows its status. No Realtime pull yet.

## Using the CLI

Run it from the repo with bun, or build the single binary (`pnpm --filter @agentsessionvault/cli build`, output in `apps/cli/dist/`):

    alias asv='bun apps/cli/src/main.ts'

Everything goes through the daemon, so start it first and leave it running in its own terminal:

    asv daemon

It asks for the passphrase on start when there's an account, or reads `AGENTSESSIONVAULT_PASSPHRASE`. Run this way, it stays up until you stop it. Harness clients (the Pi extension, next) start it themselves with `daemon --idle-exit`, in the background with its log in `~/.local/share/agentsessionvault/daemon.log`, and share one daemon per machine. That one exits 30 seconds after the last client disconnects, pushing what's queued first. Then, in another terminal:

    asv login you@example.com    # click the link in the email (or paste it, see below)
    asv setup                    # first device: passphrase, prints the recovery key
    asv unlock                   # other devices (--recovery for the recovery key)
    asv passphrase               # new passphrase; --recovery if you forgot the old one
    asv status
    asv push ~/.pi/agent/sessions/<dir>/<file>.jsonl   # by hand; see auto-push below
    asv sessions
    asv pull <session-id>        # into ~/.pi/agent/sessions, or --out <path>
    asv projects                 # one per git remote, else per path under $HOME
    asv map <project> [dir]      # put a project's sessions in dir (default: here)
    asv devices
    asv devices revoke <id>      # an id prefix is enough

`login` starts a one-shot server on `127.0.0.1` (random port and path) inside the daemon, and the email link redirects there. Click it in a browser on the same machine and the terminal finishes by itself. Sign-in uses PKCE, so the code in that redirect is only useful to this daemon.

On another machine (a VM over SSH, say), copy the link from the email and paste it at the prompt instead. If you already clicked it, paste the address of the page it tried to open. `login --paste` skips the local server entirely. The free tier doesn't allow custom email templates with the default sender, so the email has no code. The default sender also only delivers to members of the Supabase organisation.

While testing, the built-in sender's limit of a few emails per hour runs out quickly. With the daemon running, `pnpm dev:login you@example.com` signs it in without sending an email. It makes the link with the admin API (using the secret key from the logged-in Supabase CLI), creates the user if needed and completes the redirect to the daemon's callback. It respects `AGENTSESSIONVAULT_HOME` and `AGENTSESSIONVAULT_SOCKET`. Dev only, and it doesn't exercise the PKCE email path.

To try a second device on one machine, give it its own state directory and socket:

    AGENTSESSIONVAULT_HOME=/tmp/asv-b AGENTSESSIONVAULT_PI_SESSIONS=/tmp/asv-b/pi asv daemon
    AGENTSESSIONVAULT_HOME=/tmp/asv-b asv login you@example.com

Other settings: `AGENTSESSIONVAULT_SOCKET`, `AGENTSESSIONVAULT_SUPABASE_URL`, `AGENTSESSIONVAULT_PUBLISHABLE_KEY`. State lives in `~/.local/share/agentsessionvault/` (`auth.json` holds the sign-in, `sessions/` the sync state per session). No keys are ever written there.

While unlocked, the daemon pushes on its own: it watches `~/.pi/agent/sessions` and pushes a session 2 seconds after Pi last wrote to it. On unlocking, it first pushes anything that changed while it wasn't running. `asv status` shows what's queued and the last error. Failed pushes retry with backoff.

Known limits for now:

- `pull` appends to the session file. Don't pull into a session that's open in Pi.
- Pulled sessions go to this machine's checkout of the same project: a `map`, the original directory if it's the same project here, or a directory with Pi sessions for the same remote. Otherwise they wait in `~/.pi/agent/sessions/_unmapped/<project>/`, where Pi doesn't list them, until you `asv map` the project.
- A session you push from a second device before pulling it there is merged first, so nothing is duplicated. A session that already exists remotely can still re-send some entries in rare cases. Merging by id makes this harmless.

## Setup

Tools are pinned in `mise.toml` (node, bun, pnpm, supabase CLI).

    mise install
    pnpm install

No Docker needed.

## Pi extension

`apps/pi-extension` connects Pi to the daemon. On session start it connects, or starts `asv daemon --idle-exit` in the background, and keeps the connection open while Pi runs. The footer shows `vault: signed out`, `locked`, `synced`, `2 queued` or `push failed`. After each run it asks the daemon to push the session right away. `/vault` shows the details. Signing in, setup and unlocking still happen in the CLI.

### Installing from GitHub

    pi install git:github.com/Reprazent/agentsessionvault@v0.1.0

The repo root is the Pi package. Pi clones it and runs `npm install`, which installs nothing (there are no runtime dependencies). On first start, the extension downloads the daemon for its own version from the GitHub release `v<version>` (`asv-<os>-<arch>`, macOS and Linux, arm64 and x64), checks it against the release's `SHA256SUMS`, and keeps it in `~/.local/share/agentsessionvault/bin/<version>/`. The footer shows `vault: downloading daemon` meanwhile. If the download fails, it falls back to `asv` on the `PATH`.

That binary is also the CLI: `~/.local/share/agentsessionvault/bin/<version>/asv login you@example.com`, and so on.

### Installing from this checkout (development)

1. `pnpm install` (see Setup). Pi doesn't install dependencies for a local package.
2. Build the CLI binary. The extension prefers `apps/cli/dist/asv` in its checkout over a download:

       pnpm --filter @agentsessionvault/cli build

3. Install the extension as a local Pi package. Pi loads it from the checkout without copying, so edits apply on the next start or `/reload`:

       pi install .

   To try it for one run instead: `pi -e .`. To remove it: `pi remove .`.

4. Start Pi. The footer shows `vault: …`. If a daemon you started by hand with `asv daemon` is already running, the extension uses that one. Otherwise its log is in `~/.local/share/agentsessionvault/daemon.log`. Sign in and unlock with the CLI as above, and the footer follows within a few seconds.

`AGENTSESSIONVAULT_BIN` overrides which binary it starts. Rebuild after changing CLI or daemon code. A daemon that's still running keeps the old code: quit all Pi windows and wait 30 seconds, or stop it with `pkill -f 'asv daemon'`. `/vault` shows the running daemon's version and pid.

To keep a development setup apart from your real one, start Pi with `AGENTSESSIONVAULT_HOME` set (state, socket, log and downloaded binaries). The daemon inherits it. `AGENTSESSIONVAULT_PI_SESSIONS` changes which Pi sessions the daemon watches, not where Pi writes them.

### Releasing

The version lives in the root `package.json` and is shared by the CLI, the daemon and the extension. To release, bump it, commit, and push a tag `v<version>`. `.github/workflows/release.yml` tests, runs `bun scripts/build-release.ts --tag v<version>` (all four binaries plus `SHA256SUMS` in `dist/release/`) and publishes them as a GitHub release. An extension installed at that tag downloads exactly those binaries. Run the script locally to check a build; `AGENTSESSIONVAULT_RELEASES_URL` points the extension at another server for testing.

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
