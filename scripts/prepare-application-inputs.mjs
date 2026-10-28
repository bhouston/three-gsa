// Prepare the exact input layout consumed by scripts/applications/run.mjs and SSR.
// node scripts/prepare-application-inputs.mjs THREE_CHECKOUT INPUT_DIRECTORY [--generate]
// Without --generate: decode the two pinned seed-1 PNGs, write the six-run GPU
// plan, and record available hashes. With --generate: also run seeds 2–4 on a
// physical GPU using the pinned research runner. Raw inputs stay outside this repo.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length < 2 || args.slice(2).some(arg => arg !== '--generate'))
  throw new Error('Usage: node scripts/prepare-application-inputs.mjs THREE_CHECKOUT INPUT_DIRECTORY [--generate]');
const checkout = path.resolve(args[0]), destination = path.resolve(args[1]);
const generate = args.includes('--generate');
const root = fileURLToPath(new URL('../', import.meta.url));
const relative = path.relative(root, destination);
if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
  throw new Error('INPUT_DIRECTORY must be outside the three-gsa repository; generated raw masks do not belong in Git.');
const require = createRequire(path.join(checkout, 'package.json'));
const { PNG } = require('pngjs');
const RESEARCH_PIN = 'bf8053703d208df3354256733d63c0506ef71c0f';
const PR117_PIN = '2a065526980261bcf5b129f07ddb12ff7eda1f91';
const FAST_PNG = 'examples/textures/noises/experimental/fast-seed1.png';
const GSA_PNG = 'packages/example/public/noise/gsa.png';
const scalarCount = 128 * 128 * 32;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = bytes => Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));

