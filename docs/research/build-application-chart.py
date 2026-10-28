"""Render every matched application diagnostic, including all regressions.

python docs/research/build-application-chart.py [INPUT_DIRECTORY] [OUTPUT_DIRECTORY]
Inputs: applications.json and application-capture.json. Defaults: this directory.
Uses the existing research requirements.txt; no GPU or new measurements required.
"""
import hashlib
import json
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import numpy as np

SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
DESTINATION = Path(sys.argv[2]) if len(sys.argv) > 2 else SOURCE
DESTINATION.mkdir(parents=True, exist_ok=True)
METRICS = json.loads((SOURCE / "applications.json").read_text(encoding="utf-8"))
CAPTURE = json.loads((SOURCE / "application-capture.json").read_text(encoding="utf-8"))
PROTOCOL = METRICS["protocol"]
assert PROTOCOL == CAPTURE["protocol"], "Capture and scored protocols differ."
assert METRICS["gpu"] == CAPTURE["gpu"] and CAPTURE["gpu"]["fallback"] is False
assert PROTOCOL["frozenBeforeMeasurement"] is True
assert PROTOCOL["methods"] == ["FAST", "GSA"]
assert PROTOCOL["seedPairs"] == [[1, 2], [3, 4]]
assert PROTOCOL["prefixes"] == [1, 4, 16, 32, 64, 128]
assert len(PROTOCOL["temporalFilters"]) == 2 and len(PROTOCOL["spatialFilters"]) == 3
LABELS = {
    "coverage": "Coverage threshold",
    "shadow": "Rectangular area-light visibility",
    "ao-wall": "AO: infinite wall, radius 1",
    "ggx-environment": "GGX normal/lobe probe (separable)",
    "camera-shadow": "Camera motion + object-ID resets",
    "moving-shadow": "Moving shadow blocker",
}
assert PROTOCOL["cases"] == list(LABELS)
TIE_TOLERANCE = 1e-12


def key(row):
    return (row["scene"], tuple(row["pair"]), row["frames"], row["temporal"], row["spatial"])


lookup = {}
for row in METRICS["results"]:
    value = row["totalRMSE"]
    assert isinstance(value, (int, float)) and np.isfinite(value) and value >= 0
    identity = (row["method"], key(row))
    assert identity not in lookup, f"Duplicate metric row: {identity}"
    lookup[identity] = row
expected_runs = {(method, tuple(pair), scene) for method in PROTOCOL["methods"]
                 for pair in PROTOCOL["seedPairs"] for scene in PROTOCOL["cases"]}
assert {(run["method"], tuple(run["pair"]), run["scene"]) for run in CAPTURE["runs"]} == expected_runs
assert len(CAPTURE["runs"]) == len(expected_runs)
expected_keys = {(scene, tuple(pair), frame, temporal, spatial)
                 for scene in PROTOCOL["cases"] for pair in PROTOCOL["seedPairs"]
                 for frame in PROTOCOL["prefixes"] for temporal in PROTOCOL["temporalFilters"]
                 for spatial in PROTOCOL["spatialFilters"]}
assert len(expected_keys) == 432
assert set(lookup) == {(method, identity) for method in ["FAST", "GSA"] for identity in expected_keys}

comparisons = []
for identity in sorted(expected_keys):
    fast = lookup[("FAST", identity)]["totalRMSE"]
    gsa = lookup[("GSA", identity)]["totalRMSE"]
    # There are no zero references in this captured protocol. Reject new zero
    # rows rather than inventing a percentage or silently removing observations.
    assert fast > 0, "Zero FAST error has no finite relative percentage; review the protocol."
    difference = gsa - fast
    comparisons.append({"scene": identity[0], "pair": list(identity[1]),
                        "frames": identity[2], "temporal": identity[3], "spatial": identity[4],
                        "percentChange": 100 * (gsa / fast - 1),
                        "outcome": "tie" if abs(difference) <= TIE_TOLERANCE else "win" if difference < 0 else "loss"})


def summary(rows):
    changes = np.array([row["percentChange"] for row in rows])
    return {"count": len(rows), "wins": sum(row["outcome"] == "win" for row in rows),
            "losses": sum(row["outcome"] == "loss" for row in rows),
            "ties": sum(row["outcome"] == "tie" for row in rows),
            "medianPercentChange": float(np.median(changes)),
            "minimumPercentChange": float(changes.min()), "maximumPercentChange": float(changes.max())}


def canonical_sha(document):
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


