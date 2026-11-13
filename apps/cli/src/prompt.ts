import { createInterface } from "node:readline";

/**
 * Reads a line from the terminal. With hidden, nothing is echoed. When stdin
 * isn't a terminal (piped input), reads the next line as is.
 */
export function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  if (opts.hidden && process.stdin.isTTY) {
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      // Only echo the question and the final newline.
      if (s.startsWith(question) || s === "\r\n" || s === "\n") out.output.write(s);
    };
  }
  return new Promise((ok, fail) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      ok(answer);
    });
    rl.once("close", () => {
      if (!answered) fail(new Error("no input"));
    });
  });
}
