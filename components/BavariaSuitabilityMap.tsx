"use client"

import { useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ComposableMap, Geographies, Geography, ZoomableGroup, Marker, useMapContext } from "react-simple-maps"

// ─── Contract with the aiclassification pipeline ──────────────────────────────
// Source of truth: outputs/bavaria_suitability.geojson, produced by the Python
// pipeline now merged into main (EPSG:4326, lon/lat). 3,061 grid cells, one
// Polygon each. Served via the raw GitHub URL so a fresh clone works with zero
// setup; a local copy also lives at /public/bavaria_suitability.geojson.
// Set NEXT_PUBLIC_SUITABILITY_GEOJSON to override (e.g. "/bavaria_suitability.geojson").
const GEOJSON_URL =
  process.env.NEXT_PUBLIC_SUITABILITY_GEOJSON ||
  "https://raw.githubusercontent.com/jivi28/RANDOM/main/outputs/bavaria_suitability.geojson"

// Administrative context, bundled locally (see public/geo). Regierungsbezirke
// (7) draw at every zoom; the finer Landkreise (96) fade in once you zoom past
// REGBEZ_TO_KREIS so the map reads like a real atlas instead of bare blocks.
const REGBEZ_URL = "/geo/bavaria_regbez.geojson"
const KREIS_URL = "/geo/bavaria_kreise.geojson"
const GEM_URL = "/geo/bavaria_gemeinden.geojson"
const CITIES_URL = "/geo/bavaria_cities.json"
const OUTLINE_URL = "/geo/bavaria_outline.geojson"

