// Served in place of SSRNode's RNoise import by the benchmark server only.
import { Fn, If, uniform, uniformTexture, textureLoad, ivec2, vec4, int, uint, hash } from 'three/tsl';

const state = window.ssrNoise = { mode: uniform(0, 'int'), channels: [] };
for (let i = 0; i < 4; i++) {
  const node = uniformTexture(window.ssrInitialTextures[i]);
  node.getUniformHash = function () { return this.uuid; };
  state.channels.push(node);
}

export function bindAnalyticNoise(resolution, seed = 0) {
  return Fn(([uvCoord, sampleIndex]) => {
    const p = uvCoord.mul(resolution).floor().toInt();
    const frame = int(sampleIndex);
    const cycle = frame.div(32);
    const x = p.x.add(cycle.mul(37)).mod(128);
    const y = p.y.add(cycle.mul(71)).mod(128).add(frame.mod(32).mul(128));
    const result = vec4().toVar();
    If(state.mode.equal(0), () => {
      const key = uint(p.x).add(uint(p.y).mul(128)).add(uint(frame).mul(16384)).add(uint(seed).mul(2654435761));
      result.assign(vec4(hash(key), hash(key.add(1013904223)), hash(key.add(2027808446)), hash(key.add(3041712669))));
    }).Else(() => {
      result.assign(vec4(...state.channels.map(node => textureLoad(node, ivec2(x, y)).r.mul(255).add(0.5).div(256))));
    });
    return result;
  });
}
