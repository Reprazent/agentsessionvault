import { beforeEach, describe, expect, test } from "bun:test";
import { accountSubkeys, generateKey, parseHeader as parseChunkHeader } from "@agentsessionvault/crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, MemoryServer, NotFoundError, StateStore, SyncEngine, splitLines } from "../src/index.ts";

const USER = "a0000000-0000-4000-8000-000000000001";
const SID = "01a1d47c-9870-7461-a887-70599c34d8ab";
const header = JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-11-13T10:38:17.712Z", cwd: "/work/proj" });
const entry = (id: string, parentId: string | null, text = id) =>
  JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: text } });
const enc = (s: string) => new TextEncoder().encode(s);

let server: MemoryServer;
let accountKey: Uint8Array;

async function device(name: string, o: { maxChunkBytes?: number; maxAttempts?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), `asv-${name}-`));
  const engine = new SyncEngine({
    remote: server.remote(USER, `${name}-device`),
    keys: await accountSubkeys(USER, accountKey, 1),
    stateDir: join(root, "state"),
    sessionsDir: join(root, "sessions"),
    ...o,
  });
  return { root, engine, state: new StateStore(join(root, "state")), file: join(root, "local.jsonl") };
}

beforeEach(() => {
  server = new MemoryServer();
  accountKey = generateKey();
});

describe("splitLines", () => {
  test("groups whole lines up to the limit", () => {
    const out = splitLines(enc("aa\nbb\ncc\n"), 6).map((b) => new TextDecoder().decode(b));
    expect(out).toEqual(["aa\nbb\n", "cc\n"]);
  });
  test("a long line stands alone", () => {
    const out = splitLines(enc("a\nbbbbbbbb\nc\n"), 4).map((b) => new TextDecoder().decode(b));
    expect(out).toEqual(["a\n", "bbbbbbbb\n", "c\n"]);
  });
  test("empty input", () => {
    expect(splitLines(new Uint8Array(), 4)).toEqual([]);
  });
  test("keeps a trailing line without newline", () => {
    expect(splitLines(enc("a\nb"), 100).map((b) => new TextDecoder().decode(b))).toEqual(["a\nb"]);
  });
});

describe("push", () => {
  test("creates the session and pushes complete lines only", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null, "Fix the build")}\n{"partial`);
    const r = await a.engine.push(a.file);
    expect(r.created).toBe(true);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.seq).toBe(1);
    expect(r.chunks[0]!.kind).toBe("append");

    const s = server.sessions.get(SID)!;
    expect(s.head_seq).toBe(1);
    expect(s.harness).toBe("pi");
    expect(JSON.stringify(s.meta_enc)).not.toContain("Fix the build");

    const obj = server.objects.get(server.chunks.get(SID)![0]!.object_name)!;
    expect(parseChunkHeader(obj).keyId).toBe(0);
    expect(new TextDecoder().decode(obj)).not.toContain("e1");

    const st = (await a.state.load(SID))!;
    expect(st.pushedOffset).toBe(enc(`${header}\n${entry("e1", null, "Fix the build")}\n`).length);
    expect(st.pulledSeq).toBe(1);
  });

  test("only new lines, and nothing when nothing changed", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    expect((await a.engine.push(a.file)).chunks).toEqual([]);
    await appendFile(a.file, `${entry("e2", "e1")}\n`);
    const r = await a.engine.push(a.file);
    expect(r.created).toBe(false);
    expect(r.chunks.map((c) => c.seq)).toEqual([2]);
  });

  test("splits large payloads into several chunks", async () => {
    const a = await device("a", { maxChunkBytes: 200 });
    await writeFile(a.file, [header, ...Array.from({ length: 6 }, (_, i) => entry(`e${i}`, null, "x".repeat(60)))].join("\n") + "\n");
    const r = await a.engine.push(a.file);
    expect(r.chunks.length).toBeGreaterThan(2);
    expect(r.chunks.map((c) => c.seq)).toEqual(r.chunks.map((_, i) => i + 1));
  });

  test("a rewritten file becomes a snapshot", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`);
    await a.engine.push(a.file);
    await writeFile(a.file, `${header}\n${entry("e1", null, "migrated")}\n`);
    const r = await a.engine.push(a.file);
    expect(r.chunks).toEqual([expect.objectContaining({ seq: 2, kind: "snapshot" })]);
  });

  test("updates the encrypted title when it changes", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null, "first")}\n`);
    await a.engine.push(a.file);
    const before = server.sessions.get(SID)!.meta_enc;
    await a.engine.push(a.file);
    expect(server.sessions.get(SID)!.meta_enc).toEqual(before);
    await appendFile(a.file, `{"type":"session_info","id":"i1","parentId":"e1","name":"Renamed"}\n`);
    await a.engine.push(a.file);
    expect(server.sessions.get(SID)!.meta_enc).not.toEqual(before);
    expect((await a.engine.sessions())[0]!.title).toBe("Renamed");
  });

  test("rejects files that aren't Pi sessions", async () => {
    const a = await device("a");
    await writeFile(a.file, "hello\n");
    await expect(a.engine.push(a.file)).rejects.toThrow("first line is not JSON");
  });
});

