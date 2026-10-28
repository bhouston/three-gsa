"""Rebuild GSA blog figures from pinned research data (Python, NumPy, Pillow, Matplotlib).

Usage: python build-charts.py [THREE_JS_REPOSITORY] [OUTPUT_DIRECTORY]
All Git reads use git-dedup. No GPU work or downloaded credentials are required.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE.parents[2] / 'three.js'
OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE
OUT.mkdir(parents=True, exist_ok=True)
PIN = 'bf8053703d208df3354256733d63c0506ef71c0f'
PR117 = '2a065526980261bcf5b129f07ddb12ff7eda1f91'
FRAMES = [1, 2, 4, 8, 16, 32, 128, 256, 512, 1024]
provenance = {}


def read_git(path, pin=PIN):
    # All values passed here are fixed source paths, never untrusted shell input.
    if os.name == 'nt':
        args = ['cmd.exe', '/d', '/s', '/c', f'git-dedup.cmd show {pin}:{path}']
    else:
        args = ['git-dedup', 'show', f'{pin}:{path}']
    data = subprocess.run(args, cwd=REPO, capture_output=True, check=True).stdout
    provenance[f'{pin}:{path}'] = hashlib.sha256(data).hexdigest()
    return data


def load_json(path):
    return json.loads(read_git(path))


def scalar_png(path, pin=PIN, packed=False):
    image = np.asarray(Image.open(io.BytesIO(read_git(path, pin))))
    if packed:
        image = image.reshape(32, 128, 256, 3)[:, :, :128, 2]
    else:
        assert image.shape == (4096, 128), image.shape
        image = image.reshape(32, 128, 128)
    return (image.astype(np.float64) + .5) / 256


def gauss(v):
    k = np.exp(-.5 * np.arange(-3, 4) ** 2)
    k /= k.sum()
    for axis in (-1, -2):
        v = sum(w * np.roll(v, i - 3, axis=axis) for i, w in enumerate(k))
    return v


def fetch(v, n):
    cycle = n // 32
    return np.roll(v[n % 32], (-71 * cycle, -37 * cycle), axis=(0, 1))


def converge(volume=None):
    # Stream one timeline into 32 accumulators: <20 MB, no 1024-frame volume.
    # White uses the same fresh seed-1 timeline for overlapping start windows.
    rng = np.random.default_rng(1)
    blurred = gauss(volume) if volume is not None else None
    sums = np.zeros((2, 32, 128, 128))
    result = {mode: {'phase_zero_std': {}, 'phase_zero_rmse': {},
                     'all_phase_rmse': {}, 'all_phase_bias': {}}
              for mode in ('raw', 'sigma1')}
    measurements = {mode: {n: [] for n in FRAMES} for mode in result}
    biases = {mode: {n: [] for n in FRAMES} for mode in result}
    for frame in range(max(FRAMES) + 31):
        plane = fetch(volume, frame) if volume is not None else rng.random((128, 128))
        blur = fetch(blurred, frame) if volume is not None else gauss(plane)
        sums[:, :min(frame + 1, 32)] += np.stack((plane, blur))[:, None]
        for phase in range(min(frame + 1, 32)):
            count = frame - phase + 1
            if count not in FRAMES:
                continue
            for index, mode in enumerate(result):
                mean = sums[index, phase] / count
                error = mean - .5
                mse = float(np.mean(error * error))
                measurements[mode][count].append(mse)
                biases[mode][count].append(float(error.mean()))
                if phase == 0:
                    result[mode]['phase_zero_std'][count] = float(mean.std())
                    result[mode]['phase_zero_rmse'][count] = float(np.sqrt(mse))
    for mode in result:
        for n in FRAMES:
            assert len(measurements[mode][n]) == 32
            result[mode]['all_phase_rmse'][n] = float(np.sqrt(np.mean(measurements[mode][n])))
            result[mode]['all_phase_bias'][n] = float(np.mean(biases[mode][n]))
    return result


plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11,
                     'axes.titlesize': 14, 'axes.labelsize': 11,
                     'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.edgecolor': '#cbd5e1', 'text.color': '#172b40',
                     'axes.labelcolor': '#334155', 'xtick.color': '#475569',
                     'ytick.color': '#475569', 'figure.facecolor': 'white',
                     'axes.facecolor': 'white', 'savefig.facecolor': 'white',
                     'svg.hashsalt': 'three-gsa-blog-2026'})
COLORS = {'White': '#94a3b8', 'FAST Spatial (shipped scalar B)': '#d68a19',
          'FAST Separate (10,000 steps)': '#3e6db1', 'GSA (3,000 steps)': '#079b83'}


def finish(fig, name, footer):
    fig.text(.04, .025, footer, fontsize=9, color='#64748b', va='bottom')
    fig.subplots_adjust(left=.09, right=.97, bottom=.18, top=.84, wspace=.28)
    for ext in ('png', 'svg'):
        fig.savefig(OUT / f'{name}.{ext}', dpi=180,
                    metadata={'Creator': 'build-charts.py'} if ext == 'svg' else None)
    plt.close(fig)


scores = load_json('utils/fastnoise/results/frontier/scores.json')['methods']
audit = load_json('utils/fastnoise/results/frontier/audit.json')['full']
gsa = scalar_png('examples/textures/noises/experimental/gpu-stratified-annealed.png')
fast = scalar_png('examples/textures/noises/experimental/fast-seed1.png', PR117)
spatial = scalar_png('examples/textures/noises/fast/gauss1-ema01-spatial.png', packed=True)
curves = {}
for name, volume in [('White', None), ('FAST Spatial (shipped scalar B)', spatial),
                     ('FAST Separate (10,000 steps)', fast), ('GSA (3,000 steps)', gsa)]:
    print('Scoring', name, flush=True)
    curves[name] = converge(volume)

# Confirm the extracted baseline is exactly the same reference as the full audit.
for name, key in [('FAST Separate (10,000 steps)', 'fast-10000-s1'),
                  ('GSA (3,000 steps)', 'latin-anneal001-3000-s1')]:
    for mode in ('raw', 'sigma1'):
        for n in (1, 4, 8, 16, 32):
            np.testing.assert_allclose(curves[name][mode]['all_phase_rmse'][n],
                scores[key]['integrands']['identity'][mode][str(n)]['rmse'], rtol=1e-12)
    for n in (1, 4, 32, 256):
        np.testing.assert_allclose(curves[name]['sigma1']['phase_zero_std'][n],
            scores[key]['compare'][f'bl{n}'], rtol=1e-12)

fig, axes = plt.subplots(1, 2, figsize=(12, 5.3))
fig.suptitle('Lower error after spatial and temporal averaging', x=.04, ha='left',
             fontsize=19, fontweight='bold')
for ax, field, title in zip(axes, ['phase_zero_std', 'all_phase_rmse'],
        ['Aligned start: scalar error spread', 'All 32 starts: error against the true mean']):
    for name, row in curves.items():
        ax.plot(FRAMES, [row['sigma1'][field][n] for n in FRAMES],
                color=COLORS[name], label=name, marker='o', ms=3.8, lw=2)
    ax.set_xscale('log', base=2)
    ax.set_yscale('log')
    ax.set_xticks([1, 4, 16, 64, 256, 1024], ['1', '4', '16', '64', '256', '1024'])
    ax.set_xlabel('Frames averaged')
    ax.set_ylabel('Standard deviation' if field == 'phase_zero_std' else 'RMSE')
    ax.set_title(title, loc='left', pad=12)
    ax.grid(axis='y', alpha=.16)
axes[0].legend(fontsize=8.5, frameon=False, loc='lower left')
finish(fig, 'gsa-convergence',
       '128×128×32, seed 1; wrapped Gaussian σ=1, radius 3. Lower is better.\n'
       'Frozen volumes shift (−71,−37) per cycle; white uses fresh samples. This tests f(u)=u, not rendered scenes.')

legacy_labels = ['Temporal low-frequency ratio', 'Spatial low-frequency ratio',
                 'Blurred spread: 1 frame', 'Blurred spread: 4 frames',
                 'Raw spread: 32 frames', 'Blurred spread: 32 frames',
                 'Raw spread: 256 frames', 'Blurred spread: 256 frames',
                 'Temporal EMA spread', 'EMA + spatial blur spread']
legacy_keys = ['tmpLow', 'spLow', 'bl1', 'bl4', 'pp32', 'bl32', 'pp256', 'bl256', 'ema', 'ema+bl']
fig, ax = plt.subplots(figsize=(11, 6.1))
fig.suptitle('All ten original diagnostics improve on both seeds', x=.04, ha='left',
             fontsize=18, fontweight='bold')
y = np.arange(10)
for seed, offset, color in [(1, -.17, '#079b83'), (2, .17, '#6ab8c7')]:
    ratios = audit[f'latin-anneal001-3000-s{seed}']['ratios']
    values = [100 * (ratios['legacy/' + k] - 1) for k in legacy_keys]
    ax.barh(y + offset, values, height=.30, color=color, label=f'Seed {seed}')
ax.set_yticks(y, legacy_labels)
ax.invert_yaxis()
ax.set_xlim(-65, 4)
ax.set_xlabel('Change relative to same-seed FAST Separate (%) · negative is better')
ax.axvline(0, color='#334155', lw=1)
ax.grid(axis='x', alpha=.15)
ax.legend(frameon=False, loc='lower left')
fig.subplots_adjust(left=.29, right=.97, bottom=.18, top=.84)
fig.text(.04, .025, 'Original protocol: phase-zero scalar spread; EMA uses the historical unshifted-cycle convention.\n'
         'These diagnostics are narrower than the all-phase known-integral audit below.', fontsize=9, color='#64748b')
for ext in ('png', 'svg'):
    fig.savefig(OUT / f'gsa-legacy-metrics.{ext}', dpi=180)
plt.close(fig)

fig, ax = plt.subplots(figsize=(11, 5.3))
fig.suptitle('Broad gains, with measurable exceptions', x=.04, ha='left', fontsize=19, fontweight='bold')
for seed, color in [(1, '#079b83'), (2, '#3e6db1')]:
    row = audit[f'latin-anneal001-3000-s{seed}']
    values = sorted(100 * (v - 1) for v in row['ratios'].values())
    ax.plot(np.arange(1, 319), values, color=color, lw=2, label=f'Seed {seed}: 262 better / 53 worse / 3 tied')
ax.axhline(0, color='#334155', lw=1)
ax.set_xlabel('318 diagnostics, sorted independently for each seed')
ax.set_ylabel('Change from FAST Separate (%)')
ax.set_ylim(-65, 11)
ax.grid(axis='y', alpha=.16)
ax.legend(frameon=False, loc='lower right')
ax.annotate('Worst regression: +7.0%', xy=(318, 7.0325), xytext=(190, 1),
            arrowprops={'arrowstyle': '->', 'color': '#b86141'}, color='#a64f31', fontsize=10)
finish(fig, 'gsa-audit',
       'Negative is better. Ten legacy diagnostics + 22 integrands × 2 filtering modes × 7 temporal measurements.\n'
       'Correlated development tests, not independent trials or untouched rendering validation; tolerance 10⁻¹².')

selected = [('Identity · 32 frames', 'identity/sigma1/32'),
            ('Threshold 0.5 · 32 frames', 'lt_0.5/sigma1/32'),
            ('Squared value · 32 frames', 'x_squared/sigma1/32'),
            ('Fourth power · 32 frames', 'x_fourth/sigma1/32'),
            ('Threshold 0.83 · 16 frames', 'lt_0.83/sigma1/16'),
            ('cos(16πu) · 1 frame', 'cos_8/sigma1/1'),
            ('sin(14πu) · 1 frame', 'sin_7/sigma1/1')]
fig, ax = plt.subplots(figsize=(11, 5.7))
fig.suptitle('Where GSA helps — and where it loses', x=.04, ha='left', fontsize=19, fontweight='bold')
y = np.arange(len(selected))
for seed, offset, color in [(1, -.17, '#079b83'), (2, .17, '#6ab8c7')]:
    ratios = audit[f'latin-anneal001-3000-s{seed}']['ratios']
    values = [100 * (ratios[k] - 1) for _, k in selected]
    ax.barh(y + offset, values, height=.30, color=color, label=f'Seed {seed}')
ax.set_yticks(y, [label for label, _ in selected])
ax.invert_yaxis()
ax.axvline(0, color='#334155', lw=1)
ax.set_xlim(-30, 10)
ax.set_xlabel('Known-integral RMSE change relative to FAST Separate (%)')
ax.grid(axis='x', alpha=.15)
ax.legend(frameon=False, loc='lower left')
fig.subplots_adjust(left=.29, right=.97, bottom=.18, top=.84)
fig.text(.04, .025, 'All 32 start phases; wrapped Gaussian σ=1 blur. Negative is better. Selected examples, not the whole audit.\n'
         'High-frequency functions and some tail thresholds regress; GSA does not dominate FAST Separate.', fontsize=9, color='#64748b')
for ext in ('png', 'svg'):
    fig.savefig(OUT / f'gsa-tradeoffs.{ext}', dpi=180)
plt.close(fig)

data = {'protocol': {'size': [128, 128, 32], 'frames': FRAMES, 'seed': 1,
        'source_commit': PIN, 'reference_import_commit': PR117,
        'spatial_filter': 'wrapped Gaussian sigma=1 radius=3',
        'temporal_filter': 'box average', 'cycle_shift_yx': [-71, -37],
        'quantization': 'PNG bytes decoded as (byte+.5)/256',
        'white': 'fresh np.random.default_rng(1) float64, same continuous timeline across phases',
        'note': 'Convergence uses scalar FAST reference matching full audit; spatial control is shipped scalar B. '
                'Aligned std excludes bias; all-phase RMSE includes it. Long windows reuse shifted frozen volumes.'},
        'source_sha256': provenance, 'convergence': curves,
        'audit': {f'seed{seed}': audit[f'latin-anneal001-3000-s{seed}'] for seed in (1, 2)},
        'selected_tradeoff_keys': selected,
        'checks': 'Both quantized volumes reproduce all-phase identity RMSE at 1/4/8/16/32 and legacy blur spreads at 1/4/32/256 to rtol=1e-12.'}
(OUT / 'gsa-chart-data.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
print('Saved four PNG/SVG figures and gsa-chart-data.json; numerical cross-checks passed.')