report = {
    "metric": "totalRMSE versus current unfiltered analytic truth",
    "percentChange": "100 * (GSA totalRMSE / FAST totalRMSE - 1); negative is lower error",
    "tieToleranceAbsoluteRMSE": TIE_TOLERANCE,
    "sources": {name: {"canonicalJSONSHA256": canonical_sha(document)} for name, document in
                [("applications.json", METRICS), ("application-capture.json", CAPTURE)]},
    "protocol": PROTOCOL,
    "overall": summary(comparisons),
    "workloads": [{"scene": scene, "label": LABELS[scene], **summary([row for row in comparisons if row["scene"] == scene]),
                   "seedPairs": [{"pair": pair, **summary([row for row in comparisons if row["scene"] == scene and row["pair"] == pair])}
                                 for pair in PROTOCOL["seedPairs"]],
                   "percentChanges": [row["percentChange"] for row in comparisons if row["scene"] == scene]}
                  for scene in PROTOCOL["cases"]],
    "limitations": [
        "432 correlated diagnostics, not 432 independent trials; 72 per workload = two seed pairs x six frame prefixes x two temporal filters x three spatial filters.",
        "Only seed pair [3,4] is new; [1,2] contains development seeds.",
        "GGX workload is a separable normal/lobe environment probe f(u)+g(v), not a full BRDF or coupled multidimensional reflection estimator.",
        "AO is an infinite vertical wall with unit maximum ray distance, not a finite-height wall or a full rendered AO scene.",
        "Camera motion uses exact integer per-object reprojection and ID resets; it does not establish arbitrary motion or SSR performance.",
        "Total RMSE includes filter bias and temporal lag. Noise RMSE and truth-only bias metrics are not counted here.",
        "No zero reference RMSE occurs; null reset-pixel diagnostics are outside this metric. All finite total-error comparisons are included.",
    ],
}
assert all(row["count"] == 72 for row in report["workloads"])
(DESTINATION / "application-summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.hashsalt": "three-gsa-application-quality-v1"})
fig, ax = plt.subplots(figsize=(12.5, 7.5))
fig.subplots_adjust(left=0.295, right=0.85, top=0.81, bottom=0.25)
green, red, neutral = "#15836b", "#c24c46", "#687385"
all_changes = np.array([row["percentChange"] for row in comparisons])
span = max(float(np.ptp(all_changes)), 1)
ax.set_xlim(float(all_changes.min()) - span * 0.06, float(all_changes.max()) + span * 0.06)
ax.axvspan(ax.get_xlim()[0], 0, color=green, alpha=0.035)
ax.axvspan(0, ax.get_xlim()[1], color=red, alpha=0.035)
ax.axvline(0, color="#465366", linewidth=1)

for y, workload in enumerate(report["workloads"]):
    rows = [row for row in comparisons if row["scene"] == workload["scene"]]
    for pair_index, pair in enumerate(PROTOCOL["seedPairs"]):
        selected = [row for row in rows if row["pair"] == pair]
        values = np.array([row["percentChange"] for row in selected])
        # The offsets only separate markers visually; they encode no metric.
        offsets = np.linspace(-0.085, 0.085, len(selected)) + (-0.16 if pair_index == 0 else 0.16)
        colors = [green if row["outcome"] == "win" else red if row["outcome"] == "loss" else neutral for row in selected]
        ax.scatter(values, y + offsets, c=colors, s=17, marker="o" if pair_index == 0 else "s", alpha=0.7, linewidths=0, zorder=3)
    ax.scatter([workload["medianPercentChange"]], [y], marker="D", s=48, c="#182334", edgecolors="white", linewidths=0.8, zorder=5)
    ax.text(1.025, y, f'{workload["wins"]} / {workload["losses"]} / {workload["ties"]}\nmedian {workload["medianPercentChange"]:+.2f}%',
            transform=ax.get_yaxis_transform(), va="center", fontsize=9, color="#263246", linespacing=1.6)

ax.set_yticks(range(6), [LABELS[scene] for scene in PROTOCOL["cases"]])
ax.set_ylim(5.55, -0.55)
ax.set_xlabel("Current-frame total RMSE change versus FAST Separate (%)\n← lower error                         higher error →", labelpad=10)
ax.grid(axis="x", color="#aab3bf", alpha=0.25)
ax.set_axisbelow(True)
ax.tick_params(axis="y", length=0, pad=12)
for side in ("top", "right", "left"):
    ax.spines[side].set_visible(False)
ax.spines["bottom"].set_color("#aab3bf")
ax.text(1.025, 1.07, "GSA wins / losses / ties", transform=ax.transAxes, fontsize=9, color="#263246")
fig.text(0.045, 0.95, "GSA application probes: gains and losses", fontsize=20, weight="bold", color="#172333")
fig.text(0.045, 0.905, "All 432 matched total-error diagnostics · 72 points per workload · every regression included", fontsize=11, color="#45536a")
legend = [Line2D([0], [0], marker="o", color="none", markerfacecolor=neutral, markeredgewidth=0, markersize=5, label="Seed pair 1,2 (development)"),
          Line2D([0], [0], marker="s", color="none", markerfacecolor=neutral, markeredgewidth=0, markersize=5, label="Seed pair 3,4 (new)"),
          Line2D([0], [0], marker="D", color="none", markerfacecolor="#182334", markeredgewidth=0, markersize=6, label="Median of 72 diagnostics")]
fig.legend(handles=legend, loc="lower left", bbox_to_anchor=(0.04, 0.125), frameon=False, ncol=3, fontsize=9)
fig.text(0.045, 0.1, "Prefixes 1/4/16/32/64/128; box or EMA-0.1 history; identity, 3×3 binomial or sigma-1 Gaussian spatial filter.", fontsize=9, color="#45536a")
fig.text(0.045, 0.067, "GGX is a separable normal/lobe probe, not a full BRDF estimator. Motion uses exact integer reprojection; no actual SSR in this figure.", fontsize=9, color="#45536a")
fig.text(0.045, 0.034, "Rows, prefixes and filters are correlated diagnostics, not independent statistical trials. Total error includes temporal lag and filter bias.", fontsize=9, color="#45536a")
fig.savefig(DESTINATION / "gsa-applications.png", dpi=170, facecolor="white", metadata={"Software": "three-gsa application chart"})
fig.savefig(DESTINATION / "gsa-applications.svg", facecolor="white", metadata={"Date": None, "Creator": "three-gsa application chart"})
plt.close(fig)
print(json.dumps(report["overall"]))
