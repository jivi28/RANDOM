# Solario — Frontend (Bavaria solar-suitability map)

Interactive map that visualises the ground-mounted PV suitability scoring produced
on the [`aiclassification`](https://github.com/jivi28/RANDOM/tree/aiclassification)
branch. Built with Next.js 16 + React 19 + `react-simple-maps` + framer-motion.

## What it shows

All **3,061 grid cells** of Bavaria from `outputs/bavaria_suitability.geojson`,
coloured by `suitability_class`:

| Class | Colour | Count |
|-----------|--------|------:|
| good      | green  |    27 |
| okay      | yellow |    59 |
| bad       | red    | 1,058 |
| excluded  | gray   | 1,917 |

- **Hover** a cell → one-line `tooltip`.
- **Click** a cell → side panel with score, slope, grid distance, protected flag,
  the five `factor_*` sub-scores as bars, and the `decision_reason`.
- **Hide excluded cells** toggle to focus on buildable land.

## Run it

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

## Data contract

The only input is `bavaria_suitability.geojson` (EPSG:4326 / lon-lat, one Polygon
per cell). Per-cell `properties`:

```
cell_id, lon, lat, score, suitability_class,
slope, ghi, dist_powerline_m, landcover, protected (0|1),
factor_sun, factor_terrain, factor_landuse, factor_grid, factor_model,
exclusion_reason, decision_reason,
top_positive_factors, top_negative_factors, tooltip
```

### Where the data comes from

By default the app fetches the file from the raw `aiclassification` URL, so a fresh
clone works with zero setup:

```
https://raw.githubusercontent.com/jivi28/RANDOM/aiclassification/outputs/bavaria_suitability.geojson
```

To serve it locally/offline instead, drop the file into `public/` and set:

```bash
# .env.local
NEXT_PUBLIC_SUITABILITY_GEOJSON=/bavaria_suitability.geojson
```

The override constant lives in `components/BavariaSuitabilityMap.tsx`.

## Structure

```
app/page.tsx                      → renders <BavariaSuitabilityMap />
components/BavariaSuitabilityMap.tsx → the map + detail panel
app/layout.tsx, app/globals.css   → shell, theme, Tailwind v4
```
