/// <reference types="@webgpu/types" preserve="true" />
import { validateDimensions } from './index.js';
import type { GSAVolume } from './index.js';
import { createKernel } from './kernel.js';
import { createShader } from './shader.js';

export type GSAProgress = { completed: number; total: number; elapsedMs: number; swapsPerIteration: number };
export type GSAOptions = {
  size?: number;
  depth?: number;
  seed?: number;
  steps?: number;
  device?: GPUDevice;
  signal?: AbortSignal;
  onProgress?: (progress: GSAProgress) => void;
};

/** The evaluated GSA profile. Default generation is seconds, not a per-frame operation.
 * Changing size/depth/steps is supported, but the published quality results apply only
 * to 128×128×32, 3000 steps. A provided device remains owned by the caller.
 */
export async function generateGSA(options: GSAOptions = {}): Promise<GSAVolume> {
  const { size: S = 128, depth: Z = 32, steps = 3000, signal, onProgress } = options;
  validateDimensions(S, Z);
  if (!Number.isInteger(steps) || steps < 0 || steps > 1_000_000) throw new RangeError('steps must be an integer from 0 to 1000000.');
  let seed = options.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a uint32.');
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Generation aborted.', 'AbortError'); };
  checkAbort();
  let device = options.device;
  const ownsDevice = device === undefined;
  if (!device) {
    if (!globalThis.navigator?.gpu) throw new Error('GSA generation requires WebGPU in a secure browser context. Load a precomputed atlas instead.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required.');
    device = await adapter.requestDevice();
  }
  const gpu = device;
  const buffers: GPUBuffer[] = [];
  gpu.pushErrorScope('validation');
  let scopeOpen = true;
  const t0 = performance.now();
  try {
    checkAbort();
    const N = S * S * Z;
    if (N * 4 > gpu.limits.maxStorageBufferBindingSize || N * 4 > gpu.limits.maxBufferSize)
      throw new RangeError('Volume exceeds this GPU device’s buffer limits.');
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0, seed / 4294967296);
    const values = new Float32Array(N);
    for (let pixel = 0; pixel < S * S; pixel++) {
      const perm = Array.from({ length: Z }, (_, i) => i);
      for (let z = Z - 1; z > 0; z--) {
        const j = Math.floor(rand() * (z + 1));
        [perm[z], perm[j]] = [perm[j], perm[z]];
      }
      for (let z = 0; z < Z; z++) values[z * S * S + pixel] = Math.min((perm[z] + rand()) / Z, 1 - 2 ** -24);
    }
    const { fs, weights, taps } = createKernel(Z);
    const workgroupX = S >= 32 ? 32 : 8, workgroupY = S >= 32 ? 2 : 8;
    const module = gpu.createShaderModule({ code: createShader(S, Z, fs, workgroupX, workgroupY) });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(errors.map(message => `WGSL line ${message.lineNum}: ${message.message}`).join('\n'));
    const buffer = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const result = gpu.createBuffer({ size: Math.max(16, size), usage });
      buffers.push(result); return result;
    };
    const uploaded = (data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer => {
      const result = buffer(data.byteLength, usage | GPUBufferUsage.COPY_DST);
      gpu.queue.writeBuffer(result, 0, data as Float32Array<ArrayBuffer>); return result;
    };
    const valuesBuf = uploaded(values, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const deltaBuf = buffer(N * 4, GPUBufferUsage.STORAGE);
    const tapsBuf = uploaded(taps, GPUBufferUsage.STORAGE);
    const wBuf = uploaded(weights, GPUBufferUsage.STORAGE);
    // Suppression adaptation is synchronized every 100 iterations in the evaluated method.
    const BATCH = 100, STRIDE = 256;
    const paramsBuf = buffer(BATCH * STRIDE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const swapsBuf = buffer(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const swapsRead = buffer(4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const layout = gpu.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ] });
    const pipelineLayout = gpu.createPipelineLayout({ bindGroupLayouts: [layout] });
    const [lossPipeline, swapPipeline] = await Promise.all(['loss', 'swap'].map(entryPoint =>
      gpu.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })));
    const bindGroup = gpu.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: valuesBuf } }, { binding: 1, resource: { buffer: deltaBuf } },
      { binding: 2, resource: { buffer: tapsBuf } }, { binding: 3, resource: { buffer: wBuf } },
      { binding: 4, resource: { buffer: paramsBuf, size: 32 } }, { binding: 5, resource: { buffer: swapsBuf } },
    ] });
    let suppression = 8;
    onProgress?.({ completed: 0, total: steps, elapsedMs: performance.now() - t0, swapsPerIteration: 0 });
    for (let step = 0; step < steps; step += BATCH) {
      checkAbort();
      const n = Math.min(BATCH, steps - step), p = new Uint32Array(BATCH * STRIDE / 4);
      for (let b = 0; b < n; b++) {
        const o = b * STRIDE / 4;
        for (let k = 0; k < 4; k++) p[o + k] = Math.floor(rand() * 4294967296) >>> 0;
        p[o + 4] = step + b; p[o + 5] = suppression; p[o + 6] = taps.length / 4;
      }
      gpu.queue.writeBuffer(paramsBuf, 0, p);
      gpu.queue.writeBuffer(swapsBuf, 0, new Uint32Array([0]));
      const enc = gpu.createCommandEncoder();
      for (let b = 0; b < n; b++) {
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, bindGroup, [b * STRIDE]);
        pass.setPipeline(lossPipeline); pass.dispatchWorkgroups(S / workgroupX, S / workgroupY, Z);
        pass.setPipeline(swapPipeline); pass.dispatchWorkgroups(S / workgroupX, S / workgroupY, Z);
        pass.end();
      }
      enc.copyBufferToBuffer(swapsBuf, 0, swapsRead, 0, 4);
      gpu.queue.submit([enc.finish()]);
      await swapsRead.mapAsync(GPUMapMode.READ);
      const swaps = new Uint32Array(swapsRead.getMappedRange())[0] / n;
      swapsRead.unmap();
      if (suppression > 1 && 8 * swaps * suppression < N) suppression /= 2;
      onProgress?.({ completed: step + n, total: steps, elapsedMs: performance.now() - t0, swapsPerIteration: swaps });
    }
    checkAbort();
    const read = buffer(N * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const enc = gpu.createCommandEncoder(); enc.copyBufferToBuffer(valuesBuf, 0, read, 0, N * 4);
    gpu.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    checkAbort();
    const error = await gpu.popErrorScope();
    scopeOpen = false;
    if (error) throw new Error(`WebGPU validation failed: ${error.message}`);
    return { size: S, depth: Z, values: result };
  } catch (error) {
    if (scopeOpen) await gpu.popErrorScope().catch(() => undefined);
    throw error;
  } finally {
    await gpu.queue.onSubmittedWorkDone().catch(() => undefined);
    for (const resource of buffers) resource.destroy();
    if (ownsDevice) gpu.destroy();
  }
}