// Satellite basemap is served as live XYZ tiles (ArcGIS World Imagery, no key)
// so it sharpens as you zoom instead of pixelating like one static image. Tiles
// are projected into the map's own coordinate space and clipped to the Bavaria
// boundary, so nothing shows outside the state.
const TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`

// Zoom thresholds that drive what detail is revealed.
const REGBEZ_TO_KREIS = 2.6 // kreis outlines start fading in here
const KREIS_TO_GEM = 5.5 // Gemeinde (municipality) outlines fade in here
const TIER2_ZOOM = 1.8 // mid-size cities (Regensburg, Ingolstadt…) appear
const TIER3_ZOOM = 3.2 // mid-size towns appear
const TIER4_ZOOM = 5.0 // small towns appear
const TIER5_ZOOM = 7.5 // villages appear

// Gaussian-blur radius (in base map units) applied to the suitability grid so
// the 5 km blocks melt into a continuous heat-surface. Purely visual: the cell
// geometry, coordinates and data are untouched. It lives inside ZoomableGroup,
// so the blur scales with zoom and the melt stays proportional at every level.
const GRID_MELT_BLUR = 3.4

type SuitabilityClass = "good" | "okay" | "bad" | "excluded"

interface CellProps {
  cell_id: number
  lon: number
  lat: number
  // Nullable: cells excluded for "missing data" carry nulls in the GeoJSON.
  score: number | null
  suitability_class: SuitabilityClass
  slope: number | null
  ghi: number | null
  dist_powerline_m: number | null
  landcover: number | null
  protected: number
  factor_sun: number
  factor_terrain: number
  factor_landuse: number
  factor_grid: number
  factor_model: number
  exclusion_reason: string
  decision_reason: string
  top_positive_factors: string
  top_negative_factors: string
  tooltip: string
}

interface City {
  name: string
  coordinates: [number, number]
  pop: number
  tier: 1 | 2 | 3
}

// ─── Class → colour ───────────────────────────────────────────────────
const CLASS_COLOR: Record<SuitabilityClass, string> = {
  good: "#22c55e",
  okay: "#eab308",
  bad: "#ef4444",
  excluded: "#6b7280",
}
const CLASS_LABEL: Record<SuitabilityClass, string> = {
  good: "Good",
  okay: "Okay",
  bad: "Bad",
  excluded: "Excluded",
}

function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const FACTORS: { key: keyof CellProps; label: string }[] = [
  { key: "factor_sun", label: "Sun (GHI)" },
  { key: "factor_terrain", label: "Terrain" },
  { key: "factor_landuse", label: "Land use" },
  { key: "factor_grid", label: "Grid proximity" },
  { key: "factor_model", label: "Model" },
]

// ─── Factor bar ────────────────────────────────────────────────────
function FactorBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  const color = pct >= 66 ? "#22c55e" : pct >= 33 ? "#eab308" : "#ef4444"
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>{label}</span>
        <span style={{ fontSize: "11px", fontFamily: "monospace", color: "white" }}>{value.toFixed(3)}</span>
      </div>
      <div style={{ height: "5px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", overflow: "hidden" }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          style={{ height: "100%", background: color }}
        />
      </div>
    </div>
  )
}

// ─── Detail panel for a selected cell ───────────────────────────────────
function CellPanel({ cell, onClose }: { cell: CellProps; onClose: () => void }) {
  const color = CLASS_COLOR[cell.suitability_class]
  // score is a 0..1 probability; "missing data" cells carry nulls.
  const stats = [
    { label: "Score", value: cell.score != null ? cell.score.toFixed(2) : "n/a" },
    { label: "Slope", value: cell.slope != null ? `${cell.slope.toFixed(1)}°` : "n/a" },
    { label: "Grid dist.", value: cell.dist_powerline_m != null ? `${(cell.dist_powerline_m / 1000).toFixed(1)} km` : "n/a" },
    { label: "Protected", value: cell.protected ? "Yes" : "No" },
  ]
  return (
    <motion.div
      initial={{ x: 340, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 340, opacity: 0 }}
      transition={{ type: "spring", stiffness: 280, damping: 30 }}
      style={{
        position: "absolute", right: 0, top: 0, height: "100%", width: "320px",
        background: "rgba(8,10,18,0.97)", borderLeft: "1px solid rgba(255,255,255,0.08)",
        zIndex: 40, overflowY: "auto", backdropFilter: "blur(10px)",
      }}
    >
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "monospace", fontSize: "10px", letterSpacing: "0.15em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase" }}>
            Cell #{cell.cell_id}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <span style={{
          display: "inline-block", marginTop: "10px",
          background: hexToRgba(color, 0.13), border: `1px solid ${hexToRgba(color, 0.4)}`,
          color, fontSize: "11px", fontWeight: 700, padding: "3px 9px", borderRadius: "5px", fontFamily: "monospace",
        }}>
          {CLASS_LABEL[cell.suitability_class].toUpperCase()} · SCORE {cell.score != null ? cell.score.toFixed(2) : "—"}
        </span>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.6)", marginTop: "12px", lineHeight: 1.5 }}>
          {cell.tooltip}
        </p>
      </div>

      {/* Stats grid */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
          {stats.map((s) => (
            <div key={s.label}>
              <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "3px" }}>{s.label}</div>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "white" }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Factor breakdown */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "14px" }}>
          Factor breakdown
        </div>
        {FACTORS.map((f) => (
          <FactorBar key={f.key} label={f.label} value={Number(cell[f.key]) || 0} />
        ))}
      </div>

      {/* Reasoning */}
      <div style={{ padding: "20px" }}>
        <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "10px" }}>
          Decision
        </div>
        <p style={{ fontSize: "13px", color: "white", marginBottom: "10px" }}>{cell.decision_reason}</p>
        {cell.top_positive_factors && (
          <p style={{ fontSize: "12px", color: "#22c55e", marginBottom: "4px" }}>＋ {cell.top_positive_factors}</p>
        )}
        {cell.top_negative_factors && (
          <p style={{ fontSize: "12px", color: "#ef4444" }}>－ {cell.top_negative_factors}</p>
        )}
      </div>
    </motion.div>
  )
}

// ─── Satellite tile basemap ─────────────────────────────────────────────
// Web-Mercator XYZ tiles, projected into the map's own coordinate space and
// clipped to the Bavaria boundary. The tile zoom level tracks the view zoom, so
// the imagery gets sharper the further you zoom in (a static image can't). Lives
// inside <ComposableMap> to read the live projection (with .invert/.scale) and
// the geoPath used to build the clip mask.
type D3Proj = ((c: [number, number]) => [number, number] | null) & {
  invert?: (p: [number, number]) => [number, number] | null
  scale?: () => number
}
const lon2t = (lon: number, n: number) => ((lon + 180) / 360) * n
const lat2t = (lat: number, n: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
}
const t2lon = (x: number, n: number) => (x / n) * 360 - 180
const t2lat = (y: number, n: number) => {
  const m = Math.PI - (2 * Math.PI * y) / n
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)))
}

// Project every vertex of the Bavaria boundary into base map coordinates and
// emit one SVG path string, used as the clip mask for the satellite tiles.
function buildClipPath(outline: BoundaryGeojson | null, projection: D3Proj): string | null {
  const geom = outline?.features?.[0]?.geometry as
    | { type: string; coordinates: number[][][] | number[][][][] }
    | undefined
  if (!geom) return null
  const rings: number[][][] =
    geom.type === "Polygon"
      ? (geom.coordinates as number[][][])
      : geom.type === "MultiPolygon"
        ? (geom.coordinates as number[][][][]).flat()
        : []
  let d = ""
  for (const ring of rings) {
    let started = false
    for (const pt of ring) {
      const p = projection([pt[0], pt[1]] as [number, number])
      if (!p) continue
      d += `${started ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`
      started = true
    }
    d += "Z"
  }
  return d || null
}

function SatelliteTiles({
  view,
  outline,
  opacity,
}: {
  view: { coordinates: [number, number]; zoom: number }
  outline: BoundaryGeojson | null
  opacity: number
}) {
  const ctx = useMapContext() as { projection?: D3Proj } | undefined
  const projection = ctx?.projection
  if (!projection || !projection.invert || !projection.scale) return null

  const Z = view.zoom
  const center = projection(view.coordinates)
  if (!center) return null

  // Visible window in the base (zoom-1) projected coordinate system. ComposableMap
  // renders into an 800×600 viewBox; ZoomableGroup scales that by Z about `center`.
  const halfW = 400 / Z
  const halfH = 300 / Z
  const tl = projection.invert([center[0] - halfW, center[1] - halfH]) // lon_min, lat_max
  const br = projection.invert([center[0] + halfW, center[1] + halfH]) // lon_max, lat_min
  if (!tl || !br) return null
  const lonMin = Math.max(8.6, Math.min(tl[0], br[0]))
  const lonMax = Math.min(14.0, Math.max(tl[0], br[0]))
  const latMin = Math.max(47.1, Math.min(tl[1], br[1]))
  const latMax = Math.min(50.7, Math.max(tl[1], br[1]))

  // Pick a tile zoom so one tile lands near ~256 screen px, then sharpen by one
  // level for retina. World width in base px = 2π·scale; ×Z gives current width.
  const worldPx = 2 * Math.PI * projection.scale()
  let tz = Math.round(Math.log2((worldPx * Z) / 256) + 2) // +2 → crisp on retina
  tz = Math.max(7, Math.min(18, tz))

  // Build the tile list, dropping a zoom level if the window asks for too many.
  let tiles: { z: number; x: number; y: number; px: number; py: number; w: number; h: number }[] = []
  for (let guard = 0; guard < 6; guard++) {
    const n = 2 ** tz
    const x0 = Math.floor(lon2t(lonMin, n))
    const x1 = Math.floor(lon2t(lonMax, n))
    const y0 = Math.floor(lat2t(latMax, n))
    const y1 = Math.floor(lat2t(latMin, n))
    const count = (x1 - x0 + 1) * (y1 - y0 + 1)
    if (count > 110 && tz > 7) { tz -= 1; continue }
    tiles = []
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const nw = projection([t2lon(x, n), t2lat(y, n)])
        const se = projection([t2lon(x + 1, n), t2lat(y + 1, n)])
        if (!nw || !se) continue
        // +0.5 px overlap hides hairline seams between tiles.
        tiles.push({ z: tz, x, y, px: nw[0], py: nw[1], w: se[0] - nw[0] + 0.5, h: se[1] - nw[1] + 0.5 })
      }
    }
    break
  }

  const clipId = "bavaria-clip"
  // Build the clip outline from the projection ourselves (context.path proved
  // unreliable inside the zoom group). Project every boundary vertex into the
  // same base coordinate space the tiles use, so the mask lines up exactly.
  const clipD = buildClipPath(outline, projection)

  return (
    <g style={{ pointerEvents: "none" }}>
      {clipD && (
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <path d={clipD} />
          </clipPath>
        </defs>
      )}
      <g clipPath={clipD ? `url(#${clipId})` : undefined}>
        <g opacity={opacity} style={{ filter: "brightness(0.85) saturate(0.95)" }}>
          {tiles.map((t) => (
            <image
              key={`${t.z}/${t.x}/${t.y}`}
              href={TILE_URL(t.z, t.x, t.y)}
              x={t.px}
              y={t.py}
              width={t.w}
              height={t.h}
              preserveAspectRatio="none"
            />
          ))}
        </g>
      </g>
    </g>
  )
}

