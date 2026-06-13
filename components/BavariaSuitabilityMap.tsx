"use client"

import { useMemo, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { ComposableMap, Geographies, Geography } from "react-simple-maps"

// ─── Contract with the aiclassification pipeline ──────────────────────────────
// Source of truth: outputs/bavaria_suitability.geojson, produced by the Python
// pipeline now merged into main (EPSG:4326, lon/lat). 3,061 grid cells, one
// Polygon each. Served via the raw GitHub URL so a fresh clone works with zero
// setup; a local copy also lives at /public/bavaria_suitability.geojson.
// Set NEXT_PUBLIC_SUITABILITY_GEOJSON to override (e.g. "/bavaria_suitability.geojson").
const GEOJSON_URL =
  process.env.NEXT_PUBLIC_SUITABILITY_GEOJSON ||
  "https://raw.githubusercontent.com/jivi28/RANDOM/main/outputs/bavaria_suitability.geojson"

type SuitabilityClass = "good" | "okay" | "bad" | "excluded"

interface CellProps {
  cell_id: number
  lon: number
  lat: number
  score: number
  suitability_class: SuitabilityClass
  slope: number
  ghi: number
  dist_powerline_m: number
  landcover: number
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
  const stats = [
    { label: "Score", value: cell.score.toFixed(0) },
    { label: "Slope", value: `${cell.slope.toFixed(1)}°` },
    { label: "Grid dist.", value: `${(cell.dist_powerline_m / 1000).toFixed(1)} km` },
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
          {CLASS_LABEL[cell.suitability_class].toUpperCase()} · SCORE {cell.score.toFixed(0)}
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

// ─── Main component ────────────────────────────────────────────────
export default function BavariaSuitabilityMap() {
  const [selected, setSelected] = useState<CellProps | null>(null)
  const [hovered, setHovered] = useState<CellProps | null>(null)
  const [hideExcluded, setHideExcluded] = useState(false)

  // Static fill cache so hover/select re-renders stay cheap across 3k cells
  const styleFor = useMemo(
    () => (cls: SuitabilityClass, dim: boolean) => {
      const base = CLASS_COLOR[cls]
      const fillAlpha = cls === "excluded" ? 0.18 : 0.55
      return {
        default: {
          fill: dim ? "rgba(0,0,0,0)" : hexToRgba(base, fillAlpha),
          stroke: "rgba(255,255,255,0.12)",
          strokeWidth: 0.15,
          outline: "none",
          cursor: dim ? "default" : "pointer",
        },
        hover: {
          fill: dim ? "rgba(0,0,0,0)" : hexToRgba(base, 0.85),
          stroke: "rgba(255,255,255,0.9)",
          strokeWidth: 0.4,
          outline: "none",
          cursor: dim ? "default" : "pointer",
        },
        pressed: {
          fill: hexToRgba(base, 0.95),
          stroke: "white",
          strokeWidth: 0.5,
          outline: "none",
        },
      }
    },
    [],
  )

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

        <button
          onClick={() => setHideExcluded((v) => !v)}
          style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: hideExcluded ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.05)", color: hideExcluded ? "#f97316" : "rgba(255,255,255,0.5)" }}
        >
          {hideExcluded ? "Showing buildable only" : "Hide excluded cells"}
        </button>

        <div style={{ display: "flex", gap: "20px" }}>
          {[
            { label: "Cells", value: "3,061" },
            { label: "Good", value: "27" },
            { label: "Okay", value: "59" },
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
        <ComposableMap
          projection="geoMercator"
          projectionConfig={{ center: [11.4, 48.95], scale: 8200 }}
          style={{ width: "100%", height: "100%" }}
        >
          <Geographies geography={GEOJSON_URL}>
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
        </ComposableMap>

        {/* Hover tooltip */}
        <AnimatePresence>
          {hovered && (
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              style={{
                position: "absolute", top: "20px", left: "50%", transform: "translateX(-50%)",
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
        </motion.div>

        {/* Hint */}
        {!selected && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }}
            style={{ position: "absolute", bottom: "24px", right: "24px", fontSize: "11px", fontFamily: "monospace", color: "rgba(255,255,255,0.3)", letterSpacing: "0.05em" }}
          >
            click a cell to inspect its factors →
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
