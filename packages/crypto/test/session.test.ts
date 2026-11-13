import { describe, expect, test } from "bun:test";
import { fromHex } from "../src/bytes.ts";
import { DecryptionError } from "../src/envelope.ts";
import * as s from "../src/session.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const sid = "00000000-0000-4000-8000-000000000002";

describe("session keys and metadata", async () => {
  const k = await s.accountSubkeys(userId, fromHex("44".repeat(32)), 1);

  test("session key wrap round trip, bound to the session", async () => {
    const { raw, envelope } = await s.newSessionKey(k, sid);
    expect(envelope.key_id).toBe("account-key-v1");
    expect(await s.unwrapSessionKey(k, sid, envelope)).toEqual(raw);
    expect(s.unwrapSessionKey(k, "00000000-0000-4000-8000-000000000003", envelope)).rejects.toThrow(DecryptionError);
  });

  test("a different account key cannot unwrap", async () => {
    const { envelope } = await s.newSessionKey(k, sid);
    const other = await s.accountSubkeys(userId, fromHex("55".repeat(32)), 1);
    expect(s.unwrapSessionKey(other, sid, envelope)).rejects.toThrow(DecryptionError);
  });

  test("metadata is bound to its column", async () => {
    const env = await s.sealMeta(k, sid, "sessions.meta_enc", { title: "hi" });
    expect(await s.openMeta(k, sid, "sessions.meta_enc", env)).toEqual({ title: "hi" });
    expect(s.openMeta(k, sid, "projects.meta_enc", env)).rejects.toThrow(DecryptionError);
  });

  test("metadata key cannot unwrap session keys", async () => {
    const env = await s.sealMeta(k, sid, "sessions.session_key", "x");
    expect(s.unwrapSessionKey(k, sid, env)).rejects.toThrow(DecryptionError);
  });

  test("project tags are deterministic per account", async () => {
    const t = await s.projectTag(k, "github.com/reprazent/agentsessionvault");
    expect(await s.projectTag(k, "github.com/reprazent/agentsessionvault")).toBe(t);
    expect(await s.projectTag(k, "github.com/reprazent/other")).not.toBe(t);
    const other = await s.accountSubkeys(userId, fromHex("55".repeat(32)), 1);
    expect(await s.projectTag(other, "github.com/reprazent/agentsessionvault")).not.toBe(t);
  });
});
