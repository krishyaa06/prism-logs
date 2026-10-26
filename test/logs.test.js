import { test } from "node:test";
import assert from "node:assert/strict";
import { LogStore, Ingestor, Generator, query, parse, parseLine, redact, detect, Bloom, eachTrigram } from "../src/index.js";

const T0 = Date.UTC(2026, 9, 26, 10);
function fixture(n = 6000) {
  const s = new LogStore({ chunkLines: 200 }), ing = new Ingestor(s), g = new Generator({ seed: 5 }); let t = T0;
  for (let i = 0; i < n; i++) { if (i === n / 2) g.incident = "db"; if (i === (n * 3) / 4) g.incident = null; t += 100; const e = g.next(t); ing.push(e.line, { service: e.service, env: e.env }); }
  return { s, ing, end: t };
}
const F = fixture();

test("detects and parses json, logfmt, nginx and syslog", () => {
  assert.equal(detect('{"a":1}'), "json"); assert.equal(detect("ts=1 level=info msg=\"hi there\" k=v"), "logfmt");
  const n = parseLine('49.1.2.3 - bob [26/Oct/2026:10:00:01 +0530] "GET /x?y=1 HTTP/1.1" 503 512 "-" "curl/8" 0.250');
  assert.equal(n.format, "nginx"); assert.equal(n.fields.status, 503); assert.equal(n.level, "error"); assert.equal(n.ts, Date.UTC(2026, 9, 26, 4, 30, 1)); assert.equal(n.fields.request_time, 0.25);
  const sy = parseLine("<11>Oct 26 10:00:00 node-1 sshd[42]: Failed password"); assert.equal(sy.format, "syslog"); assert.equal(sy.level, "error"); assert.equal(sy.fields.app, "sshd");
  const j = parseLine('{"severity":"WARNING","@timestamp":"2026-10-26T10:00:00Z","http":{"status":200}}'); assert.equal(j.level, "warn"); assert.equal(j.fields.http_status, 200); assert.equal(j.ts, Date.UTC(2026, 9, 26, 10));
  assert.equal(parseLine('{"level":50,"time":1761472800}').level, "error"); // pino numbers + epoch seconds
});
test("redacts PII and secrets but leaves non-Luhn numbers alone", () => {
  const { line, hits } = redact('user=riya.sharma@gmail.com card="4111 1111 1111 1111" order=1234567890123 ip=10.20.30.40 auth="Bearer abcdefghijklmnop123" password=hunter2 key=sk_live_abcdefghijkl');
  assert.match(line, /r\*\*\*@gmail\.com/); assert.match(line, /\*\*\*\*-1111/); assert.match(line, /order=1234567890123/); assert.match(line, /10\.20\.30\.x/);
  assert.match(line, /Bearer \[REDACTED\]/); assert.match(line, /password=\[REDACTED\]/); assert.match(line, /sk_live_\[REDACTED\]/);
  assert.ok(!line.includes("hunter2") && !line.includes("riya.sharma")); assert.equal(hits.card, 1);
});
test("bloom filter has no false negatives", () => {
  const b = new Bloom(1 << 12, 3), words = Array.from({ length: 400 }, (_, i) => "word" + i * 7919);
  for (const w of words) eachTrigram(w, (g) => b.add(g));
  for (const w of words) eachTrigram(w, (g) => assert.ok(b.has(g)));
  assert.ok(b.fpr() < 0.2);
});
test("label index selects streams; equality, regex and negative matchers", () => {
  const a = F.s.select([{ name: "service", op: "=", value: "checkout" }]); assert.ok(a.length > 0 && a.every((x) => x.labels.service === "checkout"));
  const b = F.s.select([{ name: "level", op: "=~", value: "error|fatal" }, { name: "service", op: "!=", value: "kernel" }]); assert.ok(b.every((x) => ["error", "fatal"].includes(x.labels.level) && x.labels.service !== "kernel"));
  assert.ok(F.s.labelNames().includes("level")); assert.deepEqual(F.s.labelValues("env"), ["prod", "staging"]);
});
test("line filter + json + numeric label filter, with bloom pruning", () => {
  const r = query(F.s, '{service="checkout"} |= "timeout" | json | db_wait_ms > 6000', { limit: 1e9 });
  assert.ok(r.entries.length > 10); assert.ok(r.entries.every((e) => e.line.includes("timeout") && e.fields.db_wait_ms > 6000));
  assert.ok(r.stats.chunksBloom > 0, "chunks without the needle are skipped"); assert.ok(r.entries[0].ts >= r.entries.at(-1).ts, "backward order");
  // the result equals a brute-force scan
  let brute = 0; for (const st of F.s.select([{ name: "service", op: "=", value: "checkout" }])) for (const c of st.chunks) for (const l of c.lines) if (l.includes("timeout") && JSON.parse(l).db?.wait_ms > 6000) brute++;
  assert.equal(r.entries.length, brute);
});
test("pattern parser extracts nginx fields; line_format rewrites", () => {
  const r = query(F.s, '{service="api-gateway"} | pattern `<ip> - <_> [<_>] "<method> <path> <_>" <status> <bytes>` | status >= 500 | line_format "{{.method}} {{.path}} -> {{.status}}"', { limit: 5 });
  assert.ok(r.entries.length > 0); for (const e of r.entries) assert.match(e.line, /^(GET|POST) \/\S* -> 5\d\d$/);
});
test("metric queries: count_over_time, sum by, rate ratio, quantile, topk", () => {
  const r = query(F.s, 'sum by (service) (count_over_time({level="error"}[1m]))', { end: F.end, start: F.end - 600e3, step: 60e3 });
  const svc = r.series.map((x) => x.labels.service); assert.ok(svc.includes("checkout") && svc.includes("payments"));
  const ratio = query(F.s, 'sum(rate({level="error"}[1m])) / sum(rate({env=~".+"}[1m]))', { end: F.end, start: F.end - 600e3, step: 30e3 }).series[0].values.filter((v) => v !== undefined);
  assert.ok(Math.max(...ratio) > 0.1 && Math.min(...ratio) < 0.05, "incident visible in error ratio");
  const q = query(F.s, 'quantile_over_time(0.99, {service="checkout"} | json | unwrap latency_ms [5m]) by (service)', { end: F.end, start: F.end - 300e3, step: 300e3 });
  assert.equal(q.series.length, 1); assert.ok(q.series[0].values.at(-1) > 100);
  const top = query(F.s, 'topk(2, sum by (path) (count_over_time({service="api-gateway"} | pattern `<_> - <_> [<_>] "<_> <path> <_>"` [10m])))', { end: F.end, start: F.end, step: 1 });
  assert.equal(top.series.length, 2);
});
test("parser errors are helpful", () => {
  assert.throws(() => parse('{service="x"'), /expected/); assert.throws(() => parse('sum({a="b"})'), /metric expression/);
  assert.throws(() => parse('avg_over_time({a="b"}[1m])'), /unwrap/); assert.throws(() => parse("{}"), /at least one matcher/);
});
test("retention compaction drops old chunks and empties index", () => {
  const s = new LogStore({ chunkLines: 10, retentionMs: 60e3 }); for (let i = 0; i < 100; i++) s.append({ service: i < 50 ? "old" : "new" }, T0 + i * 2000, "line " + i);
  const dropped = s.compact(T0 + 200e3); assert.ok(dropped > 0); assert.equal(s.select([{ name: "service", op: "=", value: "old" }]).length, 0); assert.ok(s.stats.lines < 100);
});
test("cardinality guard rejects new streams beyond the limit", () => {
  const s = new LogStore({ maxStreams: 3 }); for (let i = 0; i < 10; i++) s.append({ id: String(i) }, T0, "x");
  assert.equal(s.streams.size, 3); assert.equal(s.stats.rejected, 7);
});
