"use client"

import { useEffect, useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ComposableMap, Geographies, Geography, ZoomableGroup, Marker, useMapContext } from "react-simple-maps"
import {
  annualEnergyKwhFromGhi, energyKwh, energyValueEur, maintenanceEurPerMonth,
  capacityKwp, mjToKwhPerM2, formatKwh, formatKw, formatEur, formatArea,
} from "@/lib/energy"
import { fetchPastMonth, fetchNextWeek } from "@/lib/openMeteo"
import { type Farm, loadFarms, saveFarms, newFarmId } from "@/lib/farms"

// ─── Contract with the aiclassification pipeline ──────────────────────────────
// Source of truth: outputs/bavaria_suitability.geojson, produced by the Python
// pipeline now merged into main (EPSG:4326, lon/lat). 3,061 grid cells, one
// Polygon each. Served via the raw GitHub URL so a fresh clone works with zero
// setup; a local copy also lives at /public/bavaria_suitability.geojson.
// Set NEXT_PUBLIC_SUITABILITY_GEOJSON to override (e.g. "/bavaria_suitability.geojson").
const GEOJSON_URL =
  process.env.NEXT_PUBLIC_SUITABILITY_GEOJSON ||
  "https://raw.githubusercontent.com/jivi28/Solario/main/outputs/bavaria_suitability.geojson"

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
  // Human place name from the pipeline (point-in-polygon vs. Gemeinde/Landkreis).
  // Optional + nullable: border cells and pre-place-name GeoJSON have neither, in
  // which case we fall back to the bare cell id (see cellPlace).
  municipality?: string | null
  district?: string | null
  // Nullable: cells excluded for "missing data" carry nulls in the GeoJSON.
  score: number | null
  // Raw RandomForest probability before the sun/cloud resource nudge.
  model_score: number | null
  suitability_class: SuitabilityClass
  slope: number | null
  ghi: number | null
  cloud: number | null
  dist_powerline_m: number | null
  landcover: number | null
  protected: number
  // Vegetation encroachment of the cell's nearest power line (0..1, 1 = corridor
  // fully overgrown). factor_vegetation = 1 - veg_risk, but null for cells too far
  // from the grid for it to matter (see VEG_RISK_NEAR_M in the Python pipeline).
  veg_risk: number | null
  factor_vegetation: number | null
  factor_sun: number
  factor_cloud: number
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
  // Brighter, more saturated spring-green than the old #22c55e so "good" cells
  // stand out from the satellite imagery's own greens/browns instead of blending in.
  good: "#2bff77",
  okay: "#eab308",
  bad: "#ef4444",
  // Cooler, darker slate (was #6b7280) so excluded cells read as a flat grey
  // mask rather than picking up a green tint from the satellite showing through.
  excluded: "#3a4250",
}
// Display labels only — the internal keys (good/okay/bad/excluded) stay fixed
// because they're written into the GeoJSON, saved farms (farm.cls) and counts.
// "Inadequate" rather than "Bad" since these cells are still buildable; only
// "Excluded" land is off-limits.
const CLASS_LABEL: Record<SuitabilityClass, string> = {
  good: "Good",
  okay: "Satisfactory",
  bad: "Inadequate",
  excluded: "Excluded",
}

// Human-readable name for a cell. Prefers the pipeline's municipality (+ district
// as context), deduping kreisfreie Städte where the two are identical, and falls
// back to the bare grid id when no place name is present (border cells / a GeoJSON
// built before place names existed). Returns a `title` and a muted `sub`.
function cellPlace(p: Pick<CellProps, "municipality" | "district" | "cell_id">): { title: string; sub: string } {
  const mun = p.municipality?.trim()
  const dist = p.district?.trim()
  if (!mun && !dist) return { title: `Cell #${p.cell_id}`, sub: "" }
  if (mun && dist && mun !== dist) return { title: mun, sub: `${dist} · #${p.cell_id}` }
  return { title: (mun || dist) as string, sub: `#${p.cell_id}` }
}

function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// Placed-solar-farm accent (Solario orange) — distinct from the suitability palette.
const FARM_COLOR = "#f97316"

// Mirrors config.VEG_RISK_NEAR_M: beyond this the nearest line is treated as too
// far to be the interconnection, so its vegetation no longer affects the score.
const VEG_RISK_NEAR_M = 2500

