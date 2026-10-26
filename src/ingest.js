// Ingest pipeline: parse -> normalise -> redact -> label -> store.
import { parseLine } from "./parse.js";
import { redact } from "./redact.js";
export class Ingestor {
  constructor(store, { redact: doRedact = true, rules = null, labels = ["service", "env"], format = "auto", now = () => Date.now() } = {}) {
    Object.assign(this, { store, doRedact, rules, labelFields: labels, format, now });
    this.stats = { lines: 0, parsed: {}, redactions: {}, levels: {} };
  }
  /** Ingest one raw line with static labels (e.g. { service: "checkout" }). Returns the stored entry. */
  push(raw, labels = {}) {
    const p = parseLine(raw, this.format), f = p.fields, st = this.stats;
    st.lines++; st.parsed[p.format] = (st.parsed[p.format] || 0) + 1; st.levels[p.level] = (st.levels[p.level] || 0) + 1;
    const lab = { ...labels, level: p.level };
    for (const k of this.labelFields) if (lab[k] == null && f[k] != null && String(f[k]).length < 40) lab[k] = String(f[k]);
    let line = raw;
    if (this.doRedact) { const r = redact(raw, this.rules); line = r.line; for (const [k, v] of Object.entries(r.hits)) st.redactions[k] = (st.redactions[k] || 0) + v; }
    const ts = p.ts ?? this.now();
    this.store.append(lab, ts, line);
    return { ts, labels: lab, line, format: p.format };
  }
  pushMany(lines, labels) { for (const l of lines) if (l.trim()) this.push(l, labels); return this.stats; }
}
