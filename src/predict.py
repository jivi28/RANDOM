"""Score the Bavaria grid and write the map-ready, *explainable* GeoJSON.

For each cell we keep the raw features (slope, ghi, cloud, dist_powerline_m,
landcover), the resource-adjusted suitability (`score`) and class, the raw
RandomForest probability (`model_score`), and interpretable explanation fields so
a user can click a cell and immediately see *why* it is excluded / bad / okay /
good:

    factor_sun, factor_cloud, factor_terrain, factor_landuse, factor_grid,
    factor_model  (0..1)
    exclusion_reason, decision_reason, top_positive_factors,
    top_negative_factors, tooltip

`score` is `model_score` nudged by a solar-resource factor (sunlight + cloud
cover) so sunnier / clearer cells outrank cloudier / darker ones — see
config.RESOURCE_WEIGHT / CLOUD_SHARE and _apply_resource_nudge below.

Reruns prediction only (no retrain, no GEE sampling):
    python -m src.predict
"""
from __future__ import annotations

import joblib
import numpy as np
import pandas as pd

from . import config

# geopandas is imported lazily inside predict()/_attach_place() (the only callers)
# so the pure scoring/narrative helpers below can be imported without it — see
# scripts/fix_vegetation_factor.py, which re-derives the GeoJSON through them.

# A factor counts as a clear positive / negative driver beyond these cut-offs.
POS, NEG = 0.60, 0.40

# Human phrasing for each interpretable factor, by sentiment.
_PHRASES = {
    ("factor_sun", "+"): "good solar resource", ("factor_sun", "-"): "low solar resource",
    ("factor_cloud", "+"): "clear skies", ("factor_cloud", "-"): "frequently cloudy",
    ("factor_terrain", "+"): "flat terrain", ("factor_terrain", "-"): "steep terrain",
    ("factor_landuse", "+"): "suitable land use", ("factor_landuse", "-"): "poor land use",
    ("factor_grid", "+"): "close to grid", ("factor_grid", "-"): "far from grid",
    ("factor_vegetation", "+"): "clear grid corridor",
    ("factor_vegetation", "-"): "vegetation encroaching power line",
    ("factor_model", "+"): "high model score", ("factor_model", "-"): "low model score",
}
_FACTORS = ["factor_model", "factor_sun", "factor_cloud",
            "factor_terrain", "factor_landuse", "factor_grid", "factor_vegetation"]
_HEADLINE = {"good": "Good candidate", "okay": "Satisfactory candidate", "bad": "Inadequate candidate"}


# --------------------------------------------------------------------------- #
# Classification + exclusion
# --------------------------------------------------------------------------- #
def _classify(score: float, excluded: bool) -> str:
    if excluded:
        return "excluded"
    if score >= config.CLASS_THRESHOLDS["good"]:
        return "good"
    if score >= config.CLASS_THRESHOLDS["okay"]:
        return "okay"
    return "bad"


def _exclusion_reason(landcover, has_score: bool, protected: bool = False) -> str | None:
    """Return a human exclusion reason, or None if the cell is buildable."""
    if not has_score:
        return "missing data"
    if protected:
        return "protected area"
    if pd.isna(landcover):
        return None
    code = int(landcover)
    if code in config.WORLDCOVER_EXCLUDE:
        return config.WORLDCOVER_NAMES.get(code, "excluded landcover")
    return None


