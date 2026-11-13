import { describe, expect, test } from "bun:test";
import { NotAPiSessionError } from "@agentsessionvault/adapter-pi";
import { appendFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Watcher } from "../src/watcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

/** Pushes "everything up to the current size", like the engine. */
class FakeTarget {
  pushed = new Map<string, number>();
  pushes: string[] = [];
  fail: ((path: string) => Error | undefined) | undefined;
  delayMs = 0;
  async pending(path: string) {
    const size = (await stat(path)).size;
    if (size === 0) throw new NotAPiSessionError("empty");
    return this.pushed.get(path) !== size;
  }
  async push(path: string) {
    const size = (await stat(path)).size;
    await sleep(this.delayMs);
    const e = this.fail?.(path);
    if (e) throw e;
    this.pushes.push(path);
    this.pushed.set(path, size);
  }
}

async function setup(opts: { debounceMs?: number; retryMs?: number; isFatal?: (e: unknown) => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "asv-watch-"));
  const proj = join(dir, "--work-proj--");
  await mkdir(proj);
  const target = new FakeTarget();
  const logs: string[] = [];
  const w = new Watcher({ dir, target, log: (m) => logs.push(m), debounceMs: 50, retryMs: 20, maxRetryMs: 40, ...opts });
  return { dir, proj, target, logs, w };
}

describe("Watcher", () => {
  test("start pushes files with unpushed bytes, skipping others", async () => {
    const { dir, proj, target, logs, w } = await setup();
    await writeFile(join(proj, "a.jsonl"), "x\n");
    await writeFile(join(proj, "empty.jsonl"), "");
    await writeFile(join(proj, "notes.txt"), "x\n");
    await mkdir(join(dir, "_unmapped", "p"), { recursive: true });
    await writeFile(join(dir, "_unmapped", "p", "u.jsonl"), "x\n");
    await writeFile(join(dir, "--a-file--"), "");
    await w.start();
    await until(() => w.status.pending === 0 && target.pushes.length === 1);
    expect(target.pushes).toEqual([join(proj, "a.jsonl")]);
    expect(w.status.lastPush?.path).toBe(join(proj, "a.jsonl"));
    (w as unknown as { fsw: NodeJS.EventEmitter }).fsw.emit("error", new Error("too many files"));
    expect(logs).toContain("watch error: too many files");
    w.close();
    expect(w.status.watching).toBe(false);
  });

  test("a burst of appends becomes one push after the debounce", async () => {
    const { proj, target, w } = await setup();
    await w.start();
    const f = join(proj, "s.jsonl");
    await writeFile(f, "1\n");
    for (let i = 2; i < 6; i++) {
      await sleep(10);
      await appendFile(f, `${i}\n`);
    }
    expect(target.pushes).toEqual([]);
    await until(() => target.pushes.length === 1);
    await sleep(120);
    expect(target.pushes).toEqual([f]);
    expect(target.pushed.get(f)).toBe(10);
    w.close();
  });

  test("changes during a push lead to another push", async () => {
    const { proj, target, w } = await setup({ debounceMs: 10 });
    const f = join(proj, "s.jsonl");
    await writeFile(f, "1\n");
    target.delayMs = 100;
    await w.start();
    await sleep(40);
    await appendFile(f, "2\n");
    w.changed(f);
    await until(() => target.pushes.length === 2 && w.status.pending === 0);
    expect(target.pushed.get(f)).toBe(4);
    w.close();
  });

  test("failures retry with backoff; fatal errors stop until rescanned", async () => {
    const { proj, target, logs, w } = await setup({ isFatal: (e) => (e as Error).message === "locked" });
    const f = join(proj, "s.jsonl");
    await writeFile(f, "1\n");
    let n = 0;
    target.fail = () => (++n <= 2 ? new Error("offline") : undefined);
    await w.start();
    await until(() => target.pushes.length === 1);
    expect(logs.filter((l) => l.includes("offline"))).toHaveLength(2);
    expect(w.status.lastError?.message).toBe("offline");

    target.fail = () => new Error("locked");
    await appendFile(f, "2\n");
    await until(() => logs.some((l) => l.includes("stopped: locked")));
    await sleep(100);
    expect(w.status.pending).toBe(0);
    target.fail = undefined;
    expect(await w.scan()).toBe(1);
    await until(() => target.pushes.length === 2);
    w.close();
  });

  test("flush pushes now, for one file or everything queued", async () => {
    const { proj, target, w } = await setup({ debounceMs: 10_000 });
    await w.start();
    const a = join(proj, "a.jsonl");
    const b = join(proj, "b.jsonl");
    await writeFile(a, "1\n");
    await writeFile(b, "1\n");
    w.changed(a);
    w.changed(b);
    w.changed(join(proj, "..", "outside.jsonl"));
    await w.flush(a);
    expect(target.pushes).toEqual([a]);
    expect(w.status.pending).toBe(1);
    await w.flush();
    expect(target.pushes).toEqual([a, b]);
    expect(w.status.pending).toBe(0);
    // Nothing new: no push.
    await w.flush(a);
    expect(target.pushes).toEqual([a, b]);
    w.close();
    w.changed(a);
    expect(w.status.pending).toBe(0);
  });

  test("other errors from pending propagate", async () => {
    const { proj, target, w } = await setup();
    target.pending = async () => {
      throw new Error("disk on fire");
    };
    await writeFile(join(proj, "a.jsonl"), "1\n");
    await expect(w.start()).rejects.toThrow("disk on fire");
    w.close();
  });

  test("a missing directory scans as empty", async () => {
    const { proj, w } = await setup();
    const w2 = new Watcher({ dir: join(proj, "nope"), target: new FakeTarget(), log: () => {} });
    expect(await w2.scan()).toBe(0);
    void w;
  });
});