const FACTORS: { key: keyof CellProps; label: string; naLabel?: string }[] = [
  { key: "factor_sun", label: "Sun (GHI)" },
  { key: "factor_cloud", label: "Clear sky" },
  { key: "factor_terrain", label: "Terrain" },
  { key: "factor_landuse", label: "Land use" },
  { key: "factor_grid", label: "Grid proximity" },
  // Higher = clearer corridor on the nearest power line. Null (n/a) either when the
  // cell is too far from the grid for encroachment to matter, or when the nearest
  // line has no vegetation measurement — the naLabel is chosen per-cell below.
  { key: "factor_vegetation", label: "Veg. corridor" },
  { key: "factor_model", label: "Model" },
]

// ─── Factor bar ────────────────────────────────────────────────────
// value is nullable: factor_vegetation is null for far-from-grid cells, where a
// 0-bar would wrongly read as "fully encroached" — show the naLabel instead.
function FactorBar({ label, value, naLabel }: { label: string; value: number | null; naLabel?: string }) {
  const missing = value == null || Number.isNaN(value)
  const v = missing ? 0 : value
  const pct = Math.max(0, Math.min(1, v)) * 100
  const color = pct >= 66 ? "#22c55e" : pct >= 33 ? "#eab308" : "#ef4444"
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>{label}</span>
        <span style={{ fontSize: "11px", fontFamily: "monospace", color: missing ? "rgba(255,255,255,0.3)" : "white" }}>
          {missing ? (naLabel ?? "n/a") : v.toFixed(3)}
        </span>
      </div>
      <div style={{ height: "5px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", overflow: "hidden" }}>
        {!missing && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            style={{ height: "100%", background: color }}
          />
        )}
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
    { label: "Model", value: cell.model_score != null ? cell.model_score.toFixed(2) : "n/a" },
    { label: "Cloud", value: cell.cloud != null ? `${(cell.cloud * 100).toFixed(0)}%` : "n/a" },
    { label: "Slope", value: cell.slope != null ? `${cell.slope.toFixed(1)}°` : "n/a" },
    { label: "Grid dist.", value: cell.dist_powerline_m != null ? `${(cell.dist_powerline_m / 1000).toFixed(1)} km` : "n/a" },
    { label: "Veg. risk", value: cell.veg_risk != null ? `${(cell.veg_risk * 100).toFixed(0)}%` : "n/a" },
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
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "white", letterSpacing: "-0.01em" }}>
              {cellPlace(cell).title}
            </div>
            {cellPlace(cell).sub && (
              <div style={{ fontFamily: "monospace", fontSize: "10px", letterSpacing: "0.12em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase", marginTop: "3px" }}>
                {cellPlace(cell).sub}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: "20px", cursor: "pointer", lineHeight: 1, flexShrink: 0 }}>×</button>
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
        {FACTORS.map((f) => {
          const raw = cell[f.key]
          const value = raw == null ? null : Number(raw)
          // Veg. corridor is n/a for two reasons; distinguish them (mirrors
          // VEG_RISK_NEAR_M in the Python pipeline): a distant line is not the
          // interconnection, whereas a near line may simply lack a measurement.
          let naLabel = f.naLabel
          if (f.key === "factor_vegetation" && value == null) {
            const far = cell.dist_powerline_m == null || cell.dist_powerline_m > VEG_RISK_NEAR_M
            naLabel = far ? "n/a · far from grid" : "n/a · no corridor data"
          }
          return <FactorBar key={f.key} label={f.label} value={value} naLabel={naLabel} />
        })}
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

// ─── Solar-farm marker glyph ────────────────────────────────────────────
// A small panel-array icon drawn in SVG, sized in base map units and scaled by
// 1/z (clamped) so it stays tappable at every zoom. Rendered inside a <Marker>.
function SolarFarmGlyph({ z, selected }: { z: number; selected: boolean }) {
  const s = Math.min(3.2, 2.2 / z) // half-size in base units, clamped
  return (
    <g style={{ cursor: "pointer" }}>
      <circle r={s * 1.7} fill={selected ? FARM_COLOR : "rgba(7,9,15,0.85)"} stroke={FARM_COLOR} strokeWidth={s * 0.32} />
      {/* panel grid */}
      <g stroke={selected ? "#07090f" : FARM_COLOR} strokeWidth={s * 0.18} fill="none">
        <rect x={-s} y={-s * 0.7} width={s * 2} height={s * 1.4} rx={s * 0.15} />
        <line x1={-s} y1={0} x2={s} y2={0} />
        <line x1={-s * 0.33} y1={-s * 0.7} x2={-s * 0.33} y2={s * 0.7} />
        <line x1={s * 0.33} y1={-s * 0.7} x2={s * 0.33} y2={s * 0.7} />
      </g>
    </g>
  )
}

