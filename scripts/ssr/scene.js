import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, metalness, roughness, vec2, packNormalToRGB, unpackRGBToNormal, sample } from 'three/tsl';

const size = 128;
const textureFor = (bytes) => {
  const texture = new THREE.DataTexture(bytes, 128, 4096, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
};
window.ssrInitialTextures = Array.from({ length: 4 }, () => textureFor(new Uint8Array(128 * 4096)));
const { ssr } = await import('three/addons/tsl/display/SSRNode.js');
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setSize(size, size);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0.01, 0.01, 0.01);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 30);
camera.position.set(3.7, 3.4, 5.7);
camera.lookAt(0, 0.3, 0);
for (let i = 0; i < 3; i++) {
  const material = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 1, roughness: [0.12, 0.3, 0.65][i] });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 7), material);
  plane.rotation.x = -Math.PI / 2;
  plane.position.x = (i - 1) * 2;
  scene.add(plane);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5 + i * 0.2, 0.8), new THREE.MeshBasicMaterial({ color: [0xff3010, 0x20ff50, 0x3060ff][i] }));
  box.position.set((i - 1) * 1.8, 0.75 + i * 0.1, -0.8 + i * 0.3);
  scene.add(box);
}
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView), metalrough: vec2(metalness, roughness) }));
const normal = scenePass.getTextureNode('normal');
const metalrough = scenePass.getTextureNode('metalrough');
const reflection = ssr(scenePass.getTextureNode('output'), scenePass.getTextureNode('depth'), sample(uv => unpackRGBToNormal(normal.sample(uv))), {
  stochastic: true, metalnessNode: metalrough.r, roughnessNode: metalrough.g, camera,
  envImportanceSampling: false,
});
reflection.maxDistance.value = 10;
reflection.thickness.value = 0.08;
reflection.quality.value = 0.5;
reflection.mirrorBias.value = 0;
const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = reflection.rgb;
const prefixes = [1, 4, 16, 32, 64, 128];
const convert = values => values instanceof Float32Array ? values : Float32Array.from(values, value => THREE.DataUtils.fromHalfFloat(value));
window.ssrBench = {
  renderer,
  async setMasks(urls) {
    for (let i = 0; i < 4; i++) {
      const response = await fetch(urls[i]);
      if (!response.ok) throw new Error(`Mask ${urls[i]} returned ${response.status}`);
      const values = new Float32Array(await response.arrayBuffer());
      if (values.length !== 128 * 128 * 32) throw new Error('Wrong mask dimensions');
      const bytes = Uint8Array.from(values, value => Math.min(255, Math.max(0, Math.floor(value * 256))));
      window.ssrNoise.channels[i].value = textureFor(bytes);
    }
  },
  async run(mode, count) {
    window.ssrNoise.mode.value = mode === 'reference' ? 0 : 1;
    const sum = new Float64Array(size * size * 3);
    const snapshots = {};
    for (let frame = 0; frame < count; frame++) {
      // SSRNode advances the index during its update; compensate to make frame zero explicit.
      reflection._noiseIndex.value = frame - 1;
      pipeline.render();
      const pixels = convert(await renderer.readRenderTargetPixelsAsync(reflection._ssrRenderTarget, 0, 0, size, size));
      for (let p = 0; p < size * size; p++) for (let c = 0; c < 3; c++) sum[p * 3 + c] += pixels[p * 4 + c];
      const n = frame + 1;
      if (prefixes.includes(n) || n === 2048 || n === count) snapshots[n] = Array.from(sum, value => value / n);
      if (n % 32 === 0) { window.ssrProgress = { mode, frame: n, count }; await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();
    return snapshots;
  },
  async captureFrames(start, count) {
    window.ssrNoise.mode.value = 1;
    const frames = new Float32Array(count * size * size * 3);
    for (let offset = 0; offset < count; offset++) {
      reflection._noiseIndex.value = start + offset - 1;
      pipeline.render();
      const pixels = convert(await renderer.readRenderTargetPixelsAsync(reflection._ssrRenderTarget, 0, 0, size, size));
      const target = offset * size * size * 3;
      for (let p = 0; p < size * size; p++) for (let c = 0; c < 3; c++) frames[target + p * 3 + c] = pixels[p * 4 + c];
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const bytes = new Uint8Array(frames.buffer);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return btoa(chunks.join(''));
  },
  async throughput(warmupMilliseconds = 1000, measuredMilliseconds = 3000) {
    window.ssrNoise.mode.value = 1;
    const queue = renderer.backend.device.queue;
    const windowFor = async milliseconds => {
      await queue.onSubmittedWorkDone();
      const start = performance.now();
      let completedFrames = 0;
      do {
        for (let i = 0; i < 16; i++) pipeline.render();
        await queue.onSubmittedWorkDone();
        completedFrames += 16;
      } while (performance.now() - start < milliseconds);
      return { completedFrames, elapsedSeconds: (performance.now() - start) / 1000 };
    };
    const warmup = await windowFor(warmupMilliseconds);
    const measured = await windowFor(measuredMilliseconds);
    return { warmup, measured, framesPerSecond: measured.completedFrames / measured.elapsedSeconds };
  },
};
window.ssrReady = true;
