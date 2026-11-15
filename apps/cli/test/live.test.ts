import { expect, test } from "bun:test";
import type { ChunkSubscription, SessionSummary } from "@agentsessionvault/sync";
import { LivePuller } from "../src/live.ts";

const ME = "me";
const at = "2026-11-15T12:00:00Z";

/** A target with a hand-driven subscription and scripted pull outcomes. */
function setup(sessions: SessionSummary[] = [], opts: { open?: string[]; fatal?: boolean } = {}) {
  let sub!: ChunkSubscription;
  let unsubscribed = false;
  const pulls: string[] = [];
  const logs: string[] = [];
  const fail = new Map<string, Error>();
  let open = opts.open ?? [];
  let listFails = false;
  const live = new LivePuller({
    target: {
      subscribe: (s) => ((sub = s), () => void (unsubscribed = true)),
      sessions: async () => {
        if (listFails) throw new Error("offline");
        return sessions;
      },
      pull: async (id, guard) => {
        pulls.push(id);
        const e = fail.get(id);
        if (e) {
          fail.delete(id);
          throw e;
        }
        const path = `/s/${id}.jsonl`;
        guard(path);
        return { sessionId: id, path, chunks: 1, appendedBytes: 10 };
      },
    },
    deviceId: ME,
    openSessions: () => open,
    log: (m) => logs.push(m),
    debounceMs: 0,
    retryMs: 20,
    isFatal: (e) => (e as Error).message === "revoked",
  });
  live.start();
  return {
    live,
    sub: () => sub,
    pulls,
    logs,
    fail,
    setOpen: (o: string[]) => (open = o),
    setListFails: (f: boolean) => (listFails = f),
    unsubscribed: () => unsubscribed,
  };
}

const s = (id: string, head: number, pulled?: number, deleted = false): SessionSummary => ({
  id,
  head_seq: head,
  updated_at: at,
  deleted,
  ...(pulled !== undefined ? { local: { path: `/s/${id}.jsonl`, pulledSeq: pulled, pushedOffset: 0 } } : {}),
});

test("connecting catches up on what's missing; inserts from others pull, our own don't", async () => {
  const t = setup([s("new", 2), s("behind", 3, 2), s("synced", 1, 1), s("gone", 4, undefined, true)]);
  t.sub().onState(true);
  t.sub().onState(true); // repeated: no second catch-up
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  expect(t.pulls.sort()).toEqual(["behind", "new"]);
  expect(t.live.status).toMatchObject({ connected: true, remoteAhead: [], lastPull: { path: expect.stringContaining("/s/") } });

  t.pulls.length = 0;
  t.sub().onInsert({ session_id: "x", seq: 1, device_id: "other" });
  t.sub().onInsert({ session_id: "x", seq: 2, device_id: "other" });
  t.sub().onInsert({ session_id: "y", seq: 1, device_id: ME });
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  expect(t.pulls).toEqual(["x"]);

  t.sub().onState(false, "channel_error");
  expect(t.live.status.connected).toBe(false);
  expect(t.logs).toContain("live pull: disconnected (channel_error)");
  t.sub().onState(false);
  t.pulls.length = 0;
  t.sub().onState(true); // reconnect: catch up again
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  expect(t.pulls.sort()).toEqual(["behind", "new"]);

  t.live.close();
  expect(t.unsubscribed()).toBe(true);
  t.sub().onState(false);
  t.sub().onInsert({ session_id: "z", seq: 1, device_id: "other" });
  await t.live.idle();
  expect(t.pulls).not.toContain("z");
});

test("open sessions wait; they pull when closed", async () => {
  const t = setup([], { open: ["/s/a.jsonl"] });
  t.sub().onInsert({ session_id: "a", seq: 1, device_id: "other" });
  t.sub().onInsert({ session_id: "a", seq: 2, device_id: "other" });
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  t.sub().onInsert({ session_id: "a", seq: 3, device_id: "other" });
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  expect(t.live.status.remoteAhead).toEqual(["/s/a.jsonl"]);
  expect(t.logs.filter((l) => l.includes("open in a harness"))).toHaveLength(1);

  t.live.sessionsChanged(["/s/a.jsonl", "/s/b.jsonl"]); // still open
  await t.live.idle();
  expect(t.live.status.remoteAhead).toEqual(["/s/a.jsonl"]);
  t.setOpen([]);
  t.live.sessionsChanged([]);
  await new Promise((r) => setTimeout(r, 10));
  await t.live.idle();
  expect(t.live.status.remoteAhead).toEqual([]);
  t.live.close();
});

test("failed pulls retry; fatal ones and a failed catch-up don't", async () => {
  const t = setup([s("a", 1)]);
  t.fail.set("x", new Error("fetch failed"));
  t.sub().onInsert({ session_id: "x", seq: 1, device_id: "other" });
  await new Promise((r) => setTimeout(r, 60));
  await t.live.idle();
  expect(t.pulls).toEqual(["x", "x"]);
  expect(t.live.status.lastError?.message).toBe("x: fetch failed");

  t.fail.set("r", new Error("revoked"));
  t.sub().onInsert({ session_id: "r", seq: 1, device_id: "other" });
  await new Promise((r) => setTimeout(r, 60));
  await t.live.idle();
  expect(t.pulls.filter((p) => p === "r")).toEqual(["r"]);

  t.setListFails(true);
  t.sub().onState(true);
  await new Promise((r) => setTimeout(r, 10));
  expect(t.live.status.lastError?.message).toBe("catch-up: offline");
  t.live.close();
});
