@group(0) @binding(0) var<storage,read> maskU:array<f32>;
@group(0) @binding(1) var<storage,read> maskV:array<f32>;
@group(0) @binding(2) var<storage,read_write> output:array<f32>;
@group(0) @binding(3) var<uniform> config:vec4u;
fn sampleIndex(x:u32,y:u32,t:u32)->u32{return (t%32u)*16384u+((y+71u*(t/32u))%128u)*128u+(x+37u*(t/32u))%128u;}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let p=id.x;let t=id.y;if(p>=16384u||t>=128u){return;}
 let x=p%128u;let y=p/128u;let k=sampleIndex(x,y,t);let u=maskU[k];let v=maskV[k];
 let scene=config.x;
 var px=(f32(x)+0.5-64.0)/32.0;let py=(f32(y)+0.5-64.0)/32.0;
 if(scene==4u){px-=f32(t)/32.0;}
 var value=0.0;
 if(scene==0u){let coverage=0.1+0.8*(f32(x)+0.5)/128.0;value=select(0.0,1.0,u<coverage);}
 else if(scene==2u){
  // Cosine hemisphere direction: projected disk is uniform. Wall at distance d.
  let radius=sqrt(u);let dx=radius*cos(6.283185307179586*v);
  let d=0.1+0.8*(f32(x)+0.5)/128.0;
  value=select(1.0,0.0,dx>d);
 }else if(scene==3u){
  let alpha=0.35;let z=sqrt((1.0-u)/(1.0+(alpha*alpha-1.0)*u));let phi=6.283185307179586*v;
  value=0.45+0.25*z+0.2*cos(2.0*phi+px*0.7+py*0.3);
 }else{
  // Receiver z=0, area light z=4 with x/y in [-2,2]. Blocker z=2.
  let lx=4.0*u-2.0;let ly=4.0*v-2.0;
  let bx=0.5*(px+lx);let by=0.5*(py+ly);
  var center=0.0;if(scene==5u){center=0.6*sin(f32(t)*0.08);}
  value=select(1.0,0.0,abs(bx-center)<0.6&&abs(by)<0.45);
  // Foreground object crossing: separate object ID, constant analytic radiance.
  if(scene==4u&&px>0.5&&px<1.0){value=0.25;}
 }
 output[t*16384u+p]=value;
}
