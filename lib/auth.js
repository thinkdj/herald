// Authentication. Two ways in, because Herald has two kinds of caller:
//
//   people   sign in at /login with ADMIN_USER and ADMIN_PASSWORD, and get a
//            signed session cookie
//   machines send `Authorization: Bearer $ADMIN_TOKEN`, so a CI job can publish
//            without a browser
//
// All three are Worker secrets. No user table, no reset flow: there is exactly
// one operator and the credential lives in Cloudflare's secret store, not in
// the database. ADMIN_PASSWORD may be the password itself or a PBKDF2 hash of
// it from `node herald/hash-password.mjs`, so the store never has to hold the
// plain text.

const enc = new TextEncoder();

export const SESSION_COOKIE = "herald_session";
const TTL_SECONDS = 12 * 60 * 60;
// Shorter than this and the HMAC is guessable; the login refuses to sign.
export const MIN_SECRET_LENGTH = 32;
const HASH_PREFIX = "pbkdf2-sha256";
const HASH_ITERATIONS = 100000;

// Compares without leaking which character differed. Length is still
// observable, which is true of every practical implementation and does not
// matter for a high entropy secret.
export function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export const secretOk = (env) => (env.SESSION_SECRET ?? "").length >= MIN_SECRET_LENGTH;

// The signed data carries the host, so a cookie minted on one deployment is
// worthless on another even if the two were given the same secret.
const sessionData = (host, exp) => `session:${host}:${exp}`;

// The cookie carries an expiry and its own signature, so a session needs no
// server side storage and cannot be extended by editing the cookie. Rotating
// SESSION_SECRET is what revokes every session at once.
export async function sessionCookie(env, url) {
  if (!secretOk(env)) throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const exp = Date.now() + TTL_SECONDS * 1000;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE}=${exp}.${await hmac(env.SESSION_SECRET, sessionData(url.host, exp))}` +
    `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}${secure}`
  );
}

export const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function hasSession(req, env) {
  if (!secretOk(env)) return false;
  const raw = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!sig || !Number(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, sessionData(new URL(req.url).host, exp)));
}

// PBKDF2-SHA256, 32 bytes, stored as `pbkdf2-sha256$iterations$salt$hash` in
// hex. Verification derives with the stored salt and iterations and compares
// in constant time.
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
export async function hashPassword(password, iterations = HASH_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return [HASH_PREFIX, iterations, hex(salt), await derive(password, salt, iterations)].join("$");
}
async function matches(password, stored) {
  if (!stored.startsWith(HASH_PREFIX + "$")) return timingSafeEqual(password, stored);
  const [, iterations, salt, hash] = stored.split("$");
  const bytes = Uint8Array.from(salt.match(/../g) ?? [], (h) => parseInt(h, 16));
  return timingSafeEqual(await derive(password, bytes, Number(iterations)), hash);
}

// An unset password can never match, so a deploy with no secrets configured is
// locked rather than open.
export async function checkCredentials(env, user, password) {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return false;
  // Both are checked even when the username is already wrong, so a failure
  // costs the same either way.
  const okUser = timingSafeEqual(user, env.ADMIN_USER);
  const okPassword = await matches(String(password ?? ""), env.ADMIN_PASSWORD);
  return okUser && okPassword;
}

export async function authorized(req, env) {
  const bearer = req.headers.get("authorization");
  if (env.ADMIN_TOKEN && bearer && timingSafeEqual(bearer, `Bearer ${env.ADMIN_TOKEN}`)) {
    return true;
  }
  return hasSession(req, env);
}

// Paired with the LOGIN_LIMIT and LOGIN_GLOBAL rate limit bindings in
// worker.js: the delay makes each guess slow, the limiters cap how many
// guesses a client, and everyone together, gets per minute.
export const failureDelay = () => new Promise((r) => setTimeout(r, 400));
