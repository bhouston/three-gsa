/** Scalar masks use z-major slices, then y, then x. */
export type GSAVolume = { size: number; depth: number; values: Float32Array };

export function validateDimensions(size: number, depth: number): void {
  if (!Number.isInteger(size) || size < 8 || size > 512 || (size & (size - 1)) !== 0)
    throw new RangeError('size must be a power of two from 8 to 512.');
  if (!Number.isInteger(depth) || depth < 2 || depth > 128 || (depth & (depth - 1)) !== 0)
    throw new RangeError('depth must be a power of two from 2 to 128.');
}

/** Match the benchmark/export path: floor into an 8-bit stratum. */
export function quantizeGSA(volume: GSAVolume): Uint8Array {
  validateDimensions(volume.size, volume.depth);
  if (volume.values.length !== volume.size * volume.size * volume.depth)
    throw new RangeError('Volume length does not match its dimensions.');
  const bytes = new Uint8Array(volume.values.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = volume.values[i];
    if (!Number.isFinite(value) || value < 0 || value >= 1)
      throw new RangeError('Mask values must be finite and in [0, 1).');
    bytes[i] = Math.floor(value * 256);
  }
  return bytes;
}

/** FAST playback convention: repeat the stack with a (37,71) spatial shift. */
export function atlasIndex(size: number, depth: number, x: number, y: number, frame: number): number {
  validateDimensions(size, depth);
  if (![x, y, frame].every(Number.isSafeInteger) || frame < 0)
    throw new RangeError('Coordinates must be safe integers and frame must be nonnegative.');
  const wrap = (value: number) => ((value % size) + size) % size;
  const cycle = Math.floor(frame / depth) % size;
  return ((frame % depth) * size + wrap(wrap(y) + cycle * 71)) * size + wrap(wrap(x) + cycle * 37);
}

/** Sample the midpoint of the encoded 8-bit stratum, including PNG inputs. */
export function sampleGSA(bytes: Uint8Array, size: number, depth: number, x: number, y: number, frame: number): number {
  if (bytes.length !== size * size * depth) throw new RangeError('Atlas byte count does not match dimensions.');
  return (bytes[atlasIndex(size, depth, x, y, frame)] + 0.5) / 256;
}
