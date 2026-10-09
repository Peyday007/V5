/**
 * Seeded randomness, and nothing that reads a clock.
 *
 * A run is reproducible only if every number it draws is a function of the
 * recorded seed. `Math.random` is never called here: the generator is
 * xoshiro128** seeded through splitmix32, both pure integer arithmetic, so the
 * same seed yields the same stream on every machine and after every restart.
 *
 * The two transcendental helpers — Φ and Φ⁻¹ — are rational approximations
 * with no library call beyond `Math.log`, `Math.sqrt` and `Math.exp`. Their
 * accuracy (about 1e-9 for Φ⁻¹, 1e-7 for Φ) is far below a cent at any scale
 * this engine reports, and money outputs are rounded to whole cents anyway.
 */

/** splitmix32: spreads a 32-bit seed into well-mixed state words. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** A seeded stream of uniforms in (0, 1). Never 0 and never 1, so Φ⁻¹ is finite. */
export function makeRng(seed: number, stream = 0): () => number {
  const mix = splitmix32((seed ^ Math.imul(stream + 1, 0x27d4eb2d)) >>> 0);
  let a = mix(), b = mix(), c = mix(), d = mix();
  if ((a | b | c | d) === 0) a = 1;
  return () => {
    const result = Math.imul(rotl(Math.imul(b, 5) >>> 0, 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = rotl(d, 11);
    return (result + 0.5) / 4294967296;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** A deterministic Fisher–Yates permutation of 0..n-1. */
export function permutation(n: number, rng: () => number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!; out[i] = out[j]!; out[j] = tmp;
  }
  return out;
}

/** Φ⁻¹, Acklam's rational approximation. */
export function inverseNormal(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Φ, via the complementary error function (Numerical Recipes erfc, ~1.2e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const half = 0.5 * y;
  const p = z >= 0 ? 1 - half : half;
  return Math.min(Math.max(p, 1e-12), 1 - 1e-12);
}

/**
 * The lower-triangular Cholesky factor of a correlation matrix, or null when
 * the matrix is not positive definite — a set of declared correlations that
 * cannot all hold at once, which is a refusal rather than something to repair.
 */
export function cholesky(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (sum <= 1e-12) return null;
        l[i]![i] = Math.sqrt(sum);
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }
  return l;
}
