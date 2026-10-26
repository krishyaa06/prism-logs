// Format detection + parsers: JSON, logfmt, nginx/apache combined, syslog (RFC 3164-ish), plain text.
const NGINX = /^(\S+) \S+ (\S+) \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(?: (\d+(?:\.\d+)?))?/;
const SYSLOG = /^<(\d+)>(?:1 )?(\w{3} +\d+ [\d:]+|\d{4}-\d\d-\d\dT[^ ]+) (\S+) ([\w\-./]+)(?:\[(\d+)\])?: (.*)$/;
const LOGFMT = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const SEV = ["fatal", "fatal", "error", "error", "warn", "info", "info", "debug"];

export function detect(line) {
  const s = line.trimStart();
  if (s[0] === "{") return "json";
  if (s[0] === "<" && SYSLOG.test(s)) return "syslog";
  if (NGINX.test(s)) return "nginx";
  const kv = s.match(LOGFMT); if (kv && kv.length >= 2 && kv.join(" ").length > s.length * 0.6) return "logfmt";
  return "text";
}
/** Flatten nested JSON: {http:{status:500}} -> {http_status:500} (Loki-style label names). */
export function flatten(o, pre = "", out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = (pre ? pre + "_" : "") + k.replace(/[^\w]/g, "_");
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out); else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}
export function parseJSON(line) { try { const o = JSON.parse(line); return o && typeof o === "object" ? flatten(o) : null; } catch { return null; } }
export function parseLogfmt(line) {
  const out = {}; let m; LOGFMT.lastIndex = 0;
  while ((m = LOGFMT.exec(line))) { let v = m[2]; if (v[0] === '"') v = v.slice(1, -1).replace(/\\"/g, '"'); out[m[1].replace(/[^\w]/g, "_")] = num(v); }
  return out;
}
export function parseNginx(line) {
  const m = NGINX.exec(line); if (!m) return null;
  const [, ip, user, time, method, path, status, bytes, referer, ua, rt] = m;
  const t = /(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d{4})/.exec(time);
  const ts = t ? Date.UTC(+t[3], MONTHS[t[2]], +t[1], +t[4], +t[5], +t[6]) - (t[7][0] === "-" ? -1 : 1) * ((+t[7].slice(1, 3)) * 60 + +t[7].slice(3)) * 60000 : undefined;
  return { remote_addr: ip, user: user === "-" ? undefined : user, ts, method, path, status: +status, bytes: bytes === "-" ? 0 : +bytes, referer, user_agent: ua, request_time: rt ? +rt : undefined };
}
export function parseSyslog(line) {
  const m = SYSLOG.exec(line); if (!m) return null;
  const pri = +m[1]; let ts = Date.parse(m[2]); if (isNaN(ts)) { const [mo, d, hms] = m[2].split(/ +/); const [H, M, S] = hms.split(":"); ts = Date.UTC(new Date().getUTCFullYear(), MONTHS[mo], +d, +H, +M, +S); }
  return { ts, facility: pri >> 3, level: SEV[pri & 7], host: m[3], app: m[4], pid: m[5] ? +m[5] : undefined, msg: m[6] };
}
const num = (v) => (v !== "" && /^-?\d+(\.\d+)?$/.test(v) ? +v : v);
const PARSERS = { json: parseJSON, logfmt: parseLogfmt, nginx: parseNginx, syslog: parseSyslog, text: () => ({}) };
export const LEVELS = ["debug", "info", "warn", "error", "fatal"];
/** Normalise any level spelling (WARNING, Err, sev=3, 5xx status) to debug|info|warn|error|fatal. */
export function normLevel(f, line = "") {
  let v = f.level ?? f.lvl ?? f.severity ?? f.log_level ?? f.levelname;
  if (typeof v === "number") return v >= 60 ? "fatal" : v >= 50 ? "error" : v >= 40 ? "warn" : v >= 30 ? "info" : "debug"; // pino/bunyan numbers
  v = String(v ?? "").toLowerCase();
  if (/^(crit|fatal|panic|emerg|alert)/.test(v)) return "fatal";
  if (/^err/.test(v)) return "error";
  if (/^warn/.test(v)) return "warn";
  if (/^(debug|trace|verbose)/.test(v)) return "debug";
  if (/^(info|notice|information)/.test(v)) return "info";
  const st = +f.status || +f.http_status || +f.status_code;
  if (st >= 500) return "error"; if (st >= 400) return "warn"; if (st) return "info";
  if (/\b(error|exception|failed|panic)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return "info";
}
export function parseTs(v) {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v > 1e14 ? Math.floor(v / 1e6) : v; // s, ms or ns
  if (/^\d+(\.\d+)?$/.test(v)) return parseTs(+v);
  const t = Date.parse(v); return isNaN(t) ? undefined : t;
}
/** Parse a raw line into { format, fields, level, ts }. */
export function parseLine(line, format = "auto") {
  const fmt = format === "auto" ? detect(line) : format;
  const fields = PARSERS[fmt]?.(line) || {};
  const ts = parseTs(fields.ts ?? fields.time ?? fields.timestamp ?? fields["_timestamp"] ?? fields["@timestamp"] ?? fields._timestamp);
  return { format: fmt, fields, level: normLevel(fields, line), ts };
}
