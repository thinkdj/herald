// Authentication. Two ways in, because Herald has two kinds of caller:
//
//   people   sign in at /login with ADMIN_USER and ADMIN_PASSWORD, and get a
//            signed session cookie
//   machines send `Authorization: Bearer $ADMIN_TOKEN`, so a CI job can publish
//            without a browser
//
// All three are Worker secrets. No user table, no password hashing, no reset
// flow: there is exactly one operator and the credential lives in Cloudflare's
// secret store, not in the database.

const enc = new TextEncoder();

export const SESSION_COOKIE = "herald_session";
const TTL_SECONDS = 12 * 60 * 60;

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

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The cookie carries an expiry and its own signature, so a session needs no
// server side storage and cannot be extended by editing the cookie.
export async function sessionCookie(env, url) {
  const exp = Date.now() + TTL_SECONDS * 1000;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${exp}.${await hmac(env.SESSION_SECRET, String(exp))}` +
    `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}${secure}`;
}

export const clearCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function hasSession(req, env) {
  if (!env.SESSION_SECRET) return false;
  const raw = (req.headers.get("cookie") ?? "").match(
    new RegExp(`${SESSION_COOKIE}=([^;]+)`),
  )?.[1];
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!sig || !Number(exp) || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}

// An unset password can never match, so a deploy with no secrets configured is
// locked rather than open.
export function checkCredentials(env, user, password) {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return false;
  // Both are compared even when the username is already wrong, so a failure
  // costs the same either way.
  const okUser = timingSafeEqual(user, env.ADMIN_USER);
  const okPassword = timingSafeEqual(password, env.ADMIN_PASSWORD);
  return okUser && okPassword;
}

export async function authorized(req, env) {
  const bearer = req.headers.get("authorization");
  if (env.ADMIN_TOKEN && bearer && timingSafeEqual(bearer, `Bearer ${env.ADMIN_TOKEN}`)) {
    return true;
  }
  return hasSession(req, env);
}

// Paired with the LOGIN_LIMIT rate limit binding in worker.js: the delay makes
// each guess slow, the limiter caps how many guesses a client gets per minute.
export const failureDelay = () => new Promise((r) => setTimeout(r, 400));
