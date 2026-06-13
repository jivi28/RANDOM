// Company energy-hub integration seam.
//
// This endpoint stands in for the operator's real-time generation feed (SCADA /
// energy-hub API). The frontend asks it "what is this farm producing right now?".
// Today it returns a SIMULATED instantaneous output derived from the farm's
// capacity and a time-of-day solar curve. To go live, replace the body of
// `liveOutputKw` with a call to the company's actual hub for `id` and return the
// measured kW — the request/response contract and the UI stay the same.

import { NextResponse } from "next/server"
import { capacityKwp } from "@/lib/energy"

// Fraction of nameplate a clear-sky farm produces at UTC hour `h` (Bavaria sits
// ~CET/CEST, so solar noon is ~11:00 UTC). A raised cosine over an ~8h-half-window
// day, zero at night. Purely illustrative until a real feed is wired in.
function clearSkyFraction(hourUtc: number): number {
  const noon = 11
  const halfDay = 6.5 // hours from noon to sunrise/sunset
  const x = (hourUtc - noon) / halfDay
  if (Math.abs(x) >= 1) return 0
  return Math.cos((x * Math.PI) / 2) ** 2
}

function liveOutputKw(areaM2: number, now: Date): number {
  const cap = capacityKwp(areaM2)
  const hourUtc = now.getUTCHours() + now.getUTCMinutes() / 60
  const clear = clearSkyFraction(hourUtc)
  // A little deterministic-per-minute cloud jitter so the figure feels live.
  const jitter = 0.85 + 0.15 * Math.abs(Math.sin((now.getUTCMinutes() + 1) * 1.7))
  return cap * clear * jitter
}

export function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const area = Number(searchParams.get("area"))
  const id = searchParams.get("id") ?? "unknown"
  if (!Number.isFinite(area) || area <= 0) {
    return NextResponse.json({ error: "missing or invalid `area`" }, { status: 400 })
  }
  const now = new Date()
  const kw = liveOutputKw(area, now)
  return NextResponse.json({
    id,
    source: "simulated", // becomes "hub" once a real feed is connected
    timestamp: now.toISOString(),
    output_kw: Math.round(kw * 10) / 10,
    capacity_kwp: Math.round(capacityKwp(area)),
  })
}
