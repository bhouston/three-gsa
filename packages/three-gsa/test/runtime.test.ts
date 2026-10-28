import { describe, expect, it } from 'vitest';
import { atlasIndex, quantizeGSA, sampleGSA, validateDimensions } from '../src/index.js';
import { generateGSA } from '../src/generator.js';
import { createGSADataTexture } from '../src/three.js';
import { RedFormat, UnsignedByteType, NearestFilter, NoColorSpace } from 'three';

describe('scalar mask playback', () => {
  it('decodes the midpoints of byte strata, including both endpoints', () => {
    const values = new Float32Array(8 * 8 * 2).fill(0.5);
    values[0] = 0; values[1] = 1 - 2 ** -24; values[2] = 1 / 256;
    const bytes = quantizeGSA({ size: 8, depth: 2, values });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0, 255, 1]);
    expect(sampleGSA(bytes, 8, 2, 0, 0, 0)).toBe(0.5 / 256);
    expect(sampleGSA(bytes, 8, 2, 1, 0, 0)).toBe(255.5 / 256);
  });
  it('starts at slice zero, advances time first and shifts each completed stack', () => {
    expect(atlasIndex(128, 32, 0, 0, 0)).toBe(0);
    expect(atlasIndex(128, 32, 0, 0, 31)).toBe(31 * 128 * 128);
    expect(atlasIndex(128, 32, 0, 0, 32)).toBe(71 * 128 + 37);
    expect(atlasIndex(128, 32, 127, 127, 32)).toBe(70 * 128 + 36);
    expect(atlasIndex(128, 32, -1, -1, 0)).toBe(128 * 128 - 1);
    const edge = Number.MAX_SAFE_INTEGER;
    const reduced = Number(BigInt(edge) % 4096n);
    expect(atlasIndex(128, 32, edge, -edge, edge)).toBe(atlasIndex(128, 32, edge % 128, -edge % 128, reduced));
  });
  it('rejects malformed volumes and values instead of wrapping them into bytes', () => {
    expect(() => validateDimensions(12, 32)).toThrow(RangeError);
    expect(() => validateDimensions(128, 3)).toThrow(RangeError);
    expect(() => quantizeGSA({ size: 8, depth: 2, values: new Float32Array(1) })).toThrow(RangeError);
    for (const value of [-0.1, 1, NaN, Infinity]) {
      expect(() => quantizeGSA({ size: 8, depth: 2, values: new Float32Array(128).fill(value) })).toThrow(RangeError);
    }
    expect(() => atlasIndex(128, 32, 0, 0, -1)).toThrow(RangeError);
  });
  it('creates a scalar texture without filtering, color conversion or vertical reversal', () => {
    const texture = createGSADataTexture({ size: 8, depth: 2, values: new Float32Array(128).fill(0.5) });
    expect(texture.image.width).toBe(8); expect(texture.image.height).toBe(16);
    expect(texture.image.data[0]).toBe(128);
    expect(texture.format).toBe(RedFormat); expect(texture.type).toBe(UnsignedByteType);
    expect(texture.magFilter).toBe(NearestFilter); expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.flipY).toBe(false); expect(texture.generateMipmaps).toBe(false); expect(texture.colorSpace).toBe(NoColorSpace);
    texture.dispose();
  });
});

describe('generation request validation', () => {
  it('rejects invalid dimensions and options before requesting GPU access', async () => {
    await expect(generateGSA({ size: 12 })).rejects.toThrow(RangeError);
    await expect(generateGSA({ seed: -1 })).rejects.toThrow(RangeError);
    await expect(generateGSA({ steps: 1.5 })).rejects.toThrow(RangeError);
  });
  it('honors an already cancelled request without GPU access', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled by caller'));
    await expect(generateGSA({ signal: controller.signal })).rejects.toThrow('cancelled by caller');
  });
});
