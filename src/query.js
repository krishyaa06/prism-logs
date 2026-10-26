// LogQL-compatible subset: lexer, recursive-descent parser, planner (index + time + bloom pruning), executor.
import { parseJSON, parseLogfmt } from "./parse.js";
import { matchLabel, labelKey } from "./store.js";

const RANGE_FNS = ["count_over_time", "rate", "bytes_over_time", "bytes_rate", "sum_over_time", "avg_over_time", "min_over_time", "max_over_time", "quantile_over_time", "first_over_time", "last_over_time"];
const AGG_OPS = ["sum", "avg", "min", "max", "count", "topk", "bottomk", "stddev"];
const UNIT = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
export const duration = (s) => { let t = 0, m; const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g; while ((m = re.exec(s))) t += +m[1] * UNIT[m[2]]; if (!t) throw new SyntaxError("bad duration " + s); return t; };

export function lex(src) {
  const out = []; let i = 0;
  const ops = ["|=", "|~", "!=", "!~", "=~", "==", ">=", "<=", "{", "}", "(", ")", "[", "]", ",", "|", "=", ">", "<", "+", "-", "*", "/"];
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "`") { let j = i + 1, s = ""; while (j < src.length && src[j] !== ch) { if (ch === '"' && src[j] === "\\" && j + 1 < src.length) { j++; s += src[j] === "n" ? "\n" : src[j]; } else s += src[j]; j++; } if (j >= src.length) throw new SyntaxError("unterminated string at " + i); out.push({ t: "str", v: s, p: i }); i = j + 1; continue; }
    if (ch === "[") { const j = src.indexOf("]", i); const body = src.slice(i + 1, j).trim(); if (/^[\d.]+(ms|s|m|h|d)/.test(body)) { out.push({ t: "range", v: duration(body), raw: body, p: i }); i = j + 1; continue; } }
    const num = /^\d+(?:\.\d+)?(?:ms|s|m|h|d)?/.exec(src.slice(i)); if (num && !/[A-Za-z_]/.test(src[i + num[0].length] || "")) { out.push({ t: "num", v: /[a-z]$/.test(num[0]) ? duration(num[0]) / 1000 : +num[0], raw: num[0], p: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][\w.]*/.exec(src.slice(i)); if (id) { out.push({ t: "id", v: id[0], p: i }); i += id[0].length; continue; }
    const op = ops.find((o) => src.startsWith(o, i)); if (op) { out.push({ t: "op", v: op, p: i }); i += op.length; continue; }
    throw new SyntaxError(`unexpected '${ch}' at ${i}`);
  }
  out.push({ t: "eof", p: src.length }); return out;
}

