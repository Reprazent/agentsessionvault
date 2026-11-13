// Runs supabase/tests/database/*.sql against the linked hosted project without
// Docker. `supabase test db --remote` runs pg_prove in a container, so instead
// each file goes through `supabase db query --remote` (one connection, one
// transaction). Only one result set comes back, so finish() is swapped for a
// read of pgTAP's counters before the final rollback.
//
// Extra arguments are passed to the CLI, e.g. `pnpm test:db --yes` to skip the
// confirmation for the hosted project.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const dir = join(repo, "supabase/tests/database");
const tmp = mkdtempSync(join(tmpdir(), "asv-db-test-"));
const extraArgs = process.argv.slice(2);

const FINISH = /select \* from finish\(\);\s*rollback;\s*$/;
const SUMMARY = `reset role;
select "label", "value" from "__tcache__" where "label" in ('plan', 'curr_test', 'failed');
rollback;
`;

let failedFiles = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(dir, name), "utf8");
  if (!FINISH.test(sql)) {
    console.log(`FAIL ${name}: has to end with "select * from finish(); rollback;"`);
    failedFiles++;
    continue;
  }
  const file = join(tmp, name);
  writeFileSync(file, sql.replace(FINISH, SUMMARY));

  const proc = Bun.spawnSync(
    ["supabase", "db", "query", "--remote", "-f", file, "--output-format", "json", ...extraArgs],
    { cwd: repo, stdin: "inherit", stdout: "pipe", stderr: "pipe" },
  );
  const out = proc.stdout.toString();
  let rows: { label: string; value: number }[] | undefined;
  try {
    rows = JSON.parse(out.slice(out.indexOf("{"))).rows;
  } catch {
    // reported below
  }
  if (proc.exitCode !== 0 || !rows) {
    console.log(`FAIL ${name}: query failed`);
    console.log((proc.stderr.toString() + out).trim());
    failedFiles++;
    continue;
  }

  const get = (label: string) => rows!.find((r) => r.label === label)?.value;
  const [plan, ran, failed] = [get("plan"), get("curr_test"), get("failed") ?? 0];
  const ok = plan !== undefined && ran === plan && failed === 0;
  if (!ok) failedFiles++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}: ${(ran ?? 0) - failed}/${ran} passed (planned ${plan})`);
}

if (failedFiles) console.log("\nFor per-test failures, run `pnpm test:db:local` or the file in the SQL editor.");
process.exit(failedFiles ? 1 : 0);
