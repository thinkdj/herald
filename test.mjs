// Self check for the pure parts of Herald. Run: node herald/test.mjs
//
// Templates are read from disk rather than imported, because `import x from
// "./x.html"` is a Worker module rule, not something Node does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  electronFeed,
  guessPlatform,
  isNewer,
  normalizeDate,
  normalizeVersion,
  platformKeys,
  tauriFeed,
  toYaml,
  PLATFORMS,
} from "./lib/feeds.js";
import { esc, render } from "./lib/render.js";
import { checkCredentials, hasSession, sessionCookie, timingSafeEqual } from "./lib/auth.js";

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

// ---------------------------------------------------------------- templating

assert.equal(render("<p>{{a}}</p>", { a: "<b>" }), "<p>&lt;b&gt;</p>", "double braces escape");
assert.equal(render("<p>{{{a}}}</p>", { a: "<b>" }), "<p><b></p>", "triple braces do not");
assert.equal(render("{{missing}}", {}), "{{missing}}", "an unknown key is left alone");
// The admin page carries its own script, so brace pairs in JavaScript have to
// survive the pass untouched.
assert.equal(render("`${x}` and {{y}}", { y: "1" }), "`${x}` and 1");
assert.equal(esc(`<&">'`), "&lt;&amp;&quot;&gt;&#39;");

for (const name of ["layout.html", "index.html", "app-card.html", "app.html", "login.html", "admin.html"]) {
  const body = tpl(name);
  assert.ok(body.length > 0, `${name} must not be empty`);
  // Every placeholder the templates use must be one a route actually supplies.
  for (const [, key] of body.matchAll(/\{\{\{?(\w+)\}?\}\}/g)) {
    assert.ok(
      [
        "title", "nav", "body", "count", "apps", "name", "version", "platforms",
        "links", "error", "boot", "when", "href", "card", "history",
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
for (const id of ["apps", "new-app", "app-form", "app-slug", "app-name", "main", "boot"]) {
  assert.ok(admin.includes(`id="${id}"`), `the admin page must have #${id}`);
}
assert.ok(tpl("login.html").includes('name="password"'), "the login form must post a password");

// ---------------------------------------------------------------- auth

assert.equal(timingSafeEqual("abc", "abc"), true);
assert.equal(timingSafeEqual("abc", "abd"), false);
assert.equal(timingSafeEqual("abc", "abcd"), false, "length mismatch is not equal");
assert.equal(timingSafeEqual(undefined, ""), true, "nullish coerces to empty, not to a match");

// A deployment with no credentials configured must be locked, not open.
assert.equal(checkCredentials({}, "admin", "admin"), false);
assert.equal(checkCredentials({ ADMIN_USER: "a" }, "a", ""), false, "no password means no entry");
const env = { ADMIN_USER: "ops", ADMIN_PASSWORD: "s3cret", SESSION_SECRET: "signing-key" };
assert.equal(checkCredentials(env, "ops", "s3cret"), true);
assert.equal(checkCredentials(env, "ops", "wrong"), false);
assert.equal(checkCredentials(env, "nope", "s3cret"), false);

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

console.log("herald: all checks passed");
