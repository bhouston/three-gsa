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
report = {'reference': {}, 'metrics': [], 'note': 'Lower-half image ROI is rows 64 through 127 in WebGPU readback coordinates; SSR reflection output only, static scene and camera, independent PCG reference.'}
for filter_name, transform in [('raw', lambda x: x), ('binomial3', blur)]:
    target = transform(truth)
    for region, roi in [('all', np.s_[:, :, :]), ('lower-half', np.s_[64:, :, :])]:
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

# Visualize GPU render-target readback, rather than relying on browser composition.
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

fig, axes = plt.subplots(2, 3, figsize=(11, 7), constrained_layout=True)
for row, frames in enumerate([4, 128]):
    for col, name in enumerate(['reference', 'fast', 'gsa']):
        linear = load(name, 4096 if name == 'reference' else frames) * 4
        srgb = np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055)
        axes[row, col].imshow(np.clip(srgb, 0, 1), interpolation='nearest')
        axes[row, col].set_title(f'{name.upper()}, {4096 if name == "reference" else frames} samples')
        axes[row, col].axis('off')
fig.suptitle('Actual Three.js stochastic SSR reflection output\nPhysical AMD GPU readback; 4x exposure for display')
fig.savefig(root / 'ssr-readback.png', dpi=150)
plt.close(fig)
