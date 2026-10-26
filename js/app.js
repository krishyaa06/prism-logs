import { LogStore, Ingestor, Generator, query, SERVICES } from "../src/index.js";
import { $, h, esc, fmt, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, css, hexA } from "./pro.js";

const T0 = Date.UTC(2026, 9, 26, 9, 0);
const store = new LogStore({ chunkLines: 150, chunkSpanMs: 60e3, retentionMs: 15 * 60e3 });
const ing = new Ingestor(store), gen = new Generator({ seed: 11 });
let now = T0, rate = 90, incidentLeft = 0, lastCompact = 0;
const SVC = Object.keys(SERVICES), FMT = Object.fromEntries(SVC.map((s) => [s, SERVICES[s].fmt]));
const LV = { error: "#ff5c8a", fatal: "#ff2e63", warn: "#ffb547", info: "#4fb3ff", debug: "#5f6884" };
const SC = { "api-gateway": "#00d2ff", checkout: "#7c5cff", payments: "#22e3a1", auth: "#ffb547", worker: "#ff7ad9", kernel: "#8d94ad" };
const counts = { info: 0, warn: 0, error: 0 }, parts = [];
let tailPick = null, totalIn = 0;

function ingest(n, dt, animate) {
  for (let i = 0; i < n; i++) {
    const ts = now - dt * 1000 * (1 - i / n), e = gen.next(Math.round(ts)), r = ing.push(e.line, { service: e.service, env: e.env });
    totalIn++; const lv = r.labels.level; counts[lv === "fatal" ? "error" : lv === "debug" ? "info" : lv]++;
    if (animate && Math.random() < 0.35 && parts.length < 220) parts.push({ svc: e.service, key: keyOf(r.labels), k: 0, col: LV[lv] });
    if (!tailPick || Math.random() < 0.08 || (lv !== "info" && Math.random() < 0.3)) tailPick = r;
  }
}
const keyOf = (l) => "{" + Object.keys(l).sort().map((k) => `${k}="${l[k]}"`).join(",") + "}";
// prewarm: 4 virtual minutes with a short DB blip so queries have something to find
for (let t = 0; t < 240; t += 0.5) { if (t === 120) gen.incident = "db"; if (t === 150) gen.incident = null; now += 500; ingest(Math.round(rate * 0.5), 0.5, false); }
counts.info = counts.warn = counts.error = 0;

// ---------- KPIs + charts ----------
const kp = new Kpis($("#kpis"), [
  { key: "lps", label: "Lines / s", tone: "acc" }, { key: "lines", label: "Stored lines" }, { key: "streams", label: "Streams" },
  { key: "chunks", label: "Chunks" }, { key: "masked", label: "PII masked" }, { key: "err", label: "Error rate", fmt: (v) => (v * 100).toFixed(1) + "%" },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "info", color: "#4fb3ff" }, { label: "warn", color: "#ffb547" }, { label: "error", color: "#ff5c8a" }], min: 0, points: 120, area: false, fmtY: (v) => v.toFixed(0) });
const tail = new LogView($("#tail"), 120);
const MASK = /\[REDACTED[^\]]*\]|\b\w\*\*\*@[\w.-]+|\*\*\*\*-\d{4}|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.x\b|XXXX XXXX \d{4}/g;
const hl = (line) => esc(line.length > 240 ? line.slice(0, 240) + "…" : line).replace(MASK, (m) => `<span class="mask">${m}</span>`);
const ago = (ts) => new Date(ts).toISOString().slice(11, 19);

