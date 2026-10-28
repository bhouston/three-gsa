// node scripts/applications/run.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY
// Inputs: FAST-1.f32 ... FAST-4.f32, GSA-1.f32 ... GSA-4.f32.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(path.resolve('../three.js/package.json'));
const puppeteer = require('puppeteer');
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Expected input and output directories');
fs.mkdirSync(output, {recursive:true});
const protocol = JSON.parse(fs.readFileSync(new URL('../../docs/research/application-protocol.json',import.meta.url)));
const shader = fs.readFileSync(new URL('./samples.wgsl',import.meta.url),'utf8');
const server = http.createServer((req,res)=>res.end('<body>Application quality validation</body>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
const report = {protocol,inputs:{},runs:[]};
try {
 browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-unsafe-webgpu','--use-webgpu-adapter=d3d11','--disable-software-rasterizer','--disable-frame-rate-limit','--disable-gpu-vsync'],protocolTimeout:600000});
 const page = await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 report.gpu = await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();window.adapter=a;return {vendor:a.info.vendor,architecture:a.info.architecture,fallback:a.info.isFallbackAdapter??a.isFallbackAdapter};});
 if(report.gpu.fallback!==false||!/amd|nvidia|intel/i.test(report.gpu.vendor))throw Error('No physical GPU');
 console.log(report.gpu);
 await page.evaluate(async(shader)=>{
  window.device=await window.adapter.requestDevice();
  window.failures=[];device.addEventListener('uncapturederror',e=>failures.push(e.error.message));
  const module=device.createShaderModule({code:shader});
  const info=await module.getCompilationInfo();if(info.messages.some(x=>x.type==='error'))throw Error(JSON.stringify(info.messages));
  window.pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 },shader);
 for(const method of protocol.methods) for(const pair of protocol.seedPairs){
  const inputs=pair.map(seed=>{
   const filename=`${method}-${seed}.f32`;const bytes=fs.readFileSync(path.join(input,filename));if(bytes.length!==128*128*32*4)throw Error(filename+' size');
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const centers=new Float32Array(bytes.length/4);
   for(let i=0;i<centers.length;i++){const value=view.getFloat32(i*4,true);if(!Number.isFinite(value)||value<0||value>1)throw Error(filename+' invalid value');centers[i]=(Math.min(255,Math.floor(value*256))+.5)/256;}
   const quantized=Buffer.from(centers.buffer);
   report.inputs[filename]={sourceSHA256:createHash('sha256').update(bytes).digest('hex'),quantizedSHA256:createHash('sha256').update(quantized).digest('hex')};
   return quantized.toString('base64');
  });
  for(let scene=0;scene<protocol.cases.length;scene++){
   const encoded=await page.evaluate(async({inputs,scene})=>{
    const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    const buffers=inputs.map(s=>{const bytes=decode(s);const b=device.createBuffer({size:bytes.length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,bytes);return b;});
    const size=128*128*128*4;
    const result=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const read=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const config=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(config,0,new Uint32Array([scene,0,0,0]));
    const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...buffers.map((b,i)=>({binding:i,resource:{buffer:b}})),{binding:2,resource:{buffer:result}},{binding:3,resource:{buffer:config}}]});
    const e=device.createCommandEncoder();const pass=e.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(256,128);pass.end();e.copyBufferToBuffer(result,0,read,0,size);device.queue.submit([e.finish()]);await device.queue.onSubmittedWorkDone();await read.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(read.getMappedRange());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));const encoded=btoa(text);read.unmap();for(const b of [...buffers,result,read,config])b.destroy();if(failures.length)throw Error(failures.join('\n'));return encoded;
   },{inputs,scene});
   const name=`${method}-pair${pair[0]}-${protocol.cases[scene]}`;
   fs.writeFileSync(path.join(output,name+'.f32'),Buffer.from(encoded,'base64'));report.runs.push({method,pair,scene:protocol.cases[scene],file:name+'.f32'});console.log(name);
  }
 }
 fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
