// PII + secret redaction applied at ingest, before anything is stored or indexed.
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
export const RULES = [
  { id: "jwt", re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, mask: () => "[REDACTED:jwt]" },
  { id: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, mask: (m, s) => s + " [REDACTED]" },
  { id: "api_key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, mask: (m) => m.slice(0, m.indexOf("_", 3) + 1 || 4) + "[REDACTED]" },
  { id: "password", re: /\b(password|passwd|pwd|secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, mask: (m, k, sep) => k + sep + "[REDACTED]" },
  { id: "card", re: /\b(?:\d[ -]?){13,19}\b/g, mask: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) ? "****-" + d.slice(-4) : m; } },
  { id: "email", re: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, mask: (m, a, dom) => `${a}***@${dom}` },
  { id: "aadhaar", re: /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/g, mask: (m) => "XXXX XXXX " + m.slice(-4) },
  { id: "phone", re: /(?<![\w.-])\+\d{1,3}[ -]?\d{4,5}[ -]?\d{4,6}\b/g, mask: (m) => m.slice(0, 4) + "******" + m.slice(-2) },
  { id: "ipv4", re: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, mask: (m, a, b, c, d) => ([a, b, c, d].every((x) => +x <= 255) ? `${a}.${b}.${c}.x` : m) },
];
/** Redact a line. Returns { line, hits: {ruleId: count} }. `rules` can be a subset of rule ids. */
export function redact(line, rules = null) {
  const hits = {}; let out = line;
  for (const r of RULES) {
    if (rules && !rules.includes(r.id)) continue;
    out = out.replace(r.re, (...a) => { const masked = r.mask(...a); if (masked !== a[0]) hits[r.id] = (hits[r.id] || 0) + 1; return masked; });
  }
  return { line: out, hits };
}