// ---------- pipeline + chunk map canvas ----------
const hi = new Map(); // chunk id -> {state, t}
function rows() {
  const order = (s) => SVC.indexOf(s.labels.service) * 100 + ["fatal", "error", "warn", "info", "debug"].indexOf(s.labels.level) * 10 + (s.labels.env === "prod" ? 0 : 1);
  return [...store.streams.values()].sort((a, b) => order(a) - order(b));
}
function drawPipe() {
  const { ctx, w, h: H } = fit($("#pipe")); ctx.clearRect(0, 0, w, H);
  const narrow = w < 640, top = narrow ? 44 : 36, bot = 14, mono = "JetBrains Mono, monospace";
  const R = rows(), nR = Math.max(1, R.length);
  // geometry
  const src = SVC.map((s, i) => narrow ? { s, x: 12 + (i % 3) * ((w - 24) / 3), y: top + Math.floor(i / 3) * 30, w: (w - 24) / 3 - 8, h: 24 } : { s, x: 14, y: top + 8 + i * ((H - top - bot - 16) / 6), w: 122, h: 34 });
  const stages = ["parse", "normalise", "redact", "label"];
  const st = narrow ? stages.map((n, i) => ({ n, x: 12 + i * ((w - 24) / 4), y: top + 70, w: (w - 24) / 4 - 8, h: 22 })) : stages.map((n, i) => ({ n, x: 168 + i * 62, y: top + 8, w: 52, h: H - top - bot - 16 }));
  const mx = narrow ? 12 : 168 + 4 * 62 + 18, my = narrow ? top + 112 : top + 8, mw = w - mx - 12, mh = H - my - bot - 8;
  const rh0 = mh / nR; ctx.font = `${Math.min(10, rh0 - 1)}px ${mono}`; const labW = Math.max(60, ...R.map((s) => ctx.measureText(`${s.labels.service} ${s.labels.level}${s.labels.env !== "prod" ? " · stg" : ""}`).width)) + 12, rh = rh0, cw = 7, gap = 2, maxC = Math.max(1, Math.floor((mw - labW - 8) / (cw + gap)));
  // sources
  ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const b of src) {
    ctx.fillStyle = hexA(SC[b.s], 0.1); ctx.strokeStyle = hexA(SC[b.s], 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e8ecfa"; ctx.font = `600 ${narrow ? 10 : 11}px ${mono}`; ctx.fillText(b.s, b.x + 8, b.y + (narrow ? b.h / 2 : 12));
    if (!narrow) { ctx.fillStyle = "#5f6884"; ctx.font = `10px ${mono}`; ctx.fillText(FMT[b.s], b.x + 8, b.y + 25); }
  }
  // stages
  for (const s of st) {
    ctx.fillStyle = hexA(css("--accent"), 0.07); ctx.strokeStyle = hexA(css("--accent"), 0.35); ctx.beginPath(); ctx.roundRect(s.x, s.y, s.w, s.h, 8); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.fillStyle = s.n === "redact" && !ing.doRedact ? "#ff5c8a" : "#c9d1f0"; ctx.font = `600 10px ${mono}`; ctx.textAlign = "center";
    if (narrow) ctx.fillText(s.n === "redact" && !ing.doRedact ? "redact OFF" : s.n, s.x + s.w / 2, s.y + s.h / 2); else { ctx.translate(s.x + s.w / 2, s.y + s.h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(s.n === "redact" && !ing.doRedact ? "redact · OFF" : s.n, 0, 0); }
    ctx.restore();
  }
  // chunk map
  const rowY = new Map(); const tnow = performance.now();
  R.forEach((s, i) => {
    const y = my + i * rh; rowY.set(s.key, y + rh / 2);
    if (i % 2 === 0) { ctx.fillStyle = "#ffffff05"; ctx.fillRect(mx, y, mw, rh); }
    const L = s.labels, lcol = LV[L.level] || "#8d94ad";
    if (rh >= 8) { ctx.font = `${Math.min(10, rh - 1)}px ${mono}`; ctx.fillStyle = SC[L.service] || "#8d94ad"; ctx.textAlign = "left"; const tx = `${L.service}`; ctx.fillText(tx, mx + 4, y + rh / 2); const tw = ctx.measureText(tx).width; ctx.fillStyle = lcol; ctx.fillText(" " + L.level + (L.env !== "prod" ? " · stg" : ""), mx + 4 + tw, y + rh / 2); }
    const cs = s.chunks.slice(-maxC);
    cs.forEach((c, j) => {
      const x = mx + labW + j * (cw + gap), fill = Math.min(1, c.size / store.chunkLines), st8 = hi.get(c.id), age = st8 ? (tnow - st8.t) / 2600 : 1, ch = Math.max(2, rh - 3);
      ctx.fillStyle = hexA(lcol, 0.18 + 0.5 * fill * (c.sealed ? 1 : 0.6 + 0.4 * Math.sin(tnow / 160))); ctx.fillRect(x, y + 1.5, cw, ch);
      if (st8 && age < 1) {
        if (st8.state === "scan") { ctx.fillStyle = hexA(css("--accent"), 0.95 * (1 - age) + 0.05); ctx.shadowColor = css("--accent"); ctx.shadowBlur = 10 * (1 - age); ctx.fillRect(x, y + 1.5, cw, ch); ctx.shadowBlur = 0; }
        else { ctx.strokeStyle = hexA("#ff5c8a", 0.9 * (1 - age) + 0.1); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 2, cw - 1, ch - 1); ctx.beginPath(); ctx.moveTo(x + 1, y + 2.5); ctx.lineTo(x + cw - 1, y + ch); ctx.stroke(); }
      }
    });
  });
  // particles: source -> stages -> stream row
  const sx = (svc) => src.find((b) => b.s === svc);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.k += 0.025; const ry = rowY.get(p.key); if (p.k >= 1 || ry === undefined) { parts.splice(i, 1); continue; }
    const b = sx(p.svc), A = narrow ? [b.x + b.w / 2, b.y + b.h] : [b.x + b.w, b.y + b.h / 2], B = narrow ? [w / 2, top + 81] : [st[0].x, H / 2], C = narrow ? [w / 2, top + 81] : [st[3].x + st[3].w, H / 2], D = [mx + labW - 4, ry];
    let x, y; if (p.k < 0.3) { const t = p.k / 0.3; x = A[0] + (B[0] - A[0]) * t; y = A[1] + (B[1] - A[1]) * t; } else if (p.k < 0.6) { const t = (p.k - 0.3) / 0.3; x = B[0] + (C[0] - B[0]) * t; y = B[1] + (C[1] - B[1]) * t; } else { const t = (p.k - 0.6) / 0.4; x = C[0] + (D[0] - C[0]) * t; y = C[1] + (D[1] - C[1]) * t; }
    ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
  }
  // legend
  ctx.font = `10px ${mono}`; ctx.textAlign = "left"; let lx = mx + labW; const ly = H - 8;
  for (const [n, c] of [["scanned", css("--accent")], ["bloom-skipped", "#ff5c8a"], ["open chunk", "#4fb3ff"]]) { if (lx + ctx.measureText(n).width + 14 > w - 8) break; ctx.fillStyle = c; ctx.fillRect(lx, ly - 4, 8, 8); ctx.fillStyle = "#8d94ad"; ctx.fillText(n, lx + 12, ly); lx += ctx.measureText(n).width + 26; if (lx > w - 40) break; }
}

