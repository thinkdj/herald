// Templating, all of it. Templates are real .html files imported as text, so
// they are editable and highlightable as HTML rather than buried in a string.
//
// {{key}}   interpolates escaped
// {{{key}}} interpolates raw, for a body that is already HTML
//
// A placeholder with no matching key is left exactly as it was found. That is
// deliberate: the admin page carries its own inline script, and a brace pair in
// JavaScript must survive the pass untouched.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

export function render(tpl, vars = {}) {
  return tpl
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m))
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
}

// What a page may load, and from where. Scripts are Herald's own: the inline
// ones in the templates and the vendored Tailwind build. Styles come from the
// two pinned hosts plus what Tailwind injects, icons are data: masks inside
// the Iconoir sheet, and nothing may frame a page or post a form elsewhere.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Every page is a body rendered into the shared layout.
export const page = (layout, body, vars = {}) =>
  new Response(render(layout, { ...vars, body: render(body, vars) }), {
    status: vars.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": vars.cache ?? "no-store",
      "content-security-policy": CSP,
      ...(vars.headers ?? {}),
    },
  });
