# Actual Three.js SSR validation

GSA reduces error in **22 of 24 phase-averaged comparisons** in this fixed
stochastic screen-space reflection scene. The two regressions are single-frame
SSR after a 3×3 binomial filter: **0.41%** higher RMSE over all pixels and **0.45%**
over the lower-half image ROI. Unfiltered single-frame RMSE improves by 0.80%.

![Actual SSR convergence and every phase-averaged comparison](gsa-ssr.png)

| Accumulated samples | Unfiltered RMSE change | Filtered RMSE change |
| --- | ---: | ---: |
| 1 | −0.80% | +0.41% |
| 4 | −1.20% | −2.13% |
| 16 | −0.90% | −4.12% |
| 32 | −2.51% | −8.38% |
| 64 | −4.48% | −9.60% |
| 128 | −6.19% | −10.70% |

The table covers all pixels; the chart includes both image regions and both
filters. At 64 and 128 samples, GSA improves on FAST for **every one of the 32
starting phases**, with and without filtering, in both image regions. These
results support using GSA for temporally accumulated SSR in this scene. FAST
retains a small advantage for its spatially filtered, single-frame output.

The scene has three metallic floor strips with roughness 0.12, 0.3 and 0.65 and
three colored boxes. It runs the actual Three.js `SSRNode`, including GGX rays,
ray-march jitter, hit testing and sample weighting. Four separately generated
scalar masks, seeds 1–4, supply its four noise coordinates. Both samplers use
8-bit bin-center decoding and the same 32-frame cycle addressing. The shader is
unchanged apart from a localhost-only noise-source replacement. Mirror bias and
environment importance sampling are disabled. Spatial filtering is applied
identically to the sampled image and its reference.

The reference is a separate 4,096-sample integer-PCG SSR estimate, rather than
either candidate sampler. Its 2,048-to-4,096-sample change has RMSE 0.001164 raw
and 0.000598 filtered over all pixels. It measures convergence to this SSR
algorithm's expected output, rather than to a physically complete path tracer.
This is one static scene and camera, with no recurrent denoiser or environment
MIS; motion and history rejection are evaluated separately in the geometric
application suite. The 24 comparisons are correlated measurements, not 24
independent trials.

## Runtime

Actual SSR rendering, including the scene pass, was measured sequentially on the
physical AMD GCN-5 adapter with the D3D12 WebGPU backend requested. Each window
uses at least one second of warmup and three seconds of GPU-completed work,
counted in batches of 16 with queues drained between methods. Vsync and frame
caps are disabled. No GPU readback occurs in the timed interval.

| Order | FAST completed frames / seconds | GSA completed frames / seconds | FAST FPS | GSA FPS |
| --- | ---: | ---: | ---: | ---: |
| FAST then GSA | 6,640 / 3.0022 | 6,672 / 3.0021 | 2,211.71 | 2,222.44 |
| GSA then FAST | 6,656 / 3.0000 | 6,624 / 3.0009 | 2,218.67 | 2,207.34 |

The approximately ±0.5% differences reverse with order: **no consistent rendering
speed advantage is measured**. These are 128×128 benchmark rates, not interactive
high-resolution FPS. Faster mask construction is a separate measurement.
This harness's SSR fragment pipeline failed D3D11 FXC compilation on this machine;
the hardware D3D12 run succeeded. That failure is not a GSA generation result.

## Validation and reproduction

The [protocol](ssr-protocol.json) was fixed before the measurements. Starting-phase
coverage was added afterward without tuning the masks, scene or shader. The
original 24 phase-zero measurements remain in [ssr-metrics.json](ssr-metrics.json);
all improve. The broader [32-phase measurements](ssr-phases-metrics.json) preserve
per-phase values, every regression and the capture-reproduction checks.

Every manual render explicitly advances Three.js's `NodeFrame` and asserts that
`SSRNode` advanced its sample index exactly once. The
[full run](ssr-run.json) records 4,096 actual reference updates and 128 updates per
candidate; the [phase capture](ssr-phases-run.json) records 318 requested and
318 completed SSR updates. Twelve reconstructed phase-zero averages reproduce
the independently captured direct averages within 2.98e-8. A full reference
replay reproduces SHA-256
`fc7f44f53e67cbb7de8484d8736cce80db402f55332815cb61a3888256a923a3`.
An earlier harness attempt was rejected by this reproduction check and is excluded
from the published data.

```powershell
$env:SSR_ADAPTER = 'd3d12'
node scripts/ssr/run.mjs ../three.js INPUT_DIRECTORY OUTPUT_DIRECTORY
node scripts/ssr/run.mjs ../three.js INPUT_DIRECTORY OUTPUT_DIRECTORY --phases-only
python scripts/ssr/analyze.py OUTPUT_DIRECTORY
python scripts/ssr/analyze-phases.py OUTPUT_DIRECTORY
python scripts/ssr/plot.py OUTPUT_DIRECTORY docs/research
```

Inputs are `FAST-1.f32` through `FAST-4.f32` and `GSA-1.f32` through `GSA-4.f32`,
128×128×32 Float32 volumes. Their hashes, the tested SSR source hash, hardware
adapter details, lifecycle counts and raw runtime windows are recorded in the run
JSON files. The runner uses the existing Three.js checkout's Puppeteer dependency
and installed Chrome. The chart alone rebuilds from committed JSON with:

```powershell
python scripts/ssr/plot.py
```
