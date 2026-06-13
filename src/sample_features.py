"""Sample features at point locations via Google Earth Engine.

Primary features  : 64-dim AlphaEarth embedding (A00..A63).
Tier-2 features   : slope (SRTM), annual GHI (ERA5-Land), land-cover (WorldCover).
Local Tier-2      : distance to nearest power line, if powerlines geojson present.

Used for both the labelled training points and the prediction grid centroids.

Run:
    python -m src.sample_features labels    # -> data/interim/label_features.csv
    python -m src.sample_features grid      # -> data/interim/grid_features.csv
"""
from __future__ import annotations

import sys
import time

import ee
import geopandas as gpd
import pandas as pd

from . import config
from .gee_auth import get_embedding_image, init

CHUNK = 400  # points per GEE request


def feature_image(tier2: bool = True) -> "ee.Image":
    """Stack of all GEE-derived feature bands."""
    img = get_embedding_image()
    if not tier2:
        return img

    slope = ee.Terrain.slope(ee.Image(config.SRTM)).rename("slope")

    ghi = (
        ee.ImageCollection(config.ERA5_MONTHLY)
        .filterDate("2023-01-01", "2023-12-31")
        .select("surface_solar_radiation_downwards_sum")
        .sum()
        .rename("ghi")
    )

    landcover = (
        ee.ImageCollection(config.WORLDCOVER).first().select("Map").rename("landcover")
    )

    # Mean cloud fraction (0..1) over recent years. Explicit "cloudiness" signal:
    # higher = more clouds = worse for solar. Multi-year mean smooths weather noise.
    cloud = (
        ee.ImageCollection(config.MODIS_CLOUD)
        .filterDate("2020-01-01", "2024-12-31")
        .select("Cloud_Fraction_Mean_Mean")
        .mean()
        .multiply(0.0001)
        .rename("cloud")
    )

    return img.addBands([slope, ghi, landcover, cloud])


def _sample_chunk(img: "ee.Image", pts: list[dict]) -> list[dict]:
    """Reduce `img` at a chunk of points; returns list of property dicts."""
    feats = [ee.Feature(ee.Geometry.Point([p["lon"], p["lat"]]), {"_idx": p["_idx"]})
             for p in pts]
    fc = ee.FeatureCollection(feats)
    sampled = img.reduceRegions(
        collection=fc, reducer=ee.Reducer.first(), scale=10
    )
    return [f["properties"] for f in sampled.getInfo()["features"]]


def sample_points(gdf: gpd.GeoDataFrame, tier2: bool = True) -> pd.DataFrame:
    """Sample the feature image at every row's (lon, lat)."""
    init()
    img = feature_image(tier2)

    recs = gdf.reset_index(drop=True)
    recs = recs.assign(_idx=range(len(recs)))
    pts = recs[["_idx", "lon", "lat"]].to_dict("records")

    out: list[dict] = []
    for i in range(0, len(pts), CHUNK):
        chunk = pts[i:i + CHUNK]
        out.extend(_sample_chunk(img, chunk))
        print(f"[features] sampled {min(i+CHUNK, len(pts))}/{len(pts)}")
        time.sleep(0.2)

    feat_df = pd.DataFrame(out).set_index("_idx").sort_index()
    merged = recs.set_index("_idx").join(feat_df)
    return merged.reset_index(drop=True)


def add_powerline_distance(df: pd.DataFrame, gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    """Add `dist_powerline_m` if a powerlines geojson is available, else NaN."""
    pl_path = config.RAW / "powerlines_bavaria.geojson"
    if not pl_path.exists():
        df["dist_powerline_m"] = float("nan")
        return df
    lines = gpd.read_file(pl_path).to_crs("EPSG:3035")
    pts = gpd.GeoDataFrame(
        df.copy(), geometry=gpd.points_from_xy(df.lon, df.lat), crs="EPSG:4326"
    ).to_crs("EPSG:3035")
    joined = gpd.sjoin_nearest(pts, lines[["geometry"]], distance_col="dist_powerline_m")
    joined = joined[~joined.index.duplicated(keep="first")]
    # Index-aligned (pts shares df's index): a positional .values copy would
    # silently misalign / raise if sjoin_nearest dropped or reordered rows.
    df["dist_powerline_m"] = joined["dist_powerline_m"]
    return df


def run(which: str, tier2: bool = True) -> pd.DataFrame:
    if which == "labels":
        gdf = gpd.read_file(config.F_LABELS)
        out_path = config.F_LABEL_FEATURES
    elif which == "grid":
        gdf = gpd.read_file(config.F_GRID)
        out_path = config.F_GRID_FEATURES
    else:
        raise SystemExit("argument must be 'labels' or 'grid'")

    df = sample_points(gdf, tier2=tier2)
    if tier2:
        df = add_powerline_distance(df, gdf)
    df = df.drop(columns=["geometry"], errors="ignore")
    df.to_csv(out_path, index=False)
    print(f"[features] wrote {len(df)} rows x {df.shape[1]} cols -> {out_path.name}")
    return df


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "labels")
