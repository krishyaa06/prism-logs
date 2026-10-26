# Prism Logs — Usage

## Install

```bash
npm install github:krishyaa06/prism-logs
# or run the CLI directly
npx github:krishyaa06/prism-logs --help
```

## JavaScript API

```js
import { LogStore, Ingestor, query, explain } from "prism-logs";

const store = new LogStore({ chunkLines: 512, retentionMs: 7 * 864e5 });
const ingest = new Ingestor(store, { labels: ["service", "env"] });   // redaction on by default

ingest.push('{"level":"error","msg":"timeout acquiring connection","db":{"wait_ms":7200},"user":"riya@gmail.com"}', { service: "checkout", env: "prod" });
ingest.push('ts=2026-10-26T10:00:00Z level=info msg="payment captured" psp=razorpay latency_ms=142', { service: "payments", env: "prod" });

const logs = query(store, '{service="checkout"} |= "timeout" | json | db_wait_ms > 6000', { limit: 50 });
console.log(logs.entries[0].line);           // ..."user":"r***@gmail.com"...
console.log(logs.stats);                     // { chunksScanned, chunksBloom, lines, bytes, ms, ... }

const errs = query(store, 'sum by (service) (rate({level="error"}[1m]))', { start, end, step: 15e3 });
console.log(errs.series);                    // [{ labels: { service }, values: [...] }]
console.log(explain(errs.ast));
```

| Export | What it does |
|---|---|
| `new LogStore({ chunkLines, chunkSpanMs, bloomBits, retentionMs, maxStreams })` | Label-indexed chunk store |
| `store.append(labels, ts, line)` · `select(matchers)` · `labelNames()` · `labelValues(name)` · `compact(now)` | Low-level storage API |
| `new Ingestor(store, { redact, rules, labels, format })` · `.push(line, labels)` · `.pushMany(lines, labels)` · `.stats` | Parse, redact, label, store |
| `query(store, logql, { start, end, step, limit, direction })` | `{ kind: "streams", entries }` or `{ kind: "matrix", series, steps }`, plus `stats` |
| `parse(logql)` · `explain(ast)` · `lex(logql)` | Parser and plan printer |
| `parseLine(line)` · `detect(line)` · `parseJSON` · `parseLogfmt` · `parseNginx` · `parseSyslog` · `normLevel` | Parsers |
| `redact(line, ruleIds?)` · `RULES` | Redaction |
| `Bloom` · `trigrams` · `Generator` | Building blocks and synthetic traffic |

## CLI

```bash
$ npx github:krishyaa06/prism-logs query '{service="checkout"} |= "timeout" | json | db_wait_ms > 6000'
$ npx github:krishyaa06/prism-logs query 'sum by (service) (count_over_time({level=~"error|fatal"}[1m]))'
$ npx github:krishyaa06/prism-logs query '{service="app"} | logfmt | latency_ms > 300' --file app.log --service app
$ cat app.log | npx github:krishyaa06/prism-logs redact -
$ npx github:krishyaa06/prism-logs bench --n 100000
```

| Command | Description |
|---|---|
| `logs query '<logql>' [--file f --service s] [--limit n] [--since 15m]` | Run a log or metric query (synthetic data if no file) |
| `logs explain '<logql>'` | Print the query plan |
| `logs parse '<line>'` | Show detected format, fields, level and timestamp |
| `logs redact <file or ->` | Mask PII and secrets, report counts on stderr |
| `logs gen [--n] [--incident db or auth] [--seed]` | Print synthetic mixed-format logs |
| `logs bench [--n]` | Ingest and query throughput with pruning stats |

## Live simulator

Open [https://krishyaa06.github.io/prism-logs/](https://krishyaa06.github.io/prism-logs/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