export function parse(src) {
  const T = lex(src); let i = 0;
  const peek = (o = 0) => T[i + o], next = () => T[i++];
  const is = (t, v, o = 0) => peek(o).t === t && (v === undefined || peek(o).v === v);
  const expect = (t, v) => { if (!is(t, v)) throw new SyntaxError(`expected ${v || t} at ${peek().p}, got ${peek().v ?? peek().t}`); return next(); };
  function selector() {
    expect("op", "{"); const matchers = [];
    while (!is("op", "}")) { const name = expect("id").v, op = next(); if (!["=", "!=", "=~", "!~"].includes(op.v)) throw new SyntaxError("bad matcher op " + op.v); matchers.push({ name, op: op.v, value: expect("str").v }); if (is("op", ",")) next(); }
    next(); if (!matchers.length) throw new SyntaxError("selector needs at least one matcher"); return matchers;
  }
  function labelCond() {
    const name = expect("id").v, op = next(); if (!["=", "==", "!=", ">", ">=", "<", "<=", "=~", "!~"].includes(op.v)) throw new SyntaxError("bad label filter op " + op.v);
    const val = next(); if (val.t !== "str" && val.t !== "num") throw new SyntaxError("label filter needs a value");
    return { name, op: op.v === "==" ? "=" : op.v, value: val.v, numeric: val.t === "num" };
  }
  function pipeline() {
    const stages = [];
    for (;;) {
      if (is("op", "|=") || is("op", "|~") || (is("op", "!=") && is("str", undefined, 1)) || (is("op", "!~") && is("str", undefined, 1))) { const op = next().v; stages.push({ k: "line", op, value: expect("str").v }); continue; }
      if (is("op", "|")) {
        next(); const w = peek();
        if (w.t === "id" && (w.v === "json" || w.v === "logfmt")) { next(); stages.push({ k: "parser", v: w.v }); continue; }
        if (w.t === "id" && (w.v === "pattern" || w.v === "regexp")) { next(); stages.push({ k: "extract", v: w.v, src: expect("str").v, re: w.v === "pattern" ? patternRe(peek(-1).v) : new RegExp(peek(-1).v.replace(/\(\?P</g, "(?<")) }); continue; }
        if (w.t === "id" && w.v === "line_format") { next(); stages.push({ k: "fmt", v: expect("str").v }); continue; }
        if (w.t === "id" && w.v === "unwrap") { next(); stages.push({ k: "unwrap", v: expect("id").v }); continue; }
        if (w.t === "id" && (w.v === "drop" || w.v === "keep")) { next(); const names = [expect("id").v]; while (is("op", ",")) { next(); names.push(expect("id").v); } stages.push({ k: w.v, names }); continue; }
        const conds = [[labelCond()]];
        while (is("id", "and") || is("id", "or") || is("op", ",")) { const j = next().v; const c = labelCond(); if (j === "or") conds.push([c]); else conds.at(-1).push(c); }
        stages.push({ k: "filter", conds }); continue;
      }
      return stages;
    }
  }
  function logExpr() { return { type: "log", matchers: selector(), stages: pipeline() }; }
  function grouping() { const kw = next().v; expect("op", "("); const labels = []; while (!is("op", ")")) { labels.push(expect("id").v); if (is("op", ",")) next(); } next(); return { mode: kw, labels }; }
  function primary() {
    if (is("op", "{")) return logExpr();
    if (is("num")) return { type: "scalar", v: next().v };
    if (is("op", "(")) { next(); const e = expr(); expect("op", ")"); return e; }
    const w = expect("id").v;
    if (RANGE_FNS.includes(w)) {
      expect("op", "("); let q; if (w === "quantile_over_time") { q = expect("num").v; expect("op", ","); }
      const inner = logExpr(); const r = expect("range"); expect("op", ")");
      let group = null; if (is("id", "by") || is("id", "without")) group = grouping();
      if (/^(sum|avg|min|max|quantile|first|last)_over_time$/.test(w) && !inner.stages.some((s) => s.k === "unwrap")) throw new SyntaxError(w + " needs | unwrap <label>");
      return { type: "range", fn: w, q, inner, range: r.v, rangeRaw: r.raw, group };
    }
    if (AGG_OPS.includes(w)) {
      let group = null; if (is("id", "by") || is("id", "without")) group = grouping();
      expect("op", "("); let k; if (w === "topk" || w === "bottomk") { k = expect("num").v; expect("op", ","); }
      const inner = expr(); expect("op", ")"); if (!group && (is("id", "by") || is("id", "without"))) group = grouping();
      if (inner.type === "log") throw new SyntaxError(w + "() needs a metric expression, e.g. " + w + "(rate({...}[1m]))");
      return { type: "agg", op: w, k, group, inner };
    }
    throw new SyntaxError("unknown function " + w);
  }
  function term() { let l = primary(); while (is("op", "*") || is("op", "/")) { const op = next().v; l = { type: "bin", op, l, r: primary() }; } return l; }
  function expr() { let l = term(); while (is("op", "+") || is("op", "-")) { const op = next().v; l = { type: "bin", op, l, r: term() }; } return l; }
  const ast = expr(); if (!is("eof")) throw new SyntaxError(`unexpected '${peek().v}' at ${peek().p}`); return ast;
}

/** Loki pattern parser: "<ip> - <_> [<ts>] \"<method> <path> <_>\" <status>" -> RegExp with named groups. */
export function patternRe(p) {
  const parts = p.split(/(<[\w_]+>)/).filter((x) => x !== ""); let src = "^";
  parts.forEach((x, i) => { const m = /^<([\w_]+)>$/.exec(x); if (!m) src += x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); else { const last = i === parts.length - 1, g = last ? "(\\S*)" : "(.*?)"; src += m[1] === "_" ? g.replace("(", "(?:") : g.replace("(", `(?<${m[1]}>`); } });
  return new RegExp(src);
}
// ---------- execution ----------
const lineTest = (st) => { if (st.op === "|=") return (l) => l.includes(st.value); if (st.op === "!=") return (l) => !l.includes(st.value); const re = new RegExp(st.value); return st.op === "|~" ? (l) => re.test(l) : (l) => !re.test(l); };
function condTest(c) {
  if (c.op === "=~" || c.op === "!~") return (f) => matchLabel(String(f[c.name] ?? ""), c);
  return (f) => {
    const raw = f[c.name]; if (raw === undefined) return c.op === "!=";
    if (c.numeric) { const v = typeof raw === "number" ? raw : parseFloat(raw); if (isNaN(v)) return false; switch (c.op) { case "=": return v === c.value; case "!=": return v !== c.value; case ">": return v > c.value; case ">=": return v >= c.value; case "<": return v < c.value; case "<=": return v <= c.value; } }
    const s = String(raw); switch (c.op) { case "=": return s === c.value; case "!=": return s !== c.value; case ">": return s > c.value; case ">=": return s >= c.value; case "<": return s < c.value; case "<=": return s <= c.value; }
    return false;
  };
}
/** Compile pipeline stages into fn(line, labels) -> {line, fields, value} | null */
function compilePipeline(stages) {
  const fns = stages.map((st) => {
    if (st.k === "line") { const t = lineTest(st); return (e) => (t(e.line) ? e : null); }
    if (st.k === "parser") return (e) => { const f = st.v === "json" ? parseJSON(e.line) : parseLogfmt(e.line); if (f) for (const [k, v] of Object.entries(f)) if (!(k in e.labels)) e.fields[k] = v; else e.fields[k + "_extracted"] = v; else e.fields.__error__ = "parse"; return e; };
    if (st.k === "extract") return (e) => { const m = st.re.exec(e.line); if (m?.groups) for (const [k, v] of Object.entries(m.groups)) if (v !== undefined) e.fields[k in e.labels ? k + "_extracted" : k] = /^-?\d+(\.\d+)?$/.test(v) ? +v : v; else if (!m) e.fields.__error__ = "pattern"; return e; };
    if (st.k === "filter") { const ors = st.conds.map((and) => and.map(condTest)); return (e) => { const all = { ...e.labels, ...e.fields }; return ors.some((and) => and.every((t) => t(all))) ? e : null; }; }
    if (st.k === "fmt") return (e) => { const all = { ...e.labels, ...e.fields }; e.line = st.v.replace(/\{\{\s*\.([\w]+)\s*\}\}/g, (_, k) => all[k] ?? ""); return e; };
    if (st.k === "unwrap") return (e) => { const v = parseFloat(e.fields[st.v] ?? e.labels[st.v]); if (isNaN(v)) return null; e.value = v; return e; };
    if (st.k === "drop") return (e) => { for (const n of st.names) { delete e.fields[n]; } return e; };
    if (st.k === "keep") return (e) => { const f = {}; for (const n of st.names) if (n in e.fields) f[n] = e.fields[n]; e.fields = f; return e; };
    return (e) => e;
  });
  return (line, labels) => { let e = { line, labels, fields: {}, value: undefined }; for (const f of fns) { e = f(e); if (!e) return null; } return e; };
}
/** Plan + scan: returns entries passing the pipeline within [start, end]. */
function scan(store, node, start, end, stats, { limit = Infinity, direction = "backward" } = {}) {
  const streams = store.select(node.matchers); stats.streams += streams.length;
  // bloom-prunable needles: positive line filters that appear before any line_format
  const needles = []; for (const st of node.stages) { if (st.k === "fmt") break; if (st.k === "line" && st.op === "|=") needles.push(st.value); }
  const pipe = compilePipeline(node.stages), out = [];
  for (const s of streams) for (const c of s.chunks) {
    stats.chunksTotal++;
    if (c.max < start || c.min > end) { stats.chunksTime++; continue; }
    if (needles.some((n) => !c.mayContain(n))) { stats.chunksBloom++; stats.prunedIds.push(c.id); continue; }
    stats.chunksScanned++; stats.scannedIds.push(c.id); stats.bytes += c.bytes;
    for (let i = 0; i < c.size; i++) { const ts = c.ts[i]; if (ts < start || ts > end) continue; stats.lines++; const e = pipe(c.lines[i], s.labels); if (e) { e.ts = ts; e.stream = s; out.push(e); } }
  }
  out.sort(direction === "forward" ? (a, b) => a.ts - b.ts : (a, b) => b.ts - a.ts);
  stats.matched += out.length;
  return out.length > limit ? out.slice(0, limit) : out;
}
const quantile = (arr, q) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y), i = (a.length - 1) * q, lo = Math.floor(i); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo); };
function rangeAgg(fn, vals, ents, rangeS, q) {
  const n = ents.length; if (!n) return undefined;
  switch (fn) {
    case "count_over_time": return n; case "rate": return n / rangeS;
    case "bytes_over_time": return ents.reduce((s, e) => s + e.len, 0); case "bytes_rate": return ents.reduce((s, e) => s + e.len, 0) / rangeS;
    case "sum_over_time": return vals.reduce((s, v) => s + v, 0); case "avg_over_time": return vals.reduce((s, v) => s + v, 0) / n;
    case "min_over_time": return Math.min(...vals); case "max_over_time": return Math.max(...vals);
    case "quantile_over_time": return quantile(vals, q); case "first_over_time": return vals[0]; case "last_over_time": return vals[n - 1];
  }
}
const groupLabels = (labels, g) => { if (!g) return {}; const o = {}; if (g.mode === "by") { for (const k of g.labels) if (labels[k] !== undefined) o[k] = labels[k]; } else for (const [k, v] of Object.entries(labels)) if (!g.labels.includes(k)) o[k] = v; return o; };
function evalMetric(store, node, steps, stats, keep) {
  if (node.type === "scalar") return [{ labels: {}, values: steps.map(() => node.v), scalar: true }];
  if (node.type === "range") {
    const want = node.group ? node.group.labels : keep; // extracted labels survive only if referenced
    const ents = scan(store, node.inner, steps[0] - node.range, steps.at(-1), stats, { direction: "forward" });
    const series = new Map();
    for (const e of ents) {
      const labels = { ...e.labels }; if (want) for (const k of want) if (e.fields[k] !== undefined && labels[k] === undefined) labels[k] = String(e.fields[k]);
      const key = labelKey(labels); let s = series.get(key); if (!s) series.set(key, (s = { labels, ents: [] })); s.ents.push({ ts: e.ts, v: e.value, len: e.line.length });
    }
    let out = [...series.values()].map((s) => {
      let lo = 0, hi = 0; const values = steps.map((t) => { while (hi < s.ents.length && s.ents[hi].ts <= t) hi++; while (lo < hi && s.ents[lo].ts <= t - node.range) lo++; const w = s.ents.slice(lo, hi); return rangeAgg(node.fn, w.map((x) => x.v), w, node.range / 1000, node.q); });
      return { labels: s.labels, values };
    });
    if (node.group) out = aggregate(out, { op: "sum", group: node.group }, steps);
    return out;
  }
  if (node.type === "agg") return aggregate(evalMetric(store, node.inner, steps, stats, node.group?.mode === "by" ? node.group.labels : keep), node, steps);
  if (node.type === "bin") {
    const L = evalMetric(store, node.l, steps, stats, keep), R = evalMetric(store, node.r, steps, stats, keep);
    const f = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => (b === 0 ? undefined : a / b) }[node.op];
    const one = (a, b) => (a === undefined || b === undefined ? undefined : f(a, b));
    const bc = (side) => side.length === 1 && (side[0].scalar || !Object.keys(side[0].labels).length);
    if (bc(R)) return L.map((l) => ({ labels: l.labels, values: l.values.map((v, i) => one(v, R[0].values[i])) }));
    if (bc(L)) return R.map((r) => ({ labels: r.labels, values: r.values.map((v, i) => one(L[0].values[i], v)) }));
    const rm = new Map(R.map((r) => [labelKey(r.labels), r]));
    return L.filter((l) => rm.has(labelKey(l.labels))).map((l) => { const r = rm.get(labelKey(l.labels)); return { labels: l.labels, values: l.values.map((v, i) => one(v, r.values[i])) }; });
  }
  throw new Error("a metric query is required here (wrap the selector in rate(...[1m]) or count_over_time(...))");
}
function aggregate(series, node, steps) {
  if (node.op === "topk" || node.op === "bottomk") {
    const keepIdx = new Set();
    steps.forEach((_, i) => { const ranked = series.map((s, j) => [s.values[i], j]).filter((x) => x[0] !== undefined).sort((a, b) => (node.op === "topk" ? b[0] - a[0] : a[0] - b[0])); ranked.slice(0, node.k).forEach((x) => keepIdx.add(x[1])); });
    return series.filter((_, j) => keepIdx.has(j));
  }
  const groups = new Map();
  for (const s of series) { const labels = groupLabels(s.labels, node.group), key = labelKey(labels); let g = groups.get(key); if (!g) groups.set(key, (g = { labels, members: [] })); g.members.push(s); }
  return [...groups.values()].map((g) => ({ labels: g.labels, values: steps.map((_, i) => {
    const v = g.members.map((m) => m.values[i]).filter((x) => x !== undefined); if (!v.length) return undefined;
    const sum = v.reduce((a, b) => a + b, 0);
    switch (node.op) { case "sum": return sum; case "avg": return sum / v.length; case "min": return Math.min(...v); case "max": return Math.max(...v); case "count": return v.length; case "stddev": { const m = sum / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); } }
  }) }));
}
/**
 * Run a query. opts: { start, end (ms), step (ms), limit, direction }.
 * Log queries -> { kind: "streams", entries }, metric queries -> { kind: "matrix", series, steps }.
 */
