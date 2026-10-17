// A flat two-part badge, the kind a README carries: a grey label and a seal
// coloured value. Pure: text in, SVG out. Width is estimated from character
// count, which is what every badge service does too.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const width = (s) => Math.round(String(s).length * 6.5) + 12;

export function badge(label, value, color = "#B42318") {
  const lw = width(label);
  const vw = width(value);
  const w = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#57534e"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${esc(color)}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="14">${esc(value)}</text>
  </g>
</svg>
`;
}
