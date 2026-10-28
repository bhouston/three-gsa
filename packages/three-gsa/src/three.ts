import { DataTexture, RedFormat, UnsignedByteType, NearestFilter, NoColorSpace } from 'three';
import { ivec2, textureLoad, float } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { quantizeGSA, validateDimensions } from './index.js';
import type { GSAVolume } from './index.js';

/** One scalar, nearest-filtered byte per texel; 128×4096 for the default mask. */
export function createGSADataTexture(volume: GSAVolume): DataTexture {
  const texture = new DataTexture(quantizeGSA(volume), volume.size, volume.size * volume.depth, RedFormat, UnsignedByteType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** TSL scalar playback. Position and frame are integer-valued, nonnegative nodes.
 * For a PNG loaded with TextureLoader set flipY=false, NoColorSpace, NearestFilter,
 * and generateMipmaps=false. Only the red channel is used.
 */
export function gsaSampleNode(atlas: NonNullable<Parameters<typeof textureLoad>[0]>, position: Node<'vec2'>, frame: Node<'float'>, size = 128, depth = 32) {
  validateDimensions(size, depth);
  const cycle = frame.div(depth).floor().mod(size).toInt();
  const pixel = ivec2(position).add(ivec2(37, 71).mul(cycle)).mod(size);
  const coord = ivec2(pixel.x, pixel.y.add(frame.mod(depth).mul(size).toInt()));
  return textureLoad(atlas, coord).r.mul(255).add(0.5).div(float(256));
}

/** GLSL 3 equivalent for ShaderMaterial/RawShaderMaterial WebGL2 users. */
export const gsaSamplingGLSL = /* glsl */`
float sampleGSA(sampler2D atlas, ivec2 pixel, int frame, int size, int depth) {
  int cycle = (frame / depth) % size;
  ivec2 p = (pixel + ivec2(37, 71) * cycle) % size;
  float encoded = texelFetch(atlas, ivec2(p.x, p.y + (frame % depth) * size), 0).r;
  return (encoded * 255.0 + 0.5) / 256.0;
}
`;
