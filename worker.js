// Herald announces new versions to every app you ship. One Cloudflare Worker,
// one D1 database, one R2 bucket, any number of desktop apps, and one release
// shape projected into whatever dialect each updater speaks.
//
//   GET    /                                 app index, ?format=json for JSON
//   GET    /:slug                            one app: a download button per OS, every file, the history
//   GET    /about                            what Herald is
//   GET    /login, POST /login, POST /logout sign in with ADMIN_USER and ADMIN_PASSWORD
//   GET    /demo                             a sandbox session over demo/*.json, when DEMO is set
//   GET    /admin                            the operator's side: publish, adoption, feed URLs, settings
//   PUT    /:slug                            create or rename an app
//   DELETE /:slug                            delete an app and every release
//   PUT    /:slug/upload/:version/:file      store an artifact in R2
//   GET    /files/:slug/:version/:file       the stored artifact, public, immutable
//   GET    /:slug/latest.json                Tauri feed, all platforms
//   GET    /:slug/:target/:arch/:version     Tauri templated feed, 204 when current
//   GET    /:slug/latest.yml                 electron-updater, Windows
//   GET    /:slug/latest-mac.yml             electron-updater, macOS
//   GET    /:slug/latest-linux.yml           electron-updater, Linux
//   GET    /:slug/appcast.xml                Sparkle feed, macOS
//   GET    /:slug/badge.svg                  the latest version as a README badge
//   GET    /:slug/stats                      counts for the last 30 days, requires a session
//   GET    /:slug/releases                   release history, newest first
//   GET    /:slug/releases/:version          one release with its artifacts
//   GET    /:slug/download/:platform         302 to the artifact, for a site button
//   POST   /:slug/releases                   publish, merges per platform
//   DELETE /:slug/releases/:version          unpublish
//   DELETE /:slug/releases/:version/:platform  remove one artifact
//
// Writes accept either a session cookie or `Authorization: Bearer $ADMIN_TOKEN`,
// so a person uses the UI and a CI job uses curl. Reads are public, because
// an installed app's updater has no credentials and neither does a download
// button.
//
// Every feed and download link takes ?channel=beta or ?channel=nightly. A
// release is published to one channel, and a subscriber accepts that channel
// and the ones before it, so beta sees stable and beta.
//
// Artifacts are either uploaded into Herald's own R2 bucket or hosted somewhere
// else and referenced by URL. Both can be mixed, per app and per platform.

import { authorized, checkCredentials, clearCookie, failureDelay, secretOk, sessionCookie, MIN_SECRET_LENGTH } from "./lib/auth.js";
import * as d1 from "./lib/db.js";
import * as demo from "./lib/demo.js";
import { badge } from "./lib/badge.js";
import {
  ALIASES,
  CHANNELS,
  CONTENT_TYPES,
  normalizeChannel,
  sparkleFeed,
  ELECTRON_FEEDS,
  PLATFORMS,
  electronFeed,
  guessPlatform,
  isNewer,
  normalizeDate,
  normalizeVersion,
  platformKeys,
  tauriFeed,
  toYaml,
} from "./lib/feeds.js";
import { esc, page, render } from "./lib/render.js";
import layout from "./templates/layout.html";
import indexTpl from "./templates/index.html";
import appCardTpl from "./templates/app-card.html";
import loginTpl from "./templates/login.html";
import adminTpl from "./templates/admin.html";
import appTpl from "./templates/app.html";
import aboutTpl from "./templates/about.html";
// Tailwind's play build, as a text module for the same reason the templates
// are: wrangler bundles .txt as text with no rule to add.
import tailwind from "./vendor/tailwind-3.4.17.txt";
import mark from "./assets/herald.svg";

// The query layer. Each call goes to D1 or to the demo store depending on the
// handle it is given, so no route knows which one it is talking to.
const db = Object.fromEntries(
  Object.keys(d1).map((name) => [name, (handle, ...args) => (handle?.demo ? demo : d1)[name](handle, ...args)]),
);

// Path prefixes Herald owns, so none of them can also be an app slug.
const RESERVED = new Set(["files", "admin", "login", "logout", "demo", "about", "favicon.ico", "robots.txt"]);