# --------------------------------------------------------------------------- #
# Interpretable factor scores (all 0..1, higher = better for solar)
# --------------------------------------------------------------------------- #
def _factor_scores(df: pd.DataFrame) -> pd.DataFrame:
    f = pd.DataFrame(index=df.index)

    # Sun: percentile rank of annual GHI across the grid.
    f["factor_sun"] = (df["ghi"].rank(pct=True)
                       if df.get("ghi") is not None and df["ghi"].notna().any()
                       else np.nan)

    # Cloud: clear-sky goodness = 1 - percentile rank of mean cloud fraction, so
    # frequently-cloudy cells score low and clear cells score high.
    f["factor_cloud"] = (1 - df["cloud"].rank(pct=True)
                         if df.get("cloud") is not None and df["cloud"].notna().any()
                         else np.nan)

    # Terrain: flatness from slope (0 deg -> 1.0, >=15 deg -> 0).
    f["factor_terrain"] = ((1 - df["slope"] / 15.0).clip(0, 1)
                           if df.get("slope") is not None and df["slope"].notna().any()
                           else np.nan)

    # Land use: excluded classes -> 0, else WorldCover suitability weight.
    def _lu(c):
        if pd.isna(c):
            return np.nan
        c = int(c)
        if c in config.WORLDCOVER_EXCLUDE:
            return 0.0
        return config.WORLDCOVER_SUITABILITY.get(c, 0.5)
    f["factor_landuse"] = (df["landcover"].map(_lu)
                           if "landcover" in df else np.nan)

    # Grid: closer to a power line is better; NaN when no powerline data exists.
    if "dist_powerline_m" in df and df["dist_powerline_m"].notna().any():
        f["factor_grid"] = 1 - df["dist_powerline_m"].rank(pct=True)
    else:
        f["factor_grid"] = np.nan

    # Vegetation: clearance of the nearest power line's corridor (1 - encroachment),
    # only meaningful where that line is close enough to be the interconnection.
    # NaN for far-from-grid cells (and when no veg data) so it neither drives the
    # narrative nor implies a discount there -- consistent with _apply_vegetation_nudge.
    if "veg_risk" in df and df["veg_risk"].notna().any():
        veg = 1 - df["veg_risk"]
        if "dist_powerline_m" in df:
            veg = veg.where(df["dist_powerline_m"] <= config.VEG_RISK_NEAR_M, np.nan)
        f["factor_vegetation"] = veg
    else:
        f["factor_vegetation"] = np.nan

    # Model: the *raw* RandomForest suitability probability (before the resource
    # nudge), so the tooltip still surfaces the pure "looks-like-solar-land" signal.
    f["factor_model"] = df["model_score"] if "model_score" in df else df["score"]
    return f.round(3)


def _resource_factor(f: pd.DataFrame) -> pd.Series:
    """Combine sun (GHI) and cloud cover into a 0..1 solar-resource factor.

    1.0 = sunniest / clearest cell, 0.0 = darkest / cloudiest. Uses both signals
    when cloud data is present, else falls back to GHI alone. Cells missing both
    fall back to 0.5 (neutral) so the score nudge leaves them unchanged.
    """
    sun = f["factor_sun"]
    cloud = f["factor_cloud"]
    have_sun, have_cloud = sun.notna().any(), cloud.notna().any()
    if have_sun and have_cloud:
        w = config.CLOUD_SHARE
        resource = (1 - w) * sun + w * cloud
    elif have_sun:
        resource = sun
    elif have_cloud:
        resource = cloud
    else:
        resource = pd.Series(0.5, index=f.index)
    return resource.fillna(0.5).clip(0, 1)


def _apply_resource_nudge(model_score: pd.Series, resource: pd.Series) -> pd.Series:
    """Scale the model score by solar-resource quality (sun + clouds).

    Sunny / clear cells (resource > 0.5) move up, cloudy / dark cells move down,
    bounded by config.RESOURCE_WEIGHT. NaN model scores stay NaN (excluded cells).
    """
    factor = 1 + config.RESOURCE_WEIGHT * (resource - 0.5)
    return (model_score * factor).clip(0, 1)


def _apply_vegetation_nudge(score: pd.Series, df: pd.DataFrame) -> pd.Series:
    """Discount the score where the nearest power line's corridor is overgrown.

    Discount-only (a clear corridor leaves the score unchanged) and gated to cells
    within config.VEG_RISK_NEAR_M of a line, so distant overgrown lines never
    penalise far land. No-op when no vegetation data is present.
    """
    if "veg_risk" not in df or not df["veg_risk"].notna().any():
        return score
    risk = df["veg_risk"].fillna(0)
    if "dist_powerline_m" in df:
        risk = risk.where(df["dist_powerline_m"] <= config.VEG_RISK_NEAR_M, 0)
    return (score * (1 - config.VEG_RISK_WEIGHT * risk.clip(0, 1))).clip(0, 1)


# --------------------------------------------------------------------------- #
# Per-cell narrative
# --------------------------------------------------------------------------- #
def _drivers(row) -> tuple[list[str], list[str]]:
    """Split available factors into positive / negative driver phrases."""
    pos, neg = [], []
    for fac in _FACTORS:
        v = row[fac]
        if pd.isna(v):
            continue
        if v >= POS:
            pos.append((v, _PHRASES[(fac, "+")]))
        elif v <= NEG:
            neg.append((v, _PHRASES[(fac, "-")]))
    pos = [p for _, p in sorted(pos, key=lambda t: -t[0])]
    neg = [p for _, p in sorted(neg, key=lambda t: t[0])]
    return pos, neg


