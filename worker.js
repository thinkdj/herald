// Herald announces new versions to every app you ship. One Cloudflare Worker,
// one D1 database, one R2 bucket, any number of desktop apps, and one release
// shape projected into whatever dialect each updater speaks.
//
//   GET    /                                 app index, ?format=json for JSON
//   GET    /login, POST /login, POST /logout sign in with ADMIN_USER and ADMIN_PASSWORD
//   GET    /admin                            publishing UI, requires a session
//   PUT    /:slug                            create or rename an app
//   DELETE /:slug                            delete an app and every release
//   PUT    /:slug/upload/:version/:file      store an artifact in R2
//   GET    /files/:slug/:version/:file       the stored artifact, public, immutable
//   GET    /:slug/latest.json                Tauri feed, all platforms
//   GET    /:slug/:target/:arch/:version     Tauri templated feed, 204 when current
//   GET    /:slug/latest.yml                 electron-updater, Windows
//   GET    /:slug/latest-mac.yml             electron-updater, macOS
//   GET    /:slug/latest-linux.yml           electron-updater, Linux
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
// Artifacts are either uploaded into Herald's own R2 bucket or hosted somewhere
// else and referenced by URL. Both can be mixed, per app and per platform.

import { authorized, checkCredentials, clearCookie, failureDelay, sessionCookie } from "./lib/auth.js";
import * as db from "./lib/db.js";
import {
  ALIASES,
  CONTENT_TYPES,
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

// Path prefixes Herald owns, so none of them can also be an app slug.
const RESERVED = new Set(["files", "admin", "login", "logout", "favicon.ico", "robots.txt"]);

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

// True when this client IP has used up the given limiter. Login attempts and
// admin traffic are both throttled before credentials are looked at, so
// guessing a password or a bearer token is slow whichever door is tried.
async function throttled(limiter, req) {
  const key = req.headers.get("cf-connecting-ip") ?? "local";
  return !(await limiter.limit({ key })).success;
}

const redirect = (to, cookie) =>
  new Response(null, {
    status: 302,
    headers: { location: to, ...(cookie ? { "set-cookie": cookie } : {}) },
  });

const navLink = (href, icon, label) =>
  `<a class="icon-btn w-auto gap-1.5 px-2.5" href="${href}"><i class="${icon} text-lg"></i><span class="hidden sm:inline">${label}</span></a>`;
// No sign in link for visitors: the public pages are for downloads, and the
// operator knows /login.
const navFor = (signedIn) =>
  signedIn
    ? navLink("/admin", "iconoir-upload", "Publish") +
      `<form method="post" action="/logout"><button class="icon-btn" title="Sign out"><i class="iconoir-log-out text-lg"></i></button></form>`
    : "";

const OS = [
  ["windows", "Windows", "windows", "iconoir-windows"],
  ["darwin", "macOS", "macos", "iconoir-apple-mac"],
  ["linux", "Linux", "linux", "iconoir-linux"],
];

const shortDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// One app's card: name, latest version, and every stable link it has. Links
// are the point: each is stable across releases, so a site or a README can
// point at them once. Full URLs, so a row can be copied straight into a config.
function appCard(a, origin) {
  const links = a.version
    ? [
        // Only feeds this app really has: a Tauri feed needs a signature,
        // an electron feed needs a hash and a size.
        ...(a.signed ? [["iconoir-rss-feed", "Tauri feed", `/${a.slug}/latest.json`]] : []),
        ...(a.hashed ? [["iconoir-rss-feed", "Electron feed", `/${a.slug}/latest.yml`]] : []),
        ["iconoir-journal", "History", `/${a.slug}/releases`],
        ...OS.filter(([os]) => a.platforms.some((p) => p.startsWith(os))).map(([, label, alias, icon]) => [
          icon,
          `Download for ${label}`,
          `/${a.slug}/download/${alias}`,
        ]),
      ]
    : [];
  return render(appCardTpl, {
    name: a.name,
    href: `/${a.slug}`,
    version: a.version ?? "no release yet",
    when: a.pub_date ? ` <span class="text-stone-400">&bull;</span> ${shortDate(a.pub_date)}` : "",
    platforms: a.platforms.map((p) => `<span class="chip">${esc(p)}</span>`).join(""),
    links: links
      .map(
        ([icon, label, href]) =>
          `<tr class="border-t border-line first:border-0 dark:border-line-dark">
             <td class="whitespace-nowrap py-1.5 pl-5 pr-4 text-stone-600 dark:text-stone-400"><span class="inline-flex items-center gap-1.5"><i class="${icon} text-base leading-none text-stone-400"></i>${esc(label)}</span></td>
             <td class="w-full break-all py-1.5 font-mono text-xs"><a class="hover:underline" href="${esc(href)}">${esc(origin + href)}</a></td>
             <td class="py-0.5 pr-3"><button class="icon-btn" data-copy="${esc(origin + href)}" title="Copy"><i class="iconoir-copy"></i></button></td>
           </tr>`,
      )
      .join(""),
  });
}

// Public app index. Unlisted apps are left out here and in the JSON form
// only; their own page and feeds still answer.
async function index(env, signedIn, origin) {
  const apps = (await db.appsWithLatest(env.DB)).filter((a) => !a.unlisted);
  const cards = apps.map((a) => appCard(a, origin)).join("\n");
  return page(layout, indexTpl, {
    title: "Herald",
    nav: navFor(signedIn),
    count: apps.length === 0 ? "None registered." : `${apps.length} registered.`,
    apps: cards || `<p class="card px-5 py-8 text-center text-sm text-stone-500">Nothing published yet.</p>`,
  });
}

// Public page for one app: the same card as the index, then every release
// with its notes. A changelog a site can link to.
async function appPage(env, signedIn, origin, slug) {
  const app = (await db.appsWithLatest(env.DB)).find((a) => a.slug === slug);
  if (!app) return json({ error: "not found" }, 404, 0);
  const history = (await db.releaseHistory(env.DB, slug))
    .filter((r) => r.platforms.length)
    .map(
      (r) => `<li class="card px-5 py-4">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span class="font-mono font-medium">${esc(r.version)}</span>
          <span class="text-sm text-stone-500 dark:text-stone-400">${shortDate(r.pub_date)}</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">${r.platforms.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div>
        ${r.notes ? `<p class="mt-3 whitespace-pre-wrap text-sm text-stone-700 dark:text-stone-300">${esc(r.notes)}</p>` : ""}
      </li>`,
    )
    .join("");
  return page(layout, appTpl, {
    title: `${app.name} on Herald`,
    nav: navFor(signedIn),
    card: appCard(app, origin),
    history: history || `<li class="text-sm text-stone-500">Nothing published yet.</li>`,
  });
}

async function login(req, env, url) {
  if (req.method === "GET") {
    return page(layout, loginTpl, { title: "Sign in to Herald", nav: "", error: "" });
  }
  const fail = (status, message) =>
    page(layout, loginTpl, {
      title: "Sign in to Herald",
      nav: "",
      status,
      error: `<p class="rounded-md bg-seal-soft px-3 py-2 text-sm text-seal dark:bg-seal-bright/10 dark:text-seal-bright">${message}</p>`,
    });
  if (await throttled(env.LOGIN_LIMIT, req)) {
    return fail(429, "Too many attempts. Wait a minute and try again.");
  }
  const form = await req.formData();
  if (!checkCredentials(env, form.get("username"), form.get("password"))) {
    await failureDelay();
    return fail(
      401,
      env.ADMIN_PASSWORD ? "Wrong username or password." : "No credentials are configured on this deployment.",
    );
  }
  return redirect("/admin", await sessionCookie(env, url));
}

// The page boots with the app list; everything after that is fetched.
async function admin(env) {
  const apps = await db.appsWithLatest(env.DB);
  return page(layout, adminTpl, {
    title: "Publish",
    nav: navFor(true),
    boot: JSON.stringify({ apps, platforms: PLATFORMS }).replace(/</g, "\\u003c"),
  });
}

// Serve an uploaded artifact. Public and unauthenticated. Keys carry the
// version, so an object at a given key never changes and can be cached
// forever. `onlyIf` handles conditional requests and `range` a resumed
// download, both straight from the request headers.
async function serveFile(req, env, key) {
  if (!env.BUCKET) return json({ error: "no bucket bound" }, 501, 0);
  const object = await env.BUCKET.get(key, { range: req.headers, onlyIf: req.headers });
  if (!object) return json({ error: "not found" }, 404, 0);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
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
  const pubDate = normalizeDate(body.pub_date);
  if (!pubDate) return json({ error: "pub_date must be a parseable date" }, 400, 0);

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
  const release = await db.upsertRelease(env.DB, slug, version, notes, pubDate);
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
  async fetch(req, env) {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    // A HEAD is a GET whose body is dropped by the runtime. Download clients
    // and link checkers probe with it, so answering 405 would look broken.
    const method = req.method === "HEAD" ? "GET" : req.method;

    if (seg.length === 0) {
      if (url.searchParams.get("format") === "json") {
        return json({ apps: (await db.appsWithLatest(env.DB)).filter((a) => !a.unlisted) }, 200, 0);
      }
      return index(env, await authorized(req, env), url.origin);
    }

    // Artifact bytes and the pages Herald owns, checked before anything is
    // treated as an app slug.
    if (seg[0] === "files") {
      if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);
      return serveFile(req, env, seg.slice(1).join("/"));
    }
    if (seg[0] === "login" && seg.length === 1 && (method === "GET" || method === "POST")) {
      return login(req, env, url);
    }
    if (seg[0] === "logout" && seg.length === 1) return redirect("/", clearCookie);
    if (seg[0] === "admin" && seg.length === 1) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405, 0);
      if (await throttled(env.ADMIN_LIMIT, req)) return json({ error: "too many requests" }, 429, 0);
      if (!(await authorized(req, env))) return redirect("/login");
      // Every app, unlisted ones included: the UI needs the whole list.
      if (url.searchParams.get("format") === "json") return json({ apps: await db.appsWithLatest(env.DB) }, 200, 0);
      return admin(env);
    }

    const [slug, ...rest] = seg;
    const write =
      (rest.length === 0 && (method === "PUT" || method === "DELETE")) ||
      (method === "PUT" && rest[0] === "upload" && rest.length === 3) ||
      (method === "POST" && rest[0] === "releases" && rest.length === 1) ||
      (method === "DELETE" && rest[0] === "releases" && (rest.length === 2 || rest.length === 3));

    if (write) {
      if (await throttled(env.ADMIN_LIMIT, req)) return json({ error: "too many requests" }, 429, 0);
      if (!(await authorized(req, env))) return json({ error: "unauthorized" }, 401, 0);
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

    if (rest.length === 0) return appPage(env, await authorized(req, env), url.origin, slug);

    // Release history, newest first. Lets a site render a changelog from
    // Herald instead of a hand-maintained file.
    if (rest[0] === "releases") {
      if (rest.length === 1) return json({ app: slug, releases: await db.releaseHistory(env.DB, slug) }, 200, 0);
      if (rest.length === 2) return releaseDetail(env, slug, rest[1]);
    }

    const release = await db.latestRelease(env.DB, slug);
    if (!release) return json({ error: `no release for ${slug}` }, 404, 0);

    // Stable download link: /:slug/download/windows or /:slug/download/windows-x86_64
    if (rest[0] === "download" && rest[1]) {
      const wanted = ALIASES[rest[1]] ?? [rest[1]];
      const files = await db.artifactsFor(env.DB, release.id);
      const hit = wanted.map((p) => files.find((f) => f.platform === p)).find(Boolean);
      if (!hit) return json({ error: `no artifact for ${rest[1]}` }, 404, 0);
      return Response.redirect(hit.url, 302);
    }

    if (rest.length === 1 && rest[0] === "latest.json") {
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
