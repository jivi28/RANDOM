// Open-Meteo fetch helpers (keyless, CORS-friendly, called directly from the
// browser). Two windows feed the farm dashboard:
//   * past month  -> archive API  (last 30 complete days of measured irradiance)
//   * next 7 days -> forecast API (daily forecast irradiance)
// Both return daily `shortwave_radiation_sum` in MJ/m²/day; the caller converts
// to kWh with lib/energy.mjToKwhPerM2.

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
const FORECAST = "https://api.open-meteo.com/v1/forecast"

export interface DailyIrradiance {
  dates: string[] // ISO yyyy-mm-dd
  radiationMj: number[] // shortwave_radiation_sum, MJ/m²/day
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function fetchDaily(url: string): Promise<DailyIrradiance> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const json = await res.json()
  const dates: string[] = json?.daily?.time ?? []
  const radiationMj: number[] = (json?.daily?.shortwave_radiation_sum ?? []).map((v: number | null) =>
    v == null ? 0 : v,
  )
  return { dates, radiationMj }
}

/** Last 30 days of measured daily irradiance at (lat, lon). Archive lags a few
 * days, so we end 5 days before today and walk back 30 days from there. */
export async function fetchPastMonth(lat: number, lon: number): Promise<DailyIrradiance> {
  const end = new Date()
  end.setDate(end.getDate() - 5)
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: ymd(start),
    end_date: ymd(end),
    daily: "shortwave_radiation_sum",
    timezone: "UTC",
  })
  return fetchDaily(`${ARCHIVE}?${q}`)
}

/** Next 7 days of forecast daily irradiance at (lat, lon). */
export async function fetchNextWeek(lat: number, lon: number): Promise<DailyIrradiance> {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: "shortwave_radiation_sum",
    forecast_days: "7",
    timezone: "UTC",
  })
  return fetchDaily(`${FORECAST}?${q}`)
}
