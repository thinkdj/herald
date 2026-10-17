// Demo mode: the same query layer as lib/db.js, over three JSON files instead
// of D1, so the UI can be walked end to end with no database, no bucket and
// no password. Entered at /demo, left at /logout, and only answered when the
// DEMO var is set, so a real deployment has no sandbox unless it asks for one.
//
// Every function here mirrors one in db.js by name and shape. worker.js picks
// the implementation by the handle it is given: this store says `demo: true`,
// a D1 binding does not.
import apps from "../demo/apps.json" with { type: "json" };
import releases from "../demo/releases.json" with { type: "json" };
import artifacts from "../demo/artifacts.json" with { type: "json" };
import { channelsFor } from "./feeds.js";

const DEMO_COOKIE = "herald_demo";
export const demoCookie = `${DEMO_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax`;
export const clearDemoCookie = `${DEMO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
export const inDemo = (req) => /(?:^|;\s*)herald_demo=1(?:;|$)/.test(req.headers.get("cookie") ?? "");

export const today = () => new Date().toISOString().slice(0, 10);
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// Thirty days of made up counts for ctx, so the admin's panel has something to
// draw: 0.1.0 fading out as 0.1.1 takes over after its release, and a few
// downloads a day. Deterministic, so the demo looks the same every visit.
// Seeded on first use, not when the store is made: a Worker freezes the clock
// during module evaluation, which would date the seed to 1970.
const hitsOf = (db) => (db.hits ??= seedHits());
const seedHits = () => {
  const rows = [];
  for (let n = 29; n >= 0; n--) {
    const day = dayAgo(n);
    const wobble = 1 + ((n * 7) % 5) / 10;
    const share = Math.min(1, (30 - n) / 18);
    rows.push({ app_slug: "ctx", day, kind: "check", version: "0.1.1", count: Math.round(40 * share * wobble) });
    rows.push({ app_slug: "ctx", day, kind: "check", version: "0.1.0", count: Math.round(38 * (1 - share) * wobble) + 2 });
    rows.push({ app_slug: "ctx", day, kind: "download", version: "0.1.1", count: 1 + ((n * 3) % 4) });
    rows.push({ app_slug: "nimbus", day, kind: "check", version: "", count: 12 + ((n * 5) % 7) });
  }
  return rows;
};

export const createStore = () => ({
  demo: true,
  apps: structuredClone(apps),
  releases: structuredClone(releases),
  artifacts: structuredClone(artifacts),
  hits: null,
  nextId: Math.max(0, ...releases.map((r) => r.id)) + 1,
});

// ponytail: one store per isolate, shared by every demo visitor and reset when
// the isolate restarts. A copy per session if the demo ever goes public.
const store = createStore();

// The bucket keeps nothing. An upload is measured and dropped, so the publish
// flow works end to end while the demo never holds anyone's bytes.
const bucket = {
  async put(key, body) {
    let size = 0;
    await body.pipeTo(new WritableStream({ write: (chunk) => void (size += chunk.byteLength) }));
    return { size };
  },
  async get() {
    return null;
  },
};

export const demoEnv = (env) => ({ ...env, DB: store, BUCKET: bucket });

// ---------------------------------------------------------------- queries

const byNewest = (a, b) => b.pub_date.localeCompare(a.pub_date) || b.id - a.id;
const releasesOf = (db, slug) => db.releases.filter((r) => r.app_slug === slug).sort(byNewest);
const findRelease = (db, slug, version) => db.releases.find((r) => r.app_slug === slug && r.version === version);
const pick = ({ id, version, channel, notes, pub_date }) => ({ id, version, channel, notes, pub_date });

export const latestRelease = (db, slug, channel = "stable") => {
  const accepted = channelsFor(channel);
  return (
    releasesOf(db, slug)
      .filter((r) => accepted.includes(r.channel) && db.artifacts.some((a) => a.release_id === r.id))
      .map(pick)[0] ?? null
  );
};

export const artifactsFor = (db, releaseId) =>
  db.artifacts
    .filter((a) => a.release_id === releaseId)
    .map(({ platform, url, signature, sha512, size }) => ({ platform, url, signature, sha512, size }));

export const appsWithLatest = (db) =>
  [...db.apps]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((app) => {
      const latest = releasesOf(db, app.slug)[0];
      const files = latest ? artifactsFor(db, latest.id) : [];
      return {
        slug: app.slug,
        name: app.name,
        unlisted: Boolean(app.unlisted),
        version: latest?.version ?? null,
        channel: latest?.channel ?? null,
        pub_date: latest?.pub_date ?? null,
        platforms: files.map((f) => f.platform).sort(),
        signed: files.some((f) => f.signature != null),
        hashed: files.some((f) => f.sha512 != null && f.size != null),
      };
    });

export const releaseHistory = (db, slug) =>
  releasesOf(db, slug)
    .slice(0, 100)
    .map((r) => ({
      version: r.version,
      channel: r.channel,
      notes: r.notes,
      pub_date: r.pub_date,
      platforms: artifactsFor(db, r.id).map((a) => a.platform).sort(),
    }));

export const upsertApp = (db, slug, name = null, unlisted = null) => {
  const app = db.apps.find((a) => a.slug === slug);
  if (!app) {
    db.apps.push({ slug, name: name ?? slug, unlisted: unlisted ?? 0 });
    return;
  }
  if (name != null) app.name = name;
  if (unlisted != null) app.unlisted = unlisted;
};

export const upsertRelease = (db, slug, version, notes, pubDate, channel = null) => {
  let release = findRelease(db, slug, version);
  if (!release) {
    release = {
      id: db.nextId++,
      app_slug: slug,
      version,
      channel: channel ?? "stable",
      notes: notes ?? "",
      pub_date: pubDate ?? new Date().toISOString(),
    };
    db.releases.push(release);
  } else {
    if (notes != null) release.notes = notes;
    if (pubDate != null) release.pub_date = pubDate;
    if (channel != null) release.channel = channel;
  }
  return { id: release.id };
};

export const upsertArtifacts = (db, releaseId, artifacts) => {
  for (const [platform, a] of artifacts) {
    const row = {
      release_id: releaseId,
      platform,
      url: a.url,
      signature: a.signature ? String(a.signature) : null,
      sha512: a.sha512 ? String(a.sha512) : null,
      size: Number.isFinite(a.size) ? a.size : null,
    };
    const i = db.artifacts.findIndex((x) => x.release_id === releaseId && x.platform === platform);
    if (i < 0) db.artifacts.push(row);
    else db.artifacts[i] = row;
  }
};

export const releaseByVersion = (db, slug, version) => {
  const release = findRelease(db, slug, version);
  return release ? pick(release) : null;
};

export const deleteRelease = (db, slug, version) => {
  const release = findRelease(db, slug, version);
  if (!release) return null;
  db.releases = db.releases.filter((r) => r !== release);
  db.artifacts = db.artifacts.filter((a) => a.release_id !== release.id);
  return { version: release.version };
};

export const deleteArtifact = (db, slug, version, platform) => {
  const release = findRelease(db, slug, version);
  const i = release ? db.artifacts.findIndex((a) => a.release_id === release.id && a.platform === platform) : -1;
  if (i < 0) return null;
  db.artifacts.splice(i, 1);
  return { platform };
};

export const deleteApp = (db, slug) => {
  if (!db.apps.some((a) => a.slug === slug)) return null;
  db.apps = db.apps.filter((a) => a.slug !== slug);
  for (const r of releasesOf(db, slug)) deleteRelease(db, slug, r.version);
  db.hits = hitsOf(db).filter((h) => h.app_slug !== slug);
  return { slug };
};

// ---------------------------------------------------------------- counts

export const countHits = (db, rows) => {
  const day = today();
  for (const { slug, kind, version, n } of rows) {
    if (!db.apps.some((a) => a.slug === slug)) continue;
    const row = hitsOf(db).find((h) => h.app_slug === slug && h.day === day && h.kind === kind && h.version === version);
    if (row) row.count += n;
    else hitsOf(db).push({ app_slug: slug, day, kind, version, count: n });
  }
};

export const hitsFor = (db, slug, days = 30) => {
  const since = dayAgo(days);
  return hitsOf(db)
    .filter((h) => h.app_slug === slug && h.day >= since)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(({ day, kind, version, count }) => ({ day, kind, version, count }));
};
