// Label-indexed chunk store (Loki-style): streams = unique label sets, each stream is a list of
// time-ordered chunks with min/max time and a trigram bloom filter. Only labels are indexed.
import { Bloom, eachTrigram } from "./bloom.js";
export const labelKey = (labels) => "{" + Object.keys(labels).sort().map((k) => `${k}="${labels[k]}"`).join(",") + "}";

export class Chunk {
  constructor(id, bloomBits) { this.id = id; this.ts = []; this.lines = []; this.min = Infinity; this.max = -Infinity; this.bytes = 0; this.bloom = new Bloom(bloomBits, 3); this.sealed = false; this.ordered = true; this._add = (g) => this.bloom.add(g); }
  append(ts, line) {
    if (ts < this.max) this.ordered = false;
    this.ts.push(ts); this.lines.push(line); this.bytes += line.length;
    if (ts < this.min) this.min = ts; if (ts > this.max) this.max = ts;
    eachTrigram(line, this._add);
  }
  seal() { if (!this.ordered) { const idx = this.ts.map((_, i) => i).sort((a, b) => this.ts[a] - this.ts[b]); this.ts = idx.map((i) => this.ts[i]); this.lines = idx.map((i) => this.lines[i]); this.ordered = true; } this.sealed = true; }
  get size() { return this.ts.length; }
  /** Could this chunk contain `needle`? (all trigrams present). Needles < 3 chars always pass. */
  mayContain(needle) { let ok = true; eachTrigram(needle, (g) => { if (ok && !this.bloom.has(g)) ok = false; }); return ok; }
}

export class LogStore {
  constructor({ chunkLines = 512, chunkSpanMs = 10 * 60e3, bloomBits = 1 << 15, retentionMs = Infinity, maxStreams = 10000 } = {}) {
    Object.assign(this, { chunkLines, chunkSpanMs, bloomBits, retentionMs, maxStreams });
    this.streams = new Map(); this.index = new Map(); this.seq = 0; this.stats = { lines: 0, bytes: 0, chunks: 0, dropped: 0, rejected: 0 };
  }
  /** Append one entry. Labels must be low cardinality (service, level, env...). */
  append(labels, ts, line) {
    const key = labelKey(labels); let s = this.streams.get(key);
    if (!s) {
      if (this.streams.size >= this.maxStreams) { this.stats.rejected++; return false; } // cardinality guard
      s = { key, labels: { ...labels }, chunks: [] }; this.streams.set(key, s);
      for (const [k, v] of Object.entries(labels)) { const ik = k + "=" + v; if (!this.index.has(ik)) this.index.set(ik, new Set()); this.index.get(ik).add(key); }
    }
    let c = s.chunks.at(-1);
    if (!c || c.sealed || c.size >= this.chunkLines || (c.size && ts - c.min > this.chunkSpanMs)) { if (c && !c.sealed) c.seal(); c = new Chunk(++this.seq, this.bloomBits); s.chunks.push(c); this.stats.chunks++; }
    c.append(ts, line); this.stats.lines++; this.stats.bytes += line.length; return true;
  }
  labelNames() { return [...new Set([...this.index.keys()].map((k) => k.split("=")[0]))].sort(); }
  labelValues(name) { return [...this.index.keys()].filter((k) => k.startsWith(name + "=")).map((k) => k.slice(name.length + 1)).sort(); }
  /** Resolve matchers [{name, op, value}] to streams using the inverted label index. */
  select(matchers) {
    let cand = null;
    for (const m of matchers.filter((m) => m.op === "=" && m.value !== "")) { const set = this.index.get(m.name + "=" + m.value) || new Set(); cand = cand ? new Set([...cand].filter((k) => set.has(k))) : new Set(set); }
    const pool = cand ? [...cand].map((k) => this.streams.get(k)) : [...this.streams.values()];
    return pool.filter((s) => matchers.every((m) => matchLabel(s.labels[m.name] ?? "", m)));
  }
  /** Drop chunks older than retention. Returns number of chunks dropped. */
  compact(now = Date.now()) {
    let n = 0; const cutoff = now - this.retentionMs;
    for (const [key, s] of this.streams) {
      const keep = s.chunks.filter((c) => c.max >= cutoff); n += s.chunks.length - keep.length;
      for (const c of s.chunks) if (c.max < cutoff) { this.stats.lines -= c.size; this.stats.bytes -= c.bytes; }
      s.chunks = keep; if (!keep.length) { this.streams.delete(key); for (const [k, v] of Object.entries(s.labels)) this.index.get(k + "=" + v)?.delete(key); }
    }
    this.stats.chunks -= n; this.stats.dropped += n; return n;
  }
}
const reCache = new Map();
export const anchored = (src) => { let r = reCache.get(src); if (!r) { r = new RegExp("^(?:" + src + ")$"); reCache.set(src, r); } return r; };
export function matchLabel(v, m) {
  switch (m.op) { case "=": return v === m.value; case "!=": return v !== m.value; case "=~": return anchored(m.value).test(v); case "!~": return !anchored(m.value).test(v); }
  return false;
}
