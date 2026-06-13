"""Regenerate outputs/bavaria_suitability.geojson with the sun/cloud resource
logic, reusing the RandomForest probabilities already baked into the previous
output (the 64-dim embeddings needed to re-run the model live only in GEE).

This applies the *new* predict.py logic — resource nudge + cloud-aware narrative
— on the existing model_score + real GHI + Open-Meteo cloud cover. A full GEE run
(`python -m src.predict`) reproduces the same logic from scratch.

Run:
    python scripts/regenerate_output.py
"""
from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from src import config, enrich, predict

# Columns predict.py derives; drop any stale copies before recomputing.
_DERIVED = [
    "factor_sun", "factor_cloud", "factor_terrain", "factor_landuse",
    "factor_grid", "factor_vegetation", "factor_model", "veg_risk",
    "exclusion_reason", "decision_reason",
    "top_positive_factors", "top_negative_factors", "tooltip",
    "suitability_class", "model_score", "cloud",
]


def main() -> None:
    src = config.OUTPUTS / "bavaria_suitability.before.geojson"
    gdf = gpd.read_file(src if src.exists() else config.F_OUTPUT)
    df = pd.DataFrame(gdf.drop(columns="geometry"))

    # Raw RF probability: an already-regenerated output carries `model_score`;
    # the original pre-nudge output only has `score` (which *was* the raw prob).
    # Preferring model_score keeps re-runs idempotent (no double nudge).
    df["model_score"] = df["model_score"] if "model_score" in df.columns else df["score"]
    df = df.drop(columns=[c for c in _DERIVED if c in df and c != "model_score"],
                 errors="ignore")

    # Real Bavaria cloud cover (Open-Meteo climatology).
    cloud = pd.read_csv(config.RAW / "cloud_cover_bavaria.csv")[["cell_id", "cloud"]]
    df = df.merge(cloud, on="cell_id", how="left")

    # Nearest-power-line vegetation encroachment (project-local CSV, no GEE).
    df = enrich.add_vegetation_risk(df, enrich.ensure_powerlines())

    # --- new predict.py logic (mirrors predict.predict after model inference) ---
    df = pd.concat([df, predict._factor_scores(df)], axis=1)
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

    narrative = df.apply(predict._explain, axis=1, result_type="expand")
    df = pd.concat([df, narrative], axis=1)

    df["score"] = df["score"].round(4)
    df["model_score"] = df["model_score"].round(4)
    df["factor_model"] = df["model_score"]

    keep = [
        "cell_id", "lon", "lat", "score", "model_score", "suitability_class",
        "slope", "ghi", "cloud", "dist_powerline_m", "landcover", "protected",
        "veg_risk",
        "factor_sun", "factor_cloud", "factor_terrain", "factor_landuse",
        "factor_grid", "factor_vegetation", "factor_model",
        "exclusion_reason", "decision_reason",
        "top_positive_factors", "top_negative_factors", "tooltip",
    ]
    keep = [c for c in keep if c in df.columns]
    out = gdf[["cell_id", "geometry"]].merge(df[keep], on="cell_id", how="left")
    out.to_file(config.F_OUTPUT, driver="GeoJSON")

    counts = out["suitability_class"].value_counts().to_dict()
    print(f"[regen] wrote {len(out)} cells -> {config.F_OUTPUT.name}")
    print(f"[regen] class counts: {counts}")


if __name__ == "__main__":
    main()
