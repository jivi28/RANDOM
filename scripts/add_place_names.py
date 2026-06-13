"""Patch an already-built suitability GeoJSON in place, using only the Python
standard library, for environments where the full geopandas pipeline can't be
re-run. Two patches, both mirroring changes in `src.predict`:

1. Add `municipality` + `district` place names (mirrors `_attach_place`):
   point-in-polygon (ray casting, with a bounding-box pre-filter) of each cell's
   lon/lat against the bundled boundary files in public/geo.
2. Rewrite the headline wording baked into the `tooltip` / `decision_reason`
   text to match the new class labels (mirrors `_HEADLINE`):
   "Okay candidate" -> "Satisfactory candidate", "Weak candidate" -> "Inadequate
   candidate".

    python scripts/add_place_names.py

Idempotent: re-running overwrites the same fields / re-applies the same text
substitutions. Border cells with no containing polygon get null, which the
frontend renders as the bare cell id.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [ROOT / "outputs" / "bavaria_suitability.geojson",
           ROOT / "public" / "bavaria_suitability.geojson"]
GEMEINDEN = ROOT / "public" / "geo" / "bavaria_gemeinden.geojson"
KREISE = ROOT / "public" / "geo" / "bavaria_kreise.geojson"

# Headline wording fixups to match the updated class labels (see _HEADLINE).
HEADLINE_FIXUPS = {
    "Okay candidate": "Satisfactory candidate",
    "Weak candidate": "Inadequate candidate",
}


def _rings_of(geom: dict):
    """Yield each polygon's ring list ([exterior, *holes]) for Polygon/MultiPolygon."""
    t = geom.get("type")
    if t == "Polygon":
        yield geom["coordinates"]
    elif t == "MultiPolygon":
        yield from geom["coordinates"]


def _bbox(rings) -> tuple[float, float, float, float]:
    xs = [pt[0] for pt in rings[0]]
    ys = [pt[1] for pt in rings[0]]
    return min(xs), min(ys), max(xs), max(ys)


def _in_ring(x: float, y: float, ring) -> bool:
    """Ray-casting point-in-polygon for a single ring."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _in_polygon(x: float, y: float, rings) -> bool:
    """Inside the exterior ring and outside every hole."""
    if not _in_ring(x, y, rings[0]):
        return False
    return not any(_in_ring(x, y, hole) for hole in rings[1:])


def _index(path: Path):
    """[(name, type, [(bbox, rings), ...]), ...] for each boundary feature."""
    data = json.loads(path.read_text())
    idx = []
    for f in data["features"]:
        props = f["properties"]
        polys = [(_bbox(r), r) for r in _rings_of(f["geometry"])]
        idx.append((props.get("name"), props.get("type"), polys))
    return idx


def _lookup(x: float, y: float, idx):
    for name, typ, polys in idx:
        for (minx, miny, maxx, maxy), rings in polys:
            if minx <= x <= maxx and miny <= y <= maxy and _in_polygon(x, y, rings):
                return name, typ
    return None, None


def main() -> None:
    gem_idx = _index(GEMEINDEN)
    krs_idx = _index(KREISE)
    print(f"[place] {len(gem_idx)} municipalities, {len(krs_idx)} districts")

    src = next(p for p in TARGETS if p.exists())
    data = json.loads(src.read_text())
    feats = data["features"]

    matched = 0
    for f in feats:
        p = f["properties"]
        x, y = p.get("lon"), p.get("lat")
        if x is None or y is None:
            xs = [c[0] for c in f["geometry"]["coordinates"][0]]
            ys = [c[1] for c in f["geometry"]["coordinates"][0]]
            x, y = sum(xs) / len(xs), sum(ys) / len(ys)
        mun, _ = _lookup(x, y, gem_idx)
        kname, ktype = _lookup(x, y, krs_idx)
        district = None
        if isinstance(kname, str):
            if isinstance(ktype, str) and ktype.startswith("Landkreis"):
                district = f"LK {kname}"
            else:  # Kreisfreie Stadt — drop the " Städte" suffix in the source data
                district = kname.removesuffix(" Städte")
        p["municipality"] = mun
        p["district"] = district
        if mun or district:
            matched += 1
        for field in ("tooltip", "decision_reason"):
            v = p.get(field)
            if isinstance(v, str):
                for old, new in HEADLINE_FIXUPS.items():
                    v = v.replace(old, new)
                p[field] = v
    print(f"[place] matched {matched}/{len(feats)} cells")

    payload = json.dumps(data)
    for t in TARGETS:
        t.write_text(payload)
        print(f"[place] wrote {t.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
