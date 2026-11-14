// Self check for the pure parts of Herald. Run: node herald/test.mjs
//
// Templates are read from disk rather than imported, because `import x from
// "./x.html"` is a Worker module rule, not something Node does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { badge } from "./lib/badge.js";
import {
  channelsFor,
  electronFeed,
  normalizeChannel,
  sparkleFeed,
  guessPlatform,
  isNewer,
  normalizeDate,
  normalizeVersion,
  platformKeys,
  tauriFeed,
  toYaml,
  CHANNELS,
  PLATFORMS,
} from "./lib/feeds.js";
import { esc, render } from "./lib/render.js";
import { checkCredentials, hashPassword, hasSession, secretOk, sessionCookie, timingSafeEqual } from "./lib/auth.js";
import * as d1 from "./lib/db.js";
import * as demo from "./lib/demo.js";

const here = dirname(fileURLToPath(import.meta.url));
const tpl = (name) => readFileSync(join(here, "templates", name), "utf8");

// ---------------------------------------------------------------- versions

assert.equal(isNewer("1.2.3", "1.2.2"), true);
assert.equal(isNewer("1.2.3", "1.2.3"), false);
assert.equal(isNewer("1.2.2", "1.2.3"), false);
assert.equal(isNewer("1.10.0", "1.9.0"), true, "numeric compare, not string");
assert.equal(isNewer("v0.2.0", "0.1.9"), true, "leading v tolerated");
assert.equal(isNewer("1.2.0-beta.1", "1.2.0"), false, "prerelease compares equal");
assert.equal(isNewer("0.1.0", ""), true, "a missing current version still updates");

// A stored "v1.2.3" would be rejected by a client as invalid semver.
assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
assert.equal(normalizeVersion("  0.1.0 "), "0.1.0");
assert.equal(normalizeVersion("1.2.0-beta.1"), "1.2.0-beta.1");
assert.equal(normalizeVersion("1.2"), "1.2.0", "two part versions are padded");
assert.equal(normalizeVersion("v0.1"), "0.1.0");
assert.equal(normalizeVersion("2"), "2.0.0");
assert.equal(normalizeVersion("1.2-beta.1"), "1.2.0-beta.1");
assert.equal(normalizeVersion("1.2.3.4"), null, "four part versions are rejected");
assert.equal(normalizeVersion("1.2.3abc"), null);
assert.equal(normalizeVersion(""), null);

// pub_date picks the latest release by text comparison, so offsets have to be
// normalized to UTC or the sort is wrong.
assert.equal(normalizeDate("2026-01-01T10:00:00+05:30"), "2026-01-01T04:30:00.000Z");
assert.equal(normalizeDate("nonsense"), null);
assert.match(normalizeDate(undefined), /^\d{4}-/, "missing date defaults to now");

// ---------------------------------------------------------------- channels

assert.deepEqual(CHANNELS, ["stable", "beta", "nightly"]);
assert.equal(normalizeChannel(undefined), "stable", "unsaid means stable");
assert.equal(normalizeChannel(""), "stable");
assert.equal(normalizeChannel(" Beta "), "beta");
assert.equal(normalizeChannel("canary"), null);
assert.deepEqual(channelsFor("stable"), ["stable"]);
assert.deepEqual(channelsFor("beta"), ["stable", "beta"], "beta accepts stable too");
assert.deepEqual(channelsFor("nightly"), ["stable", "beta", "nightly"]);

// ---------------------------------------------------------------- platforms

assert.deepEqual(platformKeys("windows", "x86_64"), ["windows-x86_64"]);
assert.deepEqual(platformKeys("darwin", "aarch64"), ["darwin-aarch64", "darwin-universal"]);

assert.equal(guessPlatform("ctx_0.1.1_x64_en-US.msi"), "windows-x86_64");
assert.equal(guessPlatform("ctx_0.1.1_x64-setup.exe"), "windows-x86_64");
assert.equal(guessPlatform("ctx_0.1.1_arm64_en-US.msi"), "windows-aarch64");
assert.equal(guessPlatform("ctx_universal.app.tar.gz"), "darwin-universal");
assert.equal(guessPlatform("ctx_aarch64.app.tar.gz"), "darwin-aarch64");
assert.equal(guessPlatform("App-1.0.0-mac.zip"), null, "not an .app.zip");
assert.equal(guessPlatform("ctx_0.1.1_amd64.AppImage"), "linux-x86_64");
assert.equal(guessPlatform("ctx_0.1.1_amd64.deb"), "linux-x86_64");
assert.equal(guessPlatform("notes.txt"), null, "an unknown extension guesses nothing");

