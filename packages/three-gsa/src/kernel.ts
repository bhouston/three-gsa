// CPU kernel construction follows the EA FAST port. See THIRD_PARTY_NOTICES.md.
export function createKernel(depth: number): { fs: number; weights: Float32Array; taps: Float32Array } {
  const sigma = 1, alpha = 0.1, beta = 0.1, sepWeight = 0.5;
  const erf = (value: number): number => {
    const s = Math.sign(value), x = Math.abs(value), t = 1 / (1 + 0.3275911 * x);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  };
  const f: number[] = [];
  let total = 0;
  const scale = Math.sqrt(0.5) / sigma;
  for (let i = 0; total < 0.995; i++) {
    const v = 0.5 * (erf(scale * (i + 0.5)) - erf(scale * (i - 0.5)));
    f.push(v); total += (i > 0 ? 2 : 1) * v;
  }
  const fs = 2 * (f.length - 1);
  const spatial = (i: number): number => {
    let v = 0;
    for (let j = Math.max(0, i) - f.length + 1; j < f.length + Math.min(0, i); j++) v += f[Math.abs(j)] * f[Math.abs(i - j)];
    return v;
  };
  const temporal = new Float64Array(depth);
  for (let m = 1; m <= depth; m++) {
    const weight = beta * Math.pow(1 - beta, m - 1) / (1 - Math.pow(1 - beta, depth));
    for (let j = -m + 1; j < m; j++) {
      let fj = 0;
      for (let i = Math.max(0, -j); i < Math.min(m, m - j); i++) {
        let fi = Math.pow(1 - alpha, i); if (i < m - 1) fi *= alpha;
        let fij = Math.pow(1 - alpha, i + j); if (i + j < m - 1) fij *= alpha;
        fj += fi * fij;
      }
      temporal[((j % depth) + depth) % depth] += fj * weight;
    }
  }
  const weights = new Float32Array((2 * fs + 1) ** 2 * depth), taps: number[] = [];
  for (let i = -fs; i <= fs; i++) for (let j = -fs; j <= fs; j++) for (let k = 0; k < depth; k++) {
    const fx = spatial(i), fy = spatial(j), fz = temporal[k];
    const separate = (k === 0 ? fx * fy * sepWeight : 0) + (i === 0 && j === 0 ? fz * (1 - sepWeight) : 0);
    const mixed = Math.abs(i) <= 2 && Math.abs(j) <= 2 && Math.min(k, depth - k) <= 2 ? fx * fy * fz : 0;
    const w = (1 - 0.2) * separate + 0.2 * mixed;
    weights[((i + fs) * (2 * fs + 1) + (j + fs)) * depth + k] = w;
    if (w !== 0) taps.push(i, j, k, w);
  }
  return { fs, weights, taps: new Float32Array(taps) };
}
