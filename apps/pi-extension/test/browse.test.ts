import { describe, expect, test } from "bun:test";
import { type Device, type Project, type Session, devices, map, pull, revoke, sessionState, sessions } from "../src/browse.ts";
import type { DaemonStatus } from "../src/vault.ts";
import { daemon, scripted } from "./helpers.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const unlocked: DaemonStatus = { signedIn: true, email: "me@x.io", account: true, unlocked: true };
const locked: DaemonStatus = { ...unlocked, unlocked: false };

const remoteOnly: Session = { id: "aaaaaaaa-1", title: "fix the bug", project: "app", head_seq: 3, updated_at: "2026-11-15T11:50:00Z", deleted: false };
const behind: Session = { id: "bbbbbbbb-2", cwd: "/w/b", head_seq: 5, updated_at: "2026-11-15T09:00:00Z", deleted: false, local: { path: "/s/b.jsonl", pulledSeq: 4 } };
const synced: Session = { id: "cccccccc-3", title: "t", head_seq: 2, updated_at: "2026-11-12T12:00:00Z", deleted: false, local: { path: "/s/c.jsonl", pulledSeq: 2 } };
const gone: Session = { ...synced, id: "dddddddd-4", deleted: true };

test("sessionState", () => {
  const open = new Set(["/s/b.jsonl", "/s/c.jsonl"]);
  expect([remoteOnly, behind, synced].map((s) => sessionState(s, new Set()))).toEqual(["not here", "behind", "synced"]);
  expect([behind, synced].map((s) => sessionState(s, open))).toEqual(["open, behind", "open"]);
});

describe("sessions", () => {
  const list = [remoteOnly, behind, synced, gone];

  test("lists newest first with their state; picking one pulls it and opens it", async () => {
    const opened: string[] = [];
    const d = daemon({ status: () => unlocked, sessions: () => list, pull: (p) => ({ sessionId: p.sessionId, path: "/s/a.jsonl", chunks: 3 }) });
    const { ui, asked, notes } = scripted([]);
    let labels: string[] = [];
    ui.select = async (_t, options) => ((labels = options), options[0]);
    ui.confirm = async () => true;
    await sessions(d.call, ui, async (p) => void opened.push(p), NOW);
    expect(labels).toEqual([
      "fix the bug · app · 10m ago · not here · aaaaaaaa",
      "(untitled) · /w/b · 3h ago · behind · bbbbbbbb",
      "t · no project · 3d ago · synced · cccccccc",
    ]);
    expect(d.calls.at(-1)).toEqual(["pull", { sessionId: "aaaaaaaa-1" }]);
    expect(notes).toEqual(["Pulled 3 chunk(s). Saved to /s/a.jsonl."]);
    expect(opened).toEqual(["/s/a.jsonl"]);
    expect(asked).toEqual([]);
  });

  test("a synced one opens without a pull; an open or unmapped one isn't offered", async () => {
    const opened: string[] = [];
    const run = async (pick: number, status: DaemonStatus, path = "/s/x.jsonl") => {
      const d = daemon({ status: () => status, sessions: () => list, pull: () => ({ sessionId: "x", path, chunks: 1 }) });
      const { ui, notes } = scripted([]);
      let confirmed = 0;
      ui.select = async (_t, o) => o[pick];
      ui.confirm = async () => (confirmed++, true);
      await sessions(d.call, ui, async (p) => void opened.push(p), NOW);
      return { calls: d.calls.map((c) => c[0]), confirmed, notes };
    };
    expect(await run(2, unlocked)).toMatchObject({ calls: ["status", "status", "sessions"], confirmed: 1 });
    expect(await run(1, { ...unlocked, openSessions: ["/s/b.jsonl"] }, "/s/b.jsonl")).toMatchObject({ confirmed: 0 });
    const unmapped = await run(0, unlocked, "/s/_unmapped/app/a.jsonl");
    expect(unmapped.confirmed).toBe(0);
    expect(unmapped.notes[0]).toContain("/vault map");
    expect(opened).toEqual(["/s/c.jsonl"]);
  });

  test("cancelling, an empty vault, and a locked one", async () => {
    const d = daemon({ status: () => unlocked, sessions: () => [gone] });
    const { ui, notes } = scripted([]);
    await sessions(d.call, ui, undefined);
    expect(notes).toEqual(["No sessions in the vault yet."]);

    const e = daemon({ status: () => unlocked, sessions: () => list });
    const s = scripted([undefined]);
    await sessions(e.call, s.ui, undefined);
    expect(e.calls.map((c) => c[0])).not.toContain("pull");

    const l = daemon({ status: () => locked });
    const t = scripted([]);
    await sessions(l.call, t.ui, undefined);
    expect(t.notes).toEqual(["warning: The vault is locked: /vault unlock first."]);
    const o = daemon({ status: () => ({ signedIn: false, unlocked: false }) });
    const u = scripted([]);
    await pull(o.call, u.ui);
    expect(u.notes).toEqual(["warning: The vault is not set up: /vault login first."]);
  });
});

