"""Independent double-precision geometric references and fixed-protocol scoring.
python scripts/applications/score.py CAPTURE_DIRECTORY
"""
import json, sys
from pathlib import Path
import numpy as np

root=Path(sys.argv[1]); capture=json.loads((root/'capture.json').read_text())
N=128; yy,xx=np.mgrid[:N,:N]; px=(xx+.5-64)/32; py=(yy+.5-64)/32
def ggx_mean(alpha):
    b=1-alpha*alpha
    return 1/b-alpha*alpha*np.arctanh(np.sqrt(b))/(b*np.sqrt(b))
def reference_checks():
    # Quadrature checks closed form without relying on the GPU shader expression.
    # Midpoint integration converges more slowly at the square-root endpoint.
    u=(np.arange(1000000)+.5)/1000000
    numeric=np.mean(np.sqrt((1-u)/(1-(1-.35**2)*u)))
    assert abs(numeric-ggx_mean(.35))<1e-8,(numeric,ggx_mean(.35))
    a=.37
    x=(np.arange(1000000)+.5)/1000000*(1-a)+a
    numeric=np.mean(2*np.sqrt(1-x*x)/np.pi)*(1-a)
    cap=(np.arccos(a)-a*np.sqrt(1-a*a))/np.pi
    assert abs(numeric-cap)<1e-8
    # Exact planar ray midpoint and projected-rectangle intersection.
    # Integrate a deterministic 2048² grid for an off-center receiver.
    s=(np.arange(2048)+.5)/2048*4-2
    hits=(abs((s+.31)*.5)<.6).mean()*(abs((s-.23)*.5)<.45).mean()
    exact=(min(2,1.2-.31)-max(-2,-1.2-.31))*(min(2,.9+.23)-max(-2,-.9+.23))/16
    assert abs(hits-exact)<.001
    return {'ggxMeanZ':ggx_mean(.35),'ggxQuadrature':float(np.mean(np.sqrt((1-u)/(1-(1-.35**2)*u)))),'diskCapExact':float(cap),'diskCapQuadrature':float(numeric),'rectangleGridBlocked':float(hits),'rectangleExactBlocked':float(exact)}
def truth(scene,t):
    x=px-t/32 if scene=='camera-shadow' else px
    ids=((x>.5)&(x<1)).astype(int) if scene=='camera-shadow' else np.zeros_like(xx)
    if scene=='coverage': return .1+.8*(xx+.5)/N,ids
    if scene=='ao-wall':
        d=.1+.8*(xx+.5)/N
        return 1-(np.arccos(d)-d*np.sqrt(1-d*d))/np.pi,ids
    if scene=='ggx-environment': return np.full_like(px,.45+.25*ggx_mean(.35)),ids
    center=.6*np.sin(t*.08) if scene=='moving-shadow' else 0
    # Project blocker x interval [center-.6,center+.6] from receiver through z=2 onto light z=4.
    loX=2*(center-.6)-x; hiX=2*(center+.6)-x
    loY=-.9-py; hiY=.9-py
    area=np.maximum(0,np.minimum(2,hiX)-np.maximum(-2,loX))*np.maximum(0,np.minimum(2,hiY)-np.maximum(-2,loY))
    value=1-area/16
    return np.where(ids==1,.25,value),ids
def spatial(a,name):
    if name=='identity':return a
    kernel=np.array([1,2,1],dtype=float) if name=='binomial-3' else np.exp(-np.arange(-3,4,dtype=float)**2/2)
    kernel/=kernel.sum(); r=len(kernel)//2
    out=a
    for axis in (0,1):
        pad=np.pad(out,((r,r),(0,0)) if axis==0 else ((0,0),(r,r)),mode='edge')
        out=sum(w*(pad[i:i+N,:] if axis==0 else pad[:,i:i+N]) for i,w in enumerate(kernel))
    return out
def rmse(a):return float(np.sqrt(np.mean(a*a)))
results=[]
checks=reference_checks()
for run in capture['runs']:
    raw=np.fromfile(root/run['file'],dtype='<f4').reshape(128,N,N).astype(float)
    assert np.isfinite(raw).all() and raw.min()>=0 and raw.max()<=1
    scene=run['scene']; prev_ids=None
    sums=np.zeros((N,N)); true_sums=sums.copy(); counts=sums.copy(); ema=sums.copy(); true_ema=sums.copy()
    for t in range(128):
        current,ids=truth(scene,t)
        reset=np.full((N,N),t==0)
        if scene=='camera-shadow' and t:
            for a in (sums,true_sums,counts,ema,true_ema): a[:,1:]=a[:,:-1].copy()
            previous=np.empty_like(ids);previous[:,1:]=prev_ids[:,:-1];previous[:,0]=-1
            reset=previous!=ids;reset[:,0]=True
        for a in (sums,true_sums,counts,ema,true_ema):a[reset]=0
        sums+=raw[t];true_sums+=current;counts+=1
        ema=np.where(reset,raw[t],.9*ema+.1*raw[t]);true_ema=np.where(reset,current,.9*true_ema+.1*current)
        prev_ids=ids.copy()
        if t+1 not in capture['protocol']['prefixes']:continue
        for temporal,image,target in [('box',sums/counts,true_sums/counts),('ema-0.1',ema,true_ema)]:
            for filt in capture['protocol']['spatialFilters']:
                filtered=spatial(image,filt); expected=spatial(target,filt); current_filtered=spatial(current,filt)
                row={**{k:run[k] for k in ('method','pair','scene')},'frames':t+1,'temporal':temporal,'spatial':filt,'noiseRMSE':rmse(filtered-expected),'totalRMSE':rmse(filtered-current),'filterBiasRMSE':rmse(current_filtered-current),'temporalBiasRMSE':rmse(expected-current_filtered),'resetPixels':int(reset.sum()),'resetPixelRMSE':rmse((filtered-current)[reset]) if reset.any() else None}
                results.append(row)
                if t+1 in (16,128) and temporal=='box' and filt=='binomial-3':
                    stem=f"{run['method']}-pair{run['pair'][0]}-{scene}-{t+1}"
                    np.savez_compressed(root/(stem+'.npz'),estimate=filtered,truth=current,noise=filtered-expected,error=filtered-current)
    print(run['file'])
(root/'metrics.json').write_text(json.dumps({'protocol':capture['protocol'],'gpu':capture['gpu'],'referenceChecks':checks,'results':results},indent=2))