// Every key a filename can produce has to be one the publish route accepts.
for (const f of [
  "a.msi",
  "a-arm64.msi",
  "a.dmg",
  "a_universal.app.tar.gz",
  "a_aarch64.app.tar.gz",
  "a.AppImage",
  "a-arm64.deb",
]) {
  assert.ok(PLATFORMS.includes(guessPlatform(f)), `${f} guessed a key publish would reject`);
}

// ---------------------------------------------------------------- feeds

const release = { version: "1.0.0", notes: "hi", pub_date: "2026-01-01T00:00:00.000Z" };
const files = [
  {
    platform: "windows-x86_64",
    url: "https://x/a.msi",
    signature: "sig-w",
    sha512: "A".repeat(86) + "==",
    size: 100,
  },
  { platform: "darwin-universal", url: "https://x/a.app.tar.gz", signature: "sig-m" },
  { platform: "linux-x86_64", url: "https://x/a.AppImage", sha512: "B".repeat(86) + "==", size: 7 },
];

const full = tauriFeed(release, files);
assert.deepEqual(Object.keys(full.platforms), ["windows-x86_64", "darwin-universal"]);
assert.equal(full.platforms["windows-x86_64"].signature, "sig-w");
// An unsigned artifact is download only and must never reach the Tauri feed.
assert.equal("linux-x86_64" in full.platforms, false);

const mac = tauriFeed(release, files, platformKeys("darwin", "aarch64"));
assert.deepEqual(Object.keys(mac.platforms), ["darwin-universal"]);
assert.deepEqual(Object.keys(tauriFeed(release, files, platformKeys("linux", "x86_64")).platforms), []);

// electron-updater needs a hash and a size, so the signed-but-unhashed macOS
// artifact is absent from its feed even though the Tauri feed carries it.
const win = electronFeed(release, files, "windows");
assert.equal(win.version, "1.0.0");
assert.equal(win.files.length, 1);
assert.equal(win.path, "https://x/a.msi", "legacy single file field mirrors the first entry");
assert.equal(win.sha512, files[0].sha512);
assert.equal(win.releaseDate, release.pub_date);
assert.equal(electronFeed(release, files, "darwin"), null, "no hash means no electron feed");
assert.equal(electronFeed(release, files, "linux").files[0].size, 7);

// The YAML has to be parseable by electron-updater, which means quoted strings,
// bare numbers, and a list of flat maps.
const out = toYaml(win);
assert.match(out, /^version: '1\.0\.0'$/m);
assert.match(out, /^files:$/m);
assert.match(out, /^ {2}- url: 'https:\/\/x\/a\.msi'$/m);
assert.match(out, /^ {4}size: 100$/m, "size stays a bare number");
assert.match(toYaml({ n: "it's" }), /^n: 'it''s'$/, "single quotes are doubled");

// Sparkle: one item per macOS artifact, universal first, signature and
// length only when the artifact has them, notes in CDATA.
const cast = sparkleFeed("ctx", { ...release, notes: "a <b> & ]]> c" }, [
  ...files,
  { platform: "darwin-aarch64", url: "https://x/arm.app.tar.gz", size: 9 },
]);
assert.match(cast, /<title>ctx<\/title>/);
assert.equal((cast.match(/<item>/g) ?? []).length, 2, "two macOS artifacts, two items");
assert.ok(cast.indexOf("a.app.tar.gz") < cast.indexOf("arm.app.tar.gz"), "universal first");
assert.match(cast, /url="https:\/\/x\/a\.app\.tar\.gz" type="application\/octet-stream" sparkle:edSignature="sig-m"\/>/);
assert.match(cast, /url="https:\/\/x\/arm\.app\.tar\.gz" type="application\/octet-stream" length="9"\/>/);
assert.match(cast, /<sparkle:version>1\.0\.0<\/sparkle:version>/);
assert.match(cast, /<description><!\[CDATA\[a <b> & \]\]\]\]><!\[CDATA\[> c\]\]><\/description>/, "a ]]> inside notes cannot end the CDATA");
assert.match(cast, /<pubDate>Thu, 01 Jan 2026 00:00:00 GMT<\/pubDate>/);
assert.equal(sparkleFeed("ctx", release, files.filter((f) => !f.platform.startsWith("darwin"))), null, "no macOS artifact, no appcast");