// Checked once for every write, not per route. Upload and publish both turn a
// slug into a durable name, an R2 key prefix and a database row, and letting
// upload accept what publish would reject leaves bytes in the bucket that no
// release can ever point at.
const validSlug = (slug) => !RESERVED.has(slug) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);

const json = (body, status = 200, maxAge = 60) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });

const yaml = (body) =>
  new Response(toYaml(body) + "\n", {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });

// True when the given limiter is used up for this client IP, or for the
// fixed key when one is passed. Login attempts and admin traffic are both
// throttled before credentials are looked at, so guessing a password or a
// bearer token is slow whichever door is tried.
const clientIp = (req) => req.headers.get("cf-connecting-ip") ?? "local";
async function throttled(limiter, req, key = clientIp(req)) {
  return !(await limiter.limit({ key })).success;
}

const redirect = (to, ...cookies) => {
  const headers = new Headers({ location: to });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

const navLink = (href, icon, label) =>
  `<a class="icon-btn w-auto gap-1.5 px-2.5" href="${href}"><i class="${icon} text-lg"></i><span class="hidden sm:inline">${label}</span></a>`;
// No sign in link for visitors: the public pages are for downloads, and the
// operator knows /login. What Herald is lives in the footer of every page.
// In demo mode the bar above the header carries the exit, so the nav keeps
// only the Admin link.
const navFor = (signedIn, demoMode) =>
  signedIn
    ? navLink("/admin", "iconoir-tower", "Admin") +
      (demoMode
        ? ""
        : `<form method="post" action="/logout"><button class="icon-btn" title="Sign out"><i class="iconoir-log-out text-lg"></i></button></form>`)
    : "";

const DEMO_BAR = `<div class="sticky top-0 z-50 flex h-9 items-center justify-between border-b border-amber-200 bg-amber-100 px-5 text-sm text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/15 dark:text-amber-200">
  <span class="inline-flex items-center gap-2">
    <span class="inline-flex items-center gap-1.5"><i class="iconoir-info-circle text-base"></i>In Demo Mode</span>
    <span class="text-amber-900/40 dark:text-amber-200/40">|</span>
    <a class="font-medium hover:underline" href="/">Home</a>
    <span class="text-amber-900/40 dark:text-amber-200/40">|</span>
    <a class="font-medium hover:underline" href="/admin">Admin</a>
  </span>
  <form method="post" action="/logout"><button class="font-medium hover:underline">Exit</button></form>
</div>`;

// The pieces of the layout every page fills in: the nav for who is looking,
// and the demo bar when the session is a sandbox.
const chrome = (signedIn, demoMode) => ({ nav: navFor(signedIn, demoMode), demo: demoMode ? DEMO_BAR : "", signedIn });

// Counts are buffered here, per isolate, and written in one batch a few
// seconds later or when the buffer fills: a thousand update checks become
// one D1 write with a handful of statements, not a thousand writes, and a
// loop on a feed URL cannot turn into write load on the database. The buffer
// is capped; past the cap a count is dropped, which is the right failure for
// a number that is only ever approximate. An isolate that dies before its
// flush loses a few seconds of counts, same answer.
const FLUSH_MS = 5000;
const FLUSH_AT = 200;
const BUFFER_MAX = 2000;
const buffers = { d1: null, demo: null };
function queueHit(env, ctx, slug, kind, version = "") {
  const which = env.DB?.demo ? "demo" : "d1";
  const b = (buffers[which] ??= { rows: new Map(), timer: null });
  b.db = env.DB;
  const key = `${slug}|${kind}|${version}`;
  const row = b.rows.get(key);
  if (row) row.n += 1;
  else if (b.rows.size < BUFFER_MAX) b.rows.set(key, { slug, kind, version, n: 1 });
  const flush = async () => {
    const rows = [...b.rows.values()];
    b.rows.clear();
    b.timer = null;
    if (rows.length) await db.countHits(b.db, rows).catch(() => {});
  };
  if (b.rows.size >= FLUSH_AT) b.timer = flush();
  else b.timer ??= new Promise((r) => setTimeout(r, FLUSH_MS)).then(flush);
  // Keeps the isolate alive until the pending flush has run.
  ctx.waitUntil(b.timer);
}

const OS = [
  ["windows", "Windows", "windows", "iconoir-windows"],
  ["darwin", "macOS", "macos", "iconoir-apple-mac"],
  ["linux", "Linux", "linux", "iconoir-linux"],
];

// Stable is the default and goes unlabelled; anything else is marked.
const channelChip = (channel) =>
  channel && channel !== "stable" ? `<span class="ch ch-${esc(channel)}">${esc(channel)}</span>` : "";

const shortDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const megabytes = (n) => (n ? `${(n / 1048576).toFixed(1)} MB` : "");

// The systems a set of platform keys covers, as icons with a spoken name.
const osIcons = (platforms) =>
  OS.filter(([os]) => platforms.some((p) => p.startsWith(os)))
    .map(([, label, , icon]) => `<i class="${icon}" title="${label}"></i><span class="sr-only">${label}</span>`)
    .join("");

const notFound = (ui, what) =>
  page(
    layout,
    `<section class="mx-auto max-w-3xl py-16 text-center">
      <i class="iconoir-file-not-found text-4xl text-stone-400"></i>
      <h1 class="mt-3 text-2xl font-semibold tracking-tight">${esc(what)}</h1>
      <p class="muted mt-2 text-sm">Check the address, or pick the app from the list.</p>
      <a class="btn-quiet mt-6" href="/">All apps</a>
    </section>`,
    { title: "Not found", ...ui, status: 404 },
  );

// Public app index: one row per app, each a link to its page. A visitor is
// here to download something, so the feed URLs an operator pastes into a
// config live in the admin, not here. Unlisted apps are left out here and in
// the JSON form only; their own page and feeds still answer.
async function index(env, ui) {
  const apps = (await db.appsWithLatest(env.DB)).filter((a) => !a.unlisted);
  const rows = apps
    .map((a) =>
      render(appCardTpl, {
        name: a.name,
        href: `/${a.slug}`,
        version: a.version ?? "no release yet",
        when: (a.pub_date ? `<span>${shortDate(a.pub_date)}</span>` : "") + channelChip(a.channel),
        platforms: osIcons(a.platforms),
      }),
    )
    .join("\n");
  return page(layout, indexTpl, {
    title: "Herald",
    ...ui,
    count: apps.length ? "Pick one to download the latest build or read what changed." : "Nothing is published here yet.",
    apps: rows
      ? `<ul class="card divide-y divide-line overflow-hidden dark:divide-line-dark">${rows}</ul>`
      : ui.signedIn
        ? `<p class="card px-5 py-10 text-center text-sm"><a class="btn-primary" href="/admin">Create the first app</a></p>`
        : "",
  });
}

// Public page for one app, and the only one: a download button per OS that
// script promotes for the visitor's own, every file of the latest release on
// the channel, then every release with its notes. A page a site can link to
// as both its download page and its changelog.
async function appPage(env, ui, slug, channel) {
  const app = (await db.appsWithLatest(env.DB)).find((a) => a.slug === slug);
  if (!app) return notFound(ui, `No app called ${slug}`);
  const release = await db.latestRelease(env.DB, slug, channel);
  const files = release ? (await db.artifactsFor(env.DB, release.id)).sort((a, b) => a.platform.localeCompare(b.platform)) : [];
  const releases = (await db.releaseHistory(env.DB, slug)).filter((r) => r.platforms.length);
  const q = channel === "stable" ? "" : `?channel=${channel}`;

  // Offered only when there is something other than stable to switch to.
  const published = CHANNELS.filter((c) => c === "stable" || releases.some((r) => r.channel === c));
  const channels =
    published.length > 1
      ? `<div class="mt-5 flex flex-wrap items-center gap-3">
          <div class="seg">${published
            .map((c) => `<a href="/${esc(slug)}${c === "stable" ? "" : `?channel=${c}`}" aria-current="${c === channel}">${c}</a>`)
            .join("")}</div>
          <span class="muted text-xs">${
            channel === "stable" ? "Stable builds only." : `The newest build up to ${channel}, tested less than stable.`
          }</span>
        </div>`
      : "";

  const buttons = OS.filter(([os]) => files.some((f) => f.platform.startsWith(os)))
    .map(([os, label, alias, icon]) => {
      const mine = files.filter((f) => f.platform.startsWith(os));
      const hint = [mine.map((f) => f.platform.slice(os.length + 1)).join(", "), mine.length === 1 ? megabytes(mine[0].size) : ""];
      return `<a class="btn-quiet !justify-start gap-3 !px-4 !py-3" data-os="${alias}" href="/${esc(slug)}/download/${alias}${q}">
        <i class="${icon} text-2xl"></i>
        <span class="text-left"><span class="block text-base">Download for ${label}</span>
        <span class="block text-xs font-normal opacity-70">${esc(hint.filter(Boolean).join(", "))}</span></span>
      </a>`;
    })
    .join("");

  const rows = files
    .map(
      (f) => `<tr class="border-t border-line first:border-0 dark:border-line-dark">
        <td class="whitespace-nowrap py-2 pl-4 pr-4"><span class="chip">${esc(f.platform)}</span></td>
        <td class="w-full break-all py-2 pr-4 font-mono text-xs"><a class="hover:underline" href="${esc(f.url)}">${esc(f.url.split("/").pop())}</a></td>
        <td class="muted whitespace-nowrap py-2 pr-4 text-xs">${megabytes(f.size)}</td>
        <td class="whitespace-nowrap py-2 pr-4 text-xs text-emerald-700 dark:text-emerald-400">${
          f.signature ? '<i class="iconoir-shield-check"></i> signed' : f.sha512 ? '<i class="iconoir-check-circle"></i> hashed' : ""
        }</td>
      </tr>`,
    )
    .join("");

  const history = releases
    .map(
      (r) => `<li class="grid gap-x-8 gap-y-2 border-t border-line py-5 first:border-0 dark:border-line-dark sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div>
          <div class="flex flex-wrap items-center gap-2"><span class="font-mono font-medium">${esc(r.version)}</span>${channelChip(r.channel)}</div>
          <div class="muted mt-0.5 text-sm">${shortDate(r.pub_date)}</div>
          ${r.version === release?.version ? `<div class="mt-1 text-xs font-medium text-seal dark:text-seal-bright">Current</div>` : ""}
        </div>
        <div>
          <p class="whitespace-pre-wrap text-sm leading-relaxed ${r.notes ? "text-stone-700 dark:text-stone-300" : "text-stone-400"}">${esc(r.notes || "No notes for this release.")}</p>
          <div class="mt-2 flex items-center gap-2 text-stone-400">${osIcons(r.platforms)}</div>
        </div>
      </li>`,
    )
    .join("");

  return page(layout, appTpl, {
    title: `${app.name} on Herald`,
    ...ui,
    name: app.name,
    version: release?.version ?? "No release yet",
    when: release ? `Released ${shortDate(release.pub_date)}` : "",
    channels,
    manage: ui.signedIn ? `<a class="btn-quiet !py-1.5" href="/admin#${esc(slug)}"><i class="iconoir-tower"></i>Manage</a>` : "",
    buttons: buttons || `<p class="card muted px-5 py-8 text-center text-sm sm:col-span-3">Nothing published on the ${channel} channel yet.</p>`,
    files: rows
      ? `<details class="mt-4 text-sm">
          <summary class="muted inline-flex cursor-pointer items-center gap-1 rounded hover:text-stone-900 dark:hover:text-stone-100">
            Every file in ${esc(release.version)}<i class="iconoir-nav-arrow-down"></i></summary>
          <div class="card mt-3 overflow-x-auto"><table class="w-full"><tbody>${rows}</tbody></table></div>
        </details>`
      : "",
    history: history || `<li class="muted py-5 text-sm">Nothing published yet.</li>`,
  });
}

async function login(req, env, url, ui) {
  const vars = {
    title: "Sign in to Herald",
    ...ui,
    tryDemo: env.DEMO
      ? `<p class="mt-4 text-center text-sm text-stone-500"><a class="hover:underline" href="/demo">Or try the demo</a></p>`
      : "",
  };
  // Not `=== "GET"`: a HEAD reaches here too, and has no form to read.
  if (req.method !== "POST") {
    return page(layout, loginTpl, { ...vars, error: "" });
  }
  const fail = (status, message) =>
    page(layout, loginTpl, {
      ...vars,
      status,
      error: `<p class="rounded-md bg-seal-soft px-3 py-2 text-sm text-seal dark:bg-seal-bright/10 dark:text-seal-bright">${message}</p>`,
    });
  // Per IP first, then for everyone together, so guesses spread over many
  // addresses still meet a ceiling. A refused attempt is logged with its
  // address and nothing else, so an attack shows up in the Worker's logs
  // without the log ever holding a password typed into the wrong box.
  if ((await throttled(env.LOGIN_LIMIT, req)) || (await throttled(env.LOGIN_GLOBAL, req, "all"))) {
    console.warn(`login throttled: ${clientIp(req)}`);
    return fail(429, "Too many attempts. Wait a minute and try again.");
  }
  if (!secretOk(env)) {
    return fail(500, `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters on this deployment.`);
  }
  const form = await req.formData();
  if (!(await checkCredentials(env, form.get("username"), form.get("password")))) {
    await failureDelay();
    console.warn(`login failed: ${clientIp(req)}`);
    return fail(
      401,
      env.ADMIN_PASSWORD ? "Wrong username or password." : "No credentials are configured on this deployment.",
    );
  }
  return redirect("/admin", await sessionCookie(env, url));
}

// The page boots with the app list; everything after that is fetched.
async function admin(env, ui, origin) {
  const apps = await db.appsWithLatest(env.DB);
  return page(layout, adminTpl, {
    title: "Herald admin",
    ...ui,
    boot: JSON.stringify({ apps, origin, platforms: PLATFORMS, channels: CHANNELS }).replace(/</g, "\\u003c"),
  });
}

// Serve an uploaded artifact. Public and unauthenticated. A republished
// version overwrites its key, so the bytes behind a URL can change and a
// cache has to ask before reusing them: a stale installer under a fresh
// signature is an update that fails to verify. `onlyIf` answers that check
// with a 304, and `range` a resumed download, both straight from the request
// headers.
async function serveFile(req, env, key, count) {
  if (!env.BUCKET) return json({ error: "no bucket bound" }, 501, 0);
  const object = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
  // A whole file going out is one download. A 304, a range or a HEAD is not:
  // a resumed download would count once per chunk, a probe is not a download.
  if (object?.body && req.method === "GET" && !req.headers.has("range")) {
    const [slug, version] = key.split("/");
    count(slug, "download", version);
  }
  if (!object) return json({ error: "not found" }, 404, 0);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, no-cache");
  headers.set("content-disposition", `attachment; filename="${key.split("/").pop()}"`);
  // A body-less object means the conditional request matched: nothing to send.
  if (!object.body) return new Response(null, { status: 304, headers });
  // Only the request asking for a range makes this a partial response. R2 fills
  // in object.range either way, so trusting it alone answers an ordinary
  // download with a 206, which some clients and caches refuse.
  if (req.headers.has("range") && object.range && "offset" in object.range) {
    const { offset = 0, length = object.size - offset } = object.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

// PUT the raw file as the body. The key is slug/version/filename, so a
// republished version overwrites in place rather than accumulating.
async function upload(req, env, url, slug, version, filename) {
  if (!env.BUCKET) return json({ error: "no bucket bound" }, 501, 0);

  const clean = normalizeVersion(version);
  if (!clean) return json({ error: "version must be semver" }, 400, 0);
  // The filename becomes part of an R2 key and a content-disposition value, so
  // it is validated rather than escaped.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename) || filename.includes("..")) {
    return json({ error: "bad filename" }, 400, 0);
  }
  if (!req.body) return json({ error: "empty body" }, 400, 0);

  const key = `${slug}/${clean}/${filename}`;
  const ext = filename.toLowerCase().split(".").pop();
  const put = await env.BUCKET.put(key, req.body, {
    httpMetadata: { contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
  // Always https, never the request scheme: Cloudflare serves the worker over
  // https in production, so a url captured while testing over http is still a
  // valid one to store.
  return json(
    {
      ok: true,
      url: `https://${url.host}/files/${key}`,
      size: put?.size ?? null,
      sha512: req.headers.get("x-herald-sha512"),
      platform: guessPlatform(filename),
    },
    200,
    0,
  );
}

// The slug is already validated by the write gate in fetch. Artifacts merge
// per platform into the version, so publishing with none is a notes edit and
// is only allowed on a release that already has some.
async function publish(env, slug, req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400, 0);
  }
  const version = normalizeVersion(body.version);
  if (!version) return json({ error: "version must be semver, for example 1.2.3" }, 400, 0);
  // Left out, the date is decided by the database: now for a new release,
  // unchanged for one that exists.
  const pubDate = body.pub_date == null ? null : normalizeDate(body.pub_date);
  if (body.pub_date != null && !pubDate) return json({ error: "pub_date must be a parseable date" }, 400, 0);

  const channel = body.channel == null ? null : normalizeChannel(body.channel);
  if (body.channel != null && !channel) return json({ error: `channel must be one of ${CHANNELS.join(", ")}` }, 400, 0);

  const artifacts = Object.entries(body.artifacts ?? {});
  // A publish is one D1 batch, so the statement count stays bounded.
  if (artifacts.length > 24) return json({ error: "too many artifacts" }, 400, 0);
  for (const [platform, a] of artifacts) {
    if (!PLATFORMS.includes(platform)) return json({ error: `unknown platform: ${platform}` }, 400, 0);
    if (!/^https:\/\//.test(a?.url ?? "")) {
      return json({ error: `artifact ${platform} needs an https url` }, 400, 0);
    }
    // 64 raw bytes of SHA-512, base64 encoded. A malformed hash would fail on
    // the client with nothing to point at, so it is rejected here.
    if (a.sha512 && !/^[A-Za-z0-9+/]{86}==$/.test(a.sha512)) {
      return json({ error: `artifact ${platform} has a malformed sha512` }, 400, 0);
    }
  }
  if (artifacts.length === 0 && !(await db.releaseByVersion(env.DB, slug, version))) {
    return json({ error: "at least one artifact is required" }, 400, 0);
  }

  await db.upsertApp(env.DB, slug, body.name === undefined ? null : String(body.name));
  const notes = body.notes === undefined ? null : String(body.notes);
  const release = await db.upsertRelease(env.DB, slug, version, notes, pubDate, channel);
  if (artifacts.length) await db.upsertArtifacts(env.DB, release.id, artifacts);
  return json({ ok: true, app: slug, version, platforms: artifacts.map(([p]) => p) }, 200, 0);
}

async function releaseDetail(env, slug, version) {
  const release = await db.releaseByVersion(env.DB, slug, normalizeVersion(version) ?? version);
  if (!release) return json({ error: `no release ${version} for ${slug}` }, 404, 0);
  const artifacts = (await db.artifactsFor(env.DB, release.id)).map((a) => ({
    platform: a.platform,
    url: a.url,
    size: a.size,
    signed: a.signature != null,
    hashed: a.sha512 != null && a.size != null,
  }));
  const { id, ...rest } = release;
  return json({ ...rest, artifacts }, 200, 0);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    // A HEAD is a GET whose body is dropped by the runtime. Download clients
    // and link checkers probe with it, so answering 405 would look broken.
    const method = req.method === "HEAD" ? "GET" : req.method;

    // A demo session is a signed in one over the in-memory store. Only when
    // the deployment opted in, so a stray cookie on a real host does nothing.
    const demoMode = Boolean(env.DEMO) && demo.inDemo(req);
    if (demoMode) env = demo.demoEnv(env);
    const signedIn = async () => demoMode || authorized(req, env);
    const ui = async () => chrome(await signedIn(), demoMode);
    // Counting is a buffer append; the write happens later, in a batch, and
    // can never fail or slow a request.
    const count = (slug, kind, version = "") => queueHit(env, ctx, slug, kind, version);

    if (seg.length === 0) {
      if (url.searchParams.get("format") === "json") {
        return json({ apps: (await db.appsWithLatest(env.DB)).filter((a) => !a.unlisted) }, 200, 0);
      }
      return index(env, await ui());
    }

    // Artifact bytes and the pages Herald owns, checked before anything is
    // treated as an app slug.
    // The name carries the version and a slug cannot contain a dot, so this
    // can be cached for good and never shadows an app.
    if (seg[0] === "tailwind-3.4.17.js" && seg.length === 1) {
      return new Response(tailwind, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }
    if (seg[0] === "herald.svg" && seg.length === 1) {
      return new Response(mark, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }
    if (seg[0] === "files") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);
      return serveFile(req, env, seg.slice(1).join("/"), count);
    }
    if (seg[0] === "about" && seg.length === 1) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);
      return page(layout, aboutTpl, { title: "About Herald", ...(await ui()), cache: "public, max-age=3600" });
    }
    if (seg[0] === "login" && seg.length === 1 && (method === "GET" || method === "POST")) {
      return login(req, env, url, chrome(false, demoMode));
    }
    // POST only: a plain link must not be able to end the session.
    if (seg[0] === "logout" && seg.length === 1) {
      if (method !== "POST") return json({ error: "method not allowed" }, 405, 0);
      return redirect("/", clearCookie, demo.clearDemoCookie);
    }
    if (seg[0] === "demo" && seg.length === 1) {
      if (!env.DEMO) return json({ error: "not found" }, 404, 0);
      return redirect("/admin", demo.demoCookie);
    }
    if (seg[0] === "admin" && seg.length === 1) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);
      if (await throttled(env.ADMIN_LIMIT, req)) return json({ error: "too many requests" }, 429, 0);
      if (!(await signedIn())) return redirect("/login");
      // Every app, unlisted ones included: the UI needs the whole list.
      if (url.searchParams.get("format") === "json") return json({ apps: await db.appsWithLatest(env.DB) }, 200, 0);
      return admin(env, await ui(), url.origin);
    }

    const [slug, ...rest] = seg;
    const write =
      (rest.length === 0 && (method === "PUT" || method === "DELETE")) ||
      (method === "PUT" && rest[0] === "upload" && rest.length === 3) ||
      (method === "POST" && rest[0] === "releases" && rest.length === 1) ||
      (method === "DELETE" && rest[0] === "releases" && (rest.length === 2 || rest.length === 3));

    if (write) {
      if (await throttled(env.ADMIN_LIMIT, req)) return json({ error: "too many requests" }, 429, 0);
      if (!(await signedIn())) return json({ error: "unauthorized" }, 401, 0);
      if (!validSlug(slug)) return json({ error: `bad app slug: ${slug}` }, 400, 0);

      if (rest.length === 0) {
        if (method === "DELETE") {
          const gone = await db.deleteApp(env.DB, slug);
          return gone ? json({ ok: true, deleted: slug }, 200, 0) : json({ error: `no app ${slug}` }, 404, 0);
        }
        const body = await req.json().catch(() => ({}));
        await db.upsertApp(
          env.DB,
          slug,
          body.name === undefined ? null : String(body.name || slug),
          body.unlisted === undefined ? null : Number(Boolean(body.unlisted)),
        );
        return json({ ok: true, app: slug }, 200, 0);
      }
      if (method === "PUT") return upload(req, env, url, slug, rest[1], rest[2]);
      if (method === "POST") return publish(env, slug, req);

      const version = normalizeVersion(rest[1]) ?? rest[1];
      if (rest.length === 3) {
        const gone = await db.deleteArtifact(env.DB, slug, version, rest[2]);
        if (!gone) return json({ error: `no ${rest[2]} artifact on ${slug} ${version}` }, 404, 0);
        return json({ ok: true, deleted: gone.platform }, 200, 0);
      }
      const gone = await db.deleteRelease(env.DB, slug, version);
      if (!gone) return json({ error: `no release ${rest[1]} for ${slug}` }, 404, 0);
      return json({ ok: true, deleted: gone.version }, 200, 0);
    }
    if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);

    // A page falls back to stable on a channel it does not know; a feed, below, refuses.
    if (rest.length === 0) {
      return appPage(env, await ui(), slug, normalizeChannel(url.searchParams.get("channel")) ?? "stable");
    }
    // The download page and the app page are one page now.
    if (rest.length === 1 && rest[0] === "download") return redirect(`/${slug}${url.search}`);

    // The operator's counts. Not public: they say how many copies are out
    // there, which is the operator's business and nobody else's.
    if (rest.length === 1 && rest[0] === "stats") {
      if (!(await signedIn())) return json({ error: "unauthorized" }, 401, 0);
      return json({ app: slug, days: 30, hits: await db.hitsFor(env.DB, slug, 30) }, 200, 0);
    }

    // Release history, newest first. Lets a site render a changelog from
    // Herald instead of a hand-maintained file.
    if (rest[0] === "releases") {
      if (rest.length === 1) return json({ app: slug, releases: await db.releaseHistory(env.DB, slug) }, 200, 0);
      if (rest.length === 2) return releaseDetail(env, slug, rest[1]);
    }

    const channel = normalizeChannel(url.searchParams.get("channel"));
    if (!channel) return json({ error: `channel must be one of ${CHANNELS.join(", ")}` }, 400, 0);

    const release = await db.latestRelease(env.DB, slug, channel);
    if (rest.length === 1 && rest[0] === "badge.svg") {
      return new Response(badge(channel === "stable" ? "release" : channel, release?.version ?? "none"), {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300" },
      });
    }
    if (!release) return json({ error: `no release for ${slug}` }, 404, 0);

    // Stable download link: /:slug/download/windows or /:slug/download/windows-x86_64
    if (rest[0] === "download" && rest[1]) {
      const wanted = ALIASES[rest[1]] ?? [rest[1]];
      const files = await db.artifactsFor(env.DB, release.id);
      const hit = wanted.map((p) => files.find((f) => f.platform === p)).find(Boolean);
      if (!hit) return json({ error: `no artifact for ${rest[1]}` }, 404, 0);
      return Response.redirect(hit.url, 302);
    }

    if (rest.length === 1 && rest[0] === "appcast.xml") {
      count(slug, "check");
      const feed = sparkleFeed(slug, release, await db.artifactsFor(env.DB, release.id));
      if (!feed) return json({ error: `no macOS artifact for ${slug}` }, 404, 0);
      return new Response(feed, {
        headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }

    if (rest.length === 1 && rest[0] === "latest.json") {
      count(slug, "check");
      const feed = tauriFeed(release, await db.artifactsFor(env.DB, release.id));
      // An app that publishes no signatures has no Tauri feed, which is a 404
      // rather than a 200 carrying an empty platform map the client would
      // reject with a less useful message. The templated route answers 204
      // instead, because there a quiet client is the right outcome.
      if (Object.keys(feed.platforms).length === 0) {
        return json({ error: `no signed artifact for ${slug}` }, 404, 0);
      }
      return json(feed);
    }

    // electron-updater reads one file per OS and follows no version in the URL,
    // so it compares versions itself and needs no 204 path.
    if (rest.length === 1 && rest[0] in ELECTRON_FEEDS) {
      count(slug, "check");
      const feed = electronFeed(
        release,
        await db.artifactsFor(env.DB, release.id),
        ELECTRON_FEEDS[rest[0]],
      );
      if (!feed) return json({ error: `no hashed artifact for ${rest[0]}` }, 404, 0);
      return yaml(feed);
    }

    // Tauri templated endpoint: /:slug/{{target}}/{{arch}}/{{current_version}}
    if (rest.length === 3) {
      const [target, arch, current] = rest;
      // Counted before the 204: a client that is current is still a client,
      // and its version is the installed base.
      count(slug, "check", normalizeVersion(current) ?? "");
      if (!isNewer(release.version, current)) return new Response(null, { status: 204 });
      const feed = tauriFeed(
        release,
        await db.artifactsFor(env.DB, release.id),
        platformKeys(target, arch),
      );
      // Nothing installable for this platform is the same answer as up to date.
      // A 204 keeps the client quiet instead of surfacing an error the user
      // cannot act on.
      if (Object.keys(feed.platforms).length === 0) return new Response(null, { status: 204 });
      return json(feed);
    }

    return json({ error: "not found" }, 404, 0);
  },
};