describe("pull", () => {
  test("one by id", async () => {
    let chunks = 2;
    const d = daemon({ status: () => unlocked, pull: (p) => ({ sessionId: p.sessionId, path: "/s/a.jsonl", chunks }) });
    const { ui, notes } = scripted([]);
    await pull(d.call, ui, "aaaa");
    chunks = 0;
    await pull(d.call, ui, "aaaa");
    expect(d.calls[1]).toEqual(["pull", { sessionId: "aaaa" }]);
    expect(notes).toEqual(["Pulled 2 chunk(s). Saved to /s/a.jsonl.", "Already up to date: /s/a.jsonl"]);
  });

  test("everything new, summarised", async () => {
    let r: unknown = { pulled: [], open: [], failed: [] };
    const d = daemon({ status: () => unlocked, pullAll: () => r });
    const { ui, notes } = scripted([]);
    await pull(d.call, ui);
    expect(notes).toEqual(["Pulling…", "Everything is up to date."]);
    r = {
      pulled: [
        { sessionId: "a", path: "/s/a.jsonl", chunks: 1 },
        { sessionId: "b", path: "/s/_unmapped/p/b.jsonl", chunks: 1 },
      ],
      open: ["c"],
      failed: [{ sessionId: "dddddddd-4", error: "boom" }],
    };
    notes.length = 0;
    await pull(d.call, ui);
    expect(notes[1]).toBe(
      [
        "warning: Pulled 2 session(s). /resume lists them.",
        "1 of them belong to projects not on this machine yet; /vault map from a checkout places them.",
        "1 open session(s) have changes from elsewhere; they pull once closed.",
        "dddddddd failed: boom",
      ].join("\n"),
    );
  });
});

describe("devices", () => {
  const list: Device[] = [
    { id: "11111111-a", name: "laptop", status: "active", current: true, last_seen_at: "2026-11-15T11:59:00Z", revoked_at: null },
    { id: "22222222-b", status: "active", current: false, last_seen_at: null, revoked_at: null },
    { id: "33333333-c", name: "old", status: "revoked", current: false, last_seen_at: null, revoked_at: "2026-11-01T12:00:00Z" },
  ];

  test("lists them", async () => {
    const d = daemon({ status: () => unlocked, devices: () => list });
    const { ui, notes } = scripted([]);
    await devices(d.call, ui, NOW);
    expect(notes).toEqual([
      "* laptop · active · seen 1m ago · 11111111\n  (unnamed) · active · seen never · 22222222\n  old · revoked · revoked 14d ago · 33333333",
    ]);
  });

  test("revokes another active one after confirming", async () => {
    const d = daemon({ status: () => unlocked, devices: () => list, revokeDevice: (p) => ({ ...list[1], id: p.id }) });
    const { ui, notes } = scripted([]);
    let options: string[] = [];
    ui.select = async (_t, o) => ((options = o), o[0]);
    ui.confirm = async () => true;
    await revoke(d.call, ui);
    expect(options).toEqual(["(unnamed) · active · 22222222"]);
    expect(d.calls.at(-1)).toEqual(["revokeDevice", { id: "22222222-b" }]);
    expect(notes).toEqual(["Revoked 22222222."]);
  });

  test("nothing to revoke, or not confirmed", async () => {
    const d = daemon({ status: () => unlocked, devices: () => [list[0]] });
    const s = scripted([]);
    await revoke(d.call, s.ui);
    expect(s.notes).toEqual(["No other devices to revoke."]);
    const e = daemon({ status: () => unlocked, devices: () => list });
    const t = scripted(["(unnamed) · active · 22222222", false]);
    await revoke(e.call, t.ui);
    expect(e.calls.map((c) => c[0])).not.toContain("revokeDevice");
  });
});

describe("map", () => {
  const list: Project[] = [
    { id: "pppppppp-1", name: "app", sessions: 2 },
    { id: "qqqqqqqq-2", sessions: 1, local: { dir: "/w/q", how: "map" } },
  ];

  test("maps the picked project to the current directory", async () => {
    const d = daemon({ status: () => unlocked, projects: () => list, map: () => ({ moved: ["/s/x.jsonl"] }) });
    const { ui, notes } = scripted([]);
    let options: string[] = [];
    ui.select = async (_t, o) => ((options = o), o[0]);
    ui.confirm = async () => true;
    await map(d.call, ui, "/w/app");
    expect(options).toEqual(["app · 2 session(s) · not on this machine", "(undecryptable) · 1 session(s) · /w/q (mapped)"]);
    expect(d.calls.at(-1)).toEqual(["map", { project: "pppppppp-1", dir: "/w/app" }]);
    expect(notes).toEqual(["Mapped app to /w/app. Moved 1 session(s); /resume lists them."]);
  });

  test("no projects, cancelled, or not confirmed", async () => {
    const d = daemon({ status: () => unlocked, projects: () => [] });
    const s = scripted([]);
    await map(d.call, s.ui, "/w");
    expect(s.notes).toEqual(["No projects in the vault yet."]);
    const e = daemon({ status: () => unlocked, projects: () => list });
    await map(e.call, scripted([undefined]).ui, "/w");
    await map(e.call, scripted(["(undecryptable) · 1 session(s) · /w/q (mapped)", false]).ui, "/w");
    expect(e.calls.map((c) => c[0])).not.toContain("map");
  });
});
