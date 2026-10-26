// Per-chunk trigram bloom filter: lets `|= "timeout"` skip chunks that cannot contain the needle.
// Trigrams are packed into 24-bit integers (3 lower-cased char codes) and double-hashed into the bit set.
export class Bloom {
  constructor(bits = 1 << 15, k = 3) { this.m = bits; this.k = k; this.a = new Uint32Array(Math.ceil(bits / 32)); this.n = 0; }
  _h(x) { let h1 = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0; h1 ^= h1 >>> 15; let h2 = Math.imul(x + 0x9e3779b9, 0x85ebca6b) >>> 0; h2 = (h2 ^ (h2 >>> 13)) | 1; return [h1, h2]; }
  add(x) { const [a, b] = this._h(x); let fresh = false; for (let i = 0; i < this.k; i++) { const j = ((a + Math.imul(i, b)) >>> 0) % this.m, w = j >>> 5, bit = 1 << (j & 31); if (!(this.a[w] & bit)) { this.a[w] |= bit; fresh = true; } } if (fresh) this.n++; }
  has(x) { const [a, b] = this._h(x); for (let i = 0; i < this.k; i++) { const j = ((a + Math.imul(i, b)) >>> 0) % this.m; if (!(this.a[j >>> 5] & (1 << (j & 31)))) return false; } return true; }
  /** Estimated false-positive rate at the current fill. */
  fpr() { return Math.pow(1 - Math.exp((-this.k * this.n) / this.m), this.k); }
}
const low = (c) => (c >= 65 && c <= 90 ? c + 32 : c) & 0xff;
/** Call fn(trigramInt) for every trigram of s (case-insensitive). */
export function eachTrigram(s, fn) { if (s.length < 3) return; let a = low(s.charCodeAt(0)), b = low(s.charCodeAt(1)); for (let i = 2; i < s.length; i++) { const c = low(s.charCodeAt(i)); fn((a << 16) | (b << 8) | c); a = b; b = c; } }
export function trigrams(s) { const t = new Set(); eachTrigram(s, (g) => t.add(g)); return t; }