// ---------- queries ----------
const PRESETS = [
  ["Find DB timeouts (bloom-pruned)", '{service="checkout"} |= "timeout" | json | db_wait_ms > 6000'],
  ["Errors per service", 'sum by (service) (count_over_time({level=~"error|fatal"}[30s]))'],
  ["Error ratio", 'sum(rate({level="error"}[1m])) / sum(rate({env="prod"}[1m]))'],
  ["p99 checkout latency", 'quantile_over_time(0.99, {service="checkout"} | json | unwrap latency_ms [1m]) by (service)'],
  ["5xx at the gateway (pattern)", '{service="api-gateway"} | pattern `<ip> - <_> [<_>] "<method> <path> <_>" <status> <_>` | status >= 500 | line_format "{{.method}} {{.path}} → {{.status}}"'],
  ["Brute-force sources", 'topk(3, sum by (ip) (count_over_time({service="auth"} |= "login failed" | json [1m])))'],
  ["Declined payments", '{service="payments"} | logfmt | status = 402 | line_format "{{.psp}} declined ₹{{.amount}}"'],
];
$("#preset").innerHTML = PRESETS.map(([n], i) => `<option value="${i}">${esc(n)}</option>`).join("");
$("#q").value = PRESETS[0][1];
$("#preset").onchange = (e) => { $("#q").value = PRESETS[+e.target.value][1]; run(true); };
const PAL = ["#7c5cff", "#00d2ff", "#22e3a1", "#ffb547", "#ff5c8a", "#ff7ad9", "#c9d1f0"];
let last = null;
function run(manual = false) {
  let r; try { r = query(store, $("#q").value, { end: now, start: now - 10 * 60e3, step: 5000, limit: 60 }); } catch (e) { $("#qout").innerHTML = `<div class="bad">${esc(e.message)}</div>`; $("#qstat").textContent = "parse error"; return; }
  last = r; const s = r.stats, t = performance.now();
  for (const id of s.scannedIds) hi.set(id, { state: "scan", t }); for (const id of s.prunedIds) hi.set(id, { state: "bloom", t });
  $("#qstat").innerHTML = `${s.streams} streams · <b style="color:var(--text)">${s.chunksScanned}</b>/${s.chunksTotal} chunks scanned · <span style="color:#ff5c8a">${s.chunksBloom} bloom-skipped</span> · ${s.chunksTime} time-pruned<br>${fmt.num(s.lines)} lines · ${fmt.bytes(s.bytes)} · ${fmt.num(s.matched)} matched · ${s.ms.toFixed(1)}ms`;
  $("#qkind").textContent = r.kind === "streams" ? "log query" : "metric · " + r.series.length + " series";
  if (r.kind === "streams") $("#qout").innerHTML = r.entries.length ? r.entries.slice(0, 40).map((e) => `<div class="ln"><span class="t">${ago(e.ts)}</span> <span class="lv ${e.labels.level}">${e.labels.level}</span> <span class="svc">${e.labels.service}</span> ${hl(e.line)}</div>`).join("") : `<div class="dim">no lines matched in the last 10 minutes</div>`;
  else $("#qout").innerHTML = r.series.length ? r.series.map((x, i) => { const lastV = [...x.values].reverse().find((v) => v !== undefined); return `<div class="ser"><i style="background:${PAL[i % PAL.length]}"></i><span>${esc(Object.entries(x.labels).map(([k, v]) => `${k}="${v}"`).join(", ") || "{}")}</span><span class="sp"></span><b>${fmt.num(lastV, lastV < 10 ? 3 : 1)}</b></div>`; }).join("") : `<div class="dim">empty result</div>`;
  drawResult(); if (manual) $("#qout").scrollTop = 0;
}
function drawResult() {
  const { ctx, w, h: H } = fit($("#qch")); ctx.clearRect(0, 0, w, H); if (!last) return;
  const pad = { l: 44, r: 8, t: 12, b: 18 }, iw = w - pad.l - pad.r, ih = H - pad.t - pad.b; ctx.font = "10px JetBrains Mono, monospace";
  let series, steps;
  if (last.kind === "matrix") { series = last.series.slice(0, 7).map((s) => s.values); steps = last.steps; }
  else { const B = 40, start = now - 10 * 60e3, bw = (10 * 60e3) / B, b = new Array(B).fill(0); for (const e of last.entries) { const i = Math.floor((e.ts - start) / bw); if (i >= 0 && i < B) b[i]++; } series = [b]; steps = b.map((_, i) => start + i * bw); }
  const all = series.flat().filter((v) => v !== undefined && isFinite(v)), top = Math.max(1e-9, ...all) * 1.15;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) { const y = pad.t + (ih * i) / 3; ctx.strokeStyle = "#ffffff0d"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.fillStyle = "#5f6884"; const v = top - (top * i) / 3; ctx.fillText(v === 0 ? "0" : v < 1 ? v.toFixed(3) : fmt.compact(v), pad.l - 6, y); }
  ctx.textAlign = "left"; ctx.fillStyle = "#5f6884"; ctx.fillText(ago(steps[0]), pad.l, H - 6); ctx.textAlign = "right"; ctx.fillText(ago(steps.at(-1)), w - pad.r, H - 6);
  const X = (i) => pad.l + (iw * i) / Math.max(1, steps.length - 1), Y = (v) => pad.t + ih - (v / top) * ih;
  if (last.kind === "streams") { const bw = iw / series[0].length; series[0].forEach((v, i) => { ctx.fillStyle = hexA(css("--accent"), 0.75); ctx.fillRect(pad.l + i * bw + 1, Y(v), bw - 2, pad.t + ih - Y(v)); }); return; }
  series.forEach((vals, si) => { ctx.strokeStyle = PAL[si % PAL.length]; ctx.lineWidth = 1.8; ctx.beginPath(); let on = false; vals.forEach((v, i) => { if (v === undefined) { on = false; return; } on ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); on = true; }); ctx.stroke(); });
}
$("#run").onclick = () => run(true);
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(true); } });

