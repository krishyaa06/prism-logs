// Deterministic synthetic log traffic from six services in four formats, with injectable incidents.
import { rng as mk } from "./lib/rng.js";
const USERS = ["riya.sharma@gmail.com", "arjun.k@outlook.com", "neha@prismpay.in", "dev.patel@yahoo.com", "sara.m@proton.me", "kabir@zoho.in"];
const PATHS = ["/api/v1/cart", "/api/v1/checkout", "/api/v1/products", "/api/v1/search?q=shoes", "/api/v1/orders/8812", "/healthz", "/api/v1/login"];
const UA = ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0", "okhttp/4.12.0", "curl/8.5.0"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nginxTime = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
const ip = (r) => `${r.pick([49, 103, 117, 152, 157])}.${r.int(1, 254)}.${r.int(1, 254)}.${r.int(1, 254)}`;
const CARDS = ["4111 1111 1111 1111", "5500-0000-0000-0004", "4242424242424242"];
export const SERVICES = { "api-gateway": { fmt: "nginx", w: 5 }, checkout: { fmt: "json", w: 3 }, payments: { fmt: "logfmt", w: 2 }, auth: { fmt: "json", w: 1.5 }, worker: { fmt: "logfmt", w: 1.2 }, kernel: { fmt: "syslog", w: 0.3 } };
/**
 * new Generator({ seed }).next(ts) -> { service, env, line }
 * incidents: g.incident = "db" (postgres timeouts in checkout/payments) | "auth" (credential stuffing) | null
 */
export class Generator {
  constructor({ seed = 7, env = "prod" } = {}) { this.r = mk(seed); this.env = env; this.incident = null; this.n = 0; }
  next(ts = Date.now()) {
    const r = this.r, svc = r.weighted(Object.keys(SERVICES), (k) => SERVICES[k].w * (this.incident === "auth" && k === "auth" ? 6 : 1));
    this.n++; const env = r.chance(0.85) ? this.env : "staging", trace = (this.n * 2654435761 >>> 0).toString(16).padStart(8, "0"), user = r.pick(USERS);
    const db = this.incident === "db", iso = new Date(ts).toISOString();
    let line;
    if (svc === "api-gateway") {
      const path = r.pick(PATHS), slow = db && /cart|checkout|orders/.test(path), st = slow ? r.weighted([200, 502, 504], (x) => (x === 200 ? 3 : 2)) : r.weighted([200, 201, 304, 404, 429, 500], (x) => ({ 200: 80, 201: 6, 304: 6, 404: 4, 429: 2, 500: 0.6 })[x]);
      const rt = slow ? 1 + r() * 4 : Math.max(0.002, r.exp(1 / 0.045));
      line = `${ip(r)} - ${r.chance(0.3) ? user.split("@")[0] : "-"} [${nginxTime(ts)}] "${path.includes("login") ? "POST" : r.pick(["GET", "GET", "GET", "POST"])} ${path} HTTP/1.1" ${st} ${r.int(200, 24000)} "-" "${r.pick(UA)}" ${rt.toFixed(3)}`;
    } else if (svc === "checkout") {
      if (db && r.chance(0.6)) line = JSON.stringify({ ts: iso, level: "error", service: svc, msg: "timeout acquiring connection from pool", db: { host: "pg-primary-1", pool: "orders", wait_ms: r.int(5000, 9000) }, trace_id: trace, user });
      else { const lat = Math.round(db ? 900 + r() * 3000 : 20 + r.exp(1 / 60)), items = r.int(1, 6); line = JSON.stringify({ ts: iso, level: lat > 800 ? "warn" : "info", service: svc, msg: lat > 800 ? "slow checkout" : "order placed", order_id: "ord_" + r.int(10000, 99999), items, amount: +(items * (199 + r() * 2400)).toFixed(2), currency: "INR", latency_ms: lat, user, trace_id: trace, ...(r.chance(0.08) ? { card: r.pick(CARDS) } : {}) }); }
    } else if (svc === "payments") {
      const psp = r.pick(["razorpay", "stripe", "payu"]);
      if (db && r.chance(0.5)) line = `ts=${iso} level=error msg="ledger write failed: could not connect to server: Connection timed out" psp=${psp} retry=${r.int(1, 3)} trace_id=${trace}`;
      else { const ok = r.chance(0.94), lat = Math.round(80 + r.exp(1 / 140)); line = `ts=${iso} level=${ok ? "info" : "warn"} msg="${ok ? "payment captured" : "payment declined"}" psp=${psp} amount=${(99 + r() * 9000).toFixed(2)} currency=INR status=${ok ? 200 : 402} latency_ms=${lat} key=sk_live_${trace}${trace}x trace_id=${trace}`; }
    } else if (svc === "auth") {
      if (this.incident === "auth" && r.chance(0.8)) line = JSON.stringify({ ts: iso, level: "warn", service: svc, msg: "login failed: invalid password", user: r.pick(USERS), ip: `185.220.101.${r.int(2, 60)}`, attempts: r.int(3, 40), trace_id: trace });
      else line = JSON.stringify({ ts: iso, level: r.chance(0.97) ? "info" : "warn", service: svc, msg: r.chance(0.9) ? "token issued" : "mfa challenge", user, ip: ip(r), authorization: "Bearer " + trace.repeat(5), latency_ms: Math.round(8 + r.exp(1 / 20)), trace_id: trace });
    } else if (svc === "worker") {
      const job = r.pick(["send-invoice", "sync-inventory", "rebuild-search", "email-digest"]), dur = Math.round(r.exp(1 / 800));
      line = `ts=${iso} level=${dur > 3000 ? "warn" : "info"} msg="job finished" job=${job} duration_ms=${dur} queue=default attempt=${r.chance(0.95) ? 1 : 2}`;
    } else {
      const d = new Date(ts), p = (n) => String(n).padStart(2, "0"), sev = db ? 3 : r.pick([6, 6, 5, 4]);
      line = `<${24 + sev}>${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} node-${r.int(1, 4)} ${db ? "kernel" : r.pick(["kernel", "systemd", "sshd"])}[${r.int(100, 9000)}]: ${db ? "TCP: out of memory -- consider tuning tcp_mem" : r.pick(["Started Daily apt upgrade.", "Accepted publickey for deploy from 10.0.3.14 port 52211", "eth0: link up 10Gbps"])}`;
    }
    return { service: svc, env, line };
  }
}