describe("pull", () => {
  test("recreates the session on another device under Pi's layout", async () => {
    const a = await device("a");
    const b = await device("b");
    const content = `${header}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`;
    await writeFile(a.file, content);
    await a.engine.push(a.file);

    const r = await b.engine.pull(SID);
    expect(r.path).toBe(join(b.root, "sessions", "--work-proj--", `2026-11-13T10-38-17-712Z_${SID}.jsonl`));
    expect(r.chunks).toBe(1);
    expect(await readFile(r.path, "utf8")).toBe(content);
    // Fully synced: pushing from b sends nothing.
    expect((await b.engine.push(r.path)).chunks).toEqual([]);
    expect((await b.engine.pull(SID)).chunks).toBe(0);
  });

  test("to an explicit path", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    const out = join(b.root, "elsewhere", "s.jsonl");
    expect((await b.engine.pull(SID, { path: out })).path).toBe(out);
    expect(await readFile(out, "utf8")).toBe(await readFile(a.file, "utf8"));
    // The same path again is a no-op.
    expect((await b.engine.pull(SID, { path: out })).chunks).toBe(0);
    // A new path gets the whole session, and becomes where it lives.
    const out2 = join(b.root, "again.jsonl");
    expect((await b.engine.pull(SID, { path: out2 })).chunks).toBe(1);
    expect(await readFile(out2, "utf8")).toBe(await readFile(a.file, "utf8"));
    expect((await b.state.load(SID))!.path).toBe(out2);
  });

  test("errors reading the local file propagate", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    await expect(b.engine.pull(SID, { path: b.root })).rejects.toThrow("EISDIR");
  });

  test("unknown sessions", async () => {
    const b = await device("b");
    await expect(b.engine.pull(SID)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a missing chunk is an error", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    await appendFile(a.file, `${entry("e2", "e1")}\n`);
    await a.engine.push(a.file);
    server.chunks.get(SID)!.shift();
    await expect(b.engine.pull(SID)).rejects.toThrow("chunk 1 of");
  });

  test("tampered chunks fail to decrypt", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    const name = server.chunks.get(SID)![0]!.object_name;
    server.objects.get(name)![40]! ^= 1;
    await expect(b.engine.pull(SID)).rejects.toThrow("failed to decrypt");
  });
});

