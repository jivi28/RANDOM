"""Fetch real Bavaria cloud-cover climatology from Open-Meteo (no API key).

For every grid cell we pull daily mean cloud cover for a recent full year and
average it to a single annual mean cloud fraction (0..1). Cached to
`data/raw/cloud_cover_bavaria.csv` so it can enrich the suitability output
without a Google Earth Engine round-trip.

Run:
    python scripts/fetch_cloud_openmeteo.py
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

import geopandas as gpd
import pandas as pd

from src import config

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
YEAR = ("2023-01-01", "2023-12-31")   # one recent complete year
BATCH = 20                             # coords per request (Open-Meteo multi-point)
ROUND = 0.25                           # dedupe cells onto a ~0.25 deg climatology grid


def _fetch_batch(lats: list[float], lons: list[float]) -> list[float]:
    """Annual-mean cloud fraction (0..1) for a batch of coordinates, with backoff."""
    q = urllib.parse.urlencode({
        "latitude": ",".join(f"{x:.4f}" for x in lats),
        "longitude": ",".join(f"{x:.4f}" for x in lons),
        "start_date": YEAR[0], "end_date": YEAR[1],
        "daily": "cloud_cover_mean", "timezone": "UTC",
    })
    url = f"{ARCHIVE}?{q}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                wait = 5 * (attempt + 1)
                print(f"[cloud]   429, backing off {wait}s")
                time.sleep(wait)
            else:
                raise
    locs = data if isinstance(data, list) else [data]
    out = []
    for loc in locs:
        vals = [v for v in loc["daily"]["cloud_cover_mean"] if v is not None]
        out.append(sum(vals) / len(vals) / 100.0 if vals else float("nan"))
    return out


def fetch_clouds() -> pd.DataFrame:
    grid = gpd.read_file(config.F_OUTPUT)[["cell_id", "lon", "lat"]]

    # Dedupe onto a coarse climatology grid: cloud cover is smooth and the
    # underlying reanalysis is ~0.25 deg, so neighbouring cells share a value.
    grid["klat"] = (grid["lat"] / ROUND).round() * ROUND
    grid["klon"] = (grid["lon"] / ROUND).round() * ROUND
    keys = grid[["klat", "klon"]].drop_duplicates().reset_index(drop=True)
    print(f"[cloud] {len(grid)} cells -> {len(keys)} unique {ROUND} deg points")

    vals: list[float] = []
    for i in range(0, len(keys), BATCH):
        chunk = keys.iloc[i:i + BATCH]
        vals.extend(_fetch_batch(chunk["klat"].tolist(), chunk["klon"].tolist()))
        print(f"[cloud] fetched {min(i + BATCH, len(keys))}/{len(keys)} points")
        time.sleep(2.0)   # be polite to the free endpoint

    keys["cloud"] = vals
    grid = grid.merge(keys, on=["klat", "klon"], how="left")
    grid["cloud"] = grid["cloud"].round(4)

    out = config.RAW / "cloud_cover_bavaria.csv"
    grid[["cell_id", "lon", "lat", "cloud"]].to_csv(out, index=False)
    ok = grid["cloud"].notna().sum()
    print(f"[cloud] wrote {ok}/{len(grid)} cells "
          f"(mean {grid['cloud'].mean():.3f}, "
          f"range {grid['cloud'].min():.3f}-{grid['cloud'].max():.3f}) -> {out.name}")
    return grid


if __name__ == "__main__":
    fetch_clouds()
