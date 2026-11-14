// Freezes the whole of Herald, as it is right now, into one HTML file that
// opens from disk: node herald/design/build.mjs v2.html
//
// Not a mock. The worker is bundled and runs in the page, in demo mode, over
// demo/*.json. Each response is shown in an iframe whose links, forms and
// fetch calls are routed back into the worker, so every page works, publish
// included. Fonts and icons still come from their CDNs, as they do in the app.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("usage: node herald/design/build.mjs <name>.html");

// esbuild is wrangler's own copy, so this adds no dependency.
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("wrangler"))("esbuild");
const built = await esbuild.build({
  entryPoints: [join(here, "..", "worker.js")],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "Herald",
  loader: { ".html": "text", ".txt": "text", ".svg": "text" },
});
// Inside an inline script, these two sequences end or derail the script tag.
// Both only occur in string literals, where the backslash changes nothing.
const inlineSafe = (js) => js.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");

// Runs inside every page, before the page's own scripts.
const inner = (ORIGIN, hash) => {
  // The admin keeps its place in its own hash: v2.html#/admin#ctx/adoption.
  if (hash) location.hash = hash;
  const local = (href) => href.replace(ORIGIN, "") || "/";
  const send = (form) =>
    parent.go(local(form.getAttribute("action")), { method: form.method.toUpperCase(), body: new FormData(form) });
  window.fetch = (path, init) => parent.call(local(String(path)), init);
  HTMLFormElement.prototype.submit = function () {
    send(this);
  };
  document.addEventListener("submit", (e) => {
    if (e.defaultPrevented || e.target.method === "dialog") return;
    e.preventDefault();
    send(e.target);
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute("href");
    if (/^https?:/.test(href) && !href.startsWith(ORIGIN)) return void (a.target = "_blank");
    e.preventDefault();
    if (href.startsWith("#")) location.hash = href;
    else parent.location.hash = local(href);
  });
  // An image the worker serves, a badge for one, fails to load from disk.
  document.addEventListener(
    "error",
    async (e) => {
      const img = e.target;
      if (img.tagName !== "IMG" || img.dataset.fixed) return;
      img.dataset.fixed = 1;
      const res = await parent.call(local(img.getAttribute("src")));
      img.src = "data:image/svg+xml," + encodeURIComponent(await res.text());
    },
    true,
  );
};

// Runs in the outer page: owns the worker, and so the demo store.
const outer = (ORIGIN, innerSource) => {
  const frame = document.getElementById("frame");
  const limiter = { limit: async () => ({ success: true }) };
  const env = { DEMO: "1", LOGIN_LIMIT: limiter, LOGIN_GLOBAL: limiter, ADMIN_LIMIT: limiter };
  const safe = (js) => js.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");
  const esc = (s) => s.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"));

  // A plain object, not a Request: a Request drops the cookie header.
  window.call = (path, init = {}) =>
    Herald.default.fetch(
      {
        url: new URL(path, ORIGIN).href,
        method: init.method ?? "GET",
        headers: new Headers({ ...init.headers, cookie: "herald_demo=1" }),
        body: init.body instanceof Blob ? init.body.stream() : (init.body ?? null),
        json: async () => JSON.parse(init.body),
        formData: async () => init.body,
      },
      env,
      { waitUntil() {} },
    );

  window.go = async (address, init) => {
    let [path, hash = ""] = address.split("#");
    let res = await call(path, init);
    for (let hops = 0; hops < 5 && res.status >= 300 && res.status < 400; hops++) {
      const to = new URL(res.headers.get("location"), ORIGIN);
      path = to.pathname + to.search;
      res = await call(path);
    }
    let html = await res.text();
    // A feed, a JSON answer, a badge: shown as what the client would receive.
    if (!(res.headers.get("content-type") ?? "").includes("html")) {
      html = `<body style="margin:0;font:13px/1.6 ui-monospace,monospace;background:#F4F4F1;color:#1c1917">
        <p style="margin:0;padding:12px 20px;border-bottom:1px solid #E4E4DF;background:#fff">
          <a href="javascript:history.back()" style="color:#B42318">Back</a>
          <span style="margin-left:16px">${res.status} ${esc(ORIGIN + path)}</span></p>
        <pre style="margin:0;padding:20px;white-space:pre-wrap;word-break:break-all">${esc(html)}</pre></body>`;
    } else {
      const tailwind = await (await call("/tailwind-3.4.17.js")).text();
      html = html
        .replace('<script src="/tailwind-3.4.17.js"></script>', () => `<script>${safe(tailwind)}</script>`)
        .replace("<head>", () => `<head><script>(${innerSource})(${JSON.stringify(ORIGIN)}, ${JSON.stringify(hash)})</script>`)
        .replaceAll("location.origin", JSON.stringify(ORIGIN));
    }
    frame.srcdoc = html;
  };

  // The outer hash is the address bar: v2.html#/admin opens the admin.
  window.onhashchange = () => go(location.hash.slice(1) || "/");
  window.onhashchange();
};

const ORIGIN = "https://herald.example";
writeFileSync(
  join(here, out),
  `<!doctype html>
<meta charset="utf-8" />
<title>Herald, ${out.replace(/\.html$/, "")}</title>
<style>html, body, iframe { margin: 0; width: 100%; height: 100%; border: 0; display: block; }</style>
<iframe id="frame" title="Herald"></iframe>
<script>${inlineSafe(built.outputFiles[0].text)}</script>
<script>(${inlineSafe(outer.toString())})(${JSON.stringify(ORIGIN)}, ${JSON.stringify(inlineSafe(inner.toString()))})</script>
`,
);
console.log(`wrote design/${out}`);
