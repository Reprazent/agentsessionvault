// Sessions, pulls, devices and projects from inside a harness: what the CLI
// does, for installs where `asv` isn't on the PATH. Like flows.ts, written
// against the small Ui interface so it can be tested with scripted answers.

import { type Call, type Ui, nextStep } from "./flows.ts";
import type { DaemonStatus } from "./vault.ts";

// The daemon's shapes, as far as the extension reads them. Not imported from
// the CLI: installed from git, only relative imports of plain files work.
export interface Session {
  id: string;
  title?: string;
  cwd?: string;
  project?: string;
  head_seq: number;
  updated_at: string;
  deleted: boolean;
  local?: { path: string; pulledSeq: number };
}
export interface Pulled {
  sessionId: string;
  path: string;
  chunks: number;
}
export interface PullAll {
  pulled: Pulled[];
  open: string[];
  failed: { sessionId: string; error: string }[];
}
export interface Device {
  id: string;
  name?: string;
  status: string;
  current: boolean;
  last_seen_at: string | null;
  revoked_at: string | null;
}
export interface Project {
  id: string;
  name?: string;
  identity?: string;
  sessions: number;
  local?: { dir: string; how: "map" | "found" };
}

/** Switches the harness to a session file; undefined where it can't. */
export type Open = ((path: string) => Promise<void>) | undefined;

const UNMAPPED = "/_unmapped/";

/** Commands below need an unlocked vault; says what to do otherwise. */
async function ready(call: Call, ui: Ui): Promise<boolean> {
  const s = await call<DaemonStatus>("status");
  const step = nextStep(s);
  if (step) ui.notify(`The vault is ${step === "unlock" ? "locked" : "not set up"}: /vault ${step} first.`, "warning");
  return !step;
}

export function sessionState(s: Session, open: Set<string>): string {
  if (!s.local) return "not here";
  if (open.has(s.local.path)) return s.local.pulledSeq < s.head_seq ? "open, behind" : "open";
  return s.local.pulledSeq < s.head_seq ? "behind" : "synced";
}

function age(iso: string, now = Date.now()): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function placed(p: Pulled): string {
  return p.path.includes(UNMAPPED)
    ? `Its project isn't on this machine, so it's in ${p.path}. Pi lists it once you /vault map the project from its checkout.`
    : `Saved to ${p.path}.`;
}

/**
 * Lists the vault's sessions, newest first. Picking one pulls it if this
 * machine is missing anything, then offers to open it.
 */
export async function sessions(call: Call, ui: Ui, open: Open, now = Date.now()): Promise<void> {
  if (!(await ready(call, ui))) return;
  const status = await call<DaemonStatus>("status");
  const opened = new Set(status.openSessions ?? []);
  const list = (await call<Session[]>("sessions")).filter((s) => !s.deleted);
  if (!list.length) return ui.notify("No sessions in the vault yet.");
  const labels = list.map(
    (s) =>
      `${s.title ?? "(untitled)"} · ${s.project ?? s.cwd ?? "no project"} · ${age(s.updated_at, now)} · ${sessionState(s, opened)} · ${s.id.slice(0, 8)}`,
  );
  const pick = await ui.select("Vault sessions (pick one to pull and open it)", labels);
  if (pick === undefined) return;
  const s = list[labels.indexOf(pick)]!;
  let path = s.local?.path;
  if (!s.local || s.local.pulledSeq < s.head_seq) {
    const r = await call<Pulled>("pull", { sessionId: s.id });
    ui.notify(`Pulled ${r.chunks} chunk(s). ${placed(r)}`);
    path = r.path;
  }
  if (!path || path.includes(UNMAPPED) || opened.has(path) || !open) return;
  if (await ui.confirm("Open it?", `${s.title ?? "(untitled)"}\n${s.cwd ?? path}`)) await open(path);
}

