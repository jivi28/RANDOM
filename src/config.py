"""Central configuration for the solar-farm land-suitability classifier.

Everything tunable lives here so the pipeline scripts stay declarative.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# --- Paths -----------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
INTERIM = DATA / "interim"
PROCESSED = DATA / "processed"
MODELS = ROOT / "models"
OUTPUTS = ROOT / "outputs"
for _d in (RAW, INTERIM, PROCESSED, MODELS, OUTPUTS):
    _d.mkdir(parents=True, exist_ok=True)

# --- Google Earth Engine ---------------------------------------------------
GEE_PROJECT = os.getenv("GEE_PROJECT", "").strip()

# AlphaEarth Foundations annual satellite embeddings (64 bands, 10 m).
EMBEDDING_COLLECTION = "GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL"
EMBEDDING_YEAR = 2024          # latest annual layer; falls back in gee_data if missing
EMBEDDING_BANDS = [f"A{i:02d}" for i in range(64)]  # A00..A63

# Tier-2 feature datasets (all in-GEE).
WORLDCOVER = "ESA/WorldCover/v200"          # 10 m land cover (one image collection)
SRTM = "USGS/SRTMGL1_003"                    # elevation -> slope
ERA5_MONTHLY = "ECMWF/ERA5_LAND/MONTHLY_AGGR"  # surface_solar_radiation_downwards_sum
# MODIS monthly atmosphere product -> mean cloud fraction (Cloud_Fraction_Mean_Mean,
# 0..1 after the 0.0001 scale). The explicit "how cloudy is the sky" signal that
# complements GHI (which already nets out clouds in the radiation it reports).
MODIS_CLOUD = "MODIS/061/MOD08_M3"
WDPA = "WCMC/WDPA/current/polygons"            # World Database on Protected Areas

# Local power-line file (auto-fetched from OSM if absent; drop in an official
# powerlines_bavaria.geojson to override). Powers the `factor_grid` factor.
F_POWERLINES = RAW / "powerlines_bavaria.geojson"

# Per-power-line vegetation encroachment (osm_id -> vegetation_risk in [0,1],
# 1 = vegetation right on the line, 0 = corridor clear). Keyed to F_POWERLINES by
# osm_id. Optional: powers the `factor_vegetation` factor / vegetation discount.
F_VEGETATION = RAW / "vegetation_risk_data.csv"

# WorldCover class codes we treat as *non-buildable* for solar (exclusion mask).
# 10 tree, 50 built-up, 80 perm. water, 90 herbaceous wetland, 95 mangrove.
WORLDCOVER_EXCLUDE = [10, 50, 80, 90, 95]

# Human-readable names for every ESA WorldCover v200 class (for reasons/tooltip).
WORLDCOVER_NAMES = {
    10: "forest / tree cover", 20: "shrubland", 30: "grassland",
    40: "cropland", 50: "built-up area", 60: "bare / sparse vegetation",
    70: "snow & ice", 80: "open water", 90: "herbaceous wetland",
    95: "mangrove", 100: "moss & lichen",
}
# How good each (non-excluded) land cover is to actually build a solar farm on,
# 0..1. Feeds the `land use` factor score and its reason text.
WORLDCOVER_SUITABILITY = {
    30: 1.00,   # grassland - ideal
    60: 0.95,   # bare / sparse - ideal
    40: 0.85,   # cropland - common, some land-use conflict
    20: 0.70,   # shrubland - workable
    100: 0.40,  # moss & lichen - marginal
    70: 0.10,   # snow & ice - poor
}

# --- Region: Bavaria -------------------------------------------------------
# FAO GAUL admin-1 name for the boundary lookup.
GAUL_L1 = "FAO/GAUL/2015/level1"
BAVARIA_ADM1_NAME = "Bayern"
# Rough bbox fallback (minlon, minlat, maxlon, maxlat) if GAUL is unavailable.
BAVARIA_BBOX = (8.9, 47.2, 13.9, 50.6)

# --- Grid ------------------------------------------------------------------
GRID_CELL_KM = 5.0            # CheckList Step 1: 5 km x 5 km candidate cells

# --- Labels ----------------------------------------------------------------
# Tried in order; first one that answers wins. Mirrors differ in load/policy,
# so a 406/429/5xx on one is routine -> fall through to the next.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OVERPASS_URL = OVERPASS_ENDPOINTS[0]   # back-compat alias
OVERPASS_UA = "solar-suitability-hackathon/1.0 (Overpass label fetch)"
# OSM returns ~27k solar features for Bavaria (mostly rooftop PV). Cap the
# positives used for training so GEE sampling stays tractable; the full
# download is still cached to F_SOLAR. Set to None to use all of them.
MAX_POSITIVES = 2000
NEG_PER_POS = 3               # background points per positive
POS_BUFFER_M = 2000           # keep negatives at least this far from any solar farm
RANDOM_SEED = 42

# --- Model -----------------------------------------------------------------
RF_PARAMS = dict(
    n_estimators=400,
    max_depth=None,
    min_samples_leaf=2,
    class_weight="balanced",
    n_jobs=-1,
    random_state=RANDOM_SEED,
)
SPATIAL_SPLIT_KM = 25.0       # block size for spatial train/test split

# --- Solar-resource weighting ----------------------------------------------
# The RandomForest learns "looks like existing solar land"; on its own it does
# not guarantee that sunnier / less-cloudy cells outrank cloudier ones. We nudge
# the model score by a solar-resource factor (sunlight + cloud cover) so the
# final rating respects the weather: clear, high-irradiance cells move up, cloudy
# / low-irradiance cells move down.
#   adjusted = model_score * (1 + RESOURCE_WEIGHT * (resource - 0.5))
# resource in [0,1] (0.5 = grid-average), so a fully sunny/clear cell gets up to
# +RESOURCE_WEIGHT/2 and a fully cloudy/dark cell down to -RESOURCE_WEIGHT/2.
RESOURCE_WEIGHT = 0.50        # 0 disables the nudge; 0.5 = +/-25% at the extremes
# Share of the resource factor that comes from explicit cloud cover vs. GHI.
# Falls back to GHI-only automatically when no cloud column is present.
CLOUD_SHARE = 0.40

# --- Vegetation-encroachment discount --------------------------------------
# A cell's nearest power line is its likely grid interconnection; if that line's
# corridor is overgrown (high vegetation_risk) the interconnection is a weaker
# selling point (reliability / clearing cost), so we *discount* the score:
#   adjusted = score * (1 - VEG_RISK_WEIGHT * veg_risk)
# Discount-only (a clear corridor never inflates a cell) and gated to cells
# actually near the grid, so a distant overgrown line never penalises far land.
VEG_RISK_WEIGHT = 0.15        # 0 disables; 0.15 = up to -15% when fully encroached
VEG_RISK_NEAR_M = 2500.0      # only discount cells within this dist of a power line

# --- Output ----------------------------------------------------------------
# Suitability score thresholds -> classes (probability of "suitable").
CLASS_THRESHOLDS = {"good": 0.60, "okay": 0.35}  # else "bad"; excluded -> "excluded"

# Named files
F_BAVARIA = RAW / "bavaria.geojson"
F_SOLAR = RAW / "solar_farms.geojson"
F_LABELS = RAW / "labels.geojson"
F_GRID = INTERIM / "bavaria_grid.geojson"
F_LABEL_FEATURES = INTERIM / "label_features.csv"
F_GRID_FEATURES = INTERIM / "grid_features.csv"
F_MODEL = MODELS / "suitability_rf.pkl"
F_OUTPUT = OUTPUTS / "bavaria_suitability.geojson"

# Administrative boundary files (bundled in public/geo) used to label each cell
# with a human place name: municipality (Gemeinde) + district (Landkreis).
F_GEMEINDEN = ROOT / "public" / "geo" / "bavaria_gemeinden.geojson"
F_KREISE = ROOT / "public" / "geo" / "bavaria_kreise.geojson"
