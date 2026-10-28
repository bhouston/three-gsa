# three-gsa

**GSA — GPU Stratified Annealing** is a new blue-noise sampling method and
TypeScript library for Three.js. It combines per-pixel temporal stratification
with filter-aware GPU optimization, keeping noise easier to remove with spatial
and temporal reconstruction.

Compared with the 10,000-step FAST Separate reference, GSA generates its mask
**1.99× faster** and produces lower error in **262 of 318 measured diagnostics**
on each of two seeds. It improves every original spatial/temporal diagnostic.
The full comparison below includes the 53 regressions and three ties per seed.

| Measurement | GSA result versus FAST Separate |
| --- | --- |
| Construction, seed 1 | 30.720 s vs 61.233 s — **1.993× faster** |
| Construction, seed 2 | 30.756 s vs 61.339 s — **1.994× faster** |
| Blurred 32-frame scalar integration RMSE | **22.8% lower** |
| Blurred 32-frame threshold-at-.5 RMSE | **25.5% lower** |
| Blurred 32-frame squared-integrand RMSE | **20.0% lower** |
| Blurred 32-frame fourth-power RMSE | **14.7% lower** |
| Median relative change across 318 diagnostics, seed 1 | **5.6% lower** |
| Largest regression | **7.03% higher**: single-frame blurred high-frequency sine |

The quality rows use the same 128×128×32 masks, 8-bit midpoint decoding, all 32
starting phases and identical filters. Construction compares GSA's 3,000-step
profile with FAST's 10,000-step profile on a physical AMD GCN-5 GPU; each timed
run completes its GPU readback before the next begins.

![Spatial and temporal convergence, with aligned spread and all-phase RMSE](docs/research/gsa-convergence.png)

![All 318 measured improvements and regressions, both seeds](docs/research/gsa-audit.png)

![Representative improvements and the specific cases favoring FAST](docs/research/gsa-tradeoffs.png)

These measurements favor GSA for temporally accumulated scalar sampling. FAST
retains an advantage on several single-frame, high-frequency transforms:
`sin(14*pi*u)`, `cos(16*pi*u)`, and the tested .83 threshold at 16 frames.
See [the reproducible evidence](docs/research/README.md) for the exact inputs,
filters, timing records and complete measurements.

![Standalone example on a physical AMD GPU: white noise left, GSA right](docs/research/standalone-example.png)

## Run the example

Requires Node.js 22+ and pnpm 11. The packages are source code in this repository;
no npm publication or hosted deployment is assumed.

```powershell
pnpm install
pnpm dev
```

Open the local URL printed by Vite. The example loads the evaluated 516 KiB
grayscale PNG by default and compares white noise with GSA using the same visibility
function, spatial filter and temporal accumulation. Use Reset to start from frame
one. A scalar-field view and filter toggles are available. Its interactive spatial
filter is a 3×3 binomial blur, **different from** the benchmark's sigma-1 Gaussian;
use the research scripts for the published measurements.

The optional **Generate a new GSA mask** button uses hardware WebGPU in a secure
context (localhost qualifies). Generation takes seconds to tens of seconds and
reports progress; it is not performed during startup or every frame. The example
renders with WebGL2 and continues showing the existing mask while generation runs.

## Library

The workspace has a library in `packages/three-gsa` and a Vite example in
`packages/example`. The generator is a separate import so applications using a
precomputed PNG do not need its optimizer code.

```ts
import { generateGSA } from 'three-gsa/generator';
import { createGSADataTexture } from 'three-gsa/three';

const controller = new AbortController();
const volume = await generateGSA({
  // Evaluated defaults: 128×128×32, seed 1, 3000 iterations.
  signal: controller.signal,
  onProgress: ({ completed, total }) => console.log(completed / total),
});
const atlas = createGSADataTexture(volume);
// Dispose atlas when no longer used.
```

`generateGSA` returns `{ size, depth, values: Float32Array }` in z/y/x order.
It optionally accepts an existing `GPUDevice`, which remains owned by the caller.
Otherwise it requests a hardware adapter and destroys its device after completion.
Buffers are released on success, failure or cancellation. Cancellation is checked
between synchronized 100-iteration batches. Defaults preserve the evaluated method;
smaller power-of-two dimensions and other iteration counts have not been quality
validated by the published benchmark.

For TSL with a precomputed PNG:

```ts
import { TextureLoader, NoColorSpace, NearestFilter } from 'three';
import { uniform, screenCoordinate } from 'three/tsl';
import { gsaSampleNode } from 'three-gsa/three';

const atlas = await new TextureLoader().loadAsync('/noise/gsa.png');
atlas.flipY = false;
atlas.colorSpace = NoColorSpace;
atlas.minFilter = atlas.magFilter = NearestFilter;
atlas.generateMipmaps = false;
atlas.needsUpdate = true;
const frame = uniform(0); // increment once per rendered sample, reset to zero
const scalar = gsaSampleNode(atlas, screenCoordinate, frame);
```

`gsaSamplingGLSL` provides equivalent GLSL 3 playback for WebGL2; the example uses it.
The dependency-free root entry provides `quantizeGSA`, `atlasIndex`, and `sampleGSA`
for CPU use. Encoded samples are decoded at byte-stratum midpoints:
`(byte + 0.5) / 256`. After each 32-frame stack the default playback shifts the
pixel coordinates by `(37, 71)`, matching the benchmark. Changing playback changes
the measured properties.

The default mask is a **single scalar** per pixel per frame. Do not reuse the same
value for every dimension of a path tracer. Motion, reprojection, disocclusions,
multidimensional sampling and production SSR remain application-level validation
work. Temporal stratification gives strong complete-stack behavior, but does not
guarantee every arbitrary prefix, pixel trajectory or filter will improve.

## Checks

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Unit tests cover byte decoding, cycle addressing, malformed inputs, cancellation
before GPU access and the committed PNG's hash and temporal stratification.
Browser GPU validation requires a physical GPU; software adapters are not accepted
as rendering-quality evidence.

```powershell
node scripts/verify-gpu.mjs ../three.js ../gpu-check-results
```

This optional check reuses an existing Three.js checkout's Puppeteer installation
and installed Chrome (`CHROME_PATH` can override the executable). It starts and
stops its own local Vite server and browser. It validates actual WebGL2 PNG and
DataTexture playback, TSL/WebGPU readback, mid-generation cancellation, controls,
and the complete default generation against the evaluated mask's SHA-256 hashes.
The recorded reference hash was reproduced on AMD GCN 5/D3D11; floating-point GPU
optimization is not promised to be byte-identical across different adapters.

## Origins and license

This variant was found through AI-assisted exploration and evaluation during the
Three.js noise experiments in [PR 116](https://github.com/bhouston/three.js/pull/116),
building on [PR 115](https://github.com/bhouston/three.js/pull/115) and EA FAST.
Stratification, annealing and filter-based noise objectives are established ideas;
the contribution here is this combination of constraints, objective and schedule.

New code is MIT licensed. FAST-derived portions retain EA's BSD-3-Clause license.
See [third-party notices](packages/three-gsa/THIRD_PARTY_NOTICES.md) and the included
license files. The precomputed PNG's source profile and hashes are recorded beside
it in `packages/example/public/noise/source-manifest.json`.