def _resource_note(row) -> str | None:
    """Always-on plain-language summary of the solar resource (sunlight + clouds).

    Unlike the driver phrases (which only fire past the +/- cut-offs), this always
    states the sun and cloud condition so the suitability reasoning explicitly
    explains how weather shaped the rating — even for middling cells.
    """
    parts = []
    sun = row.get("factor_sun")
    if sun is not None and not pd.isna(sun):
        lvl = "strong sunlight" if sun >= POS else (
            "moderate sunlight" if sun > NEG else "weak sunlight")
        parts.append(lvl)
    cloud = row.get("factor_cloud")
    if cloud is not None and not pd.isna(cloud):
        lvl = "clear skies" if cloud >= POS else (
            "average cloud cover" if cloud > NEG else "frequent cloud cover")
        parts.append(lvl)
    if not parts:
        return None
    return "Solar resource: " + ", ".join(parts)


def _explain(row) -> dict:
    cls = row["suitability_class"]
    reason = row["exclusion_reason"]
    grid_unavailable = pd.isna(row["factor_grid"])
    resource = _resource_note(row)

    if cls == "excluded":
        if reason == "missing data":
            tip = "Excluded: missing satellite/landcover data for this cell."
            dec = "Excluded: missing data"
        else:
            tip = f"Excluded: {reason}, not suitable for ground-mounted solar."
            if resource:
                tip += f" ({resource}.)"
            dec = f"Excluded: {reason}"
        return {"decision_reason": dec, "top_positive_factors": "",
                "top_negative_factors": "", "tooltip": tip}

    pos, neg = _drivers(row)
    score = row["score"]
    qual = "high" if score >= POS else ("moderate" if score >= config.CLASS_THRESHOLDS["okay"] else "low")
    head = _HEADLINE[cls]

    # "suitability score" not "model score": this score is the model probability
    # already nudged by the sun/cloud resource, so weather is baked into it.
    main = [f"{qual} suitability score ({score:.2f})"] + [p for p in pos if p != "high model score"]
    tip = f"{head}: " + ", ".join(main) + "."
    if resource:
        tip += f" {resource}."
    if neg:
        tip += " Limited by " + ", ".join(neg) + "."
    if grid_unavailable:
        tip += " Grid proximity unavailable."

    res_tag = f"; resource: {resource.split(': ', 1)[1]}" if resource else ""
    dec = (f"{head} (score {score:.2f}); +: {', '.join(pos) or 'none'}; "
           f"-: {', '.join(neg) or 'none'}{res_tag}")
    return {"decision_reason": dec,
            "top_positive_factors": ", ".join(pos),
            "top_negative_factors": ", ".join(neg),
            "tooltip": tip}


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def _merge_cloud_cache(df: pd.DataFrame) -> pd.DataFrame:
    """Fold in cloud cover from the Open-Meteo cache when the GEE/MODIS band is
    absent, so the sun/cloud resource score works even without a GEE re-sample.
    See scripts/fetch_cloud_openmeteo.py."""
    if "cloud" in df and df["cloud"].notna().any():
        return df
    cache = config.RAW / "cloud_cover_bavaria.csv"
    if not cache.exists():
        return df
    cc = pd.read_csv(cache)[["cell_id", "cloud"]]
    print(f"[predict] cloud band absent -> using {cache.name} ({cc['cloud'].notna().sum()} cells)")
    return df.drop(columns=["cloud"], errors="ignore").merge(cc, on="cell_id", how="left")