// ---------- controls ----------
function incident(kind, label) { gen.incident = kind; incidentLeft = 25; toast(label); }
$("#inc-db").onclick = () => incident("db", "postgres primary unreachable: checkout + payments start timing out");
$("#inc-auth").onclick = () => incident("auth", "credential stuffing from 185.220.101.0/24 against /login");
$("#red").onclick = (e) => { ing.doRedact = !ing.doRedact; e.target.classList.toggle("on", ing.doRedact); toast(ing.doRedact ? "Redaction on: PII is masked before it is stored" : "Redaction off: emails, cards and tokens now land in storage in plain text"); };
$("#rate").oninput = (e) => { rate = +e.target.value; $("#ro").textContent = rate + "/s"; };

let acc = 0, qacc = 0, lastN = totalIn;
const loop = new Loop((dt) => {
  now += dt * 1000; const lam = rate * dt; ingest(Math.floor(lam) + (Math.random() < lam % 1 ? 1 : 0), dt, true);
  if (incidentLeft > 0) { incidentLeft -= dt; if (incidentLeft <= 0) { gen.incident = null; toast("incident resolved"); } }
  if (now - lastCompact > 10e3) { store.compact(now); lastCompact = now; }
  acc += dt; qacc += dt;
  if (acc >= 0.5) {
    const tot = counts.info + counts.warn + counts.error;
    ch1.push(counts.info / acc, counts.warn / acc, counts.error / acc);
    const masked = Object.values(ing.stats.redactions).reduce((a, b) => a + b, 0);
    kp.set({ lps: (totalIn - lastN) / acc, lines: store.stats.lines, streams: store.streams.size, chunks: store.stats.chunks, masked, err: tot ? counts.error / tot : 0 });
    $("#redn").textContent = fmt.compact(masked) + " masked";
    if (tailPick) tail.html(`<span class="lv ${tailPick.labels.level}">${tailPick.labels.level}</span> <span class="svc">${tailPick.labels.service}</span> <span class="ln">${hl(tailPick.line)}</span>`, ago(tailPick.ts)); tailPick = null;
    counts.info = counts.warn = counts.error = 0; lastN = totalIn; acc = 0;
  }
  if (qacc >= 2) { qacc = 0; run(false); }
  drawPipe();
});
bindLoop(loop, $("#sim"));
run(true); drawPipe(); kp.set({ lps: rate, lines: store.stats.lines, streams: store.streams.size, chunks: store.stats.chunks, masked: Object.values(ing.stats.redactions).reduce((a, b) => a + b, 0), err: 0.02 });
loop.start();
setTimeout(() => $("#inc-db").click(), 1200);
setTimeout(() => run(true), 4200);
addEventListener("resize", () => { drawPipe(); drawResult(); });
