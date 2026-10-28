# three-gsa

**GSA — GPU Stratified Annealing** is an experimental scalar sampling mask generator
and playback library for Three.js. It combines a per-pixel temporal Latin hypercube
with FAST-derived GPU swap optimization, a mixed filter objective and a finite
simulated-annealing schedule.

The evaluated profile improves most of our scalar filtering diagnostics over FAST
Separate, with measured regressions on others. It is not a claim of a universally
better blue-noise sampler or a new state of the art. See [the research report](docs/research/README.md)
for the benchmark, provenance, timings and tradeoffs.

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

## Origins and license

This variant was found through AI-assisted exploration and evaluation during the
Three.js noise experiments in [PR 116](https://github.com/bhouston/three.js/pull/116),
building on [PR 115](https://github.com/bhouston/three.js/pull/115) and EA FAST.
Stratification, annealing and filter-based noise objectives are established ideas;
the contribution here is an evaluated experimental combination and implementation.

New code is MIT licensed. FAST-derived portions retain EA's BSD-3-Clause license.
See [third-party notices](packages/three-gsa/THIRD_PARTY_NOTICES.md) and the included
license files. The precomputed PNG's source profile and hashes are recorded beside
it in `packages/example/public/noise/source-manifest.json`.