// ─── Main component ────────────────────────────────────────────────
interface SuitabilityGeojson {
  features: { properties: CellProps }[]
}
interface BoundaryGeojson {
  features: { properties: { name: string }; geometry: unknown }[]
}

const CENTER: [number, number] = [11.4, 48.95]
const MIN_ZOOM = 1
const MAX_ZOOM = 14

export default function BavariaSuitabilityMap() {
  const [selected, setSelected] = useState<CellProps | null>(null)
  const [hovered, setHovered] = useState<CellProps | null>(null)
  const [hideExcluded, setHideExcluded] = useState(false)
  const [showSatellite, setShowSatellite] = useState(true)
  const [data, setData] = useState<SuitabilityGeojson | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Administrative overlays + place labels.
  const [regbez, setRegbez] = useState<BoundaryGeojson | null>(null)
  const [kreise, setKreise] = useState<BoundaryGeojson | null>(null)
  const [gemeinden, setGemeinden] = useState<BoundaryGeojson | null>(null)
  const [outline, setOutline] = useState<BoundaryGeojson | null>(null)
  const [cities, setCities] = useState<City[]>([])

  // Live view state from the ZoomableGroup — drives label/boundary reveal and
  // keeps stroke/text sizes constant on screen as you zoom.
  const [view, setView] = useState<{ coordinates: [number, number]; zoom: number }>({
    coordinates: CENTER,
    zoom: 1,
  })

  // Fetch the suitability grid ourselves (instead of letting <Geographies> do
  // it) so we can compute header counts from the live data and surface fetch
  // errors instead of silently rendering a blank map.
  useEffect(() => {
    let cancelled = false
    fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((gj) => { if (!cancelled) setData(gj) })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [])

  // Admin overlays are best-effort: if they fail the grid still renders.
  useEffect(() => {
    let cancelled = false
    fetch(REGBEZ_URL).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setRegbez(d) }).catch(() => {})
    fetch(KREIS_URL).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setKreise(d) }).catch(() => {})
    fetch(CITIES_URL).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setCities(d) }).catch(() => {})
    fetch(OUTLINE_URL).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setOutline(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Gemeinde outlines are 2,229 polygons (~3 MB), so they're fetched lazily the
  // first time the user zooms in far enough to need them — keeps initial load light.
  useEffect(() => {
    if (gemeinden || view.zoom < KREIS_TO_GEM) return
    let cancelled = false
    fetch(GEM_URL).then((r) => r.ok ? r.json() : null).then((d) => { if (!cancelled && d) setGemeinden(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [view.zoom, gemeinden])

  const counts = useMemo(() => {
    if (!data?.features) return null
    let good = 0, okay = 0
    for (const f of data.features) {
      const cls = f.properties?.suitability_class
      if (cls === "good") good++
      else if (cls === "okay") okay++
    }
    return { total: data.features.length, good, okay }
  }, [data])

  // Static fill cache so hover/select re-renders stay cheap across 3k cells.
  // Cell outlines thin out as you zoom in so the colour blocks read as a smooth
  // surface up close rather than a heavy grid.
  const styleFor = useMemo(
    () => (cls: SuitabilityClass, dim: boolean) => {
      const base = CLASS_COLOR[cls]
      // Bumped a touch from 0.55: after the melt blur, interior alpha reads as a
      // continuous wash rather than washed-out translucent squares.
      const fillAlpha = cls === "excluded" ? 0.2 : 0.62
      return {
        default: {
          // No outline — the cells are blurred into one another by #grid-melt,
          // so any stroke would just smear into grey haze.
          fill: dim ? "rgba(0,0,0,0)" : hexToRgba(base, fillAlpha),
          stroke: "none",
          strokeWidth: 0,
          outline: "none",
          cursor: dim ? "default" : "pointer",
        },
        hover: {
          fill: dim ? "rgba(0,0,0,0)" : hexToRgba(base, 0.85),
          stroke: "rgba(255,255,255,0.9)",
          strokeWidth: 0.6 / view.zoom,
          outline: "none",
          cursor: dim ? "default" : "pointer",
        },
        pressed: {
          fill: hexToRgba(base, 0.95),
          stroke: "white",
          strokeWidth: 0.7 / view.zoom,
          outline: "none",
        },
      }
    },
    [view.zoom],
  )

  // Reveal logic, derived from the live zoom level.
  const z = view.zoom
  const showKreise = z >= REGBEZ_TO_KREIS
  const showGem = z >= KREIS_TO_GEM
  const kreisAlpha = Math.min(1, (z - REGBEZ_TO_KREIS) / 1.2) // ease kreis lines in
  const gemAlpha = Math.min(1, (z - KREIS_TO_GEM) / 1.5) // ease gemeinde lines in
  const TIER_ZOOM: Record<number, number> = { 1: 0, 2: TIER2_ZOOM, 3: TIER3_ZOOM, 4: TIER4_ZOOM, 5: TIER5_ZOOM }
  const visibleCities = useMemo(
    () => cities.filter((c) => z >= (TIER_ZOOM[c.tier] ?? Infinity)),
    [cities, z],
  )

  const zoomTo = (factor: number) =>
    setView((v) => ({ ...v, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor)) }))

  return (
    <div style={{
      width: "100vw", height: "100vh", background: "#07090f",
      display: "flex", flexDirection: "column", overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* Top bar */}
      <motion.div
        initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.7 }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(7,9,15,0.95)", backdropFilter: "blur(12px)", zIndex: 30, flexShrink: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "linear-gradient(135deg,#f97316,#eab308)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: "14px" }}>☀</span>
          </div>
          <span style={{ fontSize: "16px", fontWeight: 700, color: "white", letterSpacing: "-0.02em" }}>Solario</span>
          <span style={{ fontSize: "10px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", borderLeft: "1px solid rgba(255,255,255,0.1)", paddingLeft: "10px", letterSpacing: "0.15em", textTransform: "uppercase" }}>
            Bavaria · Ground-mounted PV
          </span>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => setShowSatellite((v) => !v)}
            style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: showSatellite ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.05)", color: showSatellite ? "#f97316" : "rgba(255,255,255,0.5)" }}
          >
            {showSatellite ? "Satellite on" : "Satellite off"}
          </button>
          <button
            onClick={() => setHideExcluded((v) => !v)}
            style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: hideExcluded ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.05)", color: hideExcluded ? "#f97316" : "rgba(255,255,255,0.5)" }}
          >
            {hideExcluded ? "Showing buildable only" : "Hide excluded cells"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "20px" }}>
          {[
            { label: "Cells", value: counts ? counts.total.toLocaleString("en-US") : "—" },
            { label: "Good", value: counts ? String(counts.good) : "—" },
            { label: "Okay", value: counts ? String(counts.okay) : "—" },
            { label: "Source", value: "NASA + Copernicus" },
          ].map((s) => (
            <div key={s.label} style={{ textAlign: "right" }}>
              <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "white" }}>{s.value}</div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Map */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {data && (
          <ComposableMap
            projection="geoMercator"
            projectionConfig={{ center: CENTER, scale: 8200 }}
            style={{ width: "100%", height: "100%" }}
          >
            <ZoomableGroup
              center={view.coordinates}
              zoom={view.zoom}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              onMoveEnd={(pos) => setView(pos)}
            >
              {/* Layer 0 — satellite tile basemap (behind everything) */}
              {showSatellite && <SatelliteTiles view={view} outline={outline} opacity={1} />}

              {/* Melt filter — blurs the grid below into a continuous surface.
                  sRGB interpolation keeps the colour blends bright; the padded
                  region stops the blur clipping at the data's edge. */}
              <defs>
                <filter id="grid-melt" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
                  <feGaussianBlur stdDeviation={GRID_MELT_BLUR} />
                </filter>
              </defs>

              {/* Layer 1 — suitability grid (the coloured blocks).
                  Data / coordinates / 5 km structure unchanged — only the
                  wrapping <g filter> melts the squares together visually. */}
              <g filter="url(#grid-melt)">
                <Geographies geography={data}>
                  {({ geographies }) =>
                    geographies.map((geo) => {
                      const p = geo.properties as CellProps
                      const cls = p.suitability_class
                      const dim = hideExcluded && cls === "excluded"
                      return (
                        <Geography
                          key={geo.rsmKey}
                          geography={geo}
                          onMouseEnter={() => !dim && setHovered(p)}
                          onMouseLeave={() => setHovered(null)}
                          onClick={() => !dim && setSelected(p)}
                          style={styleFor(cls, dim)}
                        />
                      )
                    })
                  }
                </Geographies>
              </g>

              {/* Layer 1.5 — Gemeinde outlines (finest; fade in at deep zoom) */}
              {gemeinden && showGem && (
                <Geographies geography={gemeinden}>
                  {({ geographies }) =>
                    geographies.map((geo) => (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        style={{
                          default: {
                            fill: "rgba(0,0,0,0)",
                            stroke: `rgba(255,255,255,${0.13 * gemAlpha})`,
                            strokeWidth: 0.3 / z,
                            outline: "none",
                            pointerEvents: "none",
                          },
                          hover: { fill: "rgba(0,0,0,0)", stroke: `rgba(255,255,255,${0.13 * gemAlpha})`, strokeWidth: 0.3 / z, outline: "none", pointerEvents: "none" },
                          pressed: { fill: "rgba(0,0,0,0)", outline: "none", pointerEvents: "none" },
                        }}
                      />
                    ))
                  }
                </Geographies>
              )}

              {/* Layer 2 — Landkreis outlines (fade in when zoomed) */}
              {kreise && showKreise && (
                <Geographies geography={kreise}>
                  {({ geographies }) =>
                    geographies.map((geo) => (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        style={{
                          default: {
                            fill: "rgba(0,0,0,0)",
                            stroke: `rgba(255,255,255,${0.22 * kreisAlpha})`,
                            strokeWidth: 0.5 / z,
                            strokeDasharray: `${2 / z} ${2 / z}`,
                            outline: "none",
                            pointerEvents: "none",
                          },
                          hover: { fill: "rgba(0,0,0,0)", stroke: `rgba(255,255,255,${0.22 * kreisAlpha})`, strokeWidth: 0.5 / z, outline: "none", pointerEvents: "none" },
                          pressed: { fill: "rgba(0,0,0,0)", outline: "none", pointerEvents: "none" },
                        }}
                      />
                    ))
                  }
                </Geographies>
              )}

              {/* Layer 3 — Regierungsbezirk outlines (always) */}
              {regbez && (
                <Geographies geography={regbez}>
                  {({ geographies }) =>
                    geographies.map((geo) => (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        style={{
                          default: {
                            fill: "rgba(0,0,0,0)",
                            stroke: "rgba(255,255,255,0.32)",
                            strokeWidth: 1.1 / z,
                            outline: "none",
                            pointerEvents: "none",
                          },
                          hover: { fill: "rgba(0,0,0,0)", stroke: "rgba(255,255,255,0.32)", strokeWidth: 1.1 / z, outline: "none", pointerEvents: "none" },
                          pressed: { fill: "rgba(0,0,0,0)", outline: "none", pointerEvents: "none" },
                        }}
                      />
                    ))
                  }
                </Geographies>
              )}

              {/* Layer 4 — Regierungsbezirk names (faint atlas labels) */}
              {regbez && z < REGBEZ_TO_KREIS + 1.5 &&
                regbez.features.map((f) => {
                  const c = regbezLabelPoint(f.properties.name)
                  if (!c) return null
                  return (
                    <Marker key={`rb-${f.properties.name}`} coordinates={c}>
                      <text
                        textAnchor="middle"
                        style={{
                          fill: "rgba(255,255,255,0.28)",
                          fontSize: 9 / z,
                          fontFamily: "monospace",
                          letterSpacing: `${0.12 / z}px`,
                          textTransform: "uppercase",
                          pointerEvents: "none",
                          userSelect: "none",
                        }}
                      >
                        {f.properties.name}
                      </text>
                    </Marker>
                  )
                })}

              {/* Layer 5 — city markers + labels (tiered reveal) */}
              {visibleCities.map((city) => {
                const r = (city.tier === 1 ? 2.6 : city.tier === 2 ? 2.0 : 1.5) / z
                return (
                  <Marker key={city.name} coordinates={city.coordinates}>
                    <circle r={r} fill="#fff" stroke="rgba(0,0,0,0.5)" strokeWidth={0.5 / z} />
                    <text
                      x={4 / z}
                      y={2.5 / z}
                      style={{
                        fill: "rgba(255,255,255,0.92)",
                        fontSize: (city.tier === 1 ? 11 : city.tier === 2 ? 9.5 : 8.5) / z,
                        fontWeight: city.tier === 1 ? 700 : 500,
                        fontFamily: "'Inter', system-ui, sans-serif",
                        paintOrder: "stroke",
                        stroke: "rgba(7,9,15,0.85)",
                        strokeWidth: 2.4 / z,
                        strokeLinejoin: "round",
                        pointerEvents: "none",
                        userSelect: "none",
                      }}
                    >
                      {city.name}
                    </text>
                  </Marker>
                )
              })}
            </ZoomableGroup>
          </ComposableMap>
        )}

        {/* Loading / fetch-error states (otherwise a failed fetch = silent blank map) */}
        {!data && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {loadError ? (
              <div style={{ textAlign: "center", maxWidth: "420px", padding: "0 20px" }}>
                <div style={{ fontSize: "13px", color: "#ef4444", marginBottom: "6px", fontWeight: 600 }}>
                  Failed to load suitability data
                </div>
                <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>
                  {loadError} · {GEOJSON_URL}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "12px", fontFamily: "monospace", color: "rgba(255,255,255,0.35)", letterSpacing: "0.1em" }}>
                LOADING GRID…
              </div>
            )}
          </div>
        )}

        {/* Hover tooltip */}
        <AnimatePresence>
          {hovered && (
            <motion.div
              // x:"-50%" lives in the motion values: framer-motion owns `transform`,
              // so a static translateX(-50%) in `style` would be overwritten.
              initial={{ opacity: 0, y: 8, x: "-50%" }} animate={{ opacity: 1, y: 0, x: "-50%" }} exit={{ opacity: 0, y: 8, x: "-50%" }}
              style={{
                position: "absolute", top: "20px", left: "50%",
                background: "rgba(7,9,15,0.95)", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "8px", padding: "8px 16px", display: "flex", alignItems: "center", gap: "12px",
                backdropFilter: "blur(8px)", pointerEvents: "none", maxWidth: "80%",
              }}
            >
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: CLASS_COLOR[hovered.suitability_class], boxShadow: `0 0 8px ${CLASS_COLOR[hovered.suitability_class]}` }} />
              <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.85)" }}>{hovered.tooltip}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Zoom controls */}
        <div style={{ position: "absolute", bottom: "20px", right: "24px", display: "flex", flexDirection: "column", gap: "6px", zIndex: 20 }}>
          {[
            { label: "+", fn: () => zoomTo(1.5) },
            { label: "−", fn: () => zoomTo(1 / 1.5) },
          ].map((b) => (
            <button
              key={b.label}
              onClick={b.fn}
              style={{
                width: "34px", height: "34px", borderRadius: "8px", cursor: "pointer",
                background: "rgba(7,9,15,0.9)", border: "1px solid rgba(255,255,255,0.12)",
                color: "rgba(255,255,255,0.7)", fontSize: "18px", lineHeight: 1,
                backdropFilter: "blur(8px)",
              }}
            >
              {b.label}
            </button>
          ))}
          <button
            onClick={() => setView({ coordinates: CENTER, zoom: 1 })}
            style={{
              width: "34px", height: "34px", borderRadius: "8px", cursor: "pointer",
              background: "rgba(7,9,15,0.9)", border: "1px solid rgba(255,255,255,0.12)",
              color: "rgba(255,255,255,0.5)", fontSize: "13px", lineHeight: 1,
              backdropFilter: "blur(8px)",
            }}
            title="Reset view"
          >
            ⊙
          </button>
        </div>

        {/* Legend */}
        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}
          style={{ position: "absolute", bottom: "20px", left: "20px", background: "rgba(7,9,15,0.9)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "12px 16px", backdropFilter: "blur(8px)" }}
        >
          <div style={{ fontSize: "9px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "8px" }}>
            Suitability class
          </div>
          {(["good", "okay", "bad", "excluded"] as SuitabilityClass[]).map((c) => (
            <div key={c} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "2px", background: CLASS_COLOR[c] }} />
              <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.55)" }}>{CLASS_LABEL[c]}</span>
            </div>
          ))}
          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.07)", fontSize: "9px", fontFamily: "monospace", color: "rgba(255,255,255,0.25)", letterSpacing: "0.05em" }}>
            {showGem ? "GEMEINDE DETAIL" : showKreise ? "LANDKREIS DETAIL" : "REGIERUNGSBEZIRK VIEW"} · {z.toFixed(1)}×
          </div>
        </motion.div>

        {/* Hint */}
        {!selected && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }}
            style={{ position: "absolute", bottom: "24px", right: "70px", fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.05em", textAlign: "right" }}
          >
            scroll to zoom · drag to pan · click a cell →
          </motion.div>
        )}

        {/* Data source tags */}
        <div style={{ position: "absolute", top: "20px", right: selected ? "340px" : "20px", transition: "right 0.3s", display: "flex", gap: "8px" }}>
          {["NASA POWER", "Copernicus", "MaStR"].map((s) => (
            <span key={s} style={{ fontSize: "9px", fontFamily: "monospace", color: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: "3px" }}>{s}</span>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      <AnimatePresence>
        {selected && <CellPanel cell={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </div>
  )
}

// Hand-placed centroids for the 7 Regierungsbezirk name labels — cheaper and
// more legible than computing polygon centroids, and they never need to move.
const REGBEZ_POINTS: Record<string, [number, number]> = {
  Oberbayern: [11.9, 47.95],
  Niederbayern: [12.85, 48.7],
  Oberpfalz: [12.1, 49.4],
  Oberfranken: [11.3, 50.1],
  Mittelfranken: [10.7, 49.3],
  Unterfranken: [9.9, 50.0],
  Schwaben: [10.4, 48.2],
}
function regbezLabelPoint(name: string): [number, number] | null {
  return REGBEZ_POINTS[name] ?? null
}
