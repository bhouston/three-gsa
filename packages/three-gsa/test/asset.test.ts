import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';

it('ships the evaluated PNG and preserves a temporal stratum per pixel', () => {
  const png = readFileSync(new URL('../../example/public/noise/gsa.png', import.meta.url));
  expect(createHash('sha256').update(png).digest('hex')).toBe('cf538357aff97550a45f74f7c30b8a10a8fc4c2cd78d723cf18f4f39bee74ad5');
  expect(png.readUInt32BE(16)).toBe(128); expect(png.readUInt32BE(20)).toBe(4096);
  expect(png[24]).toBe(8); expect(png[25]).toBe(0); // 8-bit grayscale
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + size));
    offset += 12 + size;
  }
  const filtered = inflateSync(Buffer.concat(idat)), bytes = new Uint8Array(128 * 4096);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < 4096; y++) {
    const filter = filtered[y * 129];
    for (let x = 0; x < 128; x++) {
      const i = y * 128 + x, a = x ? bytes[i - 1] : 0, b = y ? bytes[i - 128] : 0, c = x && y ? bytes[i - 129] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      if (predictor === undefined) throw new Error('Unexpected PNG filter.');
      bytes[i] = filtered[y * 129 + 1 + x] + predictor;
    }
  }
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('f335d55f6e719d55313080225f7627a4aa684aded481608da2bb72b3e3fc627c');
  for (let pixel = 0; pixel < 128 * 128; pixel++) {
    const strata = new Set<number>();
    for (let z = 0; z < 32; z++) strata.add(bytes[z * 128 * 128 + pixel] >> 3);
    expect(strata.size).toBe(32);
  }
});
