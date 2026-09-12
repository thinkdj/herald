// Every D1 query Herald makes. Kept together so the shapes the routes rely on
// are visible in one place.

// The EXISTS clause matters: publishing writes the release row and the artifact
// rows in separate statements, so a run that died in between would otherwise
// leave an artifact-less release as "latest" and serve a feed with no files.
// An incomplete release is simply not the latest one.
export const latestRelease = (db, slug) =>
  db
    .prepare(
      `SELECT id, version, notes, pub_date FROM releases
       WHERE app_slug = ?1 AND EXISTS (SELECT 1 FROM artifacts WHERE release_id = releases.id)
       ORDER BY pub_date DESC, id DESC LIMIT 1`,
    )
    .bind(slug)
    .first();

export const artifactsFor = (db, releaseId) =>
  db
    .prepare(
      "SELECT platform, url, signature, sha512, size FROM artifacts WHERE release_id = ?1",
    )
    .bind(releaseId)
    .all()
    .then((r) => r.results ?? []);

// Latest release per app in one query. A LEFT JOIN keeps an app that has been
// registered but not yet released.
// `signed` and `hashed` say which updater feeds this app actually has, so the
// index can link only to feeds that exist rather than to one that 404s.
export const appsWithLatest = (db) =>
  db
    .prepare(
      `SELECT slug, name, unlisted, version, pub_date, platforms, signed, hashed FROM (
         SELECT a.slug, a.name, a.unlisted, r.version, r.pub_date, r.id AS rid,
                ROW_NUMBER() OVER (PARTITION BY a.slug ORDER BY r.pub_date DESC, r.id DESC) AS rn
         FROM apps a LEFT JOIN releases r ON r.app_slug = a.slug
       ) LEFT JOIN (
         SELECT release_id,
                group_concat(platform) AS platforms,
                max(signature IS NOT NULL) AS signed,
                max(sha512 IS NOT NULL AND size IS NOT NULL) AS hashed
           FROM artifacts GROUP BY release_id
       ) ON release_id = rid
       WHERE rn = 1 ORDER BY name`,
    )
    .all()
    .then((r) =>
      (r.results ?? []).map((a) => ({
        ...a,
        unlisted: Boolean(a.unlisted),
        platforms: (a.platforms ?? "").split(",").filter(Boolean).sort(),
        signed: Boolean(a.signed),
        hashed: Boolean(a.hashed),
      })),
    );

export const releaseHistory = (db, slug) =>
  db
    .prepare(
      `SELECT r.version, r.notes, r.pub_date,
              (SELECT group_concat(platform) FROM artifacts WHERE release_id = r.id) AS platforms
         FROM releases r WHERE r.app_slug = ?1
        ORDER BY r.pub_date DESC, r.id DESC LIMIT 100`,
    )
    .bind(slug)
    .all()
    .then((r) =>
      (r.results ?? []).map((x) => ({
        ...x,
        platforms: (x.platforms ?? "").split(",").filter(Boolean).sort(),
      })),
    );

// Null leaves a field as it is, so a publish that names the app cannot flip
// unlisted back, and an unlisted toggle does not need to resend the name.
export const upsertApp = (db, slug, name = null, unlisted = null) =>
  db
    .prepare(
      `INSERT INTO apps (slug, name, unlisted) VALUES (?1, coalesce(?2, ?1), coalesce(?3, 0))
       ON CONFLICT(slug) DO UPDATE SET name = coalesce(?2, name), unlisted = coalesce(?3, unlisted)`,
    )
    .bind(slug, name, unlisted)
    .run();

// A null notes value keeps what is there, so a per platform publish from a
// second machine does not blank the notes written on the first.
export const upsertRelease = (db, slug, version, notes, pubDate) =>
  db
    .prepare(
      `INSERT INTO releases (app_slug, version, notes, pub_date) VALUES (?1, ?2, coalesce(?3, ""), ?4)
       ON CONFLICT(app_slug, version) DO UPDATE SET notes = coalesce(?3, notes), pub_date = ?4
       RETURNING id`,
    )
    .bind(slug, version, notes, pubDate)
    .first();

// Merges per platform, so the Windows build published from one machine and the
// macOS build published from another end up in the same release. Dropping a
// platform means unpublishing the version and publishing it again.
export const upsertArtifacts = (db, releaseId, artifacts) =>
  db.batch([
    ...artifacts.map(([platform, a]) =>
      db
        .prepare(
          `INSERT INTO artifacts (release_id, platform, url, signature, sha512, size)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(release_id, platform) DO UPDATE
             SET url = ?3, signature = ?4, sha512 = ?5, size = ?6`,
        )
        .bind(
          releaseId,
          platform,
          a.url,
          a.signature ? String(a.signature) : null,
          a.sha512 ? String(a.sha512) : null,
          Number.isFinite(a.size) ? a.size : null,
        ),
    ),
  ]);

// RETURNING, not meta.changes: the cascade onto artifacts is counted in changes
// too, so it would report a release count that is wrong.
export const deleteRelease = (db, slug, version) =>
  db
    .prepare("DELETE FROM releases WHERE app_slug = ?1 AND version = ?2 RETURNING version")
    .bind(slug, version)
    .first();

export const releaseByVersion = (db, slug, version) =>
  db
    .prepare("SELECT id, version, notes, pub_date FROM releases WHERE app_slug = ?1 AND version = ?2")
    .bind(slug, version)
    .first();

export const deleteArtifact = (db, slug, version, platform) =>
  db
    .prepare(
      `DELETE FROM artifacts WHERE platform = ?3 AND release_id =
         (SELECT id FROM releases WHERE app_slug = ?1 AND version = ?2) RETURNING platform`,
    )
    .bind(slug, version, platform)
    .first();

// Releases and artifacts go with it through ON DELETE CASCADE.
export const deleteApp = (db, slug) =>
  db.prepare("DELETE FROM apps WHERE slug = ?1 RETURNING slug").bind(slug).first();
