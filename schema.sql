-- Herald schema. One row per app, one row per release, one row per platform
-- artifact. Apply with:
--   wrangler d1 execute herald --remote --config herald/wrangler.jsonc
--     --file herald/schema.sql

CREATE TABLE IF NOT EXISTS apps (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Off the public index. Feeds, downloads and /:slug still work: a deterrent
  -- for a private build, not access control.
  unlisted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
  version TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  pub_date TEXT NOT NULL,
  UNIQUE (app_slug, version)
);

-- platform is os-arch, Tauri's vocabulary used as the neutral one:
-- windows-x86_64, darwin-universal, darwin-aarch64, linux-x86_64, and so on.
--
-- Each updater verifies differently, and an artifact missing what a given
-- updater needs is left out of that feed only:
--   signature  minisign output from Tauri's bundler, for latest.json
--   sha512     base64 SHA-512 and size, for electron-updater's latest*.yml
-- An artifact with neither is still downloadable, which is what an unsigned
-- test build should be.
CREATE TABLE IF NOT EXISTS artifacts (
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  signature TEXT,
  sha512 TEXT,
  size INTEGER,
  PRIMARY KEY (release_id, platform)
);

CREATE INDEX IF NOT EXISTS releases_latest ON releases (app_slug, pub_date DESC, id DESC);
