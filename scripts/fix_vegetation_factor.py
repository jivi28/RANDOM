"""Re-derive the Veg. corridor factor in the published GeoJSON.

The source vegetation feed maps ~38% of power lines (those with a placeholder
`dist_to_vegetation_m` of 0) to risk 1.0. Matching cells to their nearest line
blindly therefore gave most cells either a meaningless 1.0 ("corridor fully
overgrown", factor 0.000) or — once those placeholders are nulled — no value at
all. Instead we assign each cell the encroachment of its nearest *measured* line,
so the factor shows real, varied corridor data wherever the grid is reachable.

This mirrors the updated enrich.add_vegetation_risk join (nearest non-placeholder
line in EPSG:3035) but reuses only shapely + pyproj, so it runs without the GEE /
geopandas stack — a full `python -m src.predict` reproduces the same result.

Run:
    python scripts/fix_vegetation_factor.py
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import shape

from src import config, predict

# Frontend copy + the canonical output; identical files, both refreshed.
_TARGETS = [config.ROOT / "public" / "bavaria_suitability.geojson", config.F_OUTPUT]


def _measured_line_risk() -> tuple[STRtree, np.ndarray]:
    """STRtree of power lines (in EPSG:3035) that carry a real vegetation
    measurement, plus the parallel array of their risk values."""
    veg = pd.read_csv(config.F_VEGETATION)
    # dist==0 is a missing-data placeholder, not "vegetation on the line".
    veg = veg[veg["dist_to_vegetation_m"] != 0.0]
    risk_by_id = dict(zip(veg["osm_id"], veg["vegetation_risk"]))

    lines = json.loads(config.F_POWERLINES.read_text())["features"]
    tf = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
    geoms, risks = [], []
    for f in lines:
        risk = risk_by_id.get(f["properties"].get("osm_id"))
        if risk is None or (isinstance(risk, float) and np.isnan(risk)):
            continue
        geoms.append(shapely.transform(shape(f["geometry"]),
                                       lambda c: np.column_stack(tf.transform(c[:, 0], c[:, 1]))))
        risks.append(risk)
    print(f"[fix-veg] {len(geoms)} measured lines (of {len(lines)} total)")
    return STRtree(geoms), np.asarray(risks)


def main() -> None:
    src = _TARGETS[0] if _TARGETS[0].exists() else config.F_OUTPUT
    gj = json.loads(src.read_text())
    feats = gj["features"]
    df = pd.DataFrame([f["properties"] for f in feats])
    old_vr = df["veg_risk"].to_numpy(dtype=float, na_value=np.nan)

    # Nearest *measured* line's encroachment for every cell (metric distance).
    tree, risks = _measured_line_risk()
    tf = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
    x, y = tf.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    pts = shapely.points(x, y)
    # query_nearest on an array returns (2, n) pairs: row 0 = point index, row 1 =
    # nearest tree (line) index. all_matches=False keeps one match per point.
    pair = tree.query_nearest(pts, all_matches=False)
    nearest = np.empty(len(pts), dtype=int)
    nearest[pair[0]] = pair[1]
    df["veg_risk"] = np.round(risks[nearest], 3)

    # Only cells whose nearest-line risk actually moved need rewriting; the rest
    # (their nearest line already carried a measurement) stay byte-identical.
    affected = ~np.isclose(old_vr, df["veg_risk"].to_numpy(), equal_nan=True)

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
    # Assign narrative columns by name (they already exist in df) so no dup columns.
    narrative = df.apply(predict._explain, axis=1, result_type="expand")
    for col in narrative.columns:
        df[col] = narrative[col]
    df["score"] = df["score"].round(4)

    # Properties predict.py owns; write them all back so the file is self-consistent.
    out_cols = [
        "veg_risk", "score", "suitability_class",
        "factor_sun", "factor_cloud", "factor_terrain", "factor_landuse",
        "factor_grid", "factor_vegetation", "factor_model",
        "exclusion_reason", "decision_reason",
        "top_positive_factors", "top_negative_factors", "tooltip",
    ]
    changed = 0
    for i, feat in enumerate(feats):
        if not affected[i]:
            continue
        feat["properties"].update({c: _clean(df.iloc[i][c]) for c in out_cols})
        changed += 1

    payload = json.dumps(gj, allow_nan=False)
    for path in _TARGETS:
        path.write_text(payload)

    have = int(df["factor_vegetation"].notna().sum())
    print(f"[fix-veg] {changed} cells changed; factor_vegetation present on "
          f"{have}/{len(df)} cells (n/a elsewhere = far from grid)")
    print(f"[fix-veg] class counts now: {df['suitability_class'].value_counts().to_dict()}")


def _clean(v):
    """JSON-safe scalar: NaN/None -> null, numpy types -> python scalars."""
    if v is None:
        return None
    if isinstance(v, (np.floating, np.integer)):
        v = v.item()
    if isinstance(v, float) and np.isnan(v):
        return None
    return v


if __name__ == "__main__":
    main()