def _attach_place(df: pd.DataFrame) -> pd.DataFrame:
    """Label each cell with its municipality (Gemeinde) and district (Landkreis).

    Point-in-polygon of the cell centroid (the lon/lat columns) against the
    bundled boundary files. Cells with no containing polygon (e.g. just outside a
    boundary) get None, which the frontend renders as the bare cell id. No-op if
    the boundary files are missing.
    """
    import geopandas as gpd

    if not (config.F_GEMEINDEN.exists() and config.F_KREISE.exists()):
        return df.assign(municipality=None, district=None)

    pts = gpd.GeoDataFrame(
        df[["cell_id"]].copy(),
        geometry=gpd.points_from_xy(df["lon"], df["lat"]),
        crs="EPSG:4326",
    )
    gem = gpd.read_file(config.F_GEMEINDEN)[["name", "geometry"]].rename(
        columns={"name": "municipality"})
    krs = gpd.read_file(config.F_KREISE)[["name", "type", "geometry"]].rename(
        columns={"name": "kreis", "type": "kreis_type"})

    j = gpd.sjoin(pts, gem, how="left", predicate="within").drop(
        columns="index_right").drop_duplicates("cell_id")
    j = gpd.sjoin(j, krs, how="left", predicate="within").drop(
        columns="index_right").drop_duplicates("cell_id")

    # "LK <name>" for Landkreise; bare city name (minus the " Städte" suffix in
    # the source data) for Kreisfreie Städte.
    def _district(n, t):
        if not isinstance(n, str):
            return None
        if isinstance(t, str) and t.startswith("Landkreis"):
            return f"LK {n}"
        return n.removesuffix(" Städte")
    j["district"] = [_district(n, t) for n, t in zip(j["kreis"], j["kreis_type"])]
    return df.merge(j[["cell_id", "municipality", "district"]], on="cell_id", how="left")


def predict() -> "gpd.GeoDataFrame":  # noqa: F821 (gpd imported lazily below)
    import geopandas as gpd

    bundle = joblib.load(config.F_MODEL)
    model, feats = bundle["model"], bundle["features"]

    df = pd.read_csv(config.F_GRID_FEATURES)
    df = _merge_cloud_cache(df)
    grid = gpd.read_file(config.F_GRID)[["cell_id", "geometry"]]

    valid = df.dropna(subset=feats).copy()
    valid["model_score"] = model.predict_proba(valid[feats].values)[:, 1]
    df = df.merge(valid[["cell_id", "model_score"]], on="cell_id", how="left")

    # Interpretable factor scores (sun/cloud/terrain/landuse/grid + raw model).
    df = pd.concat([df, _factor_scores(df)], axis=1)

    # Nudge the raw model score by solar-resource quality (sunlight + clouds) so
    # the final score rates sunny/clear cells above cloudy/dark ones, then discount
    # cells whose nearest power-line corridor is choked with vegetation.
    df["score"] = _apply_resource_nudge(df["model_score"], _resource_factor(df))
    df["score"] = _apply_vegetation_nudge(df["score"], df)

    # Exclusion + class.
    landcover = df["landcover"] if "landcover" in df else pd.Series(np.nan, index=df.index)
    protected = df["protected"] if "protected" in df else pd.Series(0, index=df.index)
    df["exclusion_reason"] = [
        _exclusion_reason(lc, not pd.isna(s), bool(p))
        for lc, s, p in zip(landcover, df["score"], protected)
    ]
    excluded = df["exclusion_reason"].notna()
    df["suitability_class"] = [
        _classify(0.0 if pd.isna(s) else s, bool(e))
        for s, e in zip(df["score"], excluded)
    ]
    df["exclusion_reason"] = df["exclusion_reason"].fillna("")  # "" = not excluded

    # Per-cell narrative (factors were computed before the resource nudge above).
    narrative = df.apply(_explain, axis=1, result_type="expand")
    df = pd.concat([df, narrative], axis=1)

    # Human place name (municipality + district) so cells read as real locations.
    df = _attach_place(df)

    df["score"] = df["score"].round(4)
    df["model_score"] = df["model_score"].round(4)
    df["factor_model"] = df["model_score"]  # tooltip shows the raw model signal

    keep = [
        "cell_id", "lon", "lat", "municipality", "district",
        "score", "model_score", "suitability_class",
        "slope", "ghi", "cloud", "dist_powerline_m", "landcover", "protected",
        "veg_risk",
        "factor_sun", "factor_cloud", "factor_terrain", "factor_landuse",
        "factor_grid", "factor_vegetation", "factor_model",
        "exclusion_reason", "decision_reason",
        "top_positive_factors", "top_negative_factors", "tooltip",
    ]
    keep = [c for c in keep if c in df.columns]
    out = grid.merge(df[keep], on="cell_id", how="left")
    out.to_file(config.F_OUTPUT, driver="GeoJSON")

    counts = out["suitability_class"].value_counts().to_dict()
    print(f"[predict] wrote {len(out)} cells x {len(keep)+1} cols -> {config.F_OUTPUT.name}")
    print(f"[predict] class counts: {counts}")
    return out


if __name__ == "__main__":
    predict()
