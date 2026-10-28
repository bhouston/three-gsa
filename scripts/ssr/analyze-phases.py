"""Preserve the initial diagnostic and analyze its predeclared 32-phase extension."""
import json
import hashlib
import pathlib
import sys
import numpy as np

root = pathlib.Path(sys.argv[1])
size = 128
truth = np.fromfile(root / 'reference-4096.f32', dtype='<f4').reshape(size, size, 3).astype(np.float64)
phase_run = json.loads((root / 'ssr-phases-run.json').read_text())
reference_hash = hashlib.sha256((root / 'reference-4096.f32').read_bytes()).hexdigest()
if phase_run['referenceSha256'] != reference_hash:
    raise ValueError('Reference changed since the phase extension')


def blur(pixels):
    padded = np.pad(pixels, ((1, 1), (1, 1), (0, 0)), mode='edge')
    result = np.zeros_like(pixels)
    for y, wy in enumerate([1, 2, 1]):
        for x, wx in enumerate([1, 2, 1]):
            result += wy * wx * padded[y:y + size, x:x + size] / 16
    return result


prefixes = [1, 4, 16, 32, 64, 128]
errors = {}
reproduction = []
for method in ['fast', 'gsa']:
    frames = np.fromfile(root / f'{method}-frames-0-158.f32', dtype='<f4').reshape(159, size, size, 3)
    if not np.isfinite(frames).all() or not np.any(frames):
        raise ValueError('Invalid phase-extension GPU readback')
    sums = np.concatenate([np.zeros((1, size, size, 3)), frames.cumsum(axis=0, dtype=np.float64)], axis=0)
    for n in prefixes:
        phase_zero = sums[n] / n
        old = np.fromfile(root / f'{method}-{n}.f32', dtype='<f4').reshape(size, size, 3)
        reproduction.append({'method': method, 'frames': n, 'max_absolute_difference': float(np.max(np.abs(phase_zero - old)))})
        if not np.allclose(phase_zero, old, atol=2e-7, rtol=0):
            raise ValueError(f'{method} frame capture did not reproduce phase-zero {n}-frame image: {np.max(np.abs(phase_zero-old))}')
        for phase in range(32):
            image = (sums[phase + n] - sums[phase]) / n
            for filter_name, transform in [('raw', lambda x: x), ('binomial3', blur)]:
                delta = transform(image) - transform(truth)
                for region, roi in [('all', np.s_[:, :, :]), ('lower-half', np.s_[64:, :, :])]:
                    errors.setdefault((filter_name, region, n), {}).setdefault(method, []).append(float(np.mean(delta[roi] ** 2)))

report = {'description': 'Post-primary phase-coverage extension, frozen before its results; original 24 phase-zero metrics remain in ssr-metrics.json.', 'starting_phases': 32, 'reference_sha256': reference_hash, 'phase_zero_reproduction_tolerance': 2e-7, 'phase_zero_reproduction': reproduction, 'metrics': []}
for (filter_name, region, frames), methods in errors.items():
    fast = np.sqrt(methods['fast'])
    gsa = np.sqrt(methods['gsa'])
    change = (gsa / fast - 1) * 100
    a = float(np.sqrt(np.mean(methods['fast'])))
    b = float(np.sqrt(np.mean(methods['gsa'])))
    report['metrics'].append({'filter': filter_name, 'region': region, 'frames': frames,
        'fast_rmse': a, 'gsa_rmse': b, 'relative_change_percent': (b / a - 1) * 100,
        'phase_improvements': int(np.sum(gsa < fast - 1e-12)), 'phase_regressions': int(np.sum(gsa > fast + 1e-12)),
        'min_phase_change_percent': float(change.min()), 'max_phase_change_percent': float(change.max()),
        'per_phase': [{'phase': p, 'fast_rmse': float(fast[p]), 'gsa_rmse': float(gsa[p]), 'relative_change_percent': float(change[p])} for p in range(32)]})
report['improvements'] = sum(row['relative_change_percent'] < 0 for row in report['metrics'])
report['regressions'] = sum(row['relative_change_percent'] > 0 for row in report['metrics'])
(root / 'ssr-phases-metrics.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'metrics'}, indent=2))
for row in report['metrics']:
    if row['region'] == 'all':
        print(row['filter'], row['frames'], round(row['relative_change_percent'], 3), row['phase_improvements'], row['phase_regressions'])
