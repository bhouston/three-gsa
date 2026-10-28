"""Compute every frozen SSR metric; requires NumPy, accepts run output directory."""
import json
import pathlib
import sys
import numpy as np

root = pathlib.Path(sys.argv[1])
size = 128


def load(name, frames):
    pixels = np.fromfile(root / f'{name}-{frames}.f32', dtype='<f4').reshape(size, size, 3).astype(np.float64)
    if not np.isfinite(pixels).all():
        raise ValueError('Nonfinite readback')
    return pixels


def blur(pixels):
    padded = np.pad(pixels, ((1, 1), (1, 1), (0, 0)), mode='edge')
    result = np.zeros_like(pixels)
    for y, wy in enumerate([1, 2, 1]):
        for x, wx in enumerate([1, 2, 1]):
            result += wy * wx * padded[y:y + size, x:x + size] / 16
    return result


truth = load('reference', 4096)
half = load('reference', 2048)
report = {'reference': {}, 'metrics': [], 'note': 'Floor ROI is bottom half in GPU readback coordinates; SSR reflection output only, static unoccluded camera, independent PCG reference.'}
for filter_name, transform in [('raw', lambda x: x), ('binomial3', blur)]:
    target = transform(truth)
    for region, roi in [('all', np.s_[:, :, :]), ('floor-half', np.s_[:64, :, :])]:
        key = f'{filter_name}/{region}'
        rmse = lambda image: float(np.sqrt(np.mean((image[roi] - target[roi]) ** 2)))
        report['reference'][key] = {'half_to_full_rmse': rmse(transform(half)), 'mean_reference': float(target[roi].mean())}
        for frames in [1, 4, 16, 32, 64, 128]:
            a = rmse(transform(load('fast', frames)))
            b = rmse(transform(load('gsa', frames)))
            report['metrics'].append({'filter': filter_name, 'region': region, 'frames': frames, 'fast_rmse': a, 'gsa_rmse': b, 'relative_change_percent': (b / a - 1) * 100})
report['improvements'] = sum(row['relative_change_percent'] < -1e-10 for row in report['metrics'])
report['regressions'] = sum(row['relative_change_percent'] > 1e-10 for row in report['metrics'])
(root / 'ssr-metrics.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'improvements': report['improvements'], 'regressions': report['regressions'], 'reference': report['reference']}, indent=2))
