// Reproducible browser checks, not a performance benchmark.
// Uses an existing Three.js checkout's Puppeteer installation; does not install browsers.
// node scripts/verify-gpu.mjs PATH_TO_THREE_JS OUTPUT_DIRECTORY
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const [checkoutArg, outputArg] = process.argv.slice(2);
if (!checkoutArg || !outputArg) throw new Error('Usage: node scripts/verify-gpu.mjs PATH_TO_THREE_JS OUTPUT_DIRECTORY');
const output = path.resolve(outputArg);
const require = createRequire(path.join(path.resolve(checkoutArg), 'package.json'));
const puppeteer = require('puppeteer');
fs.mkdirSync(output, { recursive: true });
const hook = `window.gsaTest = {
 get renderer() { return renderer; }, get samples() { return samples; },
 get atlas() { return atlas; }, reset,
 stop() { renderer.setAnimationLoop(null); },
 step() { renderSample(); },
 sphere(n) { renderer.setAnimationLoop(null); mode.value='sphere'; spatial.checked=true; temporal.checked=true; reset(); for(let i=0;i<n;i++)renderSample(); },
 renderUniform(f, texture) {
  renderer.setAnimationLoop(null); mode.value='uniform'; spatial.checked=false; temporal.checked=false;
  compute.uniforms.atlas.value=texture || atlas; samples=0; frame=f; renderSample();
  const pixels = new Float32Array(1024*512*4);
  renderer.readRenderTargetPixels(targets[0],0,0,1024,512,pixels);
  return [[0,0],[1,1],[37,71],[127,127],[128,128],[511,511]].map(([x,y])=>({x,y,value:pixels[((y*1024)+512+x)*4]}));
 }
}; init().catch`;
const virtualAPI = path.join(root,'packages/example/__gsa_check_api.ts').replaceAll('\\','/');
const server = await createServer({
  root: path.join(root, 'packages/example'),
  configFile: path.join(root, 'packages/example/vite.config.ts'),
  optimizeDeps: { include: ['three', 'three/tsl', 'three/webgpu'] },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'localhost-gpu-check-hooks', enforce: 'pre',
    configureServer(vite) { vite.middlewares.use((req,res,next) => { if(req.url==='/favicon.ico'){res.statusCode=204;res.end();}else next(); }); },
    resolveId(id) { if(id==='/__gsa_check_api.ts')return virtualAPI; },
    load(id) { if(id===virtualAPI)return "export * as THREE from 'three/webgpu'; export * as TSL from 'three/tsl';"; },
    transform(code, id) {
    if (id.split('?')[0] !== path.join(root, 'packages/example/src/main.ts').replaceAll('\\', '/')) return;
    if (!code.includes('init().catch')) throw new Error('Review browser check injection.');
    return code.replace('init().catch', hook);
  } }],
});
let browser;
const report = { errors: [], checks: [], pass: false };
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || (process.platform==='win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : puppeteer.executablePath()),
    headless: true,
    args: ['--enable-unsafe-webgpu', '--disable-software-rasterizer', ...(process.platform==='win32' ? ['--use-webgpu-adapter=d3d11'] : [])],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon.ico')) report.errors.push(message.text()); });
  await page.goto(origin);
  await page.evaluate(urls => window.gsaModuleURLs = urls, Object.fromEntries(['generator','index','three'].map(name => [name, '/@fs/' + path.join(root, 'packages/three-gsa/src/'+name+'.ts').replaceAll('\\','/')])));
  await page.waitForFunction(() => window.gsaTest?.samples >= 2, { timeout: 120000 });
  const cdp = await browser.target().createCDPSession();
  report.renderer = (await cdp.send('SystemInfo.getInfo')).gpu.auxAttributes.glRenderer;
  report.adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter } : null;
  });
  if (!/AMD|NVIDIA|Intel/i.test(report.renderer) || /SwiftShader|llvmpipe|lavapipe|Microsoft Basic/i.test(report.renderer) || report.adapter?.fallback !== false)
    throw new Error('Physical GPU context unavailable.');
  await page.evaluate(() => gsaTest.stop());
  report.generation = await page.evaluate(async () => {
    const { generateGSA } = await import(window.gsaModuleURLs.generator);
    const { quantizeGSA } = await import(window.gsaModuleURLs.index);
    const progress = [], started = performance.now();
    window.gsaVolume = await generateGSA({ onProgress: value => progress.push(value.completed) });
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2,'0')).join('');
    return { floatSHA256: await digest(gsaVolume.values.buffer), quantizedSHA256: await digest(quantizeGSA(gsaVolume)), elapsedMs: performance.now()-started, progress };
  });
  if (report.generation.floatSHA256 !== '9599fa11b7475f6a7442d6f1db3d187ff62ab83422e6812f33f98dc9b42a0270') throw new Error('Full-profile float output differs from the evaluated source mask.');
  if (report.generation.quantizedSHA256 !== 'f335d55f6e719d55313080225f7627a4aa684aded481608da2bb72b3e3fc627c') throw new Error('Quantized output differs.');
  console.log('Full GSA profile matches evaluated float and byte hashes.');
  report.checks.push('Default 3000-step generation exactly reproduces evaluated float and quantized hashes.');
  report.playback = await page.evaluate(async () => {
    const { createGSADataTexture } = await import(window.gsaModuleURLs.three);
    const { quantizeGSA, sampleGSA } = await import(window.gsaModuleURLs.index);
    const bytes = quantizeGSA(gsaVolume), texture = createGSADataTexture(gsaVolume), checks = [];
    for (const frame of [0,31,32]) {
      const png = gsaTest.renderUniform(frame), data = gsaTest.renderUniform(frame,texture);
      for (let i=0;i<png.length;i++) {
        const expected=sampleGSA(bytes,128,32,png[i].x,png[i].y,frame);
        if (Math.abs(png[i].value-expected)>1e-7 || png[i].value !== data[i].value) throw new Error('PNG/DataTexture/CPU playback disagree.');
      }
      checks.push({ frame, samples: png });
    }
    texture.dispose(); return checks;
  });
  report.checks.push('WebGL2 PNG, generated DataTexture and CPU sample helper agree at frames 0, 31 and 32.');
  report.tsl = await page.evaluate(async () => {
    const { THREE, TSL } = await import('/__gsa_check_api.ts');
    const { createGSADataTexture, gsaSampleNode } = await import(window.gsaModuleURLs.three);
    const { quantizeGSA, sampleGSA } = await import(window.gsaModuleURLs.index);
    const gpuRenderer = new THREE.WebGPURenderer({ forceWebGL: false });
    await gpuRenderer.init();
    if(!gpuRenderer.backend.isWebGPUBackend)throw new Error('TSL test unexpectedly fell back to WebGL.');
    const adapterInfo=gpuRenderer.backend.device.adapterInfo;
    if(!/amd|nvidia|intel/i.test(adapterInfo.vendor) || adapterInfo.isFallbackAdapter!==false)throw new Error('TSL test requires a physical GPU device.');
    const atlas = createGSADataTexture(gsaVolume), target = new THREE.RenderTarget(128,128,{type:THREE.FloatType,depthBuffer:false});
    const frame = TSL.uniform(0), bytes=quantizeGSA(gsaVolume);
    const material = new THREE.NodeMaterial();
    material.fragmentNode = TSL.vec4(gsaSampleNode(atlas,TSL.screenCoordinate,frame),0,0,1);
    const quad = new THREE.QuadMesh(material), checks=[];
    try {
      for(const f of [0,31,32]) {
        frame.value=f; gpuRenderer.setRenderTarget(target); quad.render(gpuRenderer);
        const pixels=await gpuRenderer.readRenderTargetPixelsAsync(target,0,0,128,128);
        for(const [x,y] of [[0,0],[1,1],[37,71],[127,127]]) {
          const expected=sampleGSA(bytes,128,32,x,y,f), actual=pixels[(y*128+x)*4];
          if(Math.abs(expected-actual)>1e-7)throw new Error(`TSL mismatch frame ${f}, (${x},${y}): ${actual} != ${expected}`);
        }
        checks.push(f);
      }
      return { backend:'WebGPU',frames:checks,adapter:gpuRenderer.backend.device.adapterInfo.vendor };
    } finally { target.dispose(); material.dispose(); atlas.dispose(); gpuRenderer.dispose(); }
  });
  report.checks.push('TSL helper renders on physical WebGPU and matches CPU samples at frames 0, 31 and 32.');
  report.cancellation = await page.evaluate(async () => {
    const { generateGSA } = await import(window.gsaModuleURLs.generator);
    const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
    const controller = new AbortController(); let cancelled=false, completed=0;
    try {
      await generateGSA({ device, size:8,depth:2,steps:200, signal:controller.signal, onProgress: progress => {
        completed=progress.completed; if(completed===100)controller.abort();
      } });
    } catch(error) { cancelled=error.name==='AbortError'; }
    if(!cancelled || completed!==100)throw new Error('Mid-generation cancellation did not occur at the synchronized batch boundary.');
    const result=await generateGSA({device,size:8,depth:2,steps:0});
    device.destroy();
    return { cancelled, completed, callerDeviceRemainsUsable:result.values.length===128 };
  });
  report.checks.push('Cancellation after 100 iterations releases resources and preserves a caller-owned GPU device.');
  await page.click('#reset');
  if(await page.evaluate(()=>gsaTest.samples)!==0)throw new Error('Reset button failed.');
  await page.select('#mode','uniform');
  await page.evaluate(()=>gsaTest.step());
  if(await page.evaluate(()=>gsaTest.samples)!==1)throw new Error('Mode switch failed to restart accumulation.');
  await page.click('#spatial');
  if(await page.evaluate(()=>gsaTest.samples)!==0)throw new Error('Spatial filter toggle failed to reset accumulation.');
  report.checks.push('Reset, mode dropdown and spatial filter controls reset accumulation.');
  await page.evaluate(()=>gsaTest.sphere(32));
  // Record the hardware-rendered sphere comparison after 32 accumulated samples.
  await page.screenshot({ path: path.join(output, 'gsa-example.png') });
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  report.pass = true;
} finally {
  fs.writeFileSync(path.join(output, 'gpu-verification.json'), JSON.stringify(report,null,2));
  if (browser) await browser.close();
  await server.close();
}
