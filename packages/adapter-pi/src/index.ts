// Pi session files: append-only JSONL. The first line is a `session` header
// ({type, version, id, timestamp, cwd}); every later line is an entry with an
// `id` and `parentId`, forming a tree. This module only translates bytes and
// lines. It does no I/O and knows nothing about the network.

export interface PiHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const NL = 0x0a;

export class NotAPiSessionError extends Error {
  override name = "NotAPiSessionError";
}

/** Parses the header line of a Pi session file. */
export function parseHeader(text: string): PiHeader {
  const first = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  let h: unknown;
  try {
    h = JSON.parse(first);
  } catch {
    throw new NotAPiSessionError("first line is not JSON");
  }
  const o = h as Partial<PiHeader>;
  if (o?.type !== "session" || typeof o.id !== "string" || typeof o.cwd !== "string" || typeof o.timestamp !== "string") {
    throw new NotAPiSessionError("first line is not a Pi session header");
  }
  return { type: "session", version: Number(o.version ?? 0), id: o.id, timestamp: o.timestamp, cwd: o.cwd };
}

/**
 * The complete lines of `file` from `offset` on. A trailing line without a
 * newline is held back, because Pi may still be writing it.
 */
export function completeLinesFrom(file: Uint8Array, offset: number): { bytes: Uint8Array; end: number } {
  if (offset > file.length) throw new RangeError("offset beyond end of file");
  const lastNl = file.lastIndexOf(NL);
  const end = lastNl < offset ? offset : lastNl + 1;
  return { bytes: file.subarray(offset, end), end };
}

/** Splits JSONL text into non-empty lines, without their newlines. */
export function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

/** The merge key of a line: the header is "session", entries use their id. */
export function lineKey(line: string): string | undefined {
  try {
    const o = JSON.parse(line) as { type?: unknown; id?: unknown };
    if (o.type === "session") return "session";
    return typeof o.id === "string" ? o.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The incoming lines that aren't in the local file yet, in their order.
 * Entries are identified by id, so two devices continuing a session just
 * produce two branches. Lines without an id are kept unless an identical
 * line exists.
 */
export function missingLines(localText: string, incomingText: string): string[] {
  const local = lines(localText);
  const keys = new Set<string>();
  const raw = new Set(local);
  for (const l of local) {
    const k = lineKey(l);
    if (k) keys.add(k);
  }
  const out: string[] = [];
  for (const l of lines(incomingText)) {
    const k = lineKey(l);
    if (k ? keys.has(k) : raw.has(l)) continue;
    if (k) keys.add(k);
    raw.add(l);
    out.push(l);
  }
  return out;
}

/**
 * The bytes to append to a local file so it contains the incoming lines.
 * If the local file ends in a partial line, that line is completed first so
 * the appended entries start on a line of their own.
 */
export function mergeBytes(local: Uint8Array, incoming: Uint8Array): Uint8Array {
  const add = missingLines(decoder.decode(local), decoder.decode(incoming));
  if (add.length === 0) return new Uint8Array();
  const needsNl = local.length > 0 && local[local.length - 1] !== NL;
  return encoder.encode((needsNl ? "\n" : "") + add.map((l) => `${l}\n`).join(""));
}

/** Pi's directory name for a working directory: "/a/b" -> "--a-b--". */
export function cwdDirName(cwd: string): string {
  return `--${cwd.replace(/^\/+/, "").replace(/\/+$/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Pi's file name for a session: "<timestamp with - for :.>_<id>.jsonl". */
export function sessionFileName(h: Pick<PiHeader, "id" | "timestamp">): string {
  return `${h.timestamp.replace(/[:.]/g, "-")}_${h.id}.jsonl`;
}

/** Path of a session relative to Pi's sessions directory. */
export function sessionRelPath(h: Pick<PiHeader, "id" | "timestamp" | "cwd">): string {
  return `${cwdDirName(h.cwd)}/${sessionFileName(h)}`;
}

/** A short human title: Pi's session_info name if present, else the first user text. */
export function sessionTitle(text: string): string | undefined {
  let firstUser: string | undefined;
  for (const l of lines(text)) {
    let o: { type?: string; name?: unknown; message?: { role?: string; content?: unknown } };
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type === "session_info" && typeof o.name === "string" && o.name) return o.name;
    if (!firstUser && o.type === "message" && o.message?.role === "user") {
      const c = o.message.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.find((p) => p?.type === "text")?.text : undefined;
      if (typeof t === "string") firstUser = t.split("\n")[0]!.slice(0, 80);
    }
  }
  return firstUser;
}