describe("two devices", () => {
  test("continuing the same session produces branches on both", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    const bPath = (await b.engine.pull(SID)).path;

    await appendFile(a.file, `${entry("a2", "e1")}\n`);
    await appendFile(bPath, `${entry("b2", "e1")}\n`);
    await a.engine.push(a.file);
    const rb = await b.engine.push(bPath);
    expect(rb.pulled).toBe(1);
    expect(rb.chunks.map((c) => c.seq)).toEqual([3]);
    await a.engine.pull(SID);

    const ids = async (p: string) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l).id).sort();
    expect(await ids(a.file)).toEqual([SID, "a2", "b2", "e1"].sort());
    expect(await ids(bPath)).toEqual(await ids(a.file));
    // Nothing echoes back.
    expect((await a.engine.push(a.file)).chunks).toEqual([]);
    expect((await b.engine.push(bPath)).chunks).toEqual([]);
  });

  test("a commit conflict pulls and retries at the next seq", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    const bPath = (await b.engine.pull(SID)).path;
    await appendFile(a.file, `${entry("a2", "e1")}\n`);
    await appendFile(bPath, `${entry("b2", "e1")}\n`);

    // a commits seq 2 between b's upload and b's commit.
    let once = true;
    server.beforeCommit = async () => {
      if (!once) return;
      once = false;
      server.beforeCommit = undefined;
      await a.engine.push(a.file);
    };
    const rb = await b.engine.push(bPath);
    expect(rb.chunks.map((c) => c.seq)).toEqual([3]);
    expect(await readFile(bPath, "utf8")).toContain('"a2"');
    expect(server.chunks.get(SID)!.map((c) => c.device_id)).toEqual(["a-device", "a-device", "b-device"]);
  });

  test("gives up after maxAttempts conflicts", async () => {
    const a = await device("a", { maxAttempts: 2 });
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    await appendFile(a.file, `${entry("e2", "e1")}\n`);
    server.beforeCommit = () => {
      throw new ConflictError("always");
    };
    await expect(a.engine.push(a.file)).rejects.toBeInstanceOf(ConflictError);
  });

  test("first push of a session another device already created", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await writeFile(b.file, `${header}\n${entry("e1", null)}\n${entry("b2", "e1")}\n`);
    await a.engine.push(a.file);
    const rb = await b.engine.push(b.file);
    expect(rb.created).toBe(false);
    // Only b2 is new; the header and e1 aren't sent again.
    expect(rb.chunks).toHaveLength(1);
    const c = await device("c");
    const text = await readFile((await c.engine.pull(SID)).path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
  });

  test("losing the createSession race is fine", async () => {
    const a = await device("a");
    const b = await device("b");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await writeFile(b.file, `${header}\n${entry("e1", null)}\n`);
    const remote = (b.engine as unknown as { remote: { getSession: (id: string) => Promise<unknown> } }).remote;
    const real = remote.getSession.bind(remote);
    let first = true;
    remote.getSession = async (id: string) => {
      if (first) {
        first = false;
        await a.engine.push(a.file);
        return null;
      }
      return real(id);
    };
    const rb = await b.engine.push(b.file);
    expect(rb.created).toBe(false);
    expect(server.sessions.get(SID)!.head_seq).toBe(1);
  });
});

describe("sessions", () => {
  test("lists decrypted metadata and local state", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null, "Hello there")}\n`);
    await a.engine.push(a.file);
    const [s] = await a.engine.sessions();
    expect(s).toMatchObject({ id: SID, title: "Hello there", cwd: "/work/proj", head_seq: 1, deleted: false });
    expect(s!.local?.path).toBe(a.file);

    const b = await device("b");
    expect((await b.engine.sessions())[0]!.local).toBeUndefined();
  });

  test("survives undecryptable metadata", async () => {
    const a = await device("a");
    await writeFile(a.file, `${header}\n${entry("e1", null)}\n`);
    await a.engine.push(a.file);
    server.sessions.get(SID)!.meta_enc.tag = "AAAAAAAAAAAAAAAAAAAAAA==";
    const [s] = await a.engine.sessions();
    expect(s!.id).toBe(SID);
    expect(s!.title).toBeUndefined();
  });
});

describe("StateStore", () => {
  test("rejects ids that aren't UUIDs", async () => {
    const st = new StateStore(await mkdtemp(join(tmpdir(), "asv-st-")));
    await expect(st.load("../etc/passwd")).rejects.toThrow(TypeError);
  });

  test("propagates errors other than a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "asv-st-"));
    const st = new StateStore(dir);
    await st.save({ sessionId: SID, path: "/x", pushedOffset: 0, prefixHash: "", pulledSeq: 0 });
    await writeFile(join(dir, "sessions", `${SID}.json`), "{broken");
    await expect(st.load(SID)).rejects.toThrow(SyntaxError);
  });
});
