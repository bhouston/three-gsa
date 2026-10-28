// node scripts/ssr/run.mjs THREE_CHECKOUT INPUT_DIRECTORY OUTPUT_DIRECTORY
// Inputs: FAST-1.f32 through FAST-4.f32 and GSA-1.f32 through GSA-4.f32.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const [checkoutArg, inputsArg, outputArg] = process.argv.slice(2);
const phasesOnly = process.argv.includes('--phases-only');
if (!outputArg) throw new Error('Usage: node scripts/ssr/run.mjs THREE_CHECKOUT INPUT_DIRECTORY OUTPUT_DIRECTORY');
const checkout = path.resolve(checkoutArg);
const inputs = path.resolve(inputsArg);
const output = path.resolve(outputArg);
const local = path.resolve(fileURLToPath(new URL('./', import.meta.url)));
fs.mkdirSync(output, { recursive: true });
const puppeteer = createRequire(path.join(checkout, 'package.json'))('puppeteer');
const protocol = JSON.parse(fs.readFileSync(new URL('../../docs/research/ssr-protocol.json', import.meta.url), 'utf8'));
const report = { protocol, requestedWebGPUBackend: process.env.SSR_ADAPTER || 'd3d11', ssrSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(checkout, 'examples/jsm/tsl/display/SSRNode.js'))).digest('hex'), inputs: {}, errors: [], complete: false };
for (const method of ['fast', 'gsa']) for (let seed = 1; seed <= 4; seed++) {
  const name = `${method.toUpperCase()}-${seed}.f32`;
  report.inputs[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(inputs, name))).digest('hex');
}
const server = http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    let filename = pathname === '/' ? path.join(local, 'index.html') : pathname.startsWith('/ssr/') ? path.join(local, pathname.slice(5)) : pathname.startsWith('/inputs/') ? path.join(inputs, pathname.slice(8)) : path.join(checkout, pathname.slice(1));
    if (![checkout, local, inputs].some(root => filename === root || filename.startsWith(root + path.sep))) throw new Error('Invalid request path');
    let body = fs.readFileSync(filename);
    if (pathname === '/examples/jsm/tsl/display/SSRNode.js') {
      const original = "import { bindAnalyticNoise } from '../utils/RNoise.js';";
      if (!body.toString().includes(original)) throw new Error('SSRNode import changed; review injection');
      body = Buffer.from(body.toString().replace(original, "import { bindAnalyticNoise } from '/ssr/noise.js';"));
    }
    const contentType = filename.endsWith('.html') ? 'text/html' : /\.(m?js)$/.test(filename) ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }); res.end(body);
  } catch (error) { console.error(`HTTP ${req.url}: ${error.message}`); res.writeHead(404); res.end(error.message); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, protocolTimeout: 1800000,
    args: ['--enable-unsafe-webgpu', `--use-webgpu-adapter=${process.env.SSR_ADAPTER || 'd3d11'}`, '--disable-software-rasterizer', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  let rejectBrowserFailure;
  const browserFailure = new Promise((resolve, reject) => { rejectBrowserFailure = reject; });
  const guard = promise => Promise.race([promise, browserFailure]);
  const fatal = message => { report.errors.push(message); console.error(message); rejectBrowserFailure(new Error(message)); };
  page.on('pageerror', error => fatal(error.message));
  page.on('console', message => { if (message.type() === 'error') fatal(message.text()); });
  await guard(page.goto(`http://127.0.0.1:${server.address().port}`));
  await guard(page.waitForFunction(() => window.ssrReady, { timeout: 120000 }));
  report.adapter = await page.evaluate(async () => { const adapter = await navigator.gpu.requestAdapter(); return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter }; });
  const cdp = await browser.target().createCDPSession();
  report.renderer = (await cdp.send('SystemInfo.getInfo')).gpu.auxAttributes.glRenderer;
  if (report.adapter.fallback !== false || !/AMD|NVIDIA|Intel/i.test(report.renderer) || /SwiftShader|llvmpipe|lavapipe|Microsoft Basic/i.test(report.renderer)) throw new Error('Physical GPU required');
  console.log(JSON.stringify({ adapter: report.adapter, renderer: report.renderer }));
  if (phasesOnly) {
    const previous = JSON.parse(fs.readFileSync(path.join(output, 'ssr-run.json'), 'utf8'));
    if (!previous.complete || previous.ssrSourceSha256 !== report.ssrSourceSha256) throw new Error('Phase extension requires the successful original reference from the same SSR source');
    if (fs.statSync(path.join(output, 'reference-4096.f32')).size !== 128 * 128 * 3 * 4) throw new Error('Reference dimensions differ');
    report.referenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, 'reference-4096.f32'))).digest('hex');
    for (const method of ['fast', 'gsa']) {
      await page.evaluate(urls => window.ssrBench.setMasks(urls), Array.from({ length: 4 }, (_, i) => `/inputs/${method.toUpperCase()}-${i + 1}.f32`));
      const filename = path.join(output, `${method}-frames-0-158.f32`);
      fs.writeFileSync(filename, Buffer.alloc(0));
      for (let start = 0; start < 159; start += 16) {
        const count = Math.min(16, 159 - start);
        const encoded = await guard(page.evaluate((first, n) => window.ssrBench.captureFrames(first, n), start, count));
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== count * 128 * 128 * 3 * 4) throw new Error('Wrong frame payload size');
        fs.appendFileSync(filename, bytes);
      }
      console.log(`Finished phase-extension ${method}`);
    }
  } else {
  for (const method of ['reference', 'fast', 'gsa']) {
    if (method !== 'reference') await page.evaluate(urls => window.ssrBench.setMasks(urls), Array.from({ length: 4 }, (_, i) => `/inputs/${method.toUpperCase()}-${i + 1}.f32`));
    console.log(`Starting ${method}`);
    const snapshots = await guard(page.evaluate((name, n) => window.ssrBench.run(name, n), method, method === 'reference' ? 4096 : 128));
    for (const [count, pixels] of Object.entries(snapshots)) {
      const array = Float32Array.from(pixels);
      if (!array.every(Number.isFinite)) throw new Error(`Nonfinite ${method} ${count}`);
      if (!array.some(value => Math.abs(value) > 1e-5)) throw new Error(`Empty reflection ${method} ${count}`);
      fs.writeFileSync(path.join(output, `${method}-${count}.f32`), Buffer.from(array.buffer));
    }
    await page.screenshot({ path: path.join(output, `${method}.png`) });
    console.log(`Finished ${method}`);
  }
  report.throughput = [];
  for (const [order, methods] of [['fast-then-gsa', ['fast', 'gsa']], ['gsa-then-fast', ['gsa', 'fast']]]) {
    for (const method of methods) {
      await page.evaluate(urls => window.ssrBench.setMasks(urls), Array.from({ length: 4 }, (_, i) => `/inputs/${method.toUpperCase()}-${i + 1}.f32`));
      const measurement = await guard(page.evaluate(() => window.ssrBench.throughput()));
      report.throughput.push({ order, method, ...measurement });
      console.log(JSON.stringify({ order, method, ...measurement }));
    }
  }
  }
  if (report.errors.length) throw new Error(`Browser reported ${report.errors.length} errors`);
  report.complete = true;
} finally {
  fs.writeFileSync(path.join(output, phasesOnly ? 'ssr-phases-run.json' : 'ssr-run.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
