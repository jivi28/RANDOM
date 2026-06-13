"""Re-derive the Veg. corridor factor in the published GeoJSON after the
`dist_to_vegetation_m == 0` placeholder fix in enrich.load_powerline_vegetation.

Why a bespoke script: the source feed maps ~38% of power lines (those with a
placeholder 0 m distance-to-vegetation) to risk 1.0, which pinned
`factor_vegetation` to 0.000 and applied an unjustified discount to every cell
whose nearest line was one of them. Because the feed derives risk as
clip(1 - dist/300, 0, 1), risk == 1.0 happens *only* for those placeholder lines,
so a cell's stored `veg_risk == 1.0` exactly identifies a sentinel match. Geometry
is unchanged, so the nearest-line assignment is identical — we just null those
matches and rebuild the affected cells through predict.py's own scoring/narrative
logic (a full GEE run, or scripts/regenerate_output.py, reproduces the same result
from scratch but needs the geopandas/earthengine stack).

Run:
    python scripts/fix_vegetation_factor.py
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from src import config, predict

# Properties that can change for an affected cell; everything else (geometry,
# the other factors, raw inputs, place names) is left byte-for-byte untouched.
_MUTABLE = [
    "veg_risk", "factor_vegetation", "score", "suitability_class",
    "exclusion_reason", "decision_reason",
    "top_positive_factors", "top_negative_factors", "tooltip",
]

# Frontend copy + the canonical output; identical files, both refreshed.
_TARGETS = [config.ROOT / "public" / "bavaria_suitability.geojson", config.F_OUTPUT]


def _clean(v):
    """JSON-safe scalar: NaN/None -> null, numpy types -> python scalars."""
    if v is None:
        return None
    if isinstance(v, float) and np.isnan(v):
        return None
    if isinstance(v, (np.floating, np.integer)):
        v = v.item()
        return None if isinstance(v, float) and np.isnan(v) else v
    return v


def main() -> None:
    src = _TARGETS[0] if _TARGETS[0].exists() else config.F_OUTPUT
    gj = json.loads(src.read_text())
    feats = gj["features"]

    df = pd.DataFrame([f["properties"] for f in feats])

    # A stored veg_risk of exactly 1.0 == nearest line was a placeholder sentinel.
    affected = df["veg_risk"].fillna(-1).round(3).eq(1.0).to_numpy()
    df.loc[affected, "veg_risk"] = np.nan

    # Rebuild the derived fields exactly as predict.predict() does post-inference.
    for col, series in predict._factor_scores(df).items():
        df[col] = series
    df["score"] = predict._apply_resource_nudge(df["model_score"], predict._resource_factor(df))
    df["score"] = predict._apply_vegetation_nudge(df["score"], df)

    landcover = df["landcover"]
    protected = df["protected"] if "protected" in df else pd.Series(0, index=df.index)
    df["exclusion_reason"] = [
        predict._exclusion_reason(lc, not pd.isna(s), bool(p))
        for lc, s, p in zip(landcover, df["score"], protected)
    ]
    excluded = df["exclusion_reason"].notna()
    df["suitability_class"] = [
        predict._classify(0.0 if pd.isna(s) else s, bool(e))
        for s, e in zip(df["score"], excluded)
    ]
    df["exclusion_reason"] = df["exclusion_reason"].fillna("")
    # Assign narrative columns by name (they already exist in df) to avoid the
    # duplicate columns a concat would create.
    narrative = df.apply(predict._explain, axis=1, result_type="expand")
    for col in narrative.columns:
        df[col] = narrative[col]
    df["score"] = df["score"].round(4)

    # Write the recomputed mutable fields back onto affected features only.
    n = 0
    for i, feat in enumerate(feats):
        if not affected[i]:
            continue
        feat["properties"].update({k: _clean(df.iloc[i][k]) for k in _MUTABLE})
        n += 1

    payload = json.dumps(gj, allow_nan=False)
    for path in _TARGETS:
        path.write_text(payload)

    counts = df["suitability_class"].value_counts().to_dict()
    print(f"[fix-veg] updated {n} sentinel-matched cells across {len(_TARGETS)} files")
    print(f"[fix-veg] class counts now: {counts}")


if __name__ == "__main__":
    main()
