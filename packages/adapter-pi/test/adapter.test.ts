import { describe, expect, test } from "bun:test";
import {
  NotAPiSessionError,
  completeLinesFrom,
  cwdDirName,
  lineKey,
  lines,
  mergeBytes,
  missingLines,
  parseHeader,
  sessionFileName,
  sessionRelPath,
  sessionTitle,
} from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const header = `{"type":"session","version":3,"id":"01a1d47c-9870-7461-a887-70599c34d8ab","timestamp":"2026-11-13T10:38:17.712Z","cwd":"/Users/bvl/diary"}`;
const e = (id: string, parentId: string | null, extra = "") =>
  `{"type":"message","id":"${id}","parentId":${parentId ? `"${parentId}"` : "null"}${extra}}`;

describe("parseHeader", () => {
  test("reads the session header", () => {
    expect(parseHeader(`${header}\n${e("a", null)}\n`)).toEqual({
      type: "session",
      version: 3,
      id: "01a1d47c-9870-7461-a887-70599c34d8ab",
      timestamp: "2026-11-13T10:38:17.712Z",
      cwd: "/Users/bvl/diary",
    });
    expect(parseHeader(header).id).toBe("01a1d47c-9870-7461-a887-70599c34d8ab");
  });

  test("defaults a missing version to 0", () => {
    expect(parseHeader(`{"type":"session","id":"x","timestamp":"t","cwd":"/"}`).version).toBe(0);
  });

  test("rejects other files", () => {
    expect(() => parseHeader("not json")).toThrow(NotAPiSessionError);
    expect(() => parseHeader(e("a", null))).toThrow(NotAPiSessionError);
    expect(() => parseHeader("null")).toThrow(NotAPiSessionError);
  });
});

describe("completeLinesFrom", () => {
  test("holds back a partial last line", () => {
    const f = enc("a\nb\nc");
    expect(completeLinesFrom(f, 0)).toEqual({ bytes: enc("a\nb\n"), end: 4 });
    expect(completeLinesFrom(f, 2)).toEqual({ bytes: enc("b\n"), end: 4 });
    expect(completeLinesFrom(f, 4)).toEqual({ bytes: enc(""), end: 4 });
  });

  test("takes everything when the file ends in a newline", () => {
    expect(completeLinesFrom(enc("a\nb\n"), 2)).toEqual({ bytes: enc("b\n"), end: 4 });
  });

  test("nothing complete yet", () => {
    expect(completeLinesFrom(enc("abc"), 0)).toEqual({ bytes: enc(""), end: 0 });
  });

  test("rejects offsets past the end", () => {
    expect(() => completeLinesFrom(enc("a\n"), 3)).toThrow(RangeError);
  });
});

describe("merging", () => {
  test("lines drops blanks", () => {
    expect(lines("a\n\n  \nb\n")).toEqual(["a", "b"]);
  });

  test("lineKey", () => {
    expect(lineKey(header)).toBe("session");
    expect(lineKey(e("a", null))).toBe("a");
    expect(lineKey(`{"type":"x"}`)).toBeUndefined();
    expect(lineKey("garbage")).toBeUndefined();
  });

  test("appends only entries with unknown ids", () => {
    const local = `${header}\n${e("a", null)}\n${e("b", "a")}\n`;
    const incoming = `${header}\n${e("a", null)}\n${e("c", "a")}\n${e("c", "a")}\n`;
    expect(missingLines(local, incoming)).toEqual([e("c", "a")]);
  });

  test("keeps id-less lines unless an identical one exists", () => {
    expect(missingLines(`x\n`, `x\ny\ny\n`)).toEqual(["y"]);
  });

  test("two devices continuing a session become two branches", () => {
    const base = `${header}\n${e("a", null)}\n`;
    const devA = `${base}${e("b", "a")}\n`;
    const devB = `${base}${e("c", "a")}\n`;
    const merged = dec(enc(devA)) + dec(mergeBytes(enc(devA), enc(devB)));
    expect(merged).toBe(`${devA}${e("c", "a")}\n`);
    expect(mergeBytes(enc(merged), enc(devB))).toEqual(new Uint8Array());
  });

  test("into an empty file includes the header", () => {
    expect(dec(mergeBytes(new Uint8Array(), enc(`${header}\n${e("a", null)}\n`)))).toBe(`${header}\n${e("a", null)}\n`);
  });

  test("completes a partial last line before appending", () => {
    expect(dec(mergeBytes(enc(`${header}\n${e("a", null)}`), enc(e("b", "a"))))).toBe(`\n${e("b", "a")}\n`);
  });
});

describe("paths", () => {
  test("match Pi's layout", () => {
    expect(cwdDirName("/Users/bvl/diary")).toBe("--Users-bvl-diary--");
    expect(cwdDirName("/Users/bvl/repos/codeberg.org/reprazent/dotfiles/")).toBe(
      "--Users-bvl-repos-codeberg.org-reprazent-dotfiles--",
    );
    const h = parseHeader(header);
    expect(sessionFileName(h)).toBe("2026-11-13T10-38-17-712Z_01a1d47c-9870-7461-a887-70599c34d8ab.jsonl");
    expect(sessionRelPath(h)).toBe(
      "--Users-bvl-diary--/2026-11-13T10-38-17-712Z_01a1d47c-9870-7461-a887-70599c34d8ab.jsonl",
    );
  });
});

describe("sessionTitle", () => {
  const user = (content: unknown) => JSON.stringify({ type: "message", id: "u", message: { role: "user", content } });

  test("prefers the session_info name", () => {
    const text = [header, user("hello"), `{"type":"session_info","id":"i","name":"Named"}`].join("\n");
    expect(sessionTitle(text)).toBe("Named");
  });

  test("falls back to the first line of the first user message", () => {
    expect(sessionTitle([header, "garbage", user([{ type: "image" }, { type: "text", text: "fix it\nplease" }])].join("\n"))).toBe(
      "fix it",
    );
    expect(sessionTitle([header, user("x".repeat(100)), user("second")].join("\n"))).toBe("x".repeat(80));
  });

  test("undefined without either", () => {
    expect(sessionTitle([header, user({}), `{"type":"session_info","id":"i","name":""}`].join("\n"))).toBeUndefined();
  });
});