export function query(store, src, { start = -Infinity, end = Infinity, step, limit = 100, direction = "backward" } = {}) {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const ast = typeof src === "string" ? parse(src) : src;
  const stats = { streams: 0, chunksTotal: 0, chunksTime: 0, chunksBloom: 0, chunksScanned: 0, lines: 0, bytes: 0, matched: 0, scannedIds: [], prunedIds: [] };
  let res;
  if (ast.type === "log") {
    const entries = scan(store, ast, start, end, stats, { limit, direction }).map((e) => ({ ts: e.ts, labels: e.labels, fields: e.fields, line: e.line }));
    res = { kind: "streams", entries };
  } else {
    if (!isFinite(end)) end = Math.max(0, ...[...store.streams.values()].flatMap((s) => s.chunks.map((c) => c.max)));
    if (!isFinite(start)) start = end - 3600e3;
    step = step || Math.max(1000, Math.ceil((end - start) / 120 / 1000) * 1000);
    const steps = []; for (let t = start; t <= end; t += step) steps.push(t);
    const series = evalMetric(store, ast, steps, stats, null).filter((s) => s.values.some((v) => v !== undefined));
    res = { kind: "matrix", series, steps };
  }
  stats.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return { ...res, stats, ast };
}
/** Pretty plan for EXPLAIN-style output. */
export function explain(ast, depth = 0) {
  const pad = "  ".repeat(depth);
  if (ast.type === "log") return `${pad}Scan {${ast.matchers.map((m) => `${m.name}${m.op}"${m.value}"`).join(", ")}}  (label index)\n` + ast.stages.map((s) => `${pad}  └ ${s.k === "line" ? `line ${s.op} "${s.value}"${s.op === "|=" ? "  (bloom-prunable)" : ""}` : s.k === "parser" ? "parse " + s.v : s.k === "extract" ? `${s.v} "${s.src}"` : s.k === "filter" ? "filter " + s.conds.map((a) => a.map((c) => `${c.name}${c.op}${c.value}`).join(" and ")).join(" or ") : s.k + " " + (s.v || s.names?.join(","))}`).join("\n") + (ast.stages.length ? "\n" : "");
  if (ast.type === "range") return `${pad}${ast.fn}${ast.q !== undefined ? "(" + ast.q + ")" : ""} [${ast.rangeRaw}]${ast.group ? ` ${ast.group.mode} (${ast.group.labels})` : ""}\n` + explain(ast.inner, depth + 1);
  if (ast.type === "agg") return `${pad}${ast.op}${ast.k ? "(" + ast.k + ")" : ""}${ast.group ? ` ${ast.group.mode} (${ast.group.labels})` : ""}\n` + explain(ast.inner, depth + 1);
  if (ast.type === "bin") return `${pad}${ast.op}\n` + explain(ast.l, depth + 1) + explain(ast.r, depth + 1);
  return `${pad}${ast.v}\n`;
}