// ─── Forecast sparkline (next-7-day daily kWh as little bars) ─────────────
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values)
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "44px", marginTop: "8px" }}>
      {values.map((v, i) => (
        <div key={i} title={`${formatKwh(v)}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${(v / max) * 100}%` }}
            transition={{ duration: 0.5, delay: i * 0.04 }}
            style={{ background: color, borderRadius: "2px 2px 0 0", minHeight: "2px" }}
          />
        </div>
      ))}
    </div>
  )
}

// ─── Placed-solar-farm dashboard panel ───────────────────────────────────
interface FarmEnergy {
  liveKw: number | null
  pastKwh: number | null
  weekDaily: number[] | null
  err: string | null
  loading: boolean
}

function FarmPanel({ farm, onClose, onRemove }: { farm: Farm; onClose: () => void; onRemove: (id: string) => void }) {
  const [e, setE] = useState<FarmEnergy>({ liveKw: null, pastKwh: null, weekDaily: null, err: null, loading: true })
  // AI briefing (Claude Haiku) — streamed text + status.
  const [brief, setBrief] = useState("")
  const [briefing, setBriefing] = useState(false)

  // Historical (Open-Meteo archive) + forecast (Open-Meteo forecast) on open/change.
  useEffect(() => {
    let cancelled = false
    setE((s) => ({ ...s, loading: true, err: null }))
    Promise.all([fetchPastMonth(farm.lat, farm.lon), fetchNextWeek(farm.lat, farm.lon)])
      .then(([past, week]) => {
        if (cancelled) return
        const pastMj = past.radiationMj.reduce((a, b) => a + b, 0)
        const pastKwh = energyKwh(farm.area_m2, mjToKwhPerM2(pastMj))
        const weekDaily = week.radiationMj.map((mj) => energyKwh(farm.area_m2, mjToKwhPerM2(mj)))
        setE((s) => ({ ...s, pastKwh, weekDaily, loading: false }))
      })
      .catch((err) => { if (!cancelled) setE((s) => ({ ...s, err: err instanceof Error ? err.message : String(err), loading: false })) })
    return () => { cancelled = true }
  }, [farm.id, farm.lat, farm.lon, farm.area_m2])

  // Live output from the company energy-hub seam — polled so the figure feels live.
  useEffect(() => {
    let cancelled = false
    const pull = () => {
      fetch(`/api/energy-hub?id=${encodeURIComponent(farm.id)}&area=${farm.area_m2}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (!cancelled && j) setE((s) => ({ ...s, liveKw: j.output_kw })) })
        .catch(() => {})
    }
    pull()
    const t = setInterval(pull, 30000)
    return () => { cancelled = true; clearInterval(t) }
  }, [farm.id, farm.area_m2])

  const cls = farm.cls as SuitabilityClass
  const color = CLASS_COLOR[cls]
  const cap = capacityKwp(farm.area_m2)
  const annualKwh = annualEnergyKwhFromGhi(farm.area_m2, farm.ghi)
  const pastValue = e.pastKwh != null ? energyValueEur(e.pastKwh) : null
  const maint = maintenanceEurPerMonth(farm.area_m2, farm.dist_powerline_m)
  const net = pastValue != null ? pastValue - maint : null
  const weekTotal = e.weekDaily ? e.weekDaily.reduce((a, b) => a + b, 0) : null

  // Ask the server route for a grounded AI briefing; stream the text into `brief`.
  const generateBrief = async () => {
    setBriefing(true)
    setBrief("")
    try {
      const res = await fetch("/api/site-brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          area_m2: farm.area_m2,
          capacity_kwp: cap,
          suitability_class: farm.cls,
          dist_powerline_m: farm.dist_powerline_m,
          annual_kwh: annualKwh,
          past_month_kwh: e.pastKwh,
          past_month_value_eur: pastValue,
          week_forecast_kwh: weekTotal,
          maintenance_eur_month: maint,
          net_eur_month: net,
          lat: farm.lat,
          lon: farm.lon,
        }),
      })
      if (!res.ok || !res.body) {
        setBrief(await res.text().catch(() => "Briefing unavailable."))
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setBrief((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch (err) {
      setBrief(`Briefing failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBriefing(false)
    }
  }

  const stat = (label: string, value: string) => (
    <div key={label}>
      <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontSize: "16px", fontWeight: 600, color: "white" }}>{value}</div>
    </div>
  )

  return (
    <motion.div
      initial={{ x: 340, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 340, opacity: 0 }}
      transition={{ type: "spring", stiffness: 280, damping: 30 }}
      style={{
        position: "absolute", right: 0, top: 0, height: "100%", width: "320px",
        background: "rgba(8,10,18,0.97)", borderLeft: "1px solid rgba(255,255,255,0.08)",
        zIndex: 40, overflowY: "auto", backdropFilter: "blur(10px)",
      }}
    >
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontFamily: "monospace", fontSize: "10px", letterSpacing: "0.15em", color: FARM_COLOR, textTransform: "uppercase" }}>
            ☀ Solar farm
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ marginTop: "10px", display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{
            display: "inline-block", background: hexToRgba(FARM_COLOR, 0.13), border: `1px solid ${hexToRgba(FARM_COLOR, 0.4)}`,
            color: FARM_COLOR, fontSize: "11px", fontWeight: 700, padding: "3px 9px", borderRadius: "5px", fontFamily: "monospace",
          }}>
            {capacityKwp(farm.area_m2) >= 1000 ? `${(cap / 1000).toFixed(1)} MWp` : `${cap.toFixed(0)} kWp`}
          </span>
          <span style={{
            display: "inline-block", background: hexToRgba(color, 0.13), border: `1px solid ${hexToRgba(color, 0.4)}`,
            color, fontSize: "11px", fontWeight: 700, padding: "3px 9px", borderRadius: "5px", fontFamily: "monospace",
          }}>
            {CLASS_LABEL[cls].toUpperCase()} LAND
          </span>
        </div>
        <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.55)", marginTop: "12px", lineHeight: 1.5 }}>
          {formatArea(farm.area_m2)} parcel · {annualKwh != null ? `~${formatKwh(annualKwh)}/yr at this site's irradiance` : "irradiance n/a"}.
        </p>
      </div>

      {/* Live output (company energy hub) */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: FARM_COLOR, boxShadow: `0 0 8px ${FARM_COLOR}` }} />
          <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Live · company hub (simulated)
          </span>
        </div>
        <div style={{ fontSize: "26px", fontWeight: 700, color: "white" }}>
          {e.liveKw != null ? formatKw(e.liveKw) : "—"}
        </div>
      </div>

      {/* Past month + costs */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "14px" }}>
          Past 30 days {e.loading && "· loading…"}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
          {stat("Energy produced", e.pastKwh != null ? formatKwh(e.pastKwh) : "—")}
          {stat("Energy value", pastValue != null ? formatEur(pastValue) : "—")}
          {stat("Maintenance", `${formatEur(maint)}/mo`)}
          {stat("Net (value − O&M)", net != null ? formatEur(net) : "—")}
        </div>
        {e.err && <div style={{ fontSize: "11px", color: "#ef4444", marginTop: "10px" }}>Weather data unavailable ({e.err}).</div>}
      </div>

      {/* Next 7 days forecast */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Next 7 days forecast
          </div>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "white" }}>{weekTotal != null ? formatKwh(weekTotal) : "—"}</div>
        </div>
        {e.weekDaily ? <Sparkline values={e.weekDaily} color={FARM_COLOR} /> : (
          <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.3)", marginTop: "8px" }}>{e.loading ? "loading forecast…" : "—"}</div>
        )}
      </div>

      {/* AI briefing (Claude Haiku) */}
      <div style={{ padding: "20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "10px" }}>
          AI site briefing
        </div>
        {brief && (
          <p style={{ fontSize: "12px", color: "rgba(255,255,255,0.75)", lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: "12px" }}>
            {brief}{briefing && <span style={{ opacity: 0.5 }}>▌</span>}
          </p>
        )}
        <button
          onClick={generateBrief}
          disabled={briefing}
          style={{ width: "100%", padding: "9px", borderRadius: "7px", fontSize: "12px", fontWeight: 600, cursor: briefing ? "default" : "pointer", background: "rgba(249,115,22,0.12)", border: "1px solid rgba(249,115,22,0.35)", color: "#f97316", opacity: briefing ? 0.6 : 1 }}
        >
          {briefing ? "Writing briefing…" : brief ? "↻ Regenerate briefing" : "✨ Generate AI briefing"}
        </button>
      </div>

      {/* Remove */}
      <div style={{ padding: "20px" }}>
        <button
          onClick={() => onRemove(farm.id)}
          style={{ width: "100%", padding: "9px", borderRadius: "7px", fontSize: "12px", fontWeight: 600, cursor: "pointer", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#ef4444" }}
        >
          Remove this farm
        </button>
      </div>
    </motion.div>
  )
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

// Latitude nudged north of the geographic mid (48.95) to the Mercator-vertical
// centre of Bavaria (~49.2), so the state sits evenly in the viewBox instead of
// riding high and clipping the northern border.
const CENTER: [number, number] = [11.4, 49.2]
// Below 1 lets you pull back past the default framing for breathing room.
const MIN_ZOOM = 0.5
// Scaled up from 14 to keep the same deepest zoom-in detail as before the base
// `scale` was reduced (8200→4800 ≈ 1.7×), since zoom multiplies that scale.
const MAX_ZOOM = 24

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

  // ── Solar-farm planning state ──
  const [showTop5, setShowTop5] = useState(false)
  const [placing, setPlacing] = useState(false)        // "Place farm" mode armed
  const [farms, setFarms] = useState<Farm[]>([])
  const [selectedFarm, setSelectedFarm] = useState<Farm | null>(null)
  const [pendingCell, setPendingCell] = useState<CellProps | null>(null) // awaiting area input
  const [areaInput, setAreaInput] = useState("250000")  // m² (0.25 km² default)
  const [toast, setToast] = useState<string | null>(null)

  // Load placed farms from localStorage once on mount.
  useEffect(() => { setFarms(loadFarms()) }, [])

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2800)
    return () => clearTimeout(t)
  }, [toast])

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
      // continuous wash rather than washed-out translucent squares. "good" cells
      // get a heavier alpha still so the buildable zones pop off the satellite
      // basemap instead of melting into its greenery.
      const fillAlpha = cls === "excluded" ? 0.6 : cls === "good" ? 0.85 : 0.62
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

  // Top 5 buildable sites by suitability score (excluded cells can't be built on).
  const top5 = useMemo(() => {
    if (!data?.features) return []
    return data.features
      .map((f) => f.properties)
      .filter((p) => p.suitability_class !== "excluded" && p.score != null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5)
  }, [data])

  const flyTo = (lon: number, lat: number, zoom = 9) =>
    setView({ coordinates: [lon, lat], zoom })

  // Placing mode: a cell click either opens the size dialog or is rejected for
  // excluded land. Otherwise a cell click opens the read-only detail panel.
  const handleCellClick = (p: CellProps) => {
    if (placing) {
      if (p.suitability_class === "excluded") {
        setToast("Can't place a solar farm on excluded land — pick green, yellow or red.")
        return
      }
      setSelectedFarm(null)
      setSelected(null)
      setPendingCell(p)
    } else {
      setSelectedFarm(null)
      setSelected(p)
    }
  }

  const persistFarms = (next: Farm[]) => { setFarms(next); saveFarms(next) }

  const finishPlacement = () => {
    if (!pendingCell) return
    const area = Math.max(1, Math.round(Number(areaInput) || 0))
    if (!Number.isFinite(area) || area <= 0) { setToast("Enter a valid area in m².") ; return }
    const farm: Farm = {
      id: newFarmId(),
      lon: pendingCell.lon,
      lat: pendingCell.lat,
      area_m2: area,
      cell_id: pendingCell.cell_id,
      cls: pendingCell.suitability_class,
      dist_powerline_m: pendingCell.dist_powerline_m,
      ghi: pendingCell.ghi,
      created: Date.now(),
    }
    persistFarms([...farms, farm])
    setPendingCell(null)
    setPlacing(false)
    setSelectedFarm(farm)
    setToast("Solar farm placed.")
  }

  const removeFarm = (id: string) => {
    persistFarms(farms.filter((f) => f.id !== id))
    setSelectedFarm(null)
  }

  return (
    <div style={{
      width: "100vw", height: "100vh", background: "#07090f",
      display: "flex", flexDirection: "column", overflow: "hidden",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* Ambient edge glow — the Solario orange/amber light hugging the left and
          right edges with a slow opposing shimmer, so the dark UI reads as lit
          rather than flat black. Purely decorative: fixed to the viewport, never
          intercepts pointer events, and sits below the top bar (z30) and detail
          panel (z40) so those surfaces stay crisp. `screen` blend makes it add
          light onto the dark background instead of painting a flat overlay. */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0.5 }}
        animate={{ opacity: [0.5, 0.85, 0.5] }}
        transition={{ duration: 5, ease: "easeInOut", repeat: Infinity }}
        style={{
          position: "fixed", top: 0, left: 0, bottom: 0, width: "150px",
          background: "linear-gradient(to right, rgba(249,115,22,0.20), rgba(234,179,8,0.05) 42%, rgba(249,115,22,0) 100%)",
          pointerEvents: "none", zIndex: 25, mixBlendMode: "screen",
        }}
      />
      <motion.div
        aria-hidden
        initial={{ opacity: 0.85 }}
        animate={{ opacity: [0.85, 0.5, 0.85] }}
        transition={{ duration: 5, ease: "easeInOut", repeat: Infinity }}
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "150px",
          background: "linear-gradient(to left, rgba(249,115,22,0.20), rgba(234,179,8,0.05) 42%, rgba(249,115,22,0) 100%)",
          pointerEvents: "none", zIndex: 25, mixBlendMode: "screen",
        }}
      />

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
            onClick={() => setShowTop5((v) => !v)}
            style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: showTop5 ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.05)", color: showTop5 ? "#f97316" : "rgba(255,255,255,0.5)" }}
          >
            ★ Top 5 sites
          </button>
          <button
            onClick={() => { setPlacing((v) => !v); setPendingCell(null) }}
            style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, border: `1px solid ${placing ? "rgba(249,115,22,0.6)" : "rgba(255,255,255,0.1)"}`, cursor: "pointer", background: placing ? "rgba(249,115,22,0.25)" : "rgba(255,255,255,0.05)", color: placing ? "#f97316" : "rgba(255,255,255,0.5)" }}
          >
            {placing ? "Placing… click a cell" : "＋ Place farm"}
          </button>
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
            { label: "Satisfactory", value: counts ? String(counts.okay) : "—" },
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
      <div style={{ flex: 1, position: "relative", overflow: "hidden", cursor: placing ? "crosshair" : undefined }}>
        {data && (
          <ComposableMap
            projection="geoMercator"
            projectionConfig={{ center: CENTER, scale: 4800 }}
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
                          onClick={() => !dim && handleCellClick(p)}
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

              {/* Layer 6 — placed solar farms */}
              {farms.map((farm) => (
                <Marker key={farm.id} coordinates={[farm.lon, farm.lat]}>
                  <g
                    onClick={(ev) => { ev.stopPropagation(); setSelected(null); setSelectedFarm(farm) }}
                  >
                    <SolarFarmGlyph z={z} selected={selectedFarm?.id === farm.id} />
                  </g>
                </Marker>
              ))}
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
        <div style={{ position: "absolute", top: "20px", right: selected || selectedFarm ? "340px" : "20px", transition: "right 0.3s", display: "flex", gap: "8px" }}>
          {["NASA POWER", "Copernicus", "MaStR"].map((s) => (
            <span key={s} style={{ fontSize: "9px", fontFamily: "monospace", color: "rgba(255,255,255,0.2)", border: "1px solid rgba(255,255,255,0.08)", padding: "2px 6px", borderRadius: "3px" }}>{s}</span>
          ))}
        </div>

        {/* Top 5 sites panel */}
        <AnimatePresence>
          {showTop5 && (
            <motion.div
              initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              style={{ position: "absolute", top: "20px", left: "20px", width: "260px", background: "rgba(7,9,15,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "10px", padding: "14px 16px", backdropFilter: "blur(10px)", zIndex: 35 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#f97316", fontFamily: "monospace", letterSpacing: "0.1em", textTransform: "uppercase" }}>★ Top 5 sites</span>
                <button onClick={() => setShowTop5(false)} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.4)", fontSize: "16px", cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              {top5.length === 0 && <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)" }}>No scored cells yet.</div>}
              {top5.map((p, i) => (
                <button
                  key={p.cell_id}
                  onClick={() => { flyTo(p.lon, p.lat); setSelectedFarm(null); setSelected(p) }}
                  style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", textAlign: "left", padding: "7px 6px", marginBottom: "2px", borderRadius: "6px", background: "transparent", border: "none", cursor: "pointer", color: "white" }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                  onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "rgba(255,255,255,0.35)", width: "16px" }}>{i + 1}</span>
                  <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: CLASS_COLOR[p.suitability_class], flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cellPlace(p).title}</span>
                    {cellPlace(p).sub && (
                      <span style={{ display: "block", fontSize: "10px", color: "rgba(255,255,255,0.4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cellPlace(p).sub}</span>
                    )}
                  </span>
                  <span style={{ fontSize: "12px", fontFamily: "monospace", fontWeight: 700, color: "#2bff77", flexShrink: 0 }}>{p.score != null ? p.score.toFixed(2) : "—"}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Area dialog (after a cell is picked in placing mode) */}
        <AnimatePresence>
          {pendingCell && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)", zIndex: 50 }}
              onClick={() => setPendingCell(null)}
            >
              <motion.div
                initial={{ scale: 0.94, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 8 }}
                onClick={(ev) => ev.stopPropagation()}
                style={{ width: "320px", background: "rgba(10,12,20,0.98)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "12px", padding: "22px", backdropFilter: "blur(12px)" }}
              >
                <div style={{ fontSize: "13px", fontWeight: 700, color: "white", marginBottom: "4px" }}>How big is the solar farm?</div>
                <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.45)", marginBottom: "16px" }}>
                  {cellPlace(pendingCell).title} · {CLASS_LABEL[pendingCell.suitability_class]} land
                </div>
                <label style={{ fontSize: "10px", color: "rgba(255,255,255,0.4)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em" }}>Area (m²)</label>
                <input
                  type="number" min={1} value={areaInput} autoFocus
                  onChange={(ev) => setAreaInput(ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === "Enter") finishPlacement() }}
                  style={{ width: "100%", marginTop: "6px", marginBottom: "8px", padding: "10px 12px", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "white", fontSize: "15px", fontFamily: "monospace" }}
                />
                <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", marginBottom: "16px" }}>
                  ≈ {formatArea(Math.max(0, Number(areaInput) || 0))} · {(capacityKwp(Math.max(0, Number(areaInput) || 0)) / 1000).toFixed(1)} MWp capacity
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={() => setPendingCell(null)} style={{ flex: 1, padding: "9px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.6)" }}>Cancel</button>
                  <button onClick={finishPlacement} style={{ flex: 1, padding: "9px", borderRadius: "8px", fontSize: "12px", fontWeight: 700, cursor: "pointer", background: "linear-gradient(135deg,#f97316,#eab308)", border: "none", color: "#07090f" }}>Finish</button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 16, x: "-50%" }} animate={{ opacity: 1, y: 0, x: "-50%" }} exit={{ opacity: 0, y: 16, x: "-50%" }}
              style={{ position: "absolute", bottom: "70px", left: "50%", background: "rgba(7,9,15,0.97)", border: "1px solid rgba(249,115,22,0.4)", borderRadius: "8px", padding: "10px 18px", fontSize: "12px", color: "white", backdropFilter: "blur(8px)", zIndex: 55, maxWidth: "80%" }}
            >
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Detail panel (cell) or farm dashboard — only one at a time */}
      <AnimatePresence>
        {selectedFarm ? (
          <FarmPanel key="farm" farm={selectedFarm} onClose={() => setSelectedFarm(null)} onRemove={removeFarm} />
        ) : selected ? (
          <CellPanel key="cell" cell={selected} onClose={() => setSelected(null)} />
        ) : null}
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