/** With an id (or prefix), pulls that session; without one, everything new. */
export async function pull(call: Call, ui: Ui, ref?: string): Promise<void> {
  if (!(await ready(call, ui))) return;
  if (ref) {
    const r = await call<Pulled>("pull", { sessionId: ref });
    return ui.notify(r.chunks ? `Pulled ${r.chunks} chunk(s). ${placed(r)}` : `Already up to date: ${r.path}`);
  }
  ui.notify("Pulling…");
  const r = await call<PullAll>("pullAll");
  const parts: string[] = [];
  if (r.pulled.length) {
    const unmapped = r.pulled.filter((p) => p.path.includes(UNMAPPED)).length;
    parts.push(`Pulled ${r.pulled.length} session(s). /resume lists them.`);
    if (unmapped) parts.push(`${unmapped} of them belong to projects not on this machine yet; /vault map from a checkout places them.`);
  }
  if (r.open.length) parts.push(`${r.open.length} open session(s) have changes from elsewhere; they pull once closed.`);
  for (const f of r.failed) parts.push(`${f.sessionId.slice(0, 8)} failed: ${f.error}`);
  ui.notify(parts.length ? parts.join("\n") : "Everything is up to date.", r.failed.length ? "warning" : "info");
}

export async function devices(call: Call, ui: Ui, now = Date.now()): Promise<void> {
  if (!(await ready(call, ui))) return;
  const list = await call<Device[]>("devices");
  ui.notify(
    list
      .map(
        (d) =>
          `${d.current ? "* " : "  "}${d.name ?? "(unnamed)"} · ${d.status} · ${
            d.revoked_at ? `revoked ${age(d.revoked_at, now)}` : `seen ${d.last_seen_at ? age(d.last_seen_at, now) : "never"}`
          } · ${d.id.slice(0, 8)}`,
      )
      .join("\n"),
  );
}

/** Picks another device and revokes it. */
export async function revoke(call: Call, ui: Ui): Promise<void> {
  if (!(await ready(call, ui))) return;
  const others = (await call<Device[]>("devices")).filter((d) => !d.current && d.status !== "revoked");
  if (!others.length) return ui.notify("No other devices to revoke.");
  const labels = others.map((d) => `${d.name ?? "(unnamed)"} · ${d.status} · ${d.id.slice(0, 8)}`);
  const pick = await ui.select("Revoke which device?", labels);
  if (pick === undefined) return;
  const d = others[labels.indexOf(pick)]!;
  if (!(await ui.confirm(`Revoke ${d.name ?? d.id.slice(0, 8)}?`, "It loses access at once and can't sign in again. What it already downloaded stays there."))) return;
  await call<Device>("revokeDevice", { id: d.id });
  ui.notify(`Revoked ${d.name ?? d.id.slice(0, 8)}.`);
}

/** Puts a project's sessions in the current directory: for projects whose checkout the vault couldn't find. */
export async function map(call: Call, ui: Ui, cwd: string): Promise<void> {
  if (!(await ready(call, ui))) return;
  const list = await call<Project[]>("projects");
  if (!list.length) return ui.notify("No projects in the vault yet.");
  const labels = list.map(
    (p) => `${p.name ?? "(undecryptable)"} · ${p.sessions} session(s) · ${p.local ? `${p.local.dir}${p.local.how === "map" ? " (mapped)" : ""}` : "not on this machine"}`,
  );
  const pick = await ui.select(`Which project is checked out in ${cwd}?`, labels);
  if (pick === undefined) return;
  const p = list[labels.indexOf(pick)]!;
  if (!(await ui.confirm(`Map ${p.name ?? p.id.slice(0, 8)} here?`, `Its sessions on this machine go to ${cwd}, including ones waiting in _unmapped/.`))) return;
  const r = await call<{ moved: string[] }>("map", { project: p.id, dir: cwd });
  ui.notify(`Mapped ${p.name ?? p.id.slice(0, 8)} to ${cwd}.${r.moved.length ? ` Moved ${r.moved.length} session(s); /resume lists them.` : ""}`);
}
