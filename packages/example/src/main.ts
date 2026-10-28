import './style.css';
import * as THREE from 'three';
import { createGSADataTexture, gsaSamplingGLSL } from 'three-gsa/three';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('comparison');
const status = element('status');
const generateButton = element<HTMLButtonElement>('generate');
const cancelButton = element<HTMLButtonElement>('cancel');
const mode = element<HTMLSelectElement>('mode');
const spatial = element<HTMLInputElement>('spatial');
const temporal = element<HTMLInputElement>('temporal');
const animate = element<HTMLInputElement>('animate');
let controller: AbortController | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let atlas: THREE.Texture | undefined;
let samples = 0, frame = 0, ready = false;
let targets: THREE.WebGLRenderTarget[] = [];
let compute: THREE.RawShaderMaterial, display: THREE.RawShaderMaterial;
let renderSample: () => void = () => {};

const vertexShader = /* glsl */`
in vec3 position; out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
function reset() { samples = 0; frame = 0; element('frames').textContent = '0'; }
for (const control of [mode, spatial, temporal]) control.addEventListener('change', reset);
element('reset').addEventListener('click', reset);

async function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Floating-point render targets are required.');
  const geometry = new THREE.PlaneGeometry(2, 2);
  const camera = new THREE.Camera(), scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry); mesh.frustumCulled = false; scene.add(mesh);
  atlas = await new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}noise/gsa.png`);
  atlas.flipY = false; atlas.colorSpace = THREE.NoColorSpace;
  atlas.minFilter = atlas.magFilter = THREE.NearestFilter; atlas.generateMipmaps = false; atlas.needsUpdate = true;
  const size = new THREE.Vector2(1024, 512);
  renderer.setSize(size.x, size.y, false);
  targets = [0, 1].map(() => new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
  compute = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader: /* glsl */`
precision highp float; precision highp int;
in vec2 vUv; out vec4 outputColor;
uniform sampler2D history, atlas; uniform int frame, count, sphere, spatial, temporal;
${gsaSamplingGLSL}
uint hash(uint x) { x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; return x ^ (x >> 16u); }
float sampleField(ivec2 p, bool right) {
  uint whiteSeed = hash(uint(p.x)) ^ hash(uint(p.y) ^ 0x9e3779b9u) ^ hash(uint(frame) ^ 0x85ebca6bu);
  float u = right ? sampleGSA(atlas, p, frame, 128, 32) : (float(hash(whiteSeed)) + 0.5) / 4294967296.0;
  if (sphere == 0) return u;
  vec2 uv = (vec2(p - ivec2(512)) + 0.5) / 512.0 * 2.0 - 1.0;
  float coverage = sqrt(max(0.0, 1.0 - dot(uv, uv) / 0.8));
  return u < coverage ? 1.0 : 0.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); bool right = p.x >= 512; ivec2 local = ivec2(p.x % 512, p.y);
  float value = 0.0;
  if (spatial == 1) {
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) { float w = float((x==0?2:1)*(y==0?2:1)) / 16.0; value += w * sampleField(local+ivec2(x,y)+ivec2(512), right); }
  } else value = sampleField(local+ivec2(512), right);
  float old = count == 0 ? 0.0 : texelFetch(history, p, 0).r;
  float result = temporal == 1 ? old + (value-old)/float(count+1) : value;
  outputColor = vec4(result,result,result,1.0);
}
`, uniforms: { history: { value: targets[0].texture }, atlas: { value: atlas }, frame: { value: 0 }, count: { value: 0 }, sphere: { value: 1 }, spatial: { value: 1 }, temporal: { value: 1 } } });
  display = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader: /* glsl */`
precision highp float; in vec2 vUv; out vec4 outputColor; uniform sampler2D image;
void main() { vec3 linear = texture(image, vUv).rgb; vec3 srgb = mix(linear * 12.92, 1.055 * pow(max(linear, vec3(0.0)),vec3(1.0/2.4))-0.055, step(vec3(0.0031308),linear)); outputColor=vec4(srgb,1.0); }
`, uniforms: { image: { value: targets[1].texture } } });
  ready = true;
  status.textContent = 'Precomputed GSA loaded. White and GSA use identical accumulation and filtering.';
  renderSample = () => {
    if (!ready || (!animate.checked && samples > 0)) return;
    const [previous, current] = targets;
    compute.uniforms.history.value = previous.texture;
    compute.uniforms.frame.value = frame;
    compute.uniforms.count.value = samples;
    compute.uniforms.sphere.value = mode.value === 'sphere' ? 1 : 0;
    compute.uniforms.spatial.value = Number(spatial.checked); compute.uniforms.temporal.value = Number(temporal.checked);
    mesh.material = compute; renderer!.setRenderTarget(current); renderer!.render(scene, camera);
    display.uniforms.image.value = current.texture;
    mesh.material = display; renderer!.setRenderTarget(null); renderer!.render(scene, camera);
    targets.reverse(); samples++; frame++;
    element('frames').textContent = String(temporal.checked ? samples : 1);
  };
  renderer.setAnimationLoop(renderSample);
}

generateButton.addEventListener('click', async () => {
  if (!ready) return;
  controller = new AbortController(); generateButton.disabled = true; cancelButton.disabled = false;
  status.textContent = 'Requesting hardware WebGPU adapter…';
  try {
    const { generateGSA } = await import('three-gsa/generator');
    const volume = await generateGSA({ signal: controller.signal, onProgress: ({ completed, total, elapsedMs }) => {
      status.textContent = `Generating: ${completed}/${total} iterations (${(elapsedMs / 1000).toFixed(1)} s). Rendering continues with the existing mask.`;
    } });
    const next = createGSADataTexture(volume); atlas?.dispose(); atlas = next;
    compute.uniforms.atlas.value = next; reset();
    status.textContent = 'Generated GSA mask installed. Accumulation reset.';
  } catch (error) {
    status.textContent = controller.signal.aborted ? 'Generation cancelled; existing mask retained.' : `Generation failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally { generateButton.disabled = false; cancelButton.disabled = true; controller = undefined; }
});
cancelButton.addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => {
  controller?.abort(); renderer?.setAnimationLoop(null);
  targets.forEach(target => target.dispose()); compute?.dispose(); display?.dispose(); atlas?.dispose(); renderer?.dispose();
});
init().catch(error => { status.textContent = error instanceof Error ? error.message : String(error); generateButton.disabled = true; });
