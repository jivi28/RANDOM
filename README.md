# Solar-Farm Land-Suitability Classifier (Bavaria)

ML classification branch of the Energy/AI hackathon project
(*Direction 8 — Satellite Intelligence for Energy*).

It learns **where good solar-farm land is in Bavaria** from Google DeepMind's
**AlphaEarth Foundations** satellite embeddings (64-dim vector per 10 m patch, in
Google Earth Engine) — no vision model, no GPU. Output is a map-ready GeoJSON of
5 km grid cells scored **good / okay / bad**, which the frontend branch renders
green → yellow → red.

## The idea (PU / proxy labels)

There's no ground-truth "this cell is suitable" dataset, so:

- **Positives** = existing solar farms (OpenStreetMap). Developers already built
  where conditions are good → these are examples of *suitable* land.
- **Background** = random Bavaria points away from any farm.
- A RandomForest on the AlphaEarth embedding learns *what suitable solar land
  looks like*; its predicted probability **is** the suitability score.
- Undeveloped cells that *look like* existing farms → high score → candidate sites.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set GEE_PROJECT=your-gcp-project-id
earthengine authenticate      # one-time; you already have GEE access
python -m src.gee_auth        # connectivity check
```

## Run

```bash
python -m src.pipeline          # full run (Tier-2 features)
python -m src.pipeline --tier1  # embeddings-only, fastest
```

Or step by step: `labels → grid → sample_features labels → train →
sample_features grid → predict` (see `src/`).

## Data sources

| Data | Source | Role |
|---|---|---|
| AlphaEarth embeddings | GEE `GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL` | features (64-dim) |
| Solar farms | OpenStreetMap via Overpass API | positive labels |
| Bavaria boundary | GEE `FAO/GAUL/2015/level1` | region / grid |
| Land cover 10 m | GEE `ESA/WorldCover/v200` | exclusion mask + feature |
| Slope | GEE `USGS/SRTMGL1_003` | terrain feature |
| GHI | GEE `ECMWF/ERA5_LAND/MONTHLY_AGGR` | irradiance feature + resource score |
| Cloud cover | GEE `MODIS/061/MOD08_M3` (`Cloud_Fraction_Mean_Mean`) | cloudiness feature + resource score |
| Power lines | `data/raw/powerlines_bavaria.geojson` (optional) | grid-proximity feature |
| Vegetation encroachment | `data/raw/vegetation_risk_data.csv` (optional, keyed by `osm_id`) | per-line corridor risk -> `factor_vegetation` discount |

## Weather resource weighting

The RandomForest only learns *"looks like existing solar land"*; on its own it
doesn't guarantee a sunny cell outranks an equally-looking cloudy one. So the
final `score` is the model probability **nudged by a solar-resource factor**
(sunlight from GHI + clear-sky fraction from cloud cover):

```
score = model_score * (1 + RESOURCE_WEIGHT * (resource - 0.5))   # clipped to [0,1]
```

Sunny / clear cells move up, cloudy / low-irradiance cells move down (±25 % at
the extremes by default — tune `RESOURCE_WEIGHT` / `CLOUD_SHARE` in `config.py`).

A second, **discount-only** modifier handles **vegetation encroachment**: each
cell inherits the `vegetation_risk` (0–1) of its *nearest* power line, and a cell
that is actually near the grid (≤ `VEG_RISK_NEAR_M`) is marked down when that
line's corridor is overgrown (`score *= 1 - VEG_RISK_WEIGHT * veg_risk`, up to
−15 % when fully encroached). A clear corridor never inflates a cell, and far-
from-grid land is never penalised for a distant overgrown line. This is a grid
reliability / clearing-cost signal, so it lives as a post-hoc factor
(`factor_vegetation`) — **not** a RandomForest feature (the RF learns land
*appearance* from embeddings; vegetation-on-lines isn't that). Tune
`VEG_RISK_WEIGHT` / `VEG_RISK_NEAR_M` in `config.py`; the whole step is a no-op
if `data/raw/vegetation_risk_data.csv` is absent.
It falls back to GHI alone if cloud data is absent, and leaves a cell unchanged
if both are missing. The raw model probability is kept as `model_score` /
`factor_model` so tooltips still show the pure model signal, and every cell's
`tooltip` / `decision_reason` states the solar resource explicitly
(e.g. *"Solar resource: strong sunlight, clear skies"*).

Cloud cover comes from GEE/MODIS during a normal pipeline run. **Without GEE**,
fetch real Bavaria cloud climatology from the free Open-Meteo archive and
regenerate the output from the cached RandomForest scores:

```bash
python scripts/fetch_cloud_openmeteo.py   # -> data/raw/cloud_cover_bavaria.csv
python scripts/regenerate_output.py       # re-scores using GHI + cloud, no GEE
```

`src.predict` also auto-loads `data/raw/cloud_cover_bavaria.csv` when the MODIS
cloud band is missing.

## Output

`outputs/bavaria_suitability.geojson` — one feature per 5 km cell with
`score` ∈ [0,1] (resource-adjusted), `model_score` (raw RF), `suitability_class`
(good/okay/bad/excluded) and a feature breakdown (slope, ghi, cloud,
dist_powerline_m, landcover, veg_risk) plus interpretable `factor_*` fields (incl.
`factor_sun`, `factor_cloud`, `factor_vegetation`) for the map tooltip.

## Layout

```
src/config.py          all tunables / paths / dataset ids
src/gee_auth.py        GEE init + Bavaria + embedding helpers
src/labels.py          Overpass solar farms + random negatives
src/grid.py            Bavaria 5 km grid
src/sample_features.py sample AlphaEarth (+Tier-2) at points
src/train.py           RandomForest + spatial hold-out + save model
src/predict.py         score grid -> GeoJSON
src/pipeline.py        run all steps
notebooks/01_train_suitability.ipynb   metrics + map preview
```
