# agentsessionvault

End-to-end encrypted sync for coding agent sessions, on Supabase. See [docs/spec.md](docs/spec.md).

Status: milestone 1. The crypto package and database schema exist. There is no `agentsessionvault` CLI or Pi extension yet.

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
| `pnpm test:db` | Runs the pgTAP tests against the linked hosted Supabase project. |

Run a single package or file with bun directly:

    bun test packages/crypto
    bun test packages/crypto/test/chunk.test.ts

### `pnpm test` (crypto)

Covers `packages/crypto`: key derivation, key wrapping, envelopes, the chunk format and recovery keys. The tests check output against an independent `node:crypto` implementation, plus tampering and moving ciphertext between rows.

### `pnpm test:db:local` (approximate)

The Supabase CLI's local stack needs Docker, so this runs in [PGlite](https://pglite.dev) instead (`scripts/db-check-pglite.ts`). It stubs `auth.uid()`, `auth.jwt()`, `storage.buckets`/`objects` and the `supabase_realtime` publication. It also provides a minimal pgTAP shim (`plan`, `lives_ok`, `throws_ok`, `is`, `finish`). The script exits non-zero if any test fails or the count doesn't match `plan()`.

It's a quick feedback loop, not the source of truth. Real Supabase auth, storage and pgTAP can behave differently, and tests may only use the functions the shim provides.

### `pnpm test:db` (hosted)

Needs a linked project:

    supabase login
    supabase link --project-ref <ref>
    supabase db push
    pnpm test:db

The tests run in a transaction and roll back, but they still execute against that database. Use a dev project or branch, not production.
