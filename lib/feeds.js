// Release metadata in, updater feeds out. Everything framework specific lives
// here, and it is all pure: a release row, its artifact rows, and nothing else.
//
// Herald stores one neutral shape (app, version, per platform artifact with a
// url, an optional signature, an optional sha512 and size) and projects it into
// whatever dialect a given updater speaks. Adding a fourth updater means adding
// a function here and a route, not touching the schema.
//
//   Tauri     JSON with a minisign signature per platform
//   electron  YAML with a base64 sha512 and a byte size per file
//   anything  /:slug/download/:platform, which needs no dialect at all

// Platform keys are Tauri's vocabulary, used as the neutral one because it is
// the most specific: os-arch, plus darwin-universal for a fat macOS bundle.
export const PLATFORMS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-universal",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
];

// Friendly aliases so a download button can say /ctx/download/windows and not
// care which arch shipped.
export const ALIASES = {
  windows: ["windows-x86_64", "windows-aarch64"],
  macos: ["darwin-universal", "darwin-aarch64", "darwin-x86_64"],
  darwin: ["darwin-universal", "darwin-aarch64", "darwin-x86_64"],
  linux: ["linux-x86_64", "linux-aarch64"],
};

export const CONTENT_TYPES = {
  msi: "application/x-msi",
  exe: "application/vnd.microsoft.portable-executable",
  gz: "application/gzip",
  zip: "application/zip",
  dmg: "application/x-apple-diskimage",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  appimage: "application/x-executable",
  blockmap: "application/octet-stream",
  nupkg: "application/octet-stream",
};

// True when a is a strictly higher version than b. Prerelease suffixes are
// ignored, so 1.2.0-beta and 1.2.0 compare equal and the client stays put.
export function isNewer(a, b) {
  const parts = (v) =>
    String(v ?? "")
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Updaters parse the feed version as strict semver, so a stored "v1.2.3" makes
// a client reject a release it should have taken. Normalize on the way in and
// reject anything that is not a full three part version.
// "0.1" and "1" are padded to three parts, because that is what someone means
// by them and updaters parse the feed version as strict semver.
export function normalizeVersion(raw) {
  const v = String(raw ?? "")
    .trim()
    .replace(/^v/, "")
    .replace(/^(\d+)(\.\d+)?(?=$|[-+])/, (_, a, b) => a + (b ?? ".0") + ".0");
  return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

// pub_date decides which release is latest, and it is compared as text, so a
// mix of "Z" and "+05:30" offsets would sort wrong. Everything is stored as
// UTC ISO 8601.
export function normalizeDate(raw) {
  if (raw === undefined || raw === null) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Tauri sends target and arch separately. Universal macOS builds are filed
// under one key, so a darwin client has to be offered that too.
export function platformKeys(target, arch) {
  const keys = [`${target}-${arch}`];
  if (target === "darwin") keys.push("darwin-universal");
  return keys;
}

// Best guess at a platform key from a bundle filename, so the publish form
// arrives pre-filled instead of asking nine times. It is a guess: the admin
// page shows it in an editable field, because a macOS universal bundle and a
// single arch one can be named the same.
export function guessPlatform(filename) {
  const f = filename.toLowerCase();
  const arch = /aarch64|arm64/.test(f) ? "aarch64" : "x86_64";
  if (f.endsWith(".msi") || f.endsWith(".exe")) return `windows-${arch}`;
  if (f.endsWith(".app.tar.gz") || f.endsWith(".dmg") || f.endsWith(".app.zip")) {
    return /universal/.test(f) ? "darwin-universal" : `darwin-${arch}`;
  }
  if (f.endsWith(".appimage") || f.endsWith(".deb") || f.endsWith(".rpm")) {
    return `linux-${arch}`;
  }
  return null;
}

// Tauri's updater. An artifact with no signature cannot be verified by the
// client, so it is dropped from the feed rather than offered and then rejected.
export function tauriFeed(release, artifacts, only = null) {
  const platforms = {};
  for (const a of artifacts) {
    if (!a.signature) continue;
    if (only && !only.includes(a.platform)) continue;
    platforms[a.platform] = { signature: a.signature, url: a.url };
  }
  return {
    version: release.version,
    notes: release.notes || "",
    pub_date: release.pub_date,
    platforms,
  };
}

// electron-updater reads one file per OS: latest.yml, latest-mac.yml,
// latest-linux.yml. It verifies with a base64 sha512 and needs the byte size,
// so an artifact missing either is left out the way an unsigned one is left
// out of the Tauri feed. Returns null when that leaves nothing, which the route
// turns into a 404 rather than an empty feed the client would choke on.
export function electronFeed(release, artifacts, osPrefix) {
  const files = artifacts
    .filter((a) => a.platform.startsWith(osPrefix) && a.sha512 && a.size)
    .sort((a, b) => a.platform.localeCompare(b.platform))
    .map((a) => ({ url: a.url, sha512: a.sha512, size: a.size }));
  if (files.length === 0) return null;
  return {
    version: release.version,
    files,
    // The legacy single file fields. Older clients read these and ignore
    // `files`, so both are emitted.
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: release.pub_date,
  };
}

export const ELECTRON_FEEDS = {
  "latest.yml": "windows",
  "latest-mac.yml": "darwin",
  "latest-linux.yml": "linux",
};

// Enough YAML for the shape above: scalars, and a list of flat maps. Not a
// general emitter, and it does not need to be.
export function toYaml(obj, indent = "") {
  const scalar = (v) =>
    typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  return Object.entries(obj)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return (
          `${indent}${k}:\n` +
          v
            .map((item) =>
              Object.entries(item)
                .map(([ik, iv], i) => `${indent}  ${i === 0 ? "- " : "  "}${ik}: ${scalar(iv)}`)
                .join("\n"),
            )
            .join("\n")
        );
      }
      return `${indent}${k}: ${scalar(v)}`;
    })
    .join("\n");
}
