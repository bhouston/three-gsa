"""Rebuild the actual SSR figure from committed measurements; no GPU required.

python scripts/ssr/plot.py [INPUT_DIRECTORY] [OUTPUT_DIRECTORY]
"""
import json
import pathlib
import sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

default = pathlib.Path(__file__).resolve().parents[2] / 'docs' / 'research'
source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else default
destination = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else source
destination.mkdir(parents=True, exist_ok=True)
phases = json.loads((source / 'ssr-phases-metrics.json').read_text())
initial = json.loads((source / 'ssr-metrics.json').read_text())
run = json.loads((source / 'ssr-run.json').read_text())
phase_run = json.loads((source / 'ssr-phases-run.json').read_text())
assert run['complete'] and phase_run['complete']
assert run['sampleLifecycle']['reference'] == {'requestedSamples': 4096, 'completedSSRUpdates': 4096, 'exactFrameAdvances': 4096}
assert phase_run['lifecycle'] == {'requestedSamples': 318, 'completedSSRUpdates': 318, 'exactFrameAdvances': 318}
assert max(row['max_absolute_difference'] for row in phases['phase_zero_reproduction']) <= phases['phase_zero_reproduction_tolerance']
assert len(phases['metrics']) == 24 and phases['improvements'] == 22 and phases['regressions'] == 2
frames = [1, 4, 16, 32, 64, 128]
get = lambda filter_name, region: sorted([row for row in phases['metrics'] if row['filter'] == filter_name and row['region'] == region], key=lambda row: row['frames'])
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False, 'svg.fonttype': 'none'})
fig = plt.figure(figsize=(12, 8.7), constrained_layout=True)
grid = fig.add_gridspec(2, 2, height_ratios=[1, 1.05])
fast_color, gsa_color = '#64748b', '#087f8c'
for column, filter_name in enumerate(['raw', 'binomial3']):
    axis = fig.add_subplot(grid[0, column])
    rows = get(filter_name, 'all')
    axis.plot(frames, [row['fast_rmse'] for row in rows], 'o-', label='FAST Separate', color=fast_color, linewidth=2)
    axis.plot(frames, [row['gsa_rmse'] for row in rows], 'o-', label='GSA', color=gsa_color, linewidth=2)
    floor = initial['reference'][f'{filter_name}/all']['half_to_full_rmse']
    axis.axhline(floor, color='#a16207', linestyle=':', label='Reference 2048→4096 difference')
    axis.set(xscale='log', yscale='log', xlabel='Accumulated samples', ylabel='RGB RMSE against independent SSR reference', title='Unfiltered SSR' if filter_name == 'raw' else 'SSR + 3×3 binomial filter')
    axis.set_xticks(frames, [str(frame) for frame in frames])
    axis.grid(True, which='major', alpha=.18)
    axis.legend(fontsize=8, loc='upper right')
    axis.text(.03, .10, 'All pixels · mean square error across 32 starting phases', transform=axis.transAxes, fontsize=8)

axis = fig.add_subplot(grid[1, :])
colors = ['#445b9e', '#a1b0d7', '#087f8c', '#78c9c1']
categories = [('raw', 'all', 'Raw · all pixels'), ('raw', 'lower-half', 'Raw · lower-half ROI'), ('binomial3', 'all', 'Blur · all pixels'), ('binomial3', 'lower-half', 'Blur · lower-half ROI')]
x = np.arange(len(frames))
for index, (filter_name, region, label) in enumerate(categories):
    values = [row['relative_change_percent'] for row in get(filter_name, region)]
    bars = axis.bar(x + (index - 1.5) * .19, values, width=.18, label=label, color=colors[index])
    for bar, value in zip(bars, values):
        if value > 0:
            axis.annotate(f'+{value:.2f}%', (bar.get_x() + bar.get_width() / 2, value), xytext=(0, 5 + (index % 2) * 12), textcoords='offset points', ha='center', va='bottom', fontsize=8, color='#9a3412')
axis.axhline(0, color='#334155', linewidth=.8)
axis.set_xticks(x, [str(frame) for frame in frames])
axis.set(xlabel='Accumulated samples', ylabel='GSA RMSE change relative to FAST (%)', title='All 24 phase-averaged comparisons: 22 improvements, 2 regressions', ylim=(-12.8, 3.2))
axis.grid(axis='y', alpha=.18)
axis.legend(ncol=2, fontsize=8, loc='lower left')
axis.text(.99, .95, 'Below zero = lower error\nOnly losses: single-frame filtered SSR', transform=axis.transAxes, ha='right', va='top', fontsize=9)
fig.suptitle('GSA in actual Three.js stochastic screen-space reflections\n128×128 · static scene · four independent seed dimensions · WebGPU', fontsize=13)
fig.supxlabel('Independent 4096-sample PCG reference; 32 starting phases. Rendering throughput: FAST/GSA differ by approximately ±0.5% across two orders.', fontsize=9)
for extension in ['png', 'svg']:
    fig.savefig(destination / f'gsa-ssr.{extension}', dpi=180, facecolor='white')
plt.close(fig)
print(destination / 'gsa-ssr.png')