function gitShow(pin, filename) {
  // Only fixed hexadecimal pins and fixed source paths reach the shell. User
  // checkout paths are passed as cwd, never interpolated into command text.
  const command = process.platform === 'win32' ? 'cmd.exe' : 'git-dedup';
  const parameters = process.platform === 'win32'
    ? ['/d', '/s', '/c', `git-dedup.cmd show ${pin}:${filename}`]
    : ['show', `${pin}:${filename}`];
  const result = spawnSync(command, parameters, { cwd: checkout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot read pinned source ${pin}:${filename}: ${result.error?.message || result.stderr?.toString()}`);
  return result.stdout;
}

const profile = seed => ({
  name: `GSA-${seed}`, seed, steps: 3000, stratified: true, swapFloor: 2,
  identityWeight: 0.25, mixedWeight: 0.2, annealTemperature: 0.001, annealSteps: 1500,
});
const plan = [2, 3, 4].flatMap(seed => [{ name: `FAST-${seed}`, seed, steps: 10000 }, profile(seed)]);
const sourceFiles = {};
for (const filename of ['utils/fastnoise/generator.html', 'utils/fastnoise/experiments/gpu-features.js', 'utils/fastnoise/experiments/run-gpu.js']) {
  const pinned = normalized(gitShow(RESEARCH_PIN, filename));
  const current = normalized(fs.readFileSync(path.join(checkout, filename)));
  if (!pinned.equals(current)) throw new Error(`Research source changed: ${filename}. Use the pinned ${RESEARCH_PIN} implementation before generation.`);
  sourceFiles[filename] = { normalizedSHA256: hash(pinned) };
}
fs.mkdirSync(destination, { recursive: true });

function decodeSeedOne(pngBytes, filename, expectedFloatHash) {
  const image = PNG.sync.read(pngBytes);
  if (image.width !== 128 || image.height !== 4096)
    throw new Error(`${filename}: expected a scalar 128×4096 atlas, not a packed RGB control texture.`);
  const floats = Buffer.alloc(scalarCount * 4);
  for (let i = 0; i < scalarCount; i++) {
    const offset = i * 4, value = image.data[offset];
    if (value !== image.data[offset + 1] || value !== image.data[offset + 2] || image.data[offset + 3] !== 255)
      throw new Error(`${filename}: expected opaque grayscale scalar texels.`);
    floats.writeFloatLE((value + 0.5) / 256, offset);
  }
  if (hash(floats) !== expectedFloatHash) throw new Error(`${filename}: decoded seed-1 mask differs from the published input fingerprint.`);
  fs.writeFileSync(path.join(destination, filename), floats);
  return { pngSHA256: hash(pngBytes), midpointFloat32SHA256: hash(floats) };
}

const seedOne = {
  'FAST-1.f32': { source: `${PR117_PIN}:${FAST_PNG}`, ...decodeSeedOne(gitShow(PR117_PIN, FAST_PNG), 'FAST-1.f32', '3ab37c5fc23ebb5743eaff1ada7c996c77d233666b001953fb34f3597f6d3c2b') },
  'GSA-1.f32': { source: GSA_PNG, sourceManifest: 'packages/example/public/noise/source-manifest.json', ...decodeSeedOne(fs.readFileSync(path.join(root, GSA_PNG)), 'GSA-1.f32', 'de6ae2bf663540bca1715947ab0886406778a6cc754de171faa46d6895d018e3') },
};
const planName = 'application-input-plan.json';
const planFile = path.join(destination, planName);
fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');

function writeManifest() {
  const files = {};
  for (const method of ['FAST', 'GSA']) for (const seed of [1, 2, 3, 4]) {
    const filename = `${method}-${seed}.f32`, filepath = path.join(destination, filename);
    const item = { method, seed, status: 'missing', ...(seed === 1 ? seedOne[filename] : { generation: plan.find(entry => entry.name === `${method}-${seed}`) }) };
    if (fs.existsSync(filepath)) {
      const bytes = fs.readFileSync(filepath);
      if (bytes.length !== scalarCount * 4) throw new Error(`${filename}: expected ${scalarCount * 4} bytes.`);
      const centers = Buffer.alloc(bytes.length), quantized = Buffer.alloc(scalarCount);
      for (let i = 0; i < scalarCount; i++) {
        const value = bytes.readFloatLE(i * 4);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${filename}: value outside [0,1].`);
        quantized[i] = Math.min(255, Math.floor(value * 256));
        centers.writeFloatLE((quantized[i] + 0.5) / 256, i * 4);
      }
      Object.assign(item, { status: 'available', bytes: bytes.length, sourceSHA256: hash(bytes), quantizedFloat32SHA256: hash(centers), quantizedBytesSHA256: hash(quantized) });
    }
    files[filename] = item;
  }
  const manifest = {
    layout: '128×128×32 scalar values, z/y/x, little-endian float32; application runner quantizes to 8-bit bin centers',
    size: 128, depth: 32,
    seedOneConvention: 'Seed 1 is decoded from evaluated grayscale PNGs as (byte+0.5)/256, matching the captured application inputs. Seeds 2–4 retain raw optimizer float32 output until the application runner quantizes it.',
    researchSource: { commit: RESEARCH_PIN, files: sourceFiles },
    generationPlan: planName,
    gpuReport: fs.existsSync(path.join(destination, `gpu-screen-${planName}`)) ? `gpu-screen-${planName}` : null,
    complete: Object.values(files).every(item => item.status === 'available'),
    files,
    note: 'GPU floating-point optimization may differ across physical adapters. This records actual fingerprints; hash equality across adapters is not promised. Existing seeds 2–4 are fingerprinted but only --generate establishes that this invocation produced them.',
  };
  fs.writeFileSync(path.join(destination, 'application-input-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

writeManifest();
if (generate) {
  try {
    const result = spawnSync(process.execPath, [path.join(checkout, 'utils/fastnoise/experiments/run-gpu.js'), destination, planFile], { cwd: checkout, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Physical GPU generation failed: ${result.error?.message || `exit ${result.status}`}`);
  } finally {
    writeManifest();
  }
}
const manifest = writeManifest();
console.log(`Prepared seed-1 inputs and six-run plan in ${destination}. All eight input masks present: ${manifest.complete}.`);
if (!generate) console.log('No GPU work performed. Add --generate to produce seeds 2–4; this overwrites those six raw-mask files.');