// The badge is an SVG with both texts and a width that grows with them.
const b = badge("release", "0.1.1");
assert.match(b, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
assert.match(b, />release<\/text>/);
assert.match(b, />0\.1\.1<\/text>/);
assert.ok(Number(badge("release", "10.20.30").match(/width="(\d+)"/)[1]) > Number(b.match(/width="(\d+)"/)[1]));
assert.match(badge("a", '"<x>"'), /aria-label="a: &quot;&lt;x&gt;&quot;"/, "escaped");

// ---------------------------------------------------------------- templating

assert.equal(render("<p>{{a}}</p>", { a: "<b>" }), "<p>&lt;b&gt;</p>", "double braces escape");
assert.equal(render("<p>{{{a}}}</p>", { a: "<b>" }), "<p><b></p>", "triple braces do not");
assert.equal(render("{{missing}}", {}), "{{missing}}", "an unknown key is left alone");
// The admin page carries its own script, so brace pairs in JavaScript have to
// survive the pass untouched.
assert.equal(render("`${x}` and {{y}}", { y: "1" }), "`${x}` and 1");
assert.equal(esc(`<&">'`), "&lt;&amp;&quot;&gt;&#39;");

for (const name of ["layout.html", "index.html", "app-card.html", "app.html", "login.html", "admin.html", "about.html"]) {
  const body = tpl(name);
  assert.ok(body.length > 0, `${name} must not be empty`);
  // Every placeholder the templates use must be one a route actually supplies.
  for (const [, key] of body.matchAll(/\{\{\{?(\w+)\}?\}\}/g)) {
    assert.ok(
      [
        "title", "nav", "body", "count", "apps", "name", "version", "platforms",
        "error", "boot", "when", "href", "history", "demo", "tryDemo",
        "manage", "channels", "buttons", "files",
      ].includes(key),
      `${name} uses an unknown placeholder: ${key}`,
    );
  }
}

// The admin page's inline script used to live inside a JS template literal,
// where a stray backtick shipped a broken page. It is a real .html file now,
// but the parse check is cheap and still the only thing that would catch a
// syntax error in it.
const admin = tpl("admin.html");
const inline = admin.match(/<script>([\s\S]*)<\/script>/);
assert.ok(inline, "the admin page must contain an inline script");
new Function(inline[1]);
for (const id of ["view", "new-app", "app-form", "app-slug", "app-name", "boot"]) {
  assert.ok(admin.includes(`id="${id}"`), `the admin page must have #${id}`);
}
assert.ok(tpl("login.html").includes('name="password"'), "the login form must post a password");
// Every tab the admin links to has a function that draws it.
for (const [, tab] of admin.matchAll(/^    \["(\w+)", "\w+", "iconoir-[\w-]+"\],$/gm)) {
  assert.ok(admin.includes(`function ${tab}(`), `the admin page must draw the ${tab} tab`);
}
// The app page's script promotes the visitor's own system by these hooks.
assert.ok(tpl("app.html").includes('id="buttons"') && tpl("app.html").includes("data-os="), "the app page keeps its download hooks");
// The panel is rebuilt on every queue change, so what the user typed has to
// come back from state, never from the markup that was just thrown away.
assert.ok(admin.includes("semver(S.ver)") && admin.includes("notes: S.notes"), "publish reads the version and notes from state");
assert.ok(admin.includes('value="${esc(S.ver)}"') && admin.includes("{esc(S.notes)}"), "the admin page renders ver and notes from state");
// The layout wraps the login and publishing pages, so every script it loads
// has to come from Herald itself, and every outside stylesheet that can be
// pinned to a hash has to be.
const shell = tpl("layout.html");
assert.ok(!/<script[^>]+src="(https?:)?\/\//.test(shell), "no third party script in the layout");
assert.ok(readFileSync(join(here, "vendor", "tailwind-3.4.17.txt"), "utf8").length > 100000, "the vendored Tailwind build must be present");
assert.match(shell, /iconoir@v[\d.]+\/css\/iconoir\.css"\s+integrity="sha384-/, "Iconoir is pinned to a release and a hash");
// The header carries the mark itself, and the favicon is the same file the worker serves.
const markPaths = [...readFileSync(join(here, "assets", "herald.svg"), "utf8").matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
assert.ok(markPaths.length === 1, "the mark is one path");
for (const d of markPaths) assert.ok(shell.includes(`d="${d}"`), "the header mark matches assets/herald.svg");
assert.ok(shell.includes('rel="icon" href="/herald.svg"'), "the favicon is the mark");

// ---------------------------------------------------------------- auth

assert.equal(timingSafeEqual("abc", "abc"), true);
assert.equal(timingSafeEqual("abc", "abd"), false);
assert.equal(timingSafeEqual("abc", "abcd"), false, "length mismatch is not equal");
assert.equal(timingSafeEqual(undefined, ""), true, "nullish coerces to empty, not to a match");

// A deployment with no credentials configured must be locked, not open.
assert.equal(await checkCredentials({}, "admin", "admin"), false);
assert.equal(await checkCredentials({ ADMIN_USER: "a" }, "a", ""), false, "no password means no entry");
const env = { ADMIN_USER: "ops", ADMIN_PASSWORD: "s3cret", SESSION_SECRET: "signing-key-signing-key-signing-key" };
assert.equal(await checkCredentials(env, "ops", "s3cret"), true);
assert.equal(await checkCredentials(env, "ops", "wrong"), false);
assert.equal(await checkCredentials(env, "nope", "s3cret"), false);

// The stored password may be a PBKDF2 hash instead of the plain text.
const hashed = await hashPassword("s3cret", 1000);
assert.match(hashed, /^pbkdf2-sha256\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
assert.notEqual(hashed, await hashPassword("s3cret", 1000), "a fresh salt every time");
assert.equal(await checkCredentials({ ...env, ADMIN_PASSWORD: hashed }, "ops", "s3cret"), true);
assert.equal(await checkCredentials({ ...env, ADMIN_PASSWORD: hashed }, "ops", "s3cret "), false);
assert.equal(await checkCredentials({ ...env, ADMIN_PASSWORD: hashed }, "ops", hashed), false, "the hash itself is not the password");

// A short signing secret is refused rather than used.
assert.equal(secretOk({ SESSION_SECRET: "short" }), false);
assert.equal(secretOk(env), true);
await assert.rejects(sessionCookie({ SESSION_SECRET: "short" }, new URL("https://herald.example/login")));

// A session cookie is signed and self expiring, so it needs no server state
// and cannot be extended by editing it.
const url = new URL("https://herald.example/login");
const setCookie = await sessionCookie(env, url);
assert.match(setCookie, /HttpOnly/);
assert.match(setCookie, /SameSite=Lax/);
assert.match(setCookie, /; Secure/, "https requests get a Secure cookie");
assert.ok(!(await sessionCookie(env, new URL("http://127.0.0.1/login"))).includes("Secure"));

const cookie = setCookie.split(";")[0];
const withCookie = (c) => new Request("https://herald.example/admin", { headers: { cookie: c } });
assert.equal(await hasSession(withCookie(cookie), env), true);
assert.equal(await hasSession(new Request("https://herald.example/admin"), env), false);
assert.equal(await hasSession(withCookie(cookie), { SESSION_SECRET: "other-key" }), false, "signed with a different secret");
assert.equal(await hasSession(withCookie("herald_session=9999999999999.deadbeef"), env), false, "forged signature");
const [exp, sig] = cookie.split("=")[1].split(".");
assert.equal(
  await hasSession(withCookie(`herald_session=${Number(exp) + 60000}.${sig}`), env),
  false,
  "an extended expiry invalidates the signature",
);
assert.equal(await hasSession(withCookie("herald_session=1.abc"), env), false, "expired");
assert.equal(await hasSession(withCookie(cookie), { SESSION_SECRET: "short" }), false, "a short secret validates nothing");
assert.equal(
  await hasSession(new Request("https://staging.example/admin", { headers: { cookie } }), env),
  false,
  "a cookie is bound to the host it was minted for",
);
assert.equal(await hasSession(withCookie(`xherald_session=${cookie.split("=")[1]}`), env), false, "a lookalike cookie name is not the cookie");

// Signing out is a POST, in the header and in the demo bar.
assert.ok(!/href="\/logout"/.test(readFileSync(join(here, "worker.js"), "utf8")), "no GET link to /logout");

// ---------------------------------------------------------------- demo

// The demo store stands in for D1 behind the same names, so a query the
// routes can make against one has to exist on the other.
for (const name of Object.keys(d1)) assert.equal(typeof demo[name], "function", `demo.js is missing ${name}`);

assert.equal(demo.inDemo(withCookie("herald_demo=1")), true);
assert.equal(demo.inDemo(withCookie("other=1; herald_demo=1; x=2")), true);
assert.equal(demo.inDemo(withCookie("herald_demo=10")), false, "the value is exact");
assert.equal(demo.inDemo(new Request("https://herald.example/")), false);

const store = demo.createStore();
assert.ok(store.demo, "a demo handle says so, which is how worker.js picks it over D1");
const listed = demo.appsWithLatest(store);
assert.deepEqual(listed.map((a) => a.slug), ["ctx", "orbit", "refreshie"], "sorted by name");
assert.equal(listed[0].version, "0.1.1", "newest pub_date wins");
assert.equal(listed[0].channel, "stable");
assert.equal(listed[2].version, "2.5.0", "the card shows the newest release whatever its channel");
assert.equal(listed[2].channel, "beta");
assert.deepEqual(listed[0].platforms, ["darwin-aarch64", "windows-x86_64"]);
assert.equal(listed[0].signed, true, "ctx has a Tauri feed");
assert.equal(listed[0].hashed, false);
assert.equal(listed[2].hashed, true, "refreshie has an Electron feed");
assert.equal(listed[1].version, null, "an app with no release still lists");
assert.equal(listed[1].unlisted, true);
assert.equal(demo.releaseHistory(store, "ctx").length, 2);

// Channels: stable sees stable only, beta sees the newer beta too.
assert.equal(demo.latestRelease(store, "refreshie").version, "2.4.0", "a stable client does not get the beta");
assert.equal(demo.latestRelease(store, "refreshie", "beta").version, "2.5.0");
assert.equal(demo.latestRelease(store, "refreshie", "nightly").version, "2.5.0", "nightly accepts beta");
assert.equal(demo.releaseHistory(store, "refreshie")[0].channel, "beta");

// Counts: one row per day, kind and version, bumped in place; unknown apps
// write nothing; deleting an app takes its counts with it.
const before = demo.hitsFor(store, "ctx").length;
demo.countHits(store, [
  { slug: "ctx", kind: "check", version: "0.1.1", n: 2 },
  { slug: "ctx", kind: "download", version: "0.1.1", n: 1 },
  { slug: "nope", kind: "check", version: "", n: 1 },
]);
const todayRows = demo.hitsFor(store, "ctx").filter((h) => h.day === demo.today());
assert.equal(todayRows.find((h) => h.kind === "check" && h.version === "0.1.1").count, 42, "the seed's 40 plus two");
assert.equal(todayRows.find((h) => h.kind === "download").count, 2, "the seed's 1 plus one");
assert.equal(demo.hitsFor(store, "ctx").length, before, "no new rows for an existing day, kind and version");
assert.equal(demo.hitsFor(store, "nope").length, 0);
assert.ok(demo.hitsFor(store, "ctx").every((h) => !("app_slug" in h)), "rows carry day, kind, version and count only");
assert.equal(demo.artifactsFor(store, 4).length, 3);

// A publish round trip: a new version becomes latest, a notes edit keeps the
// date, and deletes cascade the way the schema's foreign keys do.
demo.upsertApp(store, "orbit", "Orbit One");
assert.equal(demo.appsWithLatest(store).find((a) => a.slug === "orbit").name, "Orbit One");
const { id } = demo.upsertRelease(store, "orbit", "1.0.0", "first", null, "beta");
assert.equal(demo.releaseByVersion(store, "orbit", "1.0.0").channel, "beta");
demo.upsertRelease(store, "orbit", "1.0.0", null, null, null);
assert.equal(demo.releaseByVersion(store, "orbit", "1.0.0").channel, "beta", "a null channel keeps the channel");
demo.upsertRelease(store, "orbit", "1.0.0", null, null, "stable");
assert.equal(demo.releaseByVersion(store, "orbit", "1.0.0").channel, "stable");
assert.equal(demo.latestRelease(store, "orbit"), null, "a release with no artifacts is not latest");
demo.upsertArtifacts(store, id, [["linux-x86_64", { url: "https://x/a.AppImage", size: 5 }]]);
assert.equal(demo.latestRelease(store, "orbit").version, "1.0.0");
const dated = demo.releaseByVersion(store, "orbit", "1.0.0").pub_date;
demo.upsertRelease(store, "orbit", "1.0.0", "edited", null);
assert.equal(demo.releaseByVersion(store, "orbit", "1.0.0").pub_date, dated, "a notes edit does not re-date");
assert.equal(demo.releaseByVersion(store, "orbit", "1.0.0").notes, "edited");
assert.deepEqual(demo.deleteArtifact(store, "orbit", "1.0.0", "linux-x86_64"), { platform: "linux-x86_64" });
assert.equal(demo.deleteArtifact(store, "orbit", "1.0.0", "linux-x86_64"), null);
assert.deepEqual(demo.deleteRelease(store, "orbit", "1.0.0"), { version: "1.0.0" });
assert.deepEqual(demo.deleteApp(store, "ctx"), { slug: "ctx" });
assert.equal(demo.releaseHistory(store, "ctx").length, 0, "releases go with the app");
assert.equal(demo.hitsFor(store, "ctx").length, 0, "and so do the counts");
assert.equal(store.artifacts.some((a) => a.release_id <= 2), false, "and so do their artifacts");
assert.equal(demo.deleteApp(store, "ctx"), null);
assert.equal(demo.createStore().apps.length, 3, "each store starts from the seed files");

console.log("herald: all checks passed");
