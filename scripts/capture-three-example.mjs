// Capture the actual Three.js research example on a physical GPU.
// node scripts/capture-three-example.mjs PATH_TO_THREE_JS OUTPUT_DIRECTORY
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [checkout, destination] = process.argv.slice(2).map(p => path.resolve(p));
const require = createRequire(path.join(checkout, 'package.json'));
const puppeteer = require('puppeteer');
const { createServer } = await import(pathToFileURL(path.join(checkout, 'utils/server.js')));
const source = fs.readFileSync(path.join(checkout, 'examples/webgpu_tsl_blue_noise.html'), 'utf8');
const windows = process.platform === 'win32';
const revision = spawnSync(windows ? 'cmd.exe' : 'git-dedup', windows ? ['/d', '/s', '/c', 'git-dedup.cmd rev-parse HEAD'] : ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== 'bf8053703d208df3354256733d63c0506ef71c0f') throw new Error('Check out the documented research commit before capturing.');
const marker = 'init().catch';
if (!source.includes(marker)) throw new Error('Review capture hooks against the pinned example.');
const html = source.replace(marker, `window.captureGSA = {
 get renderer() { return renderer; }, get samples() { return samples; },
 async setup() {
  renderer.setAnimationLoop(null);
  params.noise = 'GPU Stratified Annealed';
  await selectNoise(params.noise);
  params.animate = true; params.temporalBlur = true;
  resetAccumulation();
 },
 async next() {
  animate();
  await renderer.backend.device.queue.onSubmittedWorkDone();
  return renderer.domElement.toDataURL().split(',')[1];
 }
}; ${marker}`);
fs.mkdirSync(destination, { recursive: true });
const staticServer = createServer({ root: checkout });
const handler = staticServer.listeners('request')[0];
const server = http.createServer((req, res) => {
 if (req.url.startsWith('/examples/webgpu_tsl_blue_noise.html')) {
  res.setHeader('Content-Type', 'text/html'); res.end(html);
 } else if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); }
 else handler(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const frames = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const report = { source: 'bhouston/three.js', commit: 'bf8053703d208df3354256733d63c0506ef71c0f', frames, viewport: [960, 600], pixelSize: 2, mode: 'Sphere', spatialBlur: 'Gaussian sigma=1', temporalBlur: 'running average', note: 'Canvas readback of actual GPU rendering. Accelerated sample-count demonstration, not a frame-rate benchmark.', errors: [] };
report.exampleSHA256 = createHash('sha256').update(source).digest('hex');
let browser;
try {
 browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=d3d11', '--disable-software-rasterizer'] });
 const page = await browser.newPage();
 await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
 page.on('pageerror', error => report.errors.push(error.message));
 page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
 await page.goto(`http://127.0.0.1:${server.address().port}/examples/webgpu_tsl_blue_noise.html`);
 await page.waitForFunction(() => window.captureGSA?.samples >= 3);
 report.adapter = await page.evaluate(() => {
  const adapter = captureGSA.renderer.backend.device.adapterInfo;
  return { vendor: adapter.vendor, architecture: adapter.architecture, fallback: adapter.isFallbackAdapter };
 });
 const cdp = await browser.target().createCDPSession();
 report.renderer = (await cdp.send('SystemInfo.getInfo')).gpu.auxAttributes.glRenderer;
 // Older adapterInfo implementations expose the fallback flag on the adapter.
 report.requestedAdapter = await page.evaluate(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter };
 });
 if (!/amd|nvidia|intel/i.test(report.requestedAdapter.vendor) || report.requestedAdapter.fallback !== false || /SwiftShader|llvmpipe|lavapipe|Microsoft Basic/i.test(report.renderer)) throw new Error('Physical GPU context unavailable.');
 await page.evaluate(() => captureGSA.setup());
 for (let sample = 1; sample <= frames.at(-1); sample++) {
  const encoded = await page.evaluate(() => captureGSA.next());
  if (frames.includes(sample)) fs.writeFileSync(path.join(destination, `frame-${String(sample).padStart(3, '0')}.png`), Buffer.from(encoded, 'base64'));
 }
 if (report.errors.length) throw new Error(report.errors.join('\n'));
 report.pass = true;
 console.log('Captured', frames.length, 'frames on', report.requestedAdapter);
} finally {
 fs.writeFileSync(path.join(destination, 'capture.json'), JSON.stringify(report, null, 2));
 if (browser) await browser.close();
 await new Promise(resolve => server.close(resolve));
}
