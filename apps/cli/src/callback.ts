// One-shot login callback: a tiny HTTP server on 127.0.0.1 and a random port,
// under a random path. The email link redirects here with ?code= (PKCE),
// which only the daemon can exchange, since it holds the verifier. Links that
// carry the session in the URL fragment instead (which browsers don't send)
// get a page that posts the fragment back.

import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

export interface CallbackServer {
  /** Where the email link should redirect. */
  url: string;
  /** Resolves with the full callback URL (query or fragment as query) once it arrives. */
  result: Promise<URL>;
  close(): void;
}

const page = (title: string, body: string, script = "") => `<!doctype html>
<meta charset="utf-8"><title>${title}</title>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; line-height: 1.5">
<h1 style="font-size: 1.4rem">${title}</h1><p id="msg">${body}</p>${script}</body>`;

const FRAGMENT_SCRIPT = `<script>
const h = location.hash.slice(1);
if (h) fetch(location.pathname + "/fragment?" + h, { method: "POST" })
  .then((r) => r.text()).then((t) => { document.querySelector("h1").textContent = t; document.getElementById("msg").textContent = "You can close this tab."; });
else document.getElementById("msg").textContent = "The link didn't include a sign-in. Try asv login again.";
</script>`;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function startCallbackServer(opts: { timeoutMs?: number | undefined; host?: string } = {}): Promise<CallbackServer> {
  const nonce = randomBytes(16).toString("base64url");
  const base = `/callback/${nonce}`;
  const host = opts.host ?? "127.0.0.1";
  let settle!: { ok: (u: URL) => void; fail: (e: Error) => void };
  let done = false;
  const result = new Promise<URL>((ok, fail) => (settle = { ok, fail }));
  result.catch(() => {});

  const finish = (res: ServerResponse, url: URL, status = 200) => {
    const err = url.searchParams.get("error_description");
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      err
        ? page("Sign-in failed", `${escape(err)}. Run <code>asv login</code> again.`)
        : page("Signed in", "You can close this tab and go back to the terminal."),
    );
    done = true;
    settle.ok(url);
    close();
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (done || (url.pathname !== base && url.pathname !== `${base}/fragment`)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (url.pathname === `${base}/fragment`) {
      if (req.method !== "POST") return void res.writeHead(405).end();
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(url.searchParams.get("error_description") ? "Sign-in failed" : "Signed in");
      // Hand it on the way it arrived in the browser: as a fragment.
      const asFragment = new URL(url.pathname, url);
      asFragment.hash = url.search.slice(1);
      done = true;
      settle.ok(asFragment);
      return close();
    }
    const q = url.searchParams;
    if (q.has("code") || q.has("token_hash") || q.has("error_description")) return finish(res, url);
    // Nothing in the query: the session may be in the fragment.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page("Signing in…", "One moment.", FRAGMENT_SCRIPT));
  });

  const timer = setTimeout(() => {
    settle.fail(new Error("timed out waiting for the sign-in link"));
    close();
  }, opts.timeoutMs ?? 10 * 60 * 1000);
  timer.unref?.();

  function close() {
    clearTimeout(timer);
    if (!done) settle.fail(new Error("login cancelled"));
    // Let the response flush before closing.
    setImmediate(() => {
      server.close();
      server.closeAllConnections?.();
    });
  }

  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return fail(new Error("no port"));
      ok({ url: `http://${host}:${addr.port}${base}`, result, close });
    });
  });
}
