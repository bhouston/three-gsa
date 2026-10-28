# Evidence and reproduction

GSA (GPU Stratified Annealing) is the profile implemented
by this repository. It is derived from EA FAST and the Three.js research port;
stratification and simulated annealing are established methods, not inventions of
this project. See the package's third-party notices and FAST BSD-3-Clause license.

The search started while exploring noise for Three.js screen-space reflections.
The approximately 3 MB packed noise atlas motivated a search for cheaper
construction and a smaller scalar payload. AI agents proposed, implemented and
evaluated alternatives. A raw-scalar cancellation false lead prompted broader
transformed-function and phase-aware tests. The resulting profile improves most measured diagnostics, and added application
checks establish both useful rendering gains and specific losses.

## Evaluated profile

- 128×128 pixels, 32 temporal slices, seeds 1 and 2.
- One independently jittered value in each temporal stratum at every pixel.
- Swaps restricted to temporal positions within the same pixel, preserving its
  complete sample multiset. This differs from FAST's per-slice stratification.
- Distance `-abs(a-b) - .25*(a-b)^2`.
- 80% separate spatial/temporal kernel plus 20% radius-two truncated product term.
- Acceptance suppression floor 2; temperature .001 decreases to zero over the
  first 1,500 iterations, followed by 1,500 greedy iterations.

The implemented combined Float32 kernel has positive convolution eigenvalues on
all 21 tested periodic grids (sizes 8, 32, 128; depths 2–128). The default grid
minimum is 0.138983. [kernel-spectrum.json](kernel-spectrum.json) records the full
check; `scripts/kernel-spectrum.py` recomputes it using the actual library taps.
Simultaneous accepted swaps do not guarantee global descent. The short run and
the constraints work well on the measured tasks; a different renderer, function,
filter or playback pattern can change the outcome.

## Fresh sequential construction timing

Physical AMD Radeon GCN-5, Chrome/WebGPU D3D11, fallback=false. Warmups (FAST 1,000
steps and GSA 300) were excluded. Full workloads ran sequentially, with vsync and
frame caps disabled and no other intentional GPU work. Each measurement counts
one GPU-completed volume, including navigation, adapter/device setup, pipeline
construction, compute, mapped GPU readback and transfer to the driver script.

| Seed | FAST Separate, 10,000 steps | GSA, 3,000 steps | Speed ratio |
| --- | --- | --- | --- |
| 1 | 61.233 s | 30.720 s | 1.993× |
| 2 | 61.339 s | 30.756 s | 1.994× |

These are two completed-volume trials of different configurations and quality
points, not matched-quality budgets, statistical significance or rendering FPS.
Both references and GSA outputs reproduce their historical Float32 hashes. Exact
settings, logs and hashes are in [generation-benchmark.json](generation-benchmark.json).
The extraction into the standalone library is additionally checked against the
same full-size output hash by the hardware validator.

GSA still takes tens of seconds. The example loads a precomputed 528,557-byte
grayscale PNG rather than optimizing during startup. The older 3,025,821-byte
FAST atlas stores additional distributions/components; this is a scalar payload
choice, not equivalent-content compression. Both generators ultimately produce
textures, so construction speed does not imply faster sample lookup.

## Filtering and convergence

![Scalar convergence with aligned spread and all-phase RMSE](gsa-convergence.png)

Measurements include 1, 2, 4, 8, 16, 32, 128, 256, 512 and 1,024 frames. The left
panel is spatial standard deviation from a phase-zero running average; the right
includes bias by measuring RMSE against the known mean .5 over all 32 starting
phases. Both use wrapped sigma-1 Gaussian filtering with radius 3. Frozen masks
use the `(37,71)` cycle shift; white noise gets fresh values each frame. This is
the identity integrand, not a scene or multidimensional sampling comparison.

At 32 frames the all-phase blurred identity RMSE is 22.83% lower than FAST; at
1,024 it is 23.52% lower. The larger 60% aligned **raw** scalar spread improvement
in the original study does not generalize to arbitrary starting windows: cycle
shifts can cross spatial columns and weaken the temporal stratification benefit.

## Broader improvements and regressions

![Ten original metrics on both seeds](gsa-legacy-metrics.png)

![All 318 correlated development diagnostics](gsa-audit.png)

All ten original diagnostics improve on both tested seeds. The broader suite
uses 22 known-integral functions, raw and spatially blurred errors, six finite
windows and one EMA result, and every starting phase. Inputs are quantized to
8-bit bin centers before scoring. Each seed has **262 improvements, 53
regressions and three ties**, with absolute tie tolerance 1e-12. Seed 1's median
relative change is 5.6% lower. Counts are not independent statistical trials.

![Representative gains and explicit losses](gsa-tradeoffs.png)

At 32 frames with blur, representative seed-1 RMSE reductions are identity 23%,
threshold .5 26%, square 20% and fourth power 15%. Worst losses are blurred
single-frame `sin(14*pi*u)` (+6.77%/+7.03% for seeds 1/2) and `cos(16*pi*u)`
(+6.55%/+6.66%). Threshold .83 after 16 blurred frames regresses about 3.8% on seed
1. Full provenance and chart values are in [gsa-chart-data.json](gsa-chart-data.json).

## Application validation

