import type { Call, Ui } from "../src/flows.ts";

type Answer = string | undefined | boolean | ((signal?: AbortSignal) => Promise<string | undefined>);

/** A Ui that answers from a script, in order, and records what it was asked and told. */
export function scripted(answers: Answer[]) {
  const asked: string[] = [];
  const notes: string[] = [];
  const shown: string[] = [];
  const next = (kind: string, title: string, signal?: AbortSignal): Promise<any> => {
    asked.push(`${kind}: ${title}`);
    if (!answers.length) throw new Error(`no scripted answer for ${kind}: ${title}`);
    const a = answers.shift();
    return typeof a === "function" ? a(signal) : Promise.resolve(a);
  };
  const ui: Ui = {
    notify: (m, t) => notes.push(t && t !== "info" ? `${t}: ${m}` : m),
    input: (title, _p, signal) => next("input", title, signal),
    secret: (title) => next("secret", title),
    select: (title) => next("select", title),
    confirm: (title) => next("confirm", title),
    show: async (title, text) => {
      shown.push(`${title}\n${text}`);
    },
  };
  return { ui, asked, notes, shown };
}

/** A daemon: handlers by method, and a log of calls. */
export function daemon(h: Record<string, (p: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  const call: Call = async <T,>(m: string, p: Record<string, unknown> = {}) => {
    calls.push([m, p]);
    const f = h[m];
    if (!f) throw new Error(`unexpected call ${m}`);
    return (await f(p)) as T;
  };
  return { call, calls };
}

