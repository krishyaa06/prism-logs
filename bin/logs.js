#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { LogStore, Ingestor, Generator, query, explain, parseLine, redact } from "../src/index.js";
import { c, table, header, fail, spark } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("logs")} — Prism Logs: ingest, redact, index and query logs with LogQL

  logs query '<logql>' [--file app.log --service app] [--limit 20] [--since 15m]
                       run a log or metric query (no --file: 30k synthetic lines with a DB incident)
  logs explain '<logql>'          show the plan: label index -> time pruning -> bloom -> pipeline
  logs parse '<line>'              detect format, extract fields, normalise level and timestamp
  logs redact <file|->             mask emails, cards (Luhn), tokens, JWTs, passwords, IPs
  logs gen [--n 1000] [--incident db|auth] [--seed 7]   print synthetic mixed-format logs
  logs bench [--n 100000]          ingest + query throughput with bloom pruning stats
`;
const LVL = { error: c.red, fatal: c.red, warn: c.yellow, info: c.cyan, debug: c.dim };
function load() {
  const store = new LogStore(), ing = new Ingestor(store);
  const file = flag("file");
  if (file) { const svc = flag("service", "app"); ing.pushMany(readFileSync(file, "utf8").split("\n"), { service: svc }); return { store, ing, src: file }; }
  const g = new Generator({ seed: +flag("seed", 7) }); let t = Date.UTC(2026, 9, 26, 9, 30); const n = +flag("n", 30000);
  for (let i = 0; i < n; i++) { if (i === Math.floor(n * 0.6)) g.incident = "db"; if (i === Math.floor(n * 0.75)) g.incident = null; t += 60; const e = g.next(t); ing.push(e.line, { service: e.service, env: e.env }); }
  return { store, ing, src: `${n.toLocaleString()} synthetic lines, DB incident at 60–75%` };
}
const fmtLabels = (l) => Object.entries(l).map(([k, v]) => `${k}=${v}`).join(" ");
try {
  if (!cmd || cmd === "-h" || cmd === "--help") console.log(HELP);
  else if (cmd === "query") {
    const q = pos[0] || fail("usage: logs query '<logql>'"); const { store, src } = load();
    const end = Math.max(...[...store.streams.values()].flatMap((s) => s.chunks.map((x) => x.max))), since = flag("since");
    const r = query(store, q, { limit: +flag("limit", 20), end, start: since ? end - (/^\d+$/.test(since) ? +since * 1000 : parseDur(since)) : undefined });
    console.log(header("query", src) + "\n"); console.log(c.dim(explain(r.ast)));
    if (r.kind === "streams") for (const e of r.entries) console.log(`${c.dim(new Date(e.ts).toISOString().slice(11, 23))} ${(LVL[e.labels.level] || ((x) => x))(e.labels.level.padEnd(5))} ${c.magenta(e.labels.service || "")} ${e.line.length > 150 ? e.line.slice(0, 150) + "…" : e.line}`);
    else console.log(table(r.series.slice(0, 15).map((s) => { const v = s.values.map((x) => x ?? 0); const last = [...s.values].reverse().find((x) => x !== undefined); return [fmtLabels(s.labels) || "{}", spark(v.slice(-48)), (+last).toFixed(3), Math.max(...v).toFixed(3)]; }), { head: ["series", "trend", "last", "max"] }));
    const st = r.stats; console.log("\n" + c.dim(`streams ${st.streams} · chunks ${st.chunksScanned}/${st.chunksTotal} scanned (${st.chunksTime} time-pruned, ${c.green(st.chunksBloom + " bloom-pruned")}) · ${st.lines.toLocaleString()} lines · ${(st.bytes / 1024).toFixed(0)} KB · ${st.matched.toLocaleString()} matched · ${st.ms.toFixed(1)}ms`));
  } else if (cmd === "explain") { const { parse } = await import("../src/query.js"); console.log(explain(parse(pos[0] || fail("usage: logs explain '<logql>'")))); }
  else if (cmd === "parse") { const line = pos[0] || fail("usage: logs parse '<line>'"); const p = parseLine(line); console.log(header("parse", `format: ${p.format} · level: ${p.level} · ts: ${p.ts ? new Date(p.ts).toISOString() : "—"}`) + "\n"); console.log(table(Object.entries(p.fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]), { head: ["field", "value"] })); }
  else if (cmd === "redact") { const f = pos[0] || "-"; const text = readFileSync(f === "-" ? 0 : f, "utf8"); const tot = {}; for (const l of text.split("\n")) { if (!l) continue; const r = redact(l); for (const [k, v] of Object.entries(r.hits)) tot[k] = (tot[k] || 0) + v; console.log(r.line); } console.error(c.dim("redacted: " + (Object.entries(tot).map(([k, v]) => `${k}×${v}`).join(" ") || "nothing"))); }
  else if (cmd === "gen") { const g = new Generator({ seed: +flag("seed", 7) }); g.incident = flag("incident", null); let t = Date.now() - 3600e3; for (let i = 0; i < +flag("n", 1000); i++) { t += 250; console.log(g.next(t).line); } }
  else if (cmd === "bench") {
    const n = +flag("n", 100000), t0 = performance.now(); rest.push("--n", String(n)); const { store, ing } = load(); const ms = performance.now() - t0;
    console.log(header("bench", `${n.toLocaleString()} lines · 6 services · 4 formats`) + "\n");
    const rows = [["ingest", `${(n / ms * 1000).toFixed(0)} lines/s`, `${(store.stats.bytes / 1048576).toFixed(1)} MB raw · ${store.streams.size} streams · ${store.stats.chunks} chunks`], ["redactions", Object.values(ing.stats.redactions).reduce((a, b) => a + b, 0).toLocaleString(), Object.entries(ing.stats.redactions).map(([k, v]) => `${k} ${v}`).join(" · ")]];
    for (const q of [`{env="prod"} |= "timeout acquiring"`, `{service="checkout"} | json | latency_ms > 2000`, `sum by (service) (rate({level="error"}[1m]))`, `quantile_over_time(0.99, {service="checkout"} | json | unwrap latency_ms [5m]) by (service)`]) { const r = query(store, q, { limit: 1e9 }), s = r.stats; rows.push([q.length > 52 ? q.slice(0, 52) + "…" : q, s.ms.toFixed(1) + "ms", `${s.chunksScanned}/${s.chunksTotal} chunks · ${c.green(s.chunksBloom + " bloom-skipped")} · ${s.matched.toLocaleString()} hits`]); }
    console.log(table(rows, { head: ["operation", "result", "detail"] }));
  } else fail(`unknown command ${cmd}\n\n${HELP}`);
} catch (e) { fail(e.message); }
function parseDur(s) { return { s: 1e3, m: 6e4, h: 36e5 }[s.slice(-1)] * parseFloat(s); }