![All 432 matched total-image error comparisons](gsa-applications.png)

The premeasurement [application protocol](application-protocol.json) adds six
geometric workloads, two independent seed pairs (1/2 and 3/4), six prefixes
(1,4,16,32,64,128), running-average and EMA(.1) histories, and raw/binomial3/
Gaussian-sigma1 reconstruction. [applications.json](applications.json) retains
all 864 method rows, analytic history error, current-image total error, filter
bias, history lag and reset-pixel diagnostics. [application-capture.json](application-capture.json)
records adapter and input hashes. All quality inputs use 8-bit midpoints.
Total RMSE comparisons, including lag and filter bias: **270 lower, 162 higher**.
Bias-only diagnostics are identical for both masks and are not counted as gains.

Coverage, finite-distance wall AO and the GGX-normal environment probe favor GSA
in their median comparisons. Rectangular area-light shadows, a moving blocker and
exact integer camera/parallax reprojection favor FAST slightly in their median
comparisons. The GGX probe is separable. Analytic geometric references independently
provide the expected signal. Algorithm parameters were fixed before measurement.

![Actual Three.js SSR over all 32 start phases](gsa-ssr.png)

See [SSR.md](SSR.md) for the complete rendered-scene protocol, 22/24 gains, two
single-frame losses, reference convergence, explicit lifecycle assertions and
GPU-completed throughput measurements. Every requested sample advances actual
SSR state; independent captures reproduce direct cumulative images within 2.98e-8.
The four-mask test evaluates coupled dimensions in the actual Three.js SSRNode.

These application tests were added after choosing GSA's configuration. Correlated
filters, regions and frame counts measure robustness rather than independent
statistical trials. They establish concrete workload choices for the tested
scenes, filters and histories.

## Hardware animation

![Actual Three.js example: white left, GSA right](convergence.gif)

Fourteen selected captures from 1 through 128 accumulated samples of the original
Three.js sphere example. Both halves receive the same filtering. Frames come
from physical GPU canvas readback; the captioned GIF is accelerated and is not an
FPS or construction benchmark. The capture explicitly advances NodeFrame for
every manual sample, refreshing FRAME-scoped filter nodes before readback. [capture.json](capture.json) records the adapter,
viewport, filters and sample counts.

## Reproduce

The library/example need only their pnpm workspace. Research figures and the
original Three.js capture additionally use the pinned research checkout and
Python. All source reads use git-dedup. With `bhouston/three.js` checked out at
`bf8053703d208df3354256733d63c0506ef71c0f`, and PR117 commit
`2a065526980261bcf5b129f07ddb12ff7eda1f91` available locally:

```powershell
python -m pip install -r docs/research/requirements.txt
python docs/research/build-charts.py /path/to/three.js docs/research
node scripts/capture-three-example.mjs /path/to/three.js /path/to/capture
python scripts/build-gif.py /path/to/capture docs/research/convergence.gif
node /path/to/three.js/utils/fastnoise/experiments/run-gpu.js /path/to/benchmark docs/research/benchmark-plan.json
```

The capture and GPU runners default to installed Windows Chrome with D3D11 and
disable software rasterization. Other platforms need a verified hardware backend;
do not use SwiftShader, llvmpipe or lavapipe as validation substitutes. Capturing
the original example requires its installed Puppeteer dependency and build files.
SVG and PNG charts use Matplotlib's 2D raster/vector backend, not GPU rendering.
The chart script validates key values against the pinned audit to 1e-12.

The fresh timing runner's output can be compared with the committed record; it
does not automatically overwrite or statistically validate these two trials.

## Sources

- [Original exploration and common-protocol audit](https://github.com/bhouston/three.js/pull/116).
- [EA FAST source](https://github.com/electronicarts/fastnoise) and
  [FAST paper](https://arxiv.org/abs/2310.15364).
- [Scalar Spatiotemporal Blue Noise Masks](https://arxiv.org/abs/2112.09629).
- [Belcour–Heitz screen-space sampling study](https://belcour.github.io/blog/supp/2021-sampling-bluenoise/).

## Reproduce the added checks

Build the library first; use the Python requirements above. Input preparation
extracts seed 1 from the pinned PNGs and generates seeds 2–4 with frozen profiles.
Allow several minutes on the measured GPU. Generated Float32 volumes remain
outside source control. Both runners close their browsers and servers.

```powershell
node scripts/prepare-application-inputs.mjs /path/to/three.js /path/to/inputs --generate
node scripts/applications/run.mjs /path/to/inputs /path/to/applications
python scripts/applications/score.py /path/to/applications
$env:SSR_ADAPTER = 'd3d12'
node scripts/ssr/run.mjs /path/to/three.js /path/to/inputs /path/to/ssr
python scripts/ssr/analyze.py /path/to/ssr
node scripts/ssr/run.mjs /path/to/three.js /path/to/inputs /path/to/ssr --phases-only
python scripts/ssr/analyze-phases.py /path/to/ssr
python scripts/kernel-spectrum.py docs/research/kernel-spectrum.json
python docs/research/build-application-chart.py
python scripts/ssr/plot.py
```

The application runner expects its installed Three.js/Puppeteer checkout at
`../three.js` relative to the working directory. D3D11 handles the geometric
compute test; actual SSR requires hardware D3D12 on this machine.
