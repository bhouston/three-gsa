"""Numerically check the actual periodic filter spectrum, not all possible filters.
Run after pnpm build: python scripts/kernel-spectrum.py OUTPUT_JSON
Requires NumPy. Node reads the built library kernel directly.
"""
import json
from pathlib import Path
import subprocess
import sys
import numpy as np

root = Path(__file__).resolve().parents[1]
source = "import {createKernel} from './packages/three-gsa/dist/kernel.js';console.log(JSON.stringify([2,4,8,16,32,64,128].map(depth=>{const k=createKernel(depth);return {depth,fs:k.fs,weights:Array.from(k.weights)};})));"
kernels = json.loads(subprocess.run(['node', '--input-type=module', '-e', source], cwd=root, check=True, capture_output=True, text=True).stdout)
rows = []
for k in kernels:
    depth, radius = k['depth'], k['fs']
    w = np.array(k['weights']).reshape(2*radius+1, 2*radius+1, depth)
    for size in (8, 32, 128):
        periodic = np.zeros((size, size, depth))
        for i in range(-radius, radius+1):
            for j in range(-radius, radius+1):
                periodic[i % size, j % size, :] += w[i+radius, j+radius, :]
        spectrum = np.fft.fftn(periodic)
        tolerance = 128 * np.finfo(float).eps * np.abs(periodic).sum()
        rows.append({'size':size, 'depth':depth, 'minimumRealEigenvalue':float(spectrum.real.min()),
                     'maximumImaginaryResidual':float(np.abs(spectrum.imag).max()),
                     'tolerance':float(tolerance), 'nonnegativeWithinTolerance':bool(spectrum.real.min() >= -tolerance)})
report = {'method':'Eigenvalues of the circular convolution matrix are the DFT of its first column. Actual float32 GSA coefficients are embedded on each periodic grid; duplicate taps are added on small grids.',
          'scope':'Finite numerical check for the listed grids and implemented kernel, not a guarantee for arbitrary future mixtures.', 'rows':rows}
Path(sys.argv[1]).write_text(json.dumps(report, indent=2)+'\n')
default = next(r for r in rows if r['size']==128 and r['depth']==32)
print('Default spectrum:',default)
print('Negative spectra:',sum(not r['nonnegativeWithinTolerance'] for r in rows),'/',len(rows))
