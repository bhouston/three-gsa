# Third-party notices

The generator's filter kernel, swap loss, hash functions, suppression rule and WebGPU
implementation are derived from the FAST generator by Electronic Arts and the
Three.js research port in [bhouston/three.js PR 115](https://github.com/bhouston/three.js/pull/115).
EA FAST is copyright 2023 Electronic Arts Inc., BSD-3-Clause; its complete license
is included in `LICENSE-FAST.txt`. See [EA's FAST repository](https://github.com/electronicarts/fastnoise).

GSA adds per-pixel temporal stratification, time-only exchange partners, a modified
scalar distance and mixed filter objective, a suppression floor and a finite annealing
schedule. These extensions do not imply invention of stratification or simulated annealing.

The Three.js-derived code and integration are MIT licensed. Three.js is copyright
2010–2026 three.js authors. The full MIT text is reproduced below:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
